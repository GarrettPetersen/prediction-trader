import { readFile } from "node:fs/promises";
import type { AppConfig } from "./config.js";
import type {
  WeatherObservationRecord,
  WeatherPreviousRunForecastRecord,
  WeatherResolutionActualRecord
} from "./weatherDatasets.js";
import type {
  WeatherMarketCandidate,
  WeatherMarketGroup,
  WeatherMeasure
} from "./weatherMarkets.js";
import {
  fetchNoaaClimatology,
  fetchWeatherEdgeSources,
  resolveWeatherLocation,
  looksLikeHongKongLocation,
  type WeatherClimatologyReport,
  type WeatherLocation,
  type WeatherSourceId,
  type WeatherSourceResult
} from "./weatherEdge.js";
import {
  distanceKm,
  HONG_KONG_OBSERVATORY_STATION,
  resolveStationForecastTarget,
  weatherCityTargetKey,
  weatherLocationTargetKey,
  weatherStationTargetKey,
  type ParsedResolutionSource,
  type WeatherStationForecastTarget,
  type WeatherStationInfo
} from "./weatherStations.js";
import { sizeBinaryKellyBet } from "./kelly.js";
import type { WeatherTradingWindowAssessment } from "./weatherTradingWindow.js";
import {
  optimizeWeatherPortfolio,
  type WeatherPortfolioCandidate
} from "./weatherPortfolioOptimizer.js";
import {
  DEFAULT_CALIBRATION_HALF_LIFE_DAYS,
  DEFAULT_CITY_BIAS_PRIOR_WEIGHT,
  aggregateCalibratedForecast,
  buildPreviousRunForecastValueIndex,
  buildWeatherActualIndex,
  calibrateWeatherForecasts,
  calibrationBiasForTarget,
  type WeatherForecastCalibration,
  type WeatherSourceForecastValue
} from "./weatherCalibration.js";
import {
  priceWeatherMarketAnchor,
  routeWeatherHybridStrategy,
  type WeatherHybridStrategyLane
} from "./weatherMarketAnchor.js";

export interface WeatherForecastPoint {
  source: WeatherSourceId;
  provider: string;
  valueC: number;
  calibratedValueC?: number;
  sourceBiasC?: number;
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
  calibration?: {
    targetKey: string;
    mode: "historical_residuals";
    measureSamples: number;
    biasC: number;
    targetBiasC: number;
    meanAbsoluteErrorC: number;
    ignoredSources: string[];
  };
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
  strategy: WeatherTradingStrategy;
  strategyLane?: WeatherHybridStrategyLane;
  originalBestSide?: "YES" | "NO";
  originalEdge?: number;
  originalFair?: number;
  originalReferencePrice?: number;
  oppositeMarketProbability?: number;
  marketAnchorCoefficient?: number;
  reason: string;
}

export interface WeatherPricingReport {
  group: Omit<WeatherMarketGroup, "markets" | "unparsed"> & {
    marketCount: number;
  };
  markets: Array<Pick<
    WeatherMarketCandidate,
    "marketSlug" | "liquidity" | "volume" | "referencePlatform" | "parsed"
  >>;
  location: WeatherLocation;
  resolutionTarget?: WeatherPricingResolutionTarget;
  sources: Array<Pick<WeatherSourceResult, "source" | "provider" | "ok" | "skipped" | "note" | "error">>;
  climatology?: WeatherClimatologyReport;
  tradingWindow?: WeatherTradingWindowAssessment;
  consensus?: WeatherConsensus;
  outcomes: WeatherOutcomePricing[];
  errors: string[];
}

export interface WeatherPricingOptions {
  bankrollUsd?: number;
  maxPerTradeUsd?: number;
  kellyMultiplier?: number;
  maxKellyFraction?: number;
  maxGroupFraction?: number;
  portfolioStepUsd?: number;
  minEdge?: number;
  noaaYears?: number;
  skipClimatology?: boolean;
  noaaStationId?: string;
  noaaLocationId?: string;
  countryCode?: string;
  allowCityForecast?: boolean;
  skipCalibration?: boolean;
  calibrationHalfLifeDays?: number;
  cityBiasPriorWeight?: number;
  sizingStrategy?: WeatherSizingStrategy;
  strategy?: WeatherTradingStrategy;
  marketAnchor?: WeatherMarketAnchorPricingOptions;
  hybrid?: WeatherHybridPricingOptions;
}

export type WeatherSizingStrategy = "independent_kelly" | "city_portfolio";
export type WeatherTradingStrategy =
  | "forecast_edge"
  | "market_informed_inverse"
  | "market_informed_hybrid";

export interface WeatherMarketAnchorPricingOptions {
  coefficient: number;
  minOppositeMarketProbability: number;
  minExecutableEdge: number;
}

export interface WeatherHybridPricingOptions {
  normalMinMarketProbability: number;
}

export interface WeatherPricingResolutionTarget {
  matched: boolean;
  resolutionSource?: string;
  resolution: ParsedResolutionSource;
  station?: WeatherStationInfo;
  forecastLocation: Pick<WeatherLocation, "name" | "latitude" | "longitude" | "countryCode" | "country" | "admin1">;
  cityLocation?: Pick<WeatherLocation, "name" | "latitude" | "longitude" | "countryCode" | "country" | "admin1">;
  cityDistanceKm?: number;
  note?: string;
}

const BASE_WEIGHTS: Record<WeatherSourceId, number> = {
  openmeteo_ecmwf: 0.35,
  openmeteo_gfs: 0.25,
  openmeteo_ukmo: 0.2,
  nws: 0.2,
  hko: 0.5,
  noaa_ncei: 0
};

const DAY_AHEAD_SOURCES: WeatherSourceId[] = [
  "openmeteo_gfs",
  "openmeteo_ecmwf",
  "openmeteo_ukmo",
  "nws",
  "hko"
];
const CALIBRATED_DAY_AHEAD_SOURCES: WeatherSourceId[] = [
  "openmeteo_gfs",
  "openmeteo_ecmwf",
  "openmeteo_ukmo"
];
const calibrationCache = new Map<string, Promise<Map<WeatherMeasure, WeatherForecastCalibration>>>();

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

async function readJsonlRecords<T>(path: string): Promise<T[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return [];
    throw error;
  }

  return raw
    .split(/\r?\n/)
    .flatMap((line, index) => {
      const trimmed = line.trim();
      if (!trimmed) return [];
      try {
        return [JSON.parse(trimmed) as T];
      } catch (error) {
        throw new Error(`Invalid JSONL at ${path}:${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
}

async function loadHistoricalForecastCalibration(
  config: AppConfig,
  targetDate: string,
  options: Pick<WeatherPricingOptions, "calibrationHalfLifeDays" | "cityBiasPriorWeight">
): Promise<Map<WeatherMeasure, WeatherForecastCalibration>> {
  const halfLifeDays = Math.max(
    1,
    Math.trunc(options.calibrationHalfLifeDays ?? DEFAULT_CALIBRATION_HALF_LIFE_DAYS)
  );
  const cityBiasPriorWeight = Math.max(0, options.cityBiasPriorWeight ?? DEFAULT_CITY_BIAS_PRIOR_WEIGHT);
  const key = [
    targetDate,
    halfLifeDays,
    cityBiasPriorWeight,
    config.weather.datasets.observationsPath,
    config.weather.datasets.previousRunForecastsPath,
    config.weather.datasets.resolutionActualsPath
  ].join("|");
  const cached = calibrationCache.get(key);
  if (cached) return cached;

  const request = (async () => {
    const [observations, previousRuns, resolutionActuals] = await Promise.all([
      readJsonlRecords<WeatherObservationRecord>(config.weather.datasets.observationsPath),
      readJsonlRecords<WeatherPreviousRunForecastRecord>(config.weather.datasets.previousRunForecastsPath),
      readJsonlRecords<WeatherResolutionActualRecord>(config.weather.datasets.resolutionActualsPath)
    ]);
    const actualIndex = buildWeatherActualIndex(observations, resolutionActuals);
    const forecastValuesByKey = buildPreviousRunForecastValueIndex(previousRuns, {
      leadDays: 1,
      sources: CALIBRATED_DAY_AHEAD_SOURCES
    });
    return calibrateWeatherForecasts(forecastValuesByKey, actualIndex, targetDate, {
      halfLifeDays,
      cityBiasPriorWeight
    });
  })();
  calibrationCache.set(key, request);
  return request;
}

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

function currentForecastValuesForMeasure(
  sourceResults: WeatherSourceResult[],
  group: WeatherMarketGroup,
  calibration: WeatherForecastCalibration
): Array<WeatherSourceForecastValue & { provider: string }> {
  return sourceResults.flatMap((result) => {
    if (!result.ok) return [];
    if (!calibration.sourceCalibrations.has(result.source)) return [];
    const valueC = forecastValueForSource(result, group.date, group.measure);
    if (valueC === undefined) return [];
    return [{
      source: result.source,
      provider: result.provider,
      valueC
    }];
  });
}

function calibratedPricingTargetKey(
  city: string,
  location: WeatherLocation,
  target: WeatherPricingResolutionTarget | undefined
): string {
  return weatherStationTargetKey(target?.station?.id) ??
    (target?.matched ? weatherLocationTargetKey(location) : weatherCityTargetKey(city));
}

function buildCalibratedConsensus(
  location: WeatherLocation,
  group: WeatherMarketGroup,
  sourceResults: WeatherSourceResult[],
  calibrationByMeasure: Map<WeatherMeasure, WeatherForecastCalibration>,
  targetKey: string
): WeatherConsensus | undefined {
  const calibration = calibrationByMeasure.get(group.measure);
  if (!calibration || calibration.samples <= 0) return undefined;

  const values = currentForecastValuesForMeasure(sourceResults, group, calibration);
  if (values.length === 0) return undefined;

  const aggregate = aggregateCalibratedForecast(values, calibration.sourceCalibrations);
  const targetBiasC = calibrationBiasForTarget(calibration, targetKey);
  const meanC = aggregate.meanC + targetBiasC;
  const modelStdDevC = stdDev(values.map((point) => {
    const sourceCalibration = calibration.sourceCalibrations.get(point.source);
    return point.valueC + (sourceCalibration?.biasC ?? 0) + targetBiasC;
  }));
  const weightTotal = values.reduce((sum, point) => {
    const sourceCalibration = calibration.sourceCalibrations.get(point.source);
    return sum + (sourceCalibration?.ensembleWeight ?? 0);
  }, 0);
  const ignoredSources = sourceResults.flatMap((result) =>
    result.ok && forecastValueForSource(result, group.date, group.measure) !== undefined &&
      !calibration.sourceCalibrations.has(result.source)
      ? [result.source]
      : []
  );

  return {
    meanC,
    sigmaC: calibration.sigmaC,
    rawMeanC: aggregate.rawMeanC,
    modelStdDevC,
    agreement: agreementTier(modelStdDevC),
    hoursToResolution: hoursToResolution(group),
    forecastPoints: values.map((point) => {
      const sourceCalibration = calibration.sourceCalibrations.get(point.source);
      const sourceBiasC = sourceCalibration?.biasC ?? 0;
      const baseWeight = sourceCalibration?.ensembleWeight ?? 0;
      return {
        source: point.source as WeatherSourceId,
        provider: point.provider,
        valueC: point.valueC,
        calibratedValueC: point.valueC + sourceBiasC + targetBiasC,
        sourceBiasC,
        baseWeight,
        adjustedWeight: weightTotal > 0 ? baseWeight / weightTotal : 0
      };
    }),
    calibration: {
      targetKey,
      mode: "historical_residuals",
      measureSamples: calibration.samples,
      biasC: calibration.biasC,
      targetBiasC,
      meanAbsoluteErrorC: calibration.meanAbsoluteErrorC,
      ignoredSources: [...new Set(ignoredSources)].sort()
    }
  };
}

function marketPrice(candidate: WeatherMarketCandidate, outcome: "Yes" | "No"): number | undefined {
  return candidate.outcomes.find((item) => item.outcome.toLowerCase() === outcome.toLowerCase())?.price;
}

function marketToken(candidate: WeatherMarketCandidate, outcome: "Yes" | "No"): string | undefined {
  return candidate.outcomes.find((item) => item.outcome.toLowerCase() === outcome.toLowerCase())?.tokenId;
}

function marketOutcomeAsk(candidate: WeatherMarketCandidate, outcome: "Yes" | "No"): number | undefined {
  return candidate.outcomes.find((item) => item.outcome.toLowerCase() === outcome.toLowerCase())?.bestAsk;
}

function marketOutcomeBid(candidate: WeatherMarketCandidate, outcome: "Yes" | "No"): number | undefined {
  return candidate.outcomes.find((item) => item.outcome.toLowerCase() === outcome.toLowerCase())?.bestBid;
}

function validateMarketAnchorOptions(options: WeatherMarketAnchorPricingOptions): void {
  if (!Number.isFinite(options.coefficient) || options.coefficient >= 0) {
    throw new Error("Market-informed inverse pricing requires a finite negative coefficient.");
  }
  if (
    !Number.isFinite(options.minOppositeMarketProbability) ||
    options.minOppositeMarketProbability < 0 ||
    options.minOppositeMarketProbability > 1
  ) {
    throw new Error("Market-informed inverse pricing requires minOppositeMarketProbability between 0 and 1.");
  }
  if (
    !Number.isFinite(options.minExecutableEdge) ||
    options.minExecutableEdge < 0 ||
    options.minExecutableEdge > 1
  ) {
    throw new Error("Market-informed inverse pricing requires minExecutableEdge between 0 and 1.");
  }
}

function validateHybridOptions(options: WeatherHybridPricingOptions): void {
  if (
    !Number.isFinite(options.normalMinMarketProbability) ||
    options.normalMinMarketProbability < 0 ||
    options.normalMinMarketProbability > 1
  ) {
    throw new Error("Market-informed hybrid pricing requires normalMinMarketProbability between 0 and 1.");
  }
}

function compactLocation(location: WeatherLocation): WeatherPricingResolutionTarget["forecastLocation"] {
  return {
    name: location.name,
    latitude: location.latitude,
    longitude: location.longitude,
    countryCode: location.countryCode,
    country: location.country,
    admin1: location.admin1
  };
}

function looksLikeHkoText(value: string | undefined): boolean {
  return /hong\s*kong\s+observatory|\bhko\b|weather\.gov\.hk/i.test(value ?? "");
}

function looksLikeHkoSettlementGroup(group: WeatherMarketGroup): boolean {
  return looksLikeHkoText(group.eventTitle) ||
    group.markets.some((market) =>
      looksLikeHkoText(market.resolutionSource) ||
      looksLikeHkoText(market.question) ||
      looksLikeHkoText(market.description)
    );
}

function hkoForecastLocation(): WeatherLocation {
  return {
    name: "Hong Kong Observatory",
    latitude: HONG_KONG_OBSERVATORY_STATION.latitude,
    longitude: HONG_KONG_OBSERVATORY_STATION.longitude,
    timezone: "Asia/Hong_Kong",
    countryCode: "HK",
    country: "HK"
  };
}

function explicitHkoSettlementTarget(
  group: WeatherMarketGroup,
  target: WeatherStationForecastTarget
): WeatherStationForecastTarget | undefined {
  if (!looksLikeHkoSettlementGroup(group)) return undefined;
  return {
    resolutionSource: target.resolutionSource,
    resolution: target.resolution,
    station: HONG_KONG_OBSERVATORY_STATION,
    location: hkoForecastLocation(),
    matched: true,
    note: target.note
      ? `${target.note} Using Hong Kong Observatory because the market explicitly references HKO.`
      : "Using Hong Kong Observatory because the market explicitly references HKO."
  };
}

function isHkoResolutionTarget(target: WeatherPricingResolutionTarget): boolean {
  return target.station?.id.toUpperCase() === "HKO" ||
    looksLikeHkoText(target.resolutionSource);
}

export function sourcesForPricingTarget(
  target: WeatherPricingResolutionTarget,
  requestedSources?: WeatherSourceId[]
): WeatherSourceId[] {
  const sources = requestedSources ?? DAY_AHEAD_SOURCES;
  return isHkoResolutionTarget(target)
    ? sources
    : sources.filter((source) => source !== "hko");
}

function priceCandidate(
  candidate: WeatherMarketCandidate,
  consensus: WeatherConsensus,
  options: WeatherPricingOptions
): WeatherOutcomePricing {
  const forecastFairYes = probabilityInRange(
    consensus.meanC,
    consensus.sigmaC,
    candidate.parsed.outcome.lowerTempC,
    candidate.parsed.outcome.upperTempC
  );
  const forecastFairNo = 1 - forecastFairYes;
  const yesAsk = marketOutcomeAsk(candidate, "Yes") ?? candidate.bestAsk ?? marketPrice(candidate, "Yes");
  const yesBid = marketOutcomeBid(candidate, "Yes") ?? candidate.bestBid ?? marketPrice(candidate, "Yes");
  const noAsk = marketOutcomeAsk(candidate, "No") ?? marketPrice(candidate, "No") ?? (yesBid === undefined ? undefined : 1 - yesBid);
  const noBid = marketOutcomeBid(candidate, "No") ?? marketPrice(candidate, "No") ?? (yesAsk === undefined ? undefined : 1 - yesAsk);
  const yesReferencePrice = marketPrice(candidate, "Yes");
  const noReferencePrice = marketPrice(candidate, "No")
    ?? (yesReferencePrice === undefined ? undefined : 1 - yesReferencePrice);
  const threshold = dynamicEdgeThreshold(consensus.sigmaC, options.minEdge);
  const forecastYesEdge = yesAsk === undefined ? undefined : forecastFairYes - yesAsk;
  const forecastNoEdge = noAsk === undefined ? undefined : forecastFairNo - noAsk;
  const originalBest = (forecastYesEdge ?? -Infinity) >= (forecastNoEdge ?? -Infinity)
    ? {
      side: "YES" as const,
      signal: "BUY_YES" as const,
      edge: forecastYesEdge,
      price: yesAsk,
      probability: forecastFairYes,
      referencePrice: yesReferencePrice,
      oppositeReferencePrice: noReferencePrice,
      tokenId: marketToken(candidate, "Yes")
    }
    : {
      side: "NO" as const,
      signal: "BUY_NO" as const,
      edge: forecastNoEdge,
      price: noAsk,
      probability: forecastFairNo,
      referencePrice: noReferencePrice,
      oppositeReferencePrice: yesReferencePrice,
      tokenId: marketToken(candidate, "No")
    };

  const strategy = options.strategy ?? "forecast_edge";
  let fairYes = forecastFairYes;
  let fairNo = forecastFairNo;
  let yesEdge = forecastYesEdge;
  let noEdge = forecastNoEdge;
  let bestSignal = originalBest;
  let strategyGateReason: string | undefined;
  let strategyLane: WeatherHybridStrategyLane | undefined;
  let strategyLaneReason: string | undefined;
  let oppositeMarketProbability: number | undefined;
  let marketAnchorCoefficient: number | undefined;

  const applyInverseSelection = (anchoredOriginalProbability: number, selectedFair: number, edge: number) => {
    if (originalBest.side === "YES") {
      fairYes = anchoredOriginalProbability;
      fairNo = selectedFair;
      yesEdge = yesAsk === undefined ? undefined : fairYes - yesAsk;
      noEdge = edge;
      bestSignal = {
        side: "NO",
        signal: "BUY_NO",
        edge: noEdge,
        price: noAsk,
        probability: fairNo,
        referencePrice: noReferencePrice,
        oppositeReferencePrice: yesReferencePrice,
        tokenId: marketToken(candidate, "No")
      };
    } else {
      fairNo = anchoredOriginalProbability;
      fairYes = selectedFair;
      yesEdge = edge;
      noEdge = noAsk === undefined ? undefined : fairNo - noAsk;
      bestSignal = {
        side: "YES",
        signal: "BUY_YES",
        edge: yesEdge,
        price: yesAsk,
        probability: fairYes,
        referencePrice: yesReferencePrice,
        oppositeReferencePrice: noReferencePrice,
        tokenId: marketToken(candidate, "Yes")
      };
    }
  };

  if (strategy === "market_informed_inverse") {
    if (!options.marketAnchor) {
      throw new Error("market_informed_inverse pricing requires explicit marketAnchor options.");
    }
    validateMarketAnchorOptions(options.marketAnchor);
    marketAnchorCoefficient = options.marketAnchor.coefficient;
    oppositeMarketProbability = originalBest.oppositeReferencePrice;

    if (originalBest.edge === undefined || originalBest.edge < threshold) {
      strategyGateReason = `Original forecast edge ${(originalBest.edge ?? 0).toFixed(3)} is below required ${threshold.toFixed(3)}.`;
    } else if (originalBest.referencePrice === undefined || originalBest.oppositeReferencePrice === undefined) {
      strategyGateReason = "Market-informed inverse pricing requires explicit YES and NO reference prices.";
    } else if (originalBest.oppositeReferencePrice < options.marketAnchor.minOppositeMarketProbability) {
      strategyGateReason = `Opposite market probability ${originalBest.oppositeReferencePrice.toFixed(3)} is below required ${options.marketAnchor.minOppositeMarketProbability.toFixed(3)}.`;
    } else {
      if (originalBest.price === undefined) {
        strategyGateReason = "Market-informed inverse pricing requires an executable original-side price.";
      } else {
        const oppositeAsk = originalBest.side === "YES" ? noAsk : yesAsk;
        if (oppositeAsk === undefined) {
          strategyGateReason = "Market-informed inverse pricing requires an executable opposite-side price.";
        } else {
          const disagreement = originalBest.probability - originalBest.referencePrice;
          if (!(disagreement > 0)) {
            strategyGateReason = `Expected positive forecast/market disagreement; got ${disagreement.toFixed(3)}.`;
          } else {
            const anchored = priceWeatherMarketAnchor({
              coefficient: options.marketAnchor.coefficient,
              originalFair: originalBest.probability,
              originalReferencePrice: originalBest.referencePrice,
              originalExecutionPrice: originalBest.price,
              oppositeExecutionPrice: oppositeAsk
            });
            applyInverseSelection(
              anchored.anchoredOriginalProbability,
              anchored.selectedFair,
              anchored.edge
            );
            if (bestSignal.edge === undefined || bestSignal.edge < options.marketAnchor.minExecutableEdge) {
              strategyGateReason = `Inverse edge ${(bestSignal.edge ?? 0).toFixed(3)} is below executable minimum ${options.marketAnchor.minExecutableEdge.toFixed(3)}.`;
            }
          }
        }
      }
    }
  } else if (strategy === "market_informed_hybrid") {
    if (!options.marketAnchor || !options.hybrid) {
      throw new Error("market_informed_hybrid pricing requires explicit marketAnchor and hybrid options.");
    }
    validateMarketAnchorOptions(options.marketAnchor);
    validateHybridOptions(options.hybrid);
    oppositeMarketProbability = originalBest.oppositeReferencePrice;
    const oppositeAsk = originalBest.side === "YES" ? noAsk : yesAsk;
    const routed = routeWeatherHybridStrategy({
      originalSide: originalBest.side,
      originalFair: originalBest.probability,
      originalEdge: originalBest.edge,
      originalReferencePrice: originalBest.referencePrice,
      originalExecutionPrice: originalBest.price,
      oppositeReferencePrice: originalBest.oppositeReferencePrice,
      oppositeExecutionPrice: oppositeAsk,
      measure: candidate.parsed.measure,
      outcomeKind: candidate.parsed.outcome.kind,
      minOriginalEdge: threshold,
      normalMinMarketProbability: options.hybrid.normalMinMarketProbability,
      coefficient: options.marketAnchor.coefficient,
      minOppositeMarketProbability: options.marketAnchor.minOppositeMarketProbability,
      minExecutableEdge: options.marketAnchor.minExecutableEdge
    });
    strategyLane = routed.lane;
    strategyLaneReason = routed.reason;
    if (routed.lane === "abstain") {
      strategyGateReason = routed.reason;
    } else if (routed.lane === "inverse_disagreement") {
      if (
        routed.anchoredOriginalProbability === undefined ||
        routed.selectedFair === undefined ||
        routed.edge === undefined
      ) {
        throw new Error("Hybrid inverse route returned incomplete pricing.");
      }
      marketAnchorCoefficient = options.marketAnchor.coefficient;
      applyInverseSelection(
        routed.anchoredOriginalProbability,
        routed.selectedFair,
        routed.edge
      );
    }
  }

  const requiredSignalEdge = strategy === "market_informed_inverse"
    ? options.marketAnchor?.minExecutableEdge ?? Infinity
    : strategy === "market_informed_hybrid" && strategyLane === "inverse_disagreement"
      ? options.marketAnchor?.minExecutableEdge ?? Infinity
      : threshold;
  const signal = strategyGateReason === undefined && bestSignal.edge !== undefined && bestSignal.edge >= requiredSignalEdge
    ? bestSignal.signal
    : "SKIP";
  const sizing = signal === "SKIP" || bestSignal.price === undefined
    ? { kellyFraction: 0, stakeUsd: undefined }
    : sizeBinaryKellyBet(
      { probability: bestSignal.probability, price: bestSignal.price },
      {
        bankrollUsd: options.bankrollUsd,
        maxStakeUsd: options.maxPerTradeUsd,
        kellyMultiplier: options.kellyMultiplier,
        maxKellyFraction: options.maxKellyFraction
      }
    );
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
    kellyFraction: sizing.kellyFraction,
    suggestedSizeUsd: sizing.stakeUsd,
    tokenId: signal === "SKIP" ? undefined : bestSignal.tokenId,
    price: signal === "SKIP" ? undefined : bestSignal.price,
    strategy,
    strategyLane,
    originalBestSide: originalBest.side,
    originalEdge: originalBest.edge,
    originalFair: originalBest.probability,
    originalReferencePrice: originalBest.referencePrice,
    oppositeMarketProbability,
    marketAnchorCoefficient,
    reason: signal === "SKIP"
      ? strategyGateReason ?? `Best edge ${(bestSignal.edge ?? 0).toFixed(3)} is below threshold ${requiredSignalEdge.toFixed(3)}.`
      : strategy === "market_informed_inverse"
        ? `${signal} from weak market-informed inversion: original ${originalBest.side} forecast edge ${(originalBest.edge ?? 0).toFixed(3)}, coefficient ${marketAnchorCoefficient?.toFixed(2)}, inverse edge ${(bestSignal.edge ?? 0).toFixed(3)}.`
        : strategy === "market_informed_hybrid"
          ? `${strategyLaneReason} ${signal} edge ${(bestSignal.edge ?? 0).toFixed(3)}.`
        : `${signal} edge ${(bestSignal.edge ?? 0).toFixed(3)} >= threshold ${threshold.toFixed(3)}.`
  };
}

function sideForSignal(signal: WeatherOutcomePricing["signal"]): "YES" | "NO" | undefined {
  if (signal === "BUY_YES") return "YES";
  if (signal === "BUY_NO") return "NO";
  return undefined;
}

function applyCityPortfolioSizing(
  candidates: WeatherMarketCandidate[],
  outcomes: WeatherOutcomePricing[],
  consensus: WeatherConsensus,
  options: WeatherPricingOptions
): WeatherOutcomePricing[] {
  if (options.strategy === "market_informed_inverse" || options.strategy === "market_informed_hybrid") {
    return outcomes.map((outcome) => outcome.signal === "SKIP"
      ? outcome
      : {
        ...outcome,
        reason: `${outcome.reason} Sized with independent Kelly; the city/day exposure cap is enforced during execution because market-routed probabilities do not imply a coherent temperature distribution.`
      });
  }
  const optimizerInputs: WeatherPortfolioCandidate[] = outcomes.flatMap((outcome, index) => {
    const side = sideForSignal(outcome.signal);
    const market = candidates[index];
    if (!side || !market || outcome.price === undefined || outcome.edge === undefined) return [];
    return [{
      id: String(index),
      side,
      price: outcome.price,
      fair: side === "YES" ? outcome.fairYes : outcome.fairNo,
      edge: outcome.edge,
      lowerTempC: market.parsed.outcome.lowerTempC,
      upperTempC: market.parsed.outcome.upperTempC
    }];
  });

  if (optimizerInputs.length === 0) return outcomes;

  const sizes = new Map(optimizeWeatherPortfolio(
    optimizerInputs,
    { meanC: consensus.meanC, sigmaC: consensus.sigmaC },
    {
      bankrollUsd: options.bankrollUsd,
      maxStakeUsd: options.maxPerTradeUsd,
      kellyMultiplier: options.kellyMultiplier,
      maxKellyFraction: options.maxKellyFraction,
      maxPortfolioFraction: options.maxGroupFraction,
      stepUsd: options.portfolioStepUsd
    }
  ).map((size) => [size.id, size]));

  return outcomes.map((outcome, index) => {
    if (outcome.signal === "SKIP") return outcome;
    const size = sizes.get(String(index));
    if (!size || !size.stakeUsd || size.stakeUsd <= 0) {
      return {
        ...outcome,
        kellyFraction: 0,
        suggestedSizeUsd: undefined,
        reason: `${outcome.reason} City-portfolio optimizer skipped it after correlated payoff checks.`
      };
    }

    return {
      ...outcome,
      kellyFraction: size.kellyFraction,
      suggestedSizeUsd: size.stakeUsd,
      reason: `${outcome.reason} City-portfolio size ${size.stakeUsd.toFixed(2)} based on the whole ${consensus.meanC.toFixed(2)}C +/- ${consensus.sigmaC.toFixed(2)}C payoff curve.`
    };
  });
}

export async function resolvePricingForecastTarget(
  config: AppConfig,
  group: WeatherMarketGroup,
  options: WeatherPricingOptions
): Promise<{
  location: WeatherLocation;
  resolutionTarget: WeatherPricingResolutionTarget;
  strictError?: string;
}> {
  let stationTarget = await resolveStationForecastTarget(group);
  if (!stationTarget.location) {
    stationTarget = explicitHkoSettlementTarget(group, stationTarget) ?? stationTarget;
  }

  if (stationTarget.location) {
    const cityLocation = stationTarget.station?.id.toUpperCase() === "HKO"
      ? undefined
      : await resolveWeatherLocation(config, {
        city: group.city,
        countryCode: options.countryCode
      }).catch(() => undefined);
    return {
      location: stationTarget.location,
      resolutionTarget: {
        matched: true,
        resolutionSource: stationTarget.resolutionSource,
        resolution: stationTarget.resolution,
        station: stationTarget.station,
        forecastLocation: compactLocation(stationTarget.location),
        cityLocation: cityLocation ? compactLocation(cityLocation) : undefined,
        cityDistanceKm: cityLocation && stationTarget.station
          ? distanceKm(
            { latitude: cityLocation.latitude, longitude: cityLocation.longitude },
            { latitude: stationTarget.station.latitude, longitude: stationTarget.station.longitude }
          )
          : undefined,
        note: stationTarget.note ?? `Forecasting at resolution station ${stationTarget.resolution.stationId ?? stationTarget.station?.id}.`
      }
    };
  }

  const cityLocation = await resolveWeatherLocation(config, {
    city: group.city,
    countryCode: options.countryCode
  });
  const error = `Weather market ${group.eventSlug} is not station matched: ${stationTarget.note ?? "no usable resolution station"}`;
  return {
    location: cityLocation,
    resolutionTarget: {
      matched: false,
      resolutionSource: stationTarget.resolutionSource,
      resolution: stationTarget.resolution,
      forecastLocation: compactLocation(cityLocation),
      note: stationTarget.note
    },
    strictError: options.allowCityForecast ? undefined : error
  };
}

export async function priceWeatherMarketGroup(
  config: AppConfig,
  group: WeatherMarketGroup,
  options: WeatherPricingOptions = {}
): Promise<WeatherPricingReport> {
  const errors: string[] = [];
  const targetTime = Date.parse(`${group.date}T23:59:00Z`);
  const days = Number.isFinite(targetTime)
    ? clamp(Math.ceil((targetTime - Date.now()) / 86_400_000) + 1, 1, 16)
    : 7;
  const forecastTarget = await resolvePricingForecastTarget(config, group, options);
  const useCalibration = options.skipCalibration !== true;
  const sources = sourcesForPricingTarget(
    forecastTarget.resolutionTarget,
    useCalibration ? CALIBRATED_DAY_AHEAD_SOURCES : undefined
  );
  const forecastReport = forecastTarget.strictError
    ? {
      location: forecastTarget.location,
      requestedDays: days,
      sources: [],
      results: [],
      summary: { ok: 0, skipped: 0, failed: 0 }
    }
    : await fetchWeatherEdgeSources(config, {
      city: forecastTarget.location.name,
      countryCode: forecastTarget.location.countryCode ?? options.countryCode,
      latitude: forecastTarget.location.latitude,
      longitude: forecastTarget.location.longitude,
      days,
      sources
    });
  if (forecastTarget.strictError) {
    errors.push(forecastTarget.strictError);
  }
  const calibration = useCalibration && !forecastTarget.strictError
    ? await loadHistoricalForecastCalibration(config, group.date, options)
    : undefined;
  const targetKey = calibratedPricingTargetKey(group.city, forecastTarget.location, forecastTarget.resolutionTarget);
  const climatology = useCalibration || options.skipClimatology
    ? undefined
    : forecastTarget.strictError
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

  const consensus = calibration
    ? buildCalibratedConsensus(
      forecastReport.location,
      group,
      forecastReport.results,
      calibration,
      targetKey
    )
    : buildConsensus(
      forecastReport.location,
      group,
      forecastReport.results,
      climatology?.ok ? climatology : undefined
    );
  if (!consensus) {
    errors.push(useCalibration
      ? `No calibrated forecast source returned ${group.measure} for ${group.city} on ${group.date}; refresh previous-run forecast and actual datasets.`
      : `No forecast source returned ${group.measure} for ${group.city} on ${group.date}.`);
  }

  return {
    group: {
      referencePlatform: group.referencePlatform,
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
      volume: market.volume,
      referencePlatform: market.referencePlatform,
      parsed: market.parsed
    })),
    location: forecastReport.location,
    resolutionTarget: forecastTarget.resolutionTarget,
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
      ? (() => {
        const outcomes = group.markets.map((candidate) => priceCandidate(candidate, consensus, options));
        return options.sizingStrategy === "city_portfolio"
          ? applyCityPortfolioSizing(group.markets, outcomes, consensus, options)
          : outcomes;
      })()
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
