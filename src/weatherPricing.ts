import type { AppConfig } from "./config.js";
import type {
  WeatherMarketCandidate,
  WeatherMarketGroup,
  WeatherMeasure
} from "./weatherMarkets.js";
import {
  fetchNoaaClimatology,
  fetchWeatherEdgeSources,
  looksLikeHongKongLocation,
  type WeatherClimatologyReport,
  type WeatherLocation,
  type WeatherSourceId,
  type WeatherSourceResult
} from "./weatherEdge.js";

export interface WeatherForecastPoint {
  source: WeatherSourceId;
  provider: string;
  valueC: number;
  baseWeight: number;
  adjustedWeight: number;
}

export interface WeatherConsensus {
  meanC: number;
  sigmaC: number;
  rawMeanC: number;
  modelStdDevC: number;
  agreement: "VERY_HIGH" | "HIGH" | "MODERATE" | "LOW" | "VERY_LOW";
  hoursToResolution: number;
  forecastPoints: WeatherForecastPoint[];
  climatology?: {
    meanC: number;
    stdDevC: number;
    count: number;
    blended: boolean;
  };
}

export interface WeatherOutcomePricing {
  marketSlug: string;
  question: string;
  outcomeLabel: string;
  fairYes: number;
  fairNo: number;
  yesAsk?: number;
  yesBid?: number;
  noAsk?: number;
  noBid?: number;
  yesEdge?: number;
  noEdge?: number;
  signal: "BUY_YES" | "BUY_NO" | "SKIP";
  edge?: number;
  confidence: "HIGH" | "MEDIUM" | "LOW";
  kellyFraction: number;
  suggestedSizeUsd?: number;
  tokenId?: string;
  price?: number;
  reason: string;
}

export interface WeatherPricingReport {
  group: Omit<WeatherMarketGroup, "markets" | "unparsed"> & {
    marketCount: number;
  };
  markets: Array<Pick<WeatherMarketCandidate, "marketSlug" | "liquidity" | "volume">>;
  location: WeatherLocation;
  sources: Array<Pick<WeatherSourceResult, "source" | "provider" | "ok" | "skipped" | "note" | "error">>;
  climatology?: WeatherClimatologyReport;
  consensus?: WeatherConsensus;
  outcomes: WeatherOutcomePricing[];
  errors: string[];
}

export interface WeatherPricingOptions {
  bankrollUsd?: number;
  maxPerTradeUsd?: number;
  minEdge?: number;
  noaaYears?: number;
  skipClimatology?: boolean;
  noaaStationId?: string;
  noaaLocationId?: string;
  countryCode?: string;
}

const BASE_WEIGHTS: Record<WeatherSourceId, number> = {
  openmeteo_ecmwf: 0.35,
  openmeteo_gfs: 0.25,
  openmeteo_ukmo: 0.2,
  nws: 0.2,
  hko: 0.5,
  noaa_ncei: 0
};

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function stdDev(values: number[]): number {
  if (values.length === 0) return 0;
  const avg = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / values.length);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function normalCdf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const abs = Math.abs(x) / Math.sqrt(2);
  const t = 1 / (1 + 0.3275911 * abs);
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const erf = sign * (1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-abs * abs));
  return 0.5 * (1 + erf);
}

export function probabilityInRange(meanC: number, sigmaC: number, lowerC?: number, upperC?: number): number {
  const sigma = Math.max(0.1, sigmaC);
  const lowerProb = lowerC === undefined ? 0 : normalCdf((lowerC - meanC) / sigma);
  const upperProb = upperC === undefined ? 1 : normalCdf((upperC - meanC) / sigma);
  return clamp(upperProb - lowerProb, 0, 1);
}

export function calculateBaseSigma(hoursToResolution: number): number {
  if (hoursToResolution <= 6) return 0.8;
  if (hoursToResolution <= 12) return 1.0;
  if (hoursToResolution <= 24) return 1.3;
  if (hoursToResolution <= 48) return 1.8;
  if (hoursToResolution <= 72) return 2.2;
  if (hoursToResolution <= 120) return 3.0;
  if (hoursToResolution <= 168) return 3.8;
  if (hoursToResolution <= 240) return 4.5;
  return 5.5;
}

function sourceCountPenalty(count: number): number {
  if (count >= 4) return 1;
  if (count === 3) return 1.1;
  if (count === 2) return 1.25;
  return 1.5;
}

function agreementTier(spread: number): WeatherConsensus["agreement"] {
  if (spread < 0.5) return "VERY_HIGH";
  if (spread < 1.0) return "HIGH";
  if (spread < 2.0) return "MODERATE";
  if (spread < 3.5) return "LOW";
  return "VERY_LOW";
}

function dynamicEdgeThreshold(sigmaC: number, override?: number): number {
  return override ?? clamp(sigmaC * 0.02, 0.03, 0.08);
}

function quarterKelly(probability: number, price: number): number {
  if (price <= 0 || price >= 1) return 0;
  const fullKelly = (probability - price) / (1 - price);
  return clamp(fullKelly * 0.25, 0, 0.15);
}

function hoursToResolution(group: WeatherMarketGroup): number {
  const target = group.eventEndDate
    ? Date.parse(group.eventEndDate)
    : Date.parse(`${group.date}T23:59:00Z`);
  const diff = (target - Date.now()) / 3_600_000;
  return Number.isFinite(diff) ? Math.max(0, diff) : 168;
}

function forecastValueForSource(
  result: WeatherSourceResult,
  date: string,
  measure: WeatherMeasure
): number | undefined {
  const daily = result.daily?.find((point) => point.date === date);
  if (daily) {
    return measure === "temperature_high" ? daily.maxTempC : daily.minTempC;
  }

  const values = (result.hourly ?? [])
    .filter((point) => point.time.slice(0, 10) === date && point.tempC !== undefined)
    .map((point) => point.tempC as number);
  if (values.length === 0) return undefined;
  return measure === "temperature_high" ? Math.max(...values) : Math.min(...values);
}

function sourceWeightsForLocation(location: WeatherLocation): Record<WeatherSourceId, number> {
  if (!looksLikeHongKongLocation(location)) return BASE_WEIGHTS;
  return {
    ...BASE_WEIGHTS,
    hko: 0.5,
    openmeteo_ecmwf: 0.2,
    openmeteo_gfs: 0.15,
    openmeteo_ukmo: 0.1,
    nws: 0.05
  };
}

function buildConsensus(
  location: WeatherLocation,
  group: WeatherMarketGroup,
  sourceResults: WeatherSourceResult[],
  climatology?: WeatherClimatologyReport
): WeatherConsensus | undefined {
  const weights = sourceWeightsForLocation(location);
  const points = sourceResults.flatMap((result) => {
    if (!result.ok) return [];
    const valueC = forecastValueForSource(result, group.date, group.measure);
    if (valueC === undefined) return [];
    return [{
      source: result.source,
      provider: result.provider,
      valueC,
      baseWeight: weights[result.source] ?? 0,
      adjustedWeight: weights[result.source] ?? 0
    }];
  });

  if (points.length === 0) return undefined;

  const rawMeanC = mean(points.map((point) => point.valueC));
  const modelStdDevC = stdDev(points.map((point) => point.valueC));
  const outlierCutoff = modelStdDevC * 1.5;
  const adjusted = points.map((point) => ({
    ...point,
    adjustedWeight: modelStdDevC > 0 && Math.abs(point.valueC - rawMeanC) > outlierCutoff
      ? point.adjustedWeight / 2
      : point.adjustedWeight
  }));
  const weightTotal = adjusted.reduce((sum, point) => sum + point.adjustedWeight, 0) || adjusted.length;
  const forecastMeanC = adjusted.reduce((sum, point) => sum + point.valueC * (point.adjustedWeight || 1), 0) / weightTotal;
  const resolutionHours = hoursToResolution(group);
  const baseSigma = calculateBaseSigma(resolutionHours);
  const unblendedSigma = clamp(
    baseSigma * sourceCountPenalty(points.length) * (1 + modelStdDevC / 5),
    0.5,
    8
  );

  const climateSummary = group.measure === "temperature_high"
    ? climatology?.maxTempC
    : climatology?.minTempC;

  if (!climateSummary || climateSummary.count < 3) {
    return {
      meanC: forecastMeanC,
      sigmaC: unblendedSigma,
      rawMeanC,
      modelStdDevC,
      agreement: agreementTier(modelStdDevC),
      hoursToResolution: resolutionHours,
      forecastPoints: adjusted
    };
  }

  const historicalSigma = Math.max(0.5, climateSummary.stdDev);
  const forecastPrecision = 1 / (unblendedSigma ** 2);
  const historicalPrecision = 1 / (historicalSigma ** 2);
  const blendedMean = (
    forecastMeanC * forecastPrecision +
    climateSummary.mean * historicalPrecision
  ) / (forecastPrecision + historicalPrecision);
  let blendedSigma = Math.sqrt(1 / (forecastPrecision + historicalPrecision));
  if (Math.abs(forecastMeanC - climateSummary.mean) > historicalSigma * 1.5) {
    blendedSigma *= 1.3;
  }

  return {
    meanC: blendedMean,
    sigmaC: clamp(blendedSigma, 0.5, 8),
    rawMeanC,
    modelStdDevC,
    agreement: agreementTier(modelStdDevC),
    hoursToResolution: resolutionHours,
    forecastPoints: adjusted,
    climatology: {
      meanC: climateSummary.mean,
      stdDevC: historicalSigma,
      count: climateSummary.count,
      blended: true
    }
  };
}

function marketPrice(candidate: WeatherMarketCandidate, outcome: "Yes" | "No"): number | undefined {
  return candidate.outcomes.find((item) => item.outcome.toLowerCase() === outcome.toLowerCase())?.price;
}

function marketToken(candidate: WeatherMarketCandidate, outcome: "Yes" | "No"): string | undefined {
  return candidate.outcomes.find((item) => item.outcome.toLowerCase() === outcome.toLowerCase())?.tokenId;
}

function priceCandidate(
  candidate: WeatherMarketCandidate,
  consensus: WeatherConsensus,
  options: WeatherPricingOptions
): WeatherOutcomePricing {
  const fairYes = probabilityInRange(
    consensus.meanC,
    consensus.sigmaC,
    candidate.parsed.outcome.lowerTempC,
    candidate.parsed.outcome.upperTempC
  );
  const fairNo = 1 - fairYes;
  const yesAsk = candidate.bestAsk ?? marketPrice(candidate, "Yes");
  const yesBid = candidate.bestBid ?? marketPrice(candidate, "Yes");
  const noAsk = marketPrice(candidate, "No") ?? (yesBid === undefined ? undefined : 1 - yesBid);
  const noBid = marketPrice(candidate, "No") ?? (yesAsk === undefined ? undefined : 1 - yesAsk);
  const threshold = dynamicEdgeThreshold(consensus.sigmaC, options.minEdge);
  const yesEdge = yesAsk === undefined ? undefined : fairYes - yesAsk;
  const noEdge = noAsk === undefined ? undefined : fairNo - noAsk;
  const bestSignal = (yesEdge ?? -Infinity) >= (noEdge ?? -Infinity)
    ? { signal: "BUY_YES" as const, edge: yesEdge, price: yesAsk, probability: fairYes, tokenId: marketToken(candidate, "Yes") }
    : { signal: "BUY_NO" as const, edge: noEdge, price: noAsk, probability: fairNo, tokenId: marketToken(candidate, "No") };

  const signal = bestSignal.edge !== undefined && bestSignal.edge >= threshold
    ? bestSignal.signal
    : "SKIP";
  const kellyFraction = signal === "SKIP" || bestSignal.price === undefined
    ? 0
    : quarterKelly(bestSignal.probability, bestSignal.price);
  const bankroll = options.bankrollUsd ?? 0;
  const maxPerTrade = options.maxPerTradeUsd ?? Infinity;
  const suggestedSizeUsd = kellyFraction > 0 && bankroll > 0
    ? Math.min(bankroll * kellyFraction, maxPerTrade)
    : undefined;
  const confidence = consensus.agreement === "VERY_HIGH" || consensus.agreement === "HIGH"
    ? "HIGH"
    : consensus.agreement === "MODERATE"
      ? "MEDIUM"
      : "LOW";

  return {
    marketSlug: candidate.marketSlug,
    question: candidate.question,
    outcomeLabel: candidate.parsed.outcome.label,
    fairYes,
    fairNo,
    yesAsk,
    yesBid,
    noAsk,
    noBid,
    yesEdge,
    noEdge,
    signal,
    edge: signal === "SKIP" ? bestSignal.edge : bestSignal.edge,
    confidence,
    kellyFraction,
    suggestedSizeUsd,
    tokenId: signal === "SKIP" ? undefined : bestSignal.tokenId,
    price: signal === "SKIP" ? undefined : bestSignal.price,
    reason: signal === "SKIP"
      ? `Best edge ${(bestSignal.edge ?? 0).toFixed(3)} is below threshold ${threshold.toFixed(3)}.`
      : `${signal} edge ${(bestSignal.edge ?? 0).toFixed(3)} >= threshold ${threshold.toFixed(3)}.`
  };
}

export async function priceWeatherMarketGroup(
  config: AppConfig,
  group: WeatherMarketGroup,
  options: WeatherPricingOptions = {}
): Promise<WeatherPricingReport> {
  const errors: string[] = [];
  const target = Date.parse(`${group.date}T23:59:00Z`);
  const days = Number.isFinite(target)
    ? clamp(Math.ceil((target - Date.now()) / 86_400_000) + 1, 1, 16)
    : 7;
  const sources: WeatherSourceId[] = ["openmeteo_gfs", "openmeteo_ecmwf", "openmeteo_ukmo", "nws", "hko"];
  const forecastReport = await fetchWeatherEdgeSources(config, {
    city: group.city,
    countryCode: options.countryCode,
    days,
    sources
  });
  const climatology = options.skipClimatology
    ? undefined
    : await fetchNoaaClimatology(config, forecastReport.location, {
      targetDate: group.date,
      years: options.noaaYears,
      noaaStationId: options.noaaStationId,
      noaaLocationId: options.noaaLocationId
    });
  if (climatology && !climatology.ok && !climatology.skipped) {
    errors.push(climatology.error ?? "NOAA climatology failed.");
  }

  const consensus = buildConsensus(
    forecastReport.location,
    group,
    forecastReport.results,
    climatology?.ok ? climatology : undefined
  );
  if (!consensus) {
    errors.push(`No forecast source returned ${group.measure} for ${group.city} on ${group.date}.`);
  }

  return {
    group: {
      eventSlug: group.eventSlug,
      eventTitle: group.eventTitle,
      eventEndDate: group.eventEndDate,
      city: group.city,
      date: group.date,
      measure: group.measure,
      marketCount: group.markets.length
    },
    markets: group.markets.map((market) => ({
      marketSlug: market.marketSlug,
      liquidity: market.liquidity,
      volume: market.volume
    })),
    location: forecastReport.location,
    sources: forecastReport.results.map((result) => ({
      source: result.source,
      provider: result.provider,
      ok: result.ok,
      skipped: result.skipped,
      note: result.note,
      error: result.error
    })),
    climatology,
    consensus,
    outcomes: consensus
      ? group.markets.map((candidate) => priceCandidate(candidate, consensus, options))
      : [],
    errors
  };
}

export function rankWeatherSignals(reports: WeatherPricingReport[]): WeatherOutcomePricing[] {
  return reports
    .flatMap((report) => report.outcomes.map((outcome) => ({
      ...outcome,
      reason: `${report.group.eventSlug}: ${outcome.reason}`
    })))
    .filter((outcome) => outcome.signal !== "SKIP")
    .sort((a, b) => (b.edge ?? -Infinity) - (a.edge ?? -Infinity));
}
