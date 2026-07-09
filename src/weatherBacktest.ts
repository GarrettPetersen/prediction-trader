import type { AppConfig } from "./config.js";
import { parseGammaList } from "./marketplaces/polymarketData.js";
import {
  type WeatherObservationRecord,
  type WeatherPreviousRunForecastRecord,
  type WeatherResolutionActualRecord,
  readJsonlRecords
} from "./weatherDatasets.js";
import {
  parseWeatherMarketQuestion,
  resolvedYesFromGammaOutcomePrices,
  type ParsedWeatherMarket,
  type WeatherMeasure
} from "./weatherMarkets.js";
import { probabilityInRange } from "./weatherPricing.js";
import {
  parseResolutionSource,
  resolutionSourceFromText,
  weatherCityTargetKey,
  weatherStationTargetKey
} from "./weatherStations.js";
import {
  assertWeatherEntryWindowMinutes,
  DEFAULT_HIGH_ENTRY_END_MINUTES,
  DEFAULT_HIGH_ENTRY_START_MINUTES,
  DEFAULT_LOW_ENTRY_END_MINUTES,
  DEFAULT_LOW_ENTRY_START_MINUTES,
  inferWeatherTimeZone
} from "./weatherTradingWindow.js";
import {
  DEFAULT_KELLY_MULTIPLIER,
  DEFAULT_MAX_KELLY_FRACTION,
  DEFAULT_MAX_PORTFOLIO_FRACTION,
  sizeBinaryKellyPortfolio
} from "./kelly.js";
import {
  optimizeWeatherPortfolio,
  type WeatherPortfolioCandidate
} from "./weatherPortfolioOptimizer.js";
import {
  DEFAULT_CALIBRATION_HALF_LIFE_DAYS,
  DEFAULT_CITY_BIAS_PRIOR_WEIGHT,
  actualValueForMeasure,
  buildCalibratedForecastIndex,
  buildPreviousRunForecastValueIndex,
  buildWeatherActualIndex,
  calibrateWeatherForecasts,
  calibrationBiasForTarget,
  summarizeWeatherCalibrations,
  weatherForecastKey,
  weatherObservationKey
} from "./weatherCalibration.js";

const POLYMARKET_GAMMA_BASE_URL = "https://gamma-api.polymarket.com";

export interface WeatherMarketBacktestOptions {
  date: string;
  leadDays?: number;
  bankrollUsd?: number;
  minEdge?: number;
  sources?: string[];
  maxPages?: number;
  limit?: number;
  maxStalenessHours?: number;
  calibrationHalfLifeDays?: number;
  cityBiasPriorWeight?: number;
  minTradePrice?: number;
  kellyMultiplier?: number;
  maxKellyFraction?: number;
  maxPerTradeUsd?: number;
  maxPortfolioFraction?: number;
  maxGroupFraction?: number;
  portfolioStepUsd?: number;
  sizingStrategy?: WeatherBacktestSizingStrategy;
  entryMode?: WeatherBacktestEntryMode;
  highEntryStartLocalMinutes?: number;
  highEntryEndLocalMinutes?: number;
  lowEntryStartLocalMinutes?: number;
  lowEntryEndLocalMinutes?: number;
  cronIntervalHours?: number;
  cronMinute?: number;
  fillSlippage?: number;
  minExecutableEdge?: number;
}

export type WeatherBacktestSizingStrategy = "independent_kelly" | "city_portfolio";
export type WeatherBacktestEntryMode = "event_end_minus_lead" | "cron_entry_window";

export interface WeatherCalibrationSummary {
  measure: WeatherMeasure;
  samples: number;
  biasC: number;
  sigmaC: number;
  meanAbsoluteErrorC: number;
  halfLifeDays: number;
  cityBiases: number;
  sourceWeights: Record<string, number>;
  sourceBiasC: Record<string, number>;
}

export interface WeatherBacktestTrade {
  eventSlug: string;
  eventEndDate?: string;
  marketSlug: string;
  question: string;
  city: string;
  forecastTargetKey: string;
  resolutionStationId?: string;
  date: string;
  measure: WeatherMeasure;
  outcomeLabel: string;
  marketType: string;
  side: "YES" | "NO";
  referencePrice: number;
  price: number;
  fillSlippage: number;
  fair: number;
  edge: number;
  forecastMeanC: number;
  calibratedMeanC: number;
  sigmaC: number;
  actualC?: number;
  resolvedYes: boolean;
  proxyActualYes?: boolean;
  won: boolean;
  fullKellyFraction: number;
  kellyFraction: number;
  rawStakeUsd: number;
  stakeUsd: number;
  payoutUsd: number;
  pnlUsd: number;
  oppositePrice: number;
  oppositeWon: boolean;
  oppositePayoutUsd: number;
  oppositePnlUsd: number;
  decisionTime: string;
  entryMode: WeatherBacktestEntryMode;
  entryTimezone?: string;
  priceTime: string;
  priceAgeHours: number;
}

export interface WeatherMarketBacktestReport {
  date: string;
  leadDays: number;
  bankrollUsd: number;
  minEdge: number;
  strategy: string;
  calibration: WeatherCalibrationSummary[];
  summary: {
    closedEvents: number;
    binaryMarkets: number;
    skippedNoForecast: number;
    skippedNoActual: number;
    skippedNoSettlement: number;
    skippedNoPrice: number;
    skippedNoDecisionTime: number;
    scoredMarkets: number;
    candidates: number;
    wins: number;
    losses: number;
    stakeUsd: number;
    payoutUsd: number;
    pnlUsd: number;
    roi: number;
    brierScore?: number;
    candidateBrierScore?: number;
  };
  oppositeSummary: {
    wins: number;
    losses: number;
    stakeUsd: number;
    payoutUsd: number;
    pnlUsd: number;
    roi: number;
  };
  probabilityCalibration: {
    allMarkets: WeatherProbabilityCalibrationBucket[];
    candidates: WeatherProbabilityCalibrationBucket[];
  };
  breakdowns: {
    bySide: WeatherBacktestBreakdown[];
    byMarketType: WeatherBacktestBreakdown[];
    byMarketTypeAndSide: WeatherBacktestBreakdown[];
  };
  sizing: {
    method: WeatherBacktestSizingStrategy;
    kellyMultiplier: number;
    maxKellyFraction: number;
    maxPortfolioFraction: number;
    maxGroupFraction?: number;
    maxPerTradeUsd?: number;
    portfolioStepUsd?: number;
  };
  execution: {
    entryMode: WeatherBacktestEntryMode;
    fillSlippage: number;
    minExecutableEdge: number;
    cronIntervalHours?: number;
    cronMinute?: number;
    highEntryStartLocalMinutes?: number;
    highEntryEndLocalMinutes?: number;
    lowEntryStartLocalMinutes?: number;
    lowEntryEndLocalMinutes?: number;
  };
  trades: WeatherBacktestTrade[];
}

export interface WeatherProbabilityCalibrationBucket {
  bucket: string;
  count: number;
  averageProbability: number;
  actualRate: number;
  brierScore: number;
}

export interface WeatherBacktestBreakdown {
  key: string;
  tradeCount: number;
  stakeUsd: number;
  pnlUsd: number;
  roi: number | undefined;
  oppositePnlUsd: number;
  oppositeRoi: number | undefined;
}

interface ClosedWeatherMarket {
  eventSlug: string;
  eventTitle: string;
  eventEndDate?: string;
  marketSlug: string;
  question: string;
  description?: string;
  parsed: ParsedWeatherMarket;
  yesTokenId?: string;
  resolutionSource?: string;
  resolvedYes?: boolean;
}

interface PricePoint {
  t: number;
  p: number;
}

interface ForecastTargetMetadata {
  timezone?: string;
  countryCode?: string;
  country?: string;
  admin1?: string;
  longitude?: number;
}

interface BacktestDecisionTime {
  decisionTimeMs: number;
  entryMode: WeatherBacktestEntryMode;
  entryTimezone?: string;
}

interface BacktestSizingCandidate extends Omit<
  WeatherBacktestTrade,
  | "fullKellyFraction"
  | "kellyFraction"
  | "rawStakeUsd"
  | "stakeUsd"
  | "payoutUsd"
  | "pnlUsd"
  | "oppositeWon"
  | "oppositePayoutUsd"
  | "oppositePnlUsd"
> {
  lowerTempC?: number;
  upperTempC?: number;
}

interface ProbabilityScore {
  probability: number;
  actual: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function boolValue(value: unknown): boolean {
  return value === true;
}

function numberValue(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function looksLikeHkoText(value: string | undefined): boolean {
  return /hong\s*kong\s+observatory|\bhko\b|weather\.gov\.hk/i.test(value ?? "");
}

function targetForClosedMarket(market: ClosedWeatherMarket): { targetKey: string; stationId?: string } {
  const resolution = parseResolutionSource(market.resolutionSource);
  const stationId = resolution.stationId ?? (
    looksLikeHkoText(market.resolutionSource) ||
      looksLikeHkoText(market.question) ||
      looksLikeHkoText(market.eventTitle) ||
      looksLikeHkoText(market.description)
      ? "HKO"
      : undefined
  );
  const stationTarget = weatherStationTargetKey(stationId);
  return {
    targetKey: stationTarget ?? weatherCityTargetKey(market.parsed.city),
    stationId
  };
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function marketResolvesYes(parsed: ParsedWeatherMarket, actualC: number): boolean {
  const lower = parsed.outcome.lowerTempC;
  const upper = parsed.outcome.upperTempC;
  return (lower === undefined || actualC >= lower) && (upper === undefined || actualC < upper);
}

function bestEntryPriceAtOrBefore(
  history: PricePoint[],
  decisionTimeSec: number,
  maxStalenessHours: number
): { price: number; timeSec: number; ageHours: number } | undefined {
  const maxAgeSec = maxStalenessHours * 3600;
  const best = history
    .filter((point) => point.t <= decisionTimeSec && decisionTimeSec - point.t <= maxAgeSec)
    .sort((a, b) => b.t - a.t)[0];
  if (!best || best.p <= 0 || best.p >= 1) return undefined;
  return {
    price: best.p,
    timeSec: best.t,
    ageHours: (decisionTimeSec - best.t) / 3600
  };
}

function addDaysIso(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function localDateTimeParts(date: Date, timezone: string): {
  date: string;
  minutesAfterMidnight: number;
} {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const hour = Number(values.hour);
  const minute = Number(values.minute);
  return {
    date: `${values.year}-${values.month}-${values.day}`,
    minutesAfterMidnight: hour * 60 + minute
  };
}

function buildForecastTargetMetadataIndex(
  records: WeatherPreviousRunForecastRecord[]
): Map<string, ForecastTargetMetadata> {
  const index = new Map<string, ForecastTargetMetadata>();
  for (const record of records) {
    if (!record.targetKey || !record.location) continue;
    if (index.has(record.targetKey)) continue;
    index.set(record.targetKey, {
      timezone: record.location.timezone,
      countryCode: record.location.countryCode,
      country: record.location.country,
      admin1: record.location.admin1,
      longitude: record.location.longitude
    });
  }
  return index;
}

function cronEntryDecisionTimeMs(input: {
  targetDate: string;
  timezone: string;
  entryStartLocalMinutes: number;
  entryEndLocalMinutes: number;
  cronIntervalHours: number;
  cronMinute: number;
}): number | undefined {
  const entryDate = addDaysIso(input.targetDate, -1);
  const searchStart = Date.parse(`${entryDate}T00:00:00Z`) - 36 * 3_600_000;
  const searchEnd = Date.parse(`${input.targetDate}T23:59:00Z`) + 36 * 3_600_000;
  const candidates: number[] = [];
  const interval = Math.max(1, Math.trunc(input.cronIntervalHours));
  const minute = Math.max(0, Math.min(59, Math.trunc(input.cronMinute)));

  for (let t = searchStart; t <= searchEnd; t += 3_600_000) {
    const date = new Date(t);
    if (date.getUTCMinutes() !== 0) continue;
    if (date.getUTCHours() % interval !== 0) continue;
    const tick = t + minute * 60_000;
    const local = localDateTimeParts(new Date(tick), input.timezone);
    if (
      local.date === entryDate &&
      local.minutesAfterMidnight >= input.entryStartLocalMinutes &&
      local.minutesAfterMidnight <= input.entryEndLocalMinutes
    ) {
      candidates.push(tick);
    }
  }

  return candidates.sort((a, b) => a - b)[0];
}

function backtestDecisionTime(input: {
  market: ClosedWeatherMarket;
  target: { targetKey: string };
  leadDays: number;
  entryMode: WeatherBacktestEntryMode;
  targetMetadata: Map<string, ForecastTargetMetadata>;
  highEntryStartLocalMinutes: number;
  highEntryEndLocalMinutes: number;
  lowEntryStartLocalMinutes: number;
  lowEntryEndLocalMinutes: number;
  cronIntervalHours: number;
  cronMinute: number;
}): BacktestDecisionTime | undefined {
  if (input.entryMode === "event_end_minus_lead") {
    if (!input.market.eventEndDate) return undefined;
    const decisionTimeMs = Date.parse(input.market.eventEndDate) - input.leadDays * 86_400_000;
    return Number.isFinite(decisionTimeMs)
      ? { decisionTimeMs, entryMode: input.entryMode }
      : undefined;
  }

  const metadata = input.targetMetadata.get(input.target.targetKey);
  const timezone = inferWeatherTimeZone(metadata ?? {});
  if (!timezone) return undefined;
  const isLowMarket = input.market.parsed.measure === "temperature_low";
  const decisionTimeMs = cronEntryDecisionTimeMs({
    targetDate: input.market.parsed.date,
    timezone,
    entryStartLocalMinutes: isLowMarket ? input.lowEntryStartLocalMinutes : input.highEntryStartLocalMinutes,
    entryEndLocalMinutes: isLowMarket ? input.lowEntryEndLocalMinutes : input.highEntryEndLocalMinutes,
    cronIntervalHours: input.cronIntervalHours,
    cronMinute: input.cronMinute
  });
  return decisionTimeMs === undefined
    ? undefined
    : { decisionTimeMs, entryMode: input.entryMode, entryTimezone: timezone };
}

async function fetchJson(url: URL): Promise<unknown> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${(await response.text()).replace(/\s+/g, " ").slice(0, 240)}`);
  }
  return response.json();
}

async function fetchClosedWeatherMarkets(date: string, options: { limit: number; maxPages: number }): Promise<ClosedWeatherMarket[]> {
  const markets: ClosedWeatherMarket[] = [];
  const seenMarketKeys = new Set<string>();
  let sawTargetDate = false;

  for (let page = 0; page < options.maxPages; page += 1) {
    const url = new URL("/events", POLYMARKET_GAMMA_BASE_URL);
    url.searchParams.set("tag_slug", "weather");
    url.searchParams.set("closed", "true");
    url.searchParams.set("limit", String(options.limit));
    url.searchParams.set("offset", String(page * options.limit));
    url.searchParams.set("order", "endDate");
    url.searchParams.set("ascending", "false");

    const raw = await fetchJson(url);
    if (!Array.isArray(raw) || raw.length === 0) break;
    let pageHasOnlyOlderEvents = true;

    for (const eventRaw of raw) {
      if (!isRecord(eventRaw)) continue;
      const eventEndDate = stringValue(eventRaw.endDate);
      const eventDate = eventEndDate?.slice(0, 10);
      if (eventDate && eventDate >= date) pageHasOnlyOlderEvents = false;
      if (eventDate !== date) continue;
      sawTargetDate = true;

      for (const marketRaw of Array.isArray(eventRaw.markets) ? eventRaw.markets : []) {
        if (!isRecord(marketRaw)) continue;
        const question = stringValue(marketRaw.question);
        const marketSlug = stringValue(marketRaw.slug);
        if (!question || !marketSlug) continue;
        const parsed = parseWeatherMarketQuestion(question, eventEndDate);
        if (!parsed || parsed.date !== date) continue;
        const outcomes = parseGammaList(marketRaw.outcomes);
        const tokenIds = parseGammaList(marketRaw.clobTokenIds);
        const yesIndex = outcomes.findIndex((outcome) => outcome.toLowerCase() === "yes");
        const eventSlug = stringValue(eventRaw.slug) ?? "";
        const marketKey = `${eventSlug}|${marketSlug}`;
        if (seenMarketKeys.has(marketKey)) continue;
        seenMarketKeys.add(marketKey);

        markets.push({
          eventSlug,
          eventTitle: stringValue(eventRaw.title) ?? "",
          eventEndDate,
          marketSlug,
          question,
          description: stringValue(marketRaw.description) ?? stringValue(eventRaw.description),
          parsed,
          yesTokenId: yesIndex >= 0 ? tokenIds[yesIndex] : undefined,
          resolutionSource: stringValue(marketRaw.resolutionSource) ??
            resolutionSourceFromText(stringValue(marketRaw.description) ?? stringValue(eventRaw.description)),
          resolvedYes: resolvedYesFromGammaOutcomePrices(marketRaw.outcomes, marketRaw.outcomePrices)
        });
      }
    }

    if (sawTargetDate && pageHasOnlyOlderEvents) break;
  }

  return markets;
}

async function fetchTokenPriceHistory(tokenId: string): Promise<PricePoint[]> {
  const url = new URL("/prices-history", "https://clob.polymarket.com");
  url.searchParams.set("market", tokenId);
  url.searchParams.set("interval", "max");
  url.searchParams.set("fidelity", "60");
  const raw = await fetchJson(url);
  const history = isRecord(raw) && Array.isArray(raw.history) ? raw.history : [];
  return history.flatMap((point) => {
    if (!isRecord(point)) return [];
    const t = numberValue(point.t);
    const p = numberValue(point.p);
    if (t === undefined || p === undefined) return [];
    return [{ t, p }];
  }).sort((a, b) => a.t - b.t);
}

function brierScore(items: Array<{ probability: number; actual: boolean }>): number | undefined {
  if (items.length === 0) return undefined;
  return mean(items.map((item) => (item.probability - (item.actual ? 1 : 0)) ** 2));
}

function marketType(parsed: ParsedWeatherMarket): string {
  return `${parsed.measure}:${parsed.outcome.kind}:${parsed.outcome.unit}`;
}

function probabilityBucket(probability: number): string {
  const lower = Math.min(0.9, Math.max(0, Math.floor(probability * 10) / 10));
  const upper = lower + 0.1;
  return `${lower.toFixed(1)}-${upper.toFixed(1)}`;
}

function probabilityCalibrationBuckets(items: ProbabilityScore[]): WeatherProbabilityCalibrationBucket[] {
  const buckets = new Map<string, ProbabilityScore[]>();
  for (const item of items) {
    const key = probabilityBucket(item.probability);
    const bucket = buckets.get(key) ?? [];
    bucket.push(item);
    buckets.set(key, bucket);
  }

  return [...buckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([bucket, scores]) => ({
      bucket,
      count: scores.length,
      averageProbability: mean(scores.map((score) => score.probability)),
      actualRate: scores.filter((score) => score.actual).length / scores.length,
      brierScore: brierScore(scores) ?? 0
    }));
}

export function oppositeWeatherBacktestEntryPrice(input: {
  side: "YES" | "NO";
  yesPrice: number;
  noPrice: number;
}): number {
  return input.side === "YES" ? input.noPrice : input.yesPrice;
}

function tradeBreakdowns(
  trades: WeatherBacktestTrade[],
  keyForTrade: (trade: WeatherBacktestTrade) => string
): WeatherBacktestBreakdown[] {
  const buckets = new Map<string, WeatherBacktestTrade[]>();
  for (const trade of trades) {
    const key = keyForTrade(trade);
    const bucket = buckets.get(key) ?? [];
    bucket.push(trade);
    buckets.set(key, bucket);
  }

  return [...buckets.entries()]
    .map(([key, bucket]) => {
      const stakeUsd = bucket.reduce((sum, trade) => sum + trade.stakeUsd, 0);
      const pnlUsd = bucket.reduce((sum, trade) => sum + trade.pnlUsd, 0);
      const oppositePnlUsd = bucket.reduce((sum, trade) => sum + trade.oppositePnlUsd, 0);
      return {
        key,
        tradeCount: bucket.length,
        stakeUsd,
        pnlUsd,
        roi: stakeUsd > 0 ? pnlUsd / stakeUsd : undefined,
        oppositePnlUsd,
        oppositeRoi: stakeUsd > 0 ? oppositePnlUsd / stakeUsd : undefined
      };
    })
    .sort((a, b) => a.pnlUsd - b.pnlUsd);
}

async function mapWithConcurrency<T, U>(
  items: T[],
  concurrency: number,
  task: (item: T) => Promise<U>
): Promise<U[]> {
  const results = new Array<U>(items.length);
  let nextIndex = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length || 1) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await task(items[index]);
    }
  }));
  return results;
}

export async function runWeatherMarketBacktest(
  config: AppConfig,
  options: WeatherMarketBacktestOptions
): Promise<WeatherMarketBacktestReport> {
  const leadDays = Math.max(1, Math.trunc(options.leadDays ?? 1));
  const bankrollUsd = options.bankrollUsd ?? 100;
  const minEdge = options.minEdge ?? 0.05;
  const sources = options.sources && options.sources.length > 0
    ? options.sources
    : ["openmeteo_gfs", "openmeteo_ecmwf", "openmeteo_ukmo"];
  const maxStalenessHours = options.maxStalenessHours ?? 12;
  const minTradePrice = Math.max(0, Math.min(1, options.minTradePrice ?? 0));
  const kellyMultiplier = Math.max(0, Math.min(1, options.kellyMultiplier ?? DEFAULT_KELLY_MULTIPLIER));
  const maxKellyFraction = Math.max(0, Math.min(1, options.maxKellyFraction ?? DEFAULT_MAX_KELLY_FRACTION));
  const maxPortfolioFraction = Math.max(0, Math.min(1, options.maxPortfolioFraction ?? DEFAULT_MAX_PORTFOLIO_FRACTION));
  const maxGroupFraction = options.maxGroupFraction === undefined
    ? maxPortfolioFraction
    : Math.max(0, Math.min(1, options.maxGroupFraction));
  const portfolioStepUsd = options.portfolioStepUsd === undefined
    ? undefined
    : Math.max(0.01, options.portfolioStepUsd);
  const sizingStrategy = options.sizingStrategy ?? "independent_kelly";
  const entryMode = options.entryMode ?? "event_end_minus_lead";
  const highEntryStartLocalMinutes = options.highEntryStartLocalMinutes ?? DEFAULT_HIGH_ENTRY_START_MINUTES;
  const highEntryEndLocalMinutes = options.highEntryEndLocalMinutes ?? DEFAULT_HIGH_ENTRY_END_MINUTES;
  const lowEntryStartLocalMinutes = options.lowEntryStartLocalMinutes ?? DEFAULT_LOW_ENTRY_START_MINUTES;
  const lowEntryEndLocalMinutes = options.lowEntryEndLocalMinutes ?? DEFAULT_LOW_ENTRY_END_MINUTES;
  assertWeatherEntryWindowMinutes("temperature_high", highEntryStartLocalMinutes, highEntryEndLocalMinutes);
  assertWeatherEntryWindowMinutes("temperature_low", lowEntryStartLocalMinutes, lowEntryEndLocalMinutes);
  const cronIntervalHours = Math.max(1, Math.trunc(options.cronIntervalHours ?? 3));
  const cronMinute = Math.max(0, Math.min(59, Math.trunc(options.cronMinute ?? 17)));
  const fillSlippage = Math.max(0, options.fillSlippage ?? 0);
  const minExecutableEdge = Math.max(0, options.minExecutableEdge ?? 0);
  const maxPerTradeUsd = options.maxPerTradeUsd === undefined
    ? undefined
    : Math.max(0, options.maxPerTradeUsd);
  const calibrationHalfLifeDays = Math.max(
    1,
    Math.trunc(options.calibrationHalfLifeDays ?? DEFAULT_CALIBRATION_HALF_LIFE_DAYS)
  );
  const cityBiasPriorWeight = Math.max(0, options.cityBiasPriorWeight ?? DEFAULT_CITY_BIAS_PRIOR_WEIGHT);

  const [observations, previousRuns, resolutionActuals, markets] = await Promise.all([
    readJsonlRecords<WeatherObservationRecord>(config.weather.datasets.observationsPath),
    readJsonlRecords<WeatherPreviousRunForecastRecord>(config.weather.datasets.previousRunForecastsPath),
    readJsonlRecords<WeatherResolutionActualRecord>(config.weather.datasets.resolutionActualsPath),
    fetchClosedWeatherMarkets(options.date, {
      limit: Math.min(Math.max(Math.trunc(options.limit ?? 100), 1), 100),
      maxPages: Math.max(Math.trunc(options.maxPages ?? 20), 1)
    })
  ]);
  const actualIndex = buildWeatherActualIndex(observations, resolutionActuals);
  const forecastValuesByKey = buildPreviousRunForecastValueIndex(previousRuns, { leadDays, sources });
  const targetMetadata = buildForecastTargetMetadataIndex(previousRuns);
  const calibration = calibrateWeatherForecasts(forecastValuesByKey, actualIndex, options.date, {
    halfLifeDays: calibrationHalfLifeDays,
    cityBiasPriorWeight
  });
  const forecastIndex = buildCalibratedForecastIndex(forecastValuesByKey, calibration);
  const candidates: BacktestSizingCandidate[] = [];
  const scoredMarkets: ProbabilityScore[] = [];
  const candidateScores: ProbabilityScore[] = [];

  let skippedNoForecast = 0;
  let skippedNoActual = 0;
  let skippedNoSettlement = 0;
  let skippedNoPrice = 0;
  let skippedNoDecisionTime = 0;

  const priceEntries = await mapWithConcurrency(markets, 20, async (market) => {
    const target = targetForClosedMarket(market);
    if (!market.yesTokenId) return { market, target };
    const decision = backtestDecisionTime({
      market,
      target,
      leadDays,
      entryMode,
      targetMetadata,
      highEntryStartLocalMinutes,
      highEntryEndLocalMinutes,
      lowEntryStartLocalMinutes,
      lowEntryEndLocalMinutes,
      cronIntervalHours,
      cronMinute
    });
    if (!decision) return { market, target };
    try {
      const history = await fetchTokenPriceHistory(market.yesTokenId);
      return {
        market,
        target,
        entry: bestEntryPriceAtOrBefore(history, Math.trunc(decision.decisionTimeMs / 1000), maxStalenessHours),
        decision
      };
    } catch {
      return { market, target, decision };
    }
  });

  for (const { market, target, entry, decision } of priceEntries) {
    const parsed = market.parsed;
    const forecast = forecastIndex.get(weatherForecastKey(target.targetKey, parsed.date, parsed.measure));
    if (!forecast) {
      skippedNoForecast += 1;
      continue;
    }
    const actualC = actualValueForMeasure(
      actualIndex.get(weatherObservationKey(target.targetKey, parsed.date)),
      parsed.measure
    );
    if (actualC === undefined) skippedNoActual += 1;
    if (!decision) {
      skippedNoDecisionTime += 1;
      continue;
    }
    if (!entry) {
      skippedNoPrice += 1;
      continue;
    }
    const resolvedYes = market.resolvedYes;
    if (resolvedYes === undefined) {
      skippedNoSettlement += 1;
      continue;
    }

    const calibrationForMeasure = calibration.get(parsed.measure);
    if (!calibrationForMeasure) {
      skippedNoForecast += 1;
      continue;
    }
    const calibratedMeanC = forecast.meanC + calibrationBiasForTarget(calibrationForMeasure, target.targetKey);
    const fairYes = probabilityInRange(
      calibratedMeanC,
      calibrationForMeasure.sigmaC,
      parsed.outcome.lowerTempC,
      parsed.outcome.upperTempC
    );
    const referenceYesPrice = entry.price;
    const yesPrice = clamp(referenceYesPrice + fillSlippage, 0.001, 0.999);
    const noPrice = clamp(1 - referenceYesPrice + fillSlippage, 0.001, 0.999);
    const yesEdge = fairYes - yesPrice;
    const fairNo = 1 - fairYes;
    const noEdge = fairNo - noPrice;
    const side = yesEdge >= noEdge ? "YES" : "NO";
    const edge = side === "YES" ? yesEdge : noEdge;
    const proxyActualYes = actualC === undefined ? undefined : marketResolvesYes(parsed, actualC);
    scoredMarkets.push({ probability: fairYes, actual: resolvedYes });
    const price = side === "YES" ? yesPrice : noPrice;
    const inversePrice = oppositeWeatherBacktestEntryPrice({ side, yesPrice, noPrice });
    if (edge < minEdge || edge < minExecutableEdge || price < minTradePrice) continue;

    const won = side === "YES" ? resolvedYes : !resolvedYes;
    const fair = side === "YES" ? fairYes : fairNo;
    candidateScores.push({ probability: fair, actual: won });
    candidates.push({
      eventSlug: market.eventSlug,
      eventEndDate: market.eventEndDate,
      marketSlug: market.marketSlug,
      question: market.question,
      city: parsed.city,
      forecastTargetKey: target.targetKey,
      resolutionStationId: target.stationId,
      date: parsed.date,
      measure: parsed.measure,
      outcomeLabel: parsed.outcome.label,
      marketType: marketType(parsed),
      side,
      referencePrice: side === "YES" ? referenceYesPrice : 1 - referenceYesPrice,
      price,
      oppositePrice: inversePrice,
      fillSlippage,
      fair,
      edge,
      forecastMeanC: forecast.meanC,
      calibratedMeanC,
      sigmaC: calibrationForMeasure.sigmaC,
      lowerTempC: parsed.outcome.lowerTempC,
      upperTempC: parsed.outcome.upperTempC,
      actualC,
      resolvedYes,
      proxyActualYes,
      won,
      decisionTime: new Date(decision.decisionTimeMs).toISOString(),
      entryMode: decision.entryMode,
      entryTimezone: decision.entryTimezone,
      priceTime: new Date(entry.timeSec * 1000).toISOString(),
      priceAgeHours: entry.ageHours
    });
  }

  const sizes = (() => {
    if (sizingStrategy === "independent_kelly") {
      return sizeBinaryKellyPortfolio(
        candidates.map((trade, index) => ({
          id: String(index),
          probability: trade.fair,
          price: trade.price
        })),
        {
          bankrollUsd,
          kellyMultiplier,
          maxKellyFraction,
          maxStakeUsd: maxPerTradeUsd,
          maxPortfolioFraction
        }
      );
    }

    const byGroup = new Map<string, Array<{ candidate: BacktestSizingCandidate; index: number }>>();
    for (const [index, candidate] of candidates.entries()) {
      const key = `${candidate.forecastTargetKey}|${candidate.date}|${candidate.measure}`;
      const group = byGroup.get(key) ?? [];
      group.push({ candidate, index });
      byGroup.set(key, group);
    }

    const sizeByIndex = new Map<number, {
      fullKellyFraction: number;
      kellyFraction: number;
      rawStakeUsd: number;
      stakeUsd?: number;
    }>();
    for (const group of byGroup.values()) {
      const first = group[0].candidate;
      const optimized = optimizeWeatherPortfolio(
        group.map(({ candidate, index }): WeatherPortfolioCandidate => ({
          id: String(index),
          side: candidate.side,
          price: candidate.price,
          fair: candidate.fair,
          edge: candidate.edge,
          lowerTempC: candidate.lowerTempC,
          upperTempC: candidate.upperTempC
        })),
        {
          meanC: first.calibratedMeanC,
          sigmaC: first.sigmaC
        },
        {
          bankrollUsd,
          kellyMultiplier,
          maxKellyFraction,
          maxStakeUsd: maxPerTradeUsd,
          maxPortfolioFraction: maxGroupFraction,
          stepUsd: portfolioStepUsd
        }
      );
      for (const size of optimized) {
        sizeByIndex.set(Number(size.id), size);
      }
    }

    const totalStakeUsd = [...sizeByIndex.values()].reduce((sum, size) => sum + (size.stakeUsd ?? 0), 0);
    const maxPortfolioStakeUsd = bankrollUsd * maxPortfolioFraction;
    const scale = totalStakeUsd > maxPortfolioStakeUsd && totalStakeUsd > 0
      ? maxPortfolioStakeUsd / totalStakeUsd
      : 1;

    return candidates.map((_candidate, index) => {
      const size = sizeByIndex.get(index);
      const stakeUsd = (size?.stakeUsd ?? 0) * scale;
      return {
        id: String(index),
        probability: candidates[index].fair,
        price: candidates[index].price,
        fullKellyFraction: size?.fullKellyFraction ?? 0,
        kellyFraction: bankrollUsd > 0 ? stakeUsd / bankrollUsd : 0,
        rawStakeUsd: size?.rawStakeUsd ?? 0,
        stakeUsd: stakeUsd > 0 ? stakeUsd : undefined
      };
    });
  })();
  const trades = candidates.map((candidate, index) => {
    const { lowerTempC: _lowerTempC, upperTempC: _upperTempC, ...trade } = candidate;
    const sizing = sizes[index];
    const stakeUsd = sizing?.stakeUsd ?? 0;
    const payoutUsd = trade.won ? stakeUsd / trade.price : 0;
    const oppositeWon = !trade.won;
    const oppositePayoutUsd = oppositeWon ? stakeUsd / trade.oppositePrice : 0;
    return {
      ...trade,
      fullKellyFraction: sizing?.fullKellyFraction ?? 0,
      kellyFraction: sizing?.kellyFraction ?? 0,
      rawStakeUsd: sizing?.rawStakeUsd ?? 0,
      stakeUsd,
      payoutUsd,
      pnlUsd: payoutUsd - stakeUsd,
      oppositeWon,
      oppositePayoutUsd,
      oppositePnlUsd: oppositePayoutUsd - stakeUsd
    };
  }).filter((trade) => trade.stakeUsd > 0)
    .sort((a, b) => b.edge - a.edge);
  const payoutUsd = trades.reduce((sum, trade) => sum + trade.payoutUsd, 0);
  const totalStakeUsd = trades.reduce((sum, trade) => sum + trade.stakeUsd, 0);
  const pnlUsd = payoutUsd - totalStakeUsd;
  const oppositePayoutUsd = trades.reduce((sum, trade) => sum + trade.oppositePayoutUsd, 0);
  const oppositePnlUsd = oppositePayoutUsd - totalStakeUsd;

  return {
    date: options.date,
    leadDays,
    bankrollUsd,
    minEdge,
    strategy: sizingStrategy === "city_portfolio"
      ? "Estimate fair probabilities from calibrated day-ahead Open-Meteo previous-run forecasts; buy positive-edge YES/NO sides, then optimize each city/date/measure bundle over its full temperature payoff curve before applying group and daily portfolio caps."
      : "For each resolved Polymarket weather binary, estimate fair probability from calibrated day-ahead Open-Meteo previous-run forecasts; buy the better YES/NO side when edge >= minEdge; size candidates with fractional Kelly, cap each trade, and scale the day if total suggested risk exceeds the portfolio cap.",
    calibration: summarizeWeatherCalibrations(calibration),
    summary: {
      closedEvents: new Set(markets.map((market) => market.eventSlug)).size,
      binaryMarkets: markets.length,
      skippedNoForecast,
      skippedNoActual,
      skippedNoSettlement,
      skippedNoPrice,
      skippedNoDecisionTime,
      scoredMarkets: scoredMarkets.length,
      candidates: trades.length,
      wins: trades.filter((trade) => trade.won).length,
      losses: trades.filter((trade) => !trade.won).length,
      stakeUsd: totalStakeUsd,
      payoutUsd,
      pnlUsd,
      roi: bankrollUsd > 0 ? pnlUsd / bankrollUsd : 0,
      brierScore: brierScore(scoredMarkets),
      candidateBrierScore: brierScore(candidateScores)
    },
    oppositeSummary: {
      wins: trades.filter((trade) => trade.oppositeWon).length,
      losses: trades.filter((trade) => !trade.oppositeWon).length,
      stakeUsd: totalStakeUsd,
      payoutUsd: oppositePayoutUsd,
      pnlUsd: oppositePnlUsd,
      roi: bankrollUsd > 0 ? oppositePnlUsd / bankrollUsd : 0
    },
    probabilityCalibration: {
      allMarkets: probabilityCalibrationBuckets(scoredMarkets),
      candidates: probabilityCalibrationBuckets(candidateScores)
    },
    breakdowns: {
      bySide: tradeBreakdowns(trades, (trade) => trade.side),
      byMarketType: tradeBreakdowns(trades, (trade) => trade.marketType),
      byMarketTypeAndSide: tradeBreakdowns(trades, (trade) => `${trade.marketType}|${trade.side}`)
    },
    sizing: {
      method: sizingStrategy,
      kellyMultiplier,
      maxKellyFraction,
      maxPortfolioFraction,
      maxGroupFraction: sizingStrategy === "city_portfolio" ? maxGroupFraction : undefined,
      maxPerTradeUsd,
      portfolioStepUsd: sizingStrategy === "city_portfolio" ? portfolioStepUsd : undefined
    },
    execution: {
      entryMode,
      fillSlippage,
      minExecutableEdge,
      cronIntervalHours: entryMode === "cron_entry_window" ? cronIntervalHours : undefined,
      cronMinute: entryMode === "cron_entry_window" ? cronMinute : undefined,
      highEntryStartLocalMinutes: entryMode === "cron_entry_window" ? highEntryStartLocalMinutes : undefined,
      highEntryEndLocalMinutes: entryMode === "cron_entry_window" ? highEntryEndLocalMinutes : undefined,
      lowEntryStartLocalMinutes: entryMode === "cron_entry_window" ? lowEntryStartLocalMinutes : undefined,
      lowEntryEndLocalMinutes: entryMode === "cron_entry_window" ? lowEntryEndLocalMinutes : undefined
    },
    trades
  };
}
