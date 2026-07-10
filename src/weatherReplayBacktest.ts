import type { AppConfig } from "./config.js";
import {
  addDaysIso,
  bestEntryPriceAtOrBefore,
  buildForecastTargetMetadataIndex,
  fetchClosedWeatherMarkets,
  fetchTokenPriceHistory,
  targetForClosedMarket,
  type ClosedWeatherMarket,
  type PricePoint
} from "./weatherBacktest.js";
import {
  appendJsonlRecordsUnique,
  readJsonlRecords,
  type WeatherObservationRecord,
  type WeatherPreviousRunForecastRecord,
  type WeatherResolutionActualRecord
} from "./weatherDatasets.js";
import type { WeatherMeasure } from "./weatherMarkets.js";
import { probabilityInRange } from "./weatherPricing.js";
import {
  assertWeatherEntryWindowMinutes,
  assessWeatherEntryWindow,
  DEFAULT_HIGH_ENTRY_END_MINUTES,
  DEFAULT_HIGH_ENTRY_START_MINUTES,
  DEFAULT_LOW_ENTRY_END_MINUTES,
  DEFAULT_LOW_ENTRY_START_MINUTES
} from "./weatherTradingWindow.js";
import {
  DEFAULT_WEATHER_CRON_HOUR_OFFSET,
  DEFAULT_WEATHER_CRON_INTERVAL_HOURS,
  DEFAULT_WEATHER_CRON_MINUTE,
  utcHourMatchesWeatherCron
} from "./weatherCronSchedule.js";
import {
  DEFAULT_CALIBRATION_HALF_LIFE_DAYS,
  DEFAULT_CITY_BIAS_PRIOR_WEIGHT,
  buildCalibratedForecastIndex,
  buildPreviousRunForecastValueIndex,
  buildWeatherActualIndex,
  calibrateWeatherForecasts,
  calibrationBiasForTarget,
  weatherForecastKey
} from "./weatherCalibration.js";
import {
  optimizeWeatherPortfolio,
  type WeatherPortfolioCandidate
} from "./weatherPortfolioOptimizer.js";

const DEFAULT_PRICE_HISTORY_PATH = "data/weather/prices/polymarket-token-price-history.jsonl";
const DEFAULT_DAY_AHEAD_SOURCES = ["openmeteo_gfs", "openmeteo_ecmwf", "openmeteo_ukmo"];

export interface WeatherReplayBacktestOptions {
  startTime: string;
  endTime?: string;
  days?: number;
  initialBankrollUsd?: number;
  minEdge?: number;
  minTradePrice?: number;
  maxPerTradeUsd?: number;
  maxBuySpendFraction?: number;
  maxGroupFraction?: number;
  targetCashReserveUsd?: number;
  sellThreshold?: number;
  settlementLagHours?: number;
  kellyMultiplier?: number;
  maxKellyFraction?: number;
  portfolioStepUsd?: number;
  maxStalenessHours?: number;
  sources?: string[];
  leadDays?: number;
  limit?: number;
  maxPages?: number;
  priceHistoryPath?: string;
  fetchPriceHistory?: boolean;
  priceHistoryConcurrency?: number;
  strictData?: boolean;
  calibrationHalfLifeDays?: number;
  cityBiasPriorWeight?: number;
  highEntryStartLocalMinutes?: number;
  highEntryEndLocalMinutes?: number;
  lowEntryStartLocalMinutes?: number;
  lowEntryEndLocalMinutes?: number;
  cronIntervalHours?: number;
  cronHourOffset?: number;
  cronMinute?: number;
}

export interface WeatherPriceHistoryRecord {
  id: string;
  source: "polymarket_clob_prices_history";
  fetchedAt: string;
  tokenId: string;
  interval: "max";
  fidelityMinutes: number;
  history: PricePoint[];
}

export type WeatherReplayEventType = "BUY" | "SELL_LOCKED" | "SETTLE";
export type WeatherReplaySide = "YES" | "NO";

export interface WeatherReplayEvent {
  type: WeatherReplayEventType;
  time: string;
  marketSlug: string;
  eventSlug: string;
  question: string;
  city: string;
  date: string;
  measure: WeatherMeasure;
  outcomeLabel: string;
  side: WeatherReplaySide;
  price?: number;
  fair?: number;
  edge?: number;
  stakeUsd?: number;
  shares?: number;
  proceedsUsd?: number;
  payoutUsd?: number;
  pnlUsd?: number;
  resolvedYes?: boolean;
  won?: boolean;
  forecastTargetKey: string;
  resolutionStationId?: string;
  entryTimezone?: string;
  priceTime?: string;
  priceAgeHours?: number;
}

export interface WeatherReplayBacktestReport {
  startTime: string;
  endTime: string;
  initialBankrollUsd: number;
  options: {
    minEdge: number;
    minTradePrice: number;
    maxPerTradeUsd: number;
    maxBuySpendFraction: number;
    maxGroupFraction: number;
    targetCashReserveUsd: number;
    sellThreshold: number;
    settlementLagHours: number;
    kellyMultiplier: number;
    maxKellyFraction: number;
    portfolioStepUsd: number;
    maxStalenessHours: number;
    leadDays: number;
    sources: string[];
    cronIntervalHours: number;
    cronHourOffset: number;
    cronMinute: number;
    highEntryStartLocalMinutes: number;
    highEntryEndLocalMinutes: number;
    lowEntryStartLocalMinutes: number;
    lowEntryEndLocalMinutes: number;
  };
  data: {
    marketStartDate: string;
    marketEndDate: string;
    closedMarkets: number;
    observations: number;
    previousRunForecasts: number;
    resolutionActuals: number;
    priceHistoryPath: string;
    priceHistoriesCached: number;
    priceHistoriesFetched: number;
    priceHistoriesMissing: number;
  };
  summary: {
    ticks: number;
    buyEvents: number;
    sellEvents: number;
    settlementEvents: number;
    openPositions: number;
    finalCashUsd: number;
    finalOpenValueUsd: number;
    finalAccountValueUsd: number;
    realizedPnlUsd: number;
    markToMarketPnlUsd: number;
    roi: number;
    maxDrawdownUsd: number;
    maxDrawdownPct: number;
    grossBoughtUsd: number;
    grossSoldUsd: number;
    grossSettledUsd: number;
    skipped: WeatherReplaySkippedCounts;
  };
  equityCurve: WeatherReplayEquityPoint[];
  events: WeatherReplayEvent[];
  openPositions: WeatherReplayOpenPosition[];
}

export interface WeatherReplaySkippedCounts {
  outsideEntryWindow: number;
  alreadyHoldingMarket: number;
  noSettlement: number;
  noForecast: number;
  noCalibration: number;
  noTimezone: number;
  noToken: number;
  noPriceHistory: number;
  staleOrInvalidPrice: number;
  belowMinEdge: number;
  belowMinTradePrice: number;
  optimizerZeroSize: number;
  cashBudgetExhausted: number;
}

export interface WeatherReplayEquityPoint {
  time: string;
  cashUsd: number;
  openValueUsd: number;
  accountValueUsd: number;
  openPositions: number;
}

export interface WeatherReplayOpenPosition {
  id: string;
  openedAt: string;
  marketSlug: string;
  eventSlug: string;
  question: string;
  city: string;
  date: string;
  measure: WeatherMeasure;
  outcomeLabel: string;
  side: WeatherReplaySide;
  shares: number;
  costUsd: number;
  averagePrice: number;
  forecastTargetKey: string;
  resolutionStationId?: string;
  eventEndDate?: string;
  entryTimezone?: string;
  settlementReadyAt?: string;
  resolvedYes: boolean;
  lastMarkedPrice?: number;
  lastMarkedAt?: string;
}

interface LoadedPriceHistories {
  histories: Map<string, PricePoint[]>;
  cached: number;
  fetched: number;
  missing: number;
}

interface ReplayPosition extends WeatherReplayOpenPosition {
  market: ClosedWeatherMarket;
}

interface ReplayCandidate {
  id: string;
  market: ClosedWeatherMarket;
  side: WeatherReplaySide;
  price: number;
  referenceYesPrice: number;
  fair: number;
  fairYes: number;
  edge: number;
  forecastMeanC: number;
  calibratedMeanC: number;
  sigmaC: number;
  targetKey: string;
  stationId?: string;
  entryTimezone?: string;
  priceTimeSec: number;
  priceAgeHours: number;
}

interface SizedReplayCandidate extends ReplayCandidate {
  stakeUsd: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function isoDateFromMs(timeMs: number): string {
  return new Date(timeMs).toISOString().slice(0, 10);
}

function assertFiniteNumber(value: number, label: string): number {
  if (!Number.isFinite(value)) throw new Error(`${label} must be finite.`);
  return value;
}

function parseTime(value: string, label: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`${label} must be a valid ISO timestamp.`);
  return parsed;
}

function defaultEndTimeMs(startTimeMs: number, days: number | undefined): number {
  return startTimeMs + Math.max(1, Math.trunc(days ?? 30)) * 86_400_000;
}

function isoDatesBetween(startDate: string, endDate: string): string[] {
  const dates: string[] = [];
  let current = startDate;
  while (current <= endDate) {
    dates.push(current);
    current = addDaysIso(current, 1);
  }
  return dates;
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
  return {
    date: `${values.year}-${values.month}-${values.day}`,
    minutesAfterMidnight: Number(values.hour) * 60 + Number(values.minute)
  };
}

function utcTimeForLocalDateTime(input: {
  date: string;
  timezone: string;
  minutesAfterMidnight: number;
}): number {
  const searchStart = Date.parse(`${input.date}T00:00:00Z`) - 36 * 3_600_000;
  const searchEnd = Date.parse(`${input.date}T23:59:00Z`) + 36 * 3_600_000;
  for (let timeMs = searchStart; timeMs <= searchEnd; timeMs += 60_000) {
    const local = localDateTimeParts(new Date(timeMs), input.timezone);
    if (
      local.date === input.date &&
      local.minutesAfterMidnight === input.minutesAfterMidnight
    ) {
      return timeMs;
    }
  }
  throw new Error(`Could not map ${input.date} ${input.minutesAfterMidnight} in ${input.timezone} to UTC.`);
}

export function settlementReadyAt(input: {
  targetDate: string;
  timezone: string | undefined;
  lagHours: number;
}): string | undefined {
  if (!input.timezone) return undefined;
  const nextLocalDate = addDaysIso(input.targetDate, 1);
  const localMidnightUtcMs = utcTimeForLocalDateTime({
    date: nextLocalDate,
    timezone: input.timezone,
    minutesAfterMidnight: 0
  });
  return new Date(localMidnightUtcMs + input.lagHours * 3_600_000).toISOString();
}

function priceHistoryId(tokenId: string): string {
  return `polymarket_price_history:${tokenId}:max:fidelity_60`;
}

function validatePriceHistoryRecord(record: WeatherPriceHistoryRecord): void {
  if (record.source !== "polymarket_clob_prices_history") {
    throw new Error(`Invalid price-history source for ${record.tokenId}: ${String(record.source)}`);
  }
  if (typeof record.tokenId !== "string" || record.tokenId.length === 0) {
    throw new Error("Invalid price-history record with missing tokenId.");
  }
  if (!Array.isArray(record.history)) {
    throw new Error(`Invalid price-history record for ${record.tokenId}: history must be an array.`);
  }
  for (const point of record.history) {
    if (!Number.isFinite(point.t) || !Number.isFinite(point.p)) {
      throw new Error(`Invalid price-history point for ${record.tokenId}.`);
    }
  }
}

async function mapWithConcurrency<T, U>(
  items: T[],
  concurrency: number,
  task: (item: T) => Promise<U>
): Promise<U[]> {
  const results = new Array<U>(items.length);
  let nextIndex = 0;
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), items.length || 1) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await task(items[index]);
    }
  }));
  return results;
}

async function readRequiredJsonlRecords<T>(path: string, label: string): Promise<T[]> {
  const records = await readJsonlRecords<T>(path);
  if (records.length === 0) {
    throw new Error(`No ${label} records found at ${path}. Generate the dataset before running replay backtests.`);
  }
  return records;
}

function sidePrice(side: WeatherReplaySide, yesPrice: number): number {
  return side === "YES" ? yesPrice : 1 - yesPrice;
}

function latestPriceAtOrBefore(history: PricePoint[], timeSec: number): { price: number; timeSec: number } | undefined {
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const point = history[index];
    if (point.t <= timeSec && point.p > 0 && point.p < 1) {
      return { price: point.p, timeSec: point.t };
    }
  }
  return undefined;
}

function currentSidePrice(
  histories: Map<string, PricePoint[]>,
  market: ClosedWeatherMarket,
  side: WeatherReplaySide,
  timeMs: number,
  maxStalenessHours?: number
): { price: number; priceTimeSec: number; ageHours: number } | undefined {
  const tokenId = market.yesTokenId;
  if (!tokenId) return undefined;
  const history = histories.get(tokenId);
  if (!history) return undefined;
  const timeSec = Math.trunc(timeMs / 1000);
  const point = maxStalenessHours === undefined
    ? latestPriceAtOrBefore(history, timeSec)
    : bestEntryPriceAtOrBefore(history, timeSec, maxStalenessHours);
  if (!point) return undefined;
  return {
    price: sidePrice(side, point.price),
    priceTimeSec: point.timeSec,
    ageHours: (timeSec - point.timeSec) / 3600
  };
}

function wonPosition(position: ReplayPosition): boolean {
  return position.side === "YES" ? position.resolvedYes : !position.resolvedYes;
}

function eventEndTimeMs(position: ReplayPosition): number | undefined {
  if (!position.settlementReadyAt) return undefined;
  const parsed = Date.parse(position.settlementReadyAt);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function initialSkippedCounts(): WeatherReplaySkippedCounts {
  return {
    outsideEntryWindow: 0,
    alreadyHoldingMarket: 0,
    noSettlement: 0,
    noForecast: 0,
    noCalibration: 0,
    noTimezone: 0,
    noToken: 0,
    noPriceHistory: 0,
    staleOrInvalidPrice: 0,
    belowMinEdge: 0,
    belowMinTradePrice: 0,
    optimizerZeroSize: 0,
    cashBudgetExhausted: 0
  };
}

function targetGroupKey(candidate: ReplayCandidate): string {
  return `${candidate.targetKey}|${candidate.market.parsed.date}|${candidate.market.parsed.measure}`;
}

function openExposureForGroup(positions: ReplayPosition[], groupKey: string): number {
  return positions
    .filter((position) =>
      `${position.forecastTargetKey}|${position.date}|${position.measure}` === groupKey
    )
    .reduce((sum, position) => sum + position.costUsd, 0);
}

function nextCronTickMs(
  startTimeMs: number,
  intervalHours: number,
  hourOffset: number,
  cronMinute: number
): number {
  const interval = Math.max(1, Math.trunc(intervalHours));
  const minute = Math.max(0, Math.min(59, Math.trunc(cronMinute)));
  const floorHour = Math.floor(startTimeMs / 3_600_000) * 3_600_000;
  for (let timeMs = floorHour - interval * 3_600_000; timeMs <= startTimeMs + interval * 3_600_000; timeMs += 3_600_000) {
    const date = new Date(timeMs);
    if (date.getUTCMinutes() !== 0) continue;
    if (!utcHourMatchesWeatherCron(date.getUTCHours(), interval, hourOffset)) continue;
    const tickMs = timeMs + minute * 60_000;
    if (tickMs >= startTimeMs) return tickMs;
  }
  throw new Error("Could not compute first replay cron tick.");
}

function replayTicks(
  startTimeMs: number,
  endTimeMs: number,
  intervalHours: number,
  hourOffset: number,
  cronMinute: number
): number[] {
  const ticks: number[] = [];
  const intervalMs = Math.max(1, Math.trunc(intervalHours)) * 3_600_000;
  for (let tick = nextCronTickMs(startTimeMs, intervalHours, hourOffset, cronMinute); tick <= endTimeMs; tick += intervalMs) {
    ticks.push(tick);
  }
  return ticks;
}

function marketCanEnterReplay(input: {
  market: ClosedWeatherMarket;
  ticks: number[];
  targetMetadata: ReturnType<typeof buildForecastTargetMetadataIndex>;
  options: RequiredReplayOptions;
}): boolean {
  if (!input.market.yesTokenId || input.market.resolvedYes === undefined || !input.market.eventEndDate) return false;
  const target = targetForClosedMarket(input.market);
  const metadata = input.targetMetadata.get(target.targetKey);
  return input.ticks.some((tickMs) =>
    assessWeatherEntryWindow({
      targetDate: input.market.parsed.date,
      measure: input.market.parsed.measure,
      timezone: metadata?.timezone,
      countryCode: metadata?.countryCode,
      country: metadata?.country,
      admin1: metadata?.admin1,
      longitude: metadata?.longitude,
      now: new Date(tickMs),
      highEntryStartMinutes: input.options.highEntryStartLocalMinutes,
      highEntryEndMinutes: input.options.highEntryEndLocalMinutes,
      lowEntryStartMinutes: input.options.lowEntryStartLocalMinutes,
      lowEntryEndMinutes: input.options.lowEntryEndLocalMinutes
    }).shouldEnter
  );
}

async function loadPriceHistories(
  tokenIds: string[],
  options: {
    path: string;
    fetchMissing: boolean;
    concurrency: number;
    strictData: boolean;
  }
): Promise<LoadedPriceHistories> {
  const existingRecords = await readJsonlRecords<WeatherPriceHistoryRecord>(options.path);
  const histories = new Map<string, PricePoint[]>();
  for (const record of existingRecords) {
    validatePriceHistoryRecord(record);
    histories.set(record.tokenId, [...record.history].sort((a, b) => a.t - b.t));
  }

  const uniqueTokenIds = [...new Set(tokenIds)].sort();
  const missingBeforeFetch = uniqueTokenIds.filter((tokenId) => !histories.has(tokenId));
  if (missingBeforeFetch.length > 0 && !options.fetchMissing && options.strictData) {
    throw new Error(
      `Missing ${missingBeforeFetch.length} Polymarket token price histories at ${options.path}. ` +
      "Rerun with --fetch-price-history to cache them explicitly."
    );
  }

  const fetchedRecords = options.fetchMissing
    ? await mapWithConcurrency(missingBeforeFetch, options.concurrency, async (tokenId) => {
      const history = await fetchTokenPriceHistory(tokenId);
      if (history.length === 0) {
        throw new Error(`Polymarket returned no price history for token ${tokenId}.`);
      }
      return {
        id: priceHistoryId(tokenId),
        source: "polymarket_clob_prices_history" as const,
        fetchedAt: new Date().toISOString(),
        tokenId,
        interval: "max" as const,
        fidelityMinutes: 60,
        history
      };
    })
    : [];

  if (fetchedRecords.length > 0) {
    await appendJsonlRecordsUnique(options.path, fetchedRecords);
    for (const record of fetchedRecords) {
      histories.set(record.tokenId, record.history);
    }
  }

  const missing = uniqueTokenIds.filter((tokenId) => !histories.has(tokenId)).length;
  return {
    histories,
    cached: uniqueTokenIds.filter((tokenId) => histories.has(tokenId)).length - fetchedRecords.length,
    fetched: fetchedRecords.length,
    missing
  };
}

function scoreCandidateAtTick(input: {
  market: ClosedWeatherMarket;
  tickMs: number;
  histories: Map<string, PricePoint[]>;
  forecastValuesByKey: Map<string, Array<{ source: string; valueC: number }>>;
  actualIndex: ReturnType<typeof buildWeatherActualIndex>;
  targetMetadata: ReturnType<typeof buildForecastTargetMetadataIndex>;
  calibrationByDate: Map<string, ReturnType<typeof calibrateWeatherForecasts>>;
  forecastIndexByDate: Map<string, ReturnType<typeof buildCalibratedForecastIndex>>;
  options: RequiredReplayOptions;
  skipped: WeatherReplaySkippedCounts;
  holdingMarketSlugs: Set<string>;
}): ReplayCandidate | undefined {
  const { market, tickMs, histories, options, skipped } = input;
  const target = targetForClosedMarket(market);
  if (input.holdingMarketSlugs.has(market.marketSlug)) {
    skipped.alreadyHoldingMarket += 1;
    return undefined;
  }
  if (!market.yesTokenId) {
    skipped.noToken += 1;
    return undefined;
  }
  if (market.resolvedYes === undefined || !market.eventEndDate) {
    skipped.noSettlement += 1;
    return undefined;
  }

  const metadata = input.targetMetadata.get(target.targetKey);
  const window = assessWeatherEntryWindow({
    targetDate: market.parsed.date,
    measure: market.parsed.measure,
    timezone: metadata?.timezone,
    countryCode: metadata?.countryCode,
    country: metadata?.country,
    admin1: metadata?.admin1,
    longitude: metadata?.longitude,
    now: new Date(tickMs),
    highEntryStartMinutes: options.highEntryStartLocalMinutes,
    highEntryEndMinutes: options.highEntryEndLocalMinutes,
    lowEntryStartMinutes: options.lowEntryStartLocalMinutes,
    lowEntryEndMinutes: options.lowEntryEndLocalMinutes
  });
  if (window.status === "timezone_unknown") {
    skipped.noTimezone += 1;
    return undefined;
  }
  if (!window.shouldEnter) {
    skipped.outsideEntryWindow += 1;
    return undefined;
  }

  const history = histories.get(market.yesTokenId);
  if (!history) {
    skipped.noPriceHistory += 1;
    return undefined;
  }
  const entry = bestEntryPriceAtOrBefore(history, Math.trunc(tickMs / 1000), options.maxStalenessHours);
  if (!entry) {
    skipped.staleOrInvalidPrice += 1;
    return undefined;
  }

  let calibration = input.calibrationByDate.get(market.parsed.date);
  let forecastIndex = input.forecastIndexByDate.get(market.parsed.date);
  if (!calibration || !forecastIndex) {
    calibration = calibrateWeatherForecasts(input.forecastValuesByKey, input.actualIndex, market.parsed.date, {
      halfLifeDays: options.calibrationHalfLifeDays,
      cityBiasPriorWeight: options.cityBiasPriorWeight
    });
    forecastIndex = buildCalibratedForecastIndex(input.forecastValuesByKey, calibration);
    input.calibrationByDate.set(market.parsed.date, calibration);
    input.forecastIndexByDate.set(market.parsed.date, forecastIndex);
  }

  const forecast = forecastIndex.get(weatherForecastKey(target.targetKey, market.parsed.date, market.parsed.measure));
  if (!forecast) {
    skipped.noForecast += 1;
    return undefined;
  }
  const calibrationForMeasure = calibration.get(market.parsed.measure);
  if (!calibrationForMeasure || calibrationForMeasure.samples <= 0) {
    skipped.noCalibration += 1;
    return undefined;
  }

  const calibratedMeanC = forecast.meanC + calibrationBiasForTarget(calibrationForMeasure, target.targetKey);
  const fairYes = probabilityInRange(
    calibratedMeanC,
    calibrationForMeasure.sigmaC,
    market.parsed.outcome.lowerTempC,
    market.parsed.outcome.upperTempC
  );
  const yesPrice = entry.price;
  const noPrice = 1 - yesPrice;
  const fairNo = 1 - fairYes;
  const yesEdge = fairYes - yesPrice;
  const noEdge = fairNo - noPrice;
  const side = yesEdge >= noEdge ? "YES" : "NO";
  const price = side === "YES" ? yesPrice : noPrice;
  const fair = side === "YES" ? fairYes : fairNo;
  const edge = side === "YES" ? yesEdge : noEdge;
  if (edge < options.minEdge) {
    skipped.belowMinEdge += 1;
    return undefined;
  }
  if (price < options.minTradePrice) {
    skipped.belowMinTradePrice += 1;
    return undefined;
  }

  return {
    id: `${market.marketSlug}|${side}|${new Date(tickMs).toISOString()}`,
    market,
    side,
    price,
    referenceYesPrice: yesPrice,
    fair,
    fairYes,
    edge,
    forecastMeanC: forecast.meanC,
    calibratedMeanC,
    sigmaC: calibrationForMeasure.sigmaC,
    targetKey: target.targetKey,
    stationId: target.stationId,
    entryTimezone: window.timezone,
    priceTimeSec: entry.timeSec,
    priceAgeHours: entry.ageHours
  };
}

interface RequiredReplayOptions {
  minEdge: number;
  minTradePrice: number;
  maxPerTradeUsd: number;
  maxBuySpendFraction: number;
  maxGroupFraction: number;
  targetCashReserveUsd: number;
  sellThreshold: number;
  settlementLagHours: number;
  kellyMultiplier: number;
  maxKellyFraction: number;
  portfolioStepUsd: number;
  maxStalenessHours: number;
  leadDays: number;
  sources: string[];
  limit: number;
  maxPages: number;
  priceHistoryPath: string;
  fetchPriceHistory: boolean;
  priceHistoryConcurrency: number;
  strictData: boolean;
  calibrationHalfLifeDays: number;
  cityBiasPriorWeight: number;
  highEntryStartLocalMinutes: number;
  highEntryEndLocalMinutes: number;
  lowEntryStartLocalMinutes: number;
  lowEntryEndLocalMinutes: number;
  cronIntervalHours: number;
  cronHourOffset: number;
  cronMinute: number;
}

function normalizeOptions(options: WeatherReplayBacktestOptions): {
  startTimeMs: number;
  endTimeMs: number;
  initialBankrollUsd: number;
  options: RequiredReplayOptions;
} {
  const startTimeMs = parseTime(options.startTime, "--start");
  const endTimeMs = options.endTime === undefined
    ? defaultEndTimeMs(startTimeMs, options.days)
    : parseTime(options.endTime, "--end");
  if (endTimeMs <= startTimeMs) throw new Error("--end must be after --start.");

  const highEntryStartLocalMinutes = options.highEntryStartLocalMinutes ?? DEFAULT_HIGH_ENTRY_START_MINUTES;
  const highEntryEndLocalMinutes = options.highEntryEndLocalMinutes ?? DEFAULT_HIGH_ENTRY_END_MINUTES;
  const lowEntryStartLocalMinutes = options.lowEntryStartLocalMinutes ?? DEFAULT_LOW_ENTRY_START_MINUTES;
  const lowEntryEndLocalMinutes = options.lowEntryEndLocalMinutes ?? DEFAULT_LOW_ENTRY_END_MINUTES;
  assertWeatherEntryWindowMinutes("temperature_high", highEntryStartLocalMinutes, highEntryEndLocalMinutes);
  assertWeatherEntryWindowMinutes("temperature_low", lowEntryStartLocalMinutes, lowEntryEndLocalMinutes);

  return {
    startTimeMs,
    endTimeMs,
    initialBankrollUsd: Math.max(0, assertFiniteNumber(options.initialBankrollUsd ?? 100, "--bankroll")),
    options: {
      minEdge: Math.max(0, assertFiniteNumber(options.minEdge ?? 0.2, "--min-edge")),
      minTradePrice: clamp(assertFiniteNumber(options.minTradePrice ?? 0.001, "--min-trade-price"), 0, 1),
      maxPerTradeUsd: Math.max(0, assertFiniteNumber(options.maxPerTradeUsd ?? 10, "--max-per-trade")),
      maxBuySpendFraction: clamp(assertFiniteNumber(options.maxBuySpendFraction ?? 1, "--max-buy-spend-fraction"), 0, 1),
      maxGroupFraction: clamp(assertFiniteNumber(options.maxGroupFraction ?? 0.25, "--max-group-fraction"), 0, 1),
      targetCashReserveUsd: Math.max(0, assertFiniteNumber(options.targetCashReserveUsd ?? 20, "--target-cash-reserve")),
      sellThreshold: clamp(assertFiniteNumber(options.sellThreshold ?? 0.99, "--sell-threshold"), 0, 1),
      settlementLagHours: Math.max(0, assertFiniteNumber(options.settlementLagHours ?? 6, "--settlement-lag-hours")),
      kellyMultiplier: clamp(assertFiniteNumber(options.kellyMultiplier ?? 0.25, "--kelly-multiplier"), 0, 1),
      maxKellyFraction: clamp(assertFiniteNumber(options.maxKellyFraction ?? 0.25, "--max-kelly-fraction"), 0, 1),
      portfolioStepUsd: Math.max(0.01, assertFiniteNumber(options.portfolioStepUsd ?? 0.5, "--portfolio-step-usd")),
      maxStalenessHours: Math.max(0.1, assertFiniteNumber(options.maxStalenessHours ?? 6, "--max-staleness-hours")),
      leadDays: Math.max(1, Math.trunc(assertFiniteNumber(options.leadDays ?? 1, "--lead-days"))),
      sources: options.sources && options.sources.length > 0 ? options.sources : DEFAULT_DAY_AHEAD_SOURCES,
      limit: Math.min(Math.max(Math.trunc(assertFiniteNumber(options.limit ?? 100, "--limit")), 1), 100),
      maxPages: Math.max(Math.trunc(assertFiniteNumber(options.maxPages ?? 20, "--max-pages")), 1),
      priceHistoryPath: options.priceHistoryPath ?? DEFAULT_PRICE_HISTORY_PATH,
      fetchPriceHistory: options.fetchPriceHistory === true,
      priceHistoryConcurrency: Math.max(1, Math.trunc(assertFiniteNumber(options.priceHistoryConcurrency ?? 5, "--price-history-concurrency"))),
      strictData: options.strictData === true,
      calibrationHalfLifeDays: Math.max(1, Math.trunc(assertFiniteNumber(options.calibrationHalfLifeDays ?? DEFAULT_CALIBRATION_HALF_LIFE_DAYS, "--calibration-half-life-days"))),
      cityBiasPriorWeight: Math.max(0, assertFiniteNumber(options.cityBiasPriorWeight ?? DEFAULT_CITY_BIAS_PRIOR_WEIGHT, "--city-bias-prior-weight")),
      highEntryStartLocalMinutes,
      highEntryEndLocalMinutes,
      lowEntryStartLocalMinutes,
      lowEntryEndLocalMinutes,
      cronIntervalHours: Math.max(1, Math.trunc(assertFiniteNumber(
        options.cronIntervalHours ?? DEFAULT_WEATHER_CRON_INTERVAL_HOURS,
        "--cron-interval-hours"
      ))),
      cronHourOffset: Math.trunc(assertFiniteNumber(
        options.cronHourOffset ?? DEFAULT_WEATHER_CRON_HOUR_OFFSET,
        "--cron-hour-offset"
      )),
      cronMinute: Math.max(0, Math.min(59, Math.trunc(assertFiniteNumber(
        options.cronMinute ?? DEFAULT_WEATHER_CRON_MINUTE,
        "--cron-minute"
      ))))
    }
  };
}

function markOpenValue(input: {
  positions: ReplayPosition[];
  histories: Map<string, PricePoint[]>;
  timeMs: number;
}): number {
  let value = 0;
  for (const position of input.positions) {
    const mark = currentSidePrice(input.histories, position.market, position.side, input.timeMs);
    if (mark) {
      position.lastMarkedPrice = mark.price;
      position.lastMarkedAt = new Date(mark.priceTimeSec * 1000).toISOString();
    }
    if (position.lastMarkedPrice === undefined) {
      throw new Error(`Cannot mark ${position.marketSlug}: no current or prior price mark is available.`);
    }
    value += position.shares * position.lastMarkedPrice;
  }
  return value;
}

function compactOpenPosition(position: ReplayPosition): WeatherReplayOpenPosition {
  const { market: _market, ...openPosition } = position;
  return openPosition;
}

function settlePositions(input: {
  positions: ReplayPosition[];
  timeMs: number;
  cashUsd: number;
  events: WeatherReplayEvent[];
}): { positions: ReplayPosition[]; cashUsd: number; grossSettledUsd: number } {
  const remaining: ReplayPosition[] = [];
  let cashUsd = input.cashUsd;
  let grossSettledUsd = 0;
  for (const position of input.positions) {
    const endMs = eventEndTimeMs(position);
    if (endMs === undefined || endMs > input.timeMs) {
      remaining.push(position);
      continue;
    }
    const won = wonPosition(position);
    const payoutUsd = won ? position.shares : 0;
    const pnlUsd = payoutUsd - position.costUsd;
    cashUsd += payoutUsd;
    grossSettledUsd += payoutUsd;
    input.events.push({
      type: "SETTLE",
      time: new Date(input.timeMs).toISOString(),
      marketSlug: position.marketSlug,
      eventSlug: position.eventSlug,
      question: position.question,
      city: position.city,
      date: position.date,
      measure: position.measure,
      outcomeLabel: position.outcomeLabel,
      side: position.side,
      payoutUsd,
      pnlUsd,
      resolvedYes: position.resolvedYes,
      won,
      forecastTargetKey: position.forecastTargetKey,
      resolutionStationId: position.resolutionStationId
    });
  }
  return { positions: remaining, cashUsd, grossSettledUsd };
}

function sellLockedPositions(input: {
  positions: ReplayPosition[];
  histories: Map<string, PricePoint[]>;
  timeMs: number;
  cashUsd: number;
  sellThreshold: number;
  maxStalenessHours: number;
  events: WeatherReplayEvent[];
}): { positions: ReplayPosition[]; cashUsd: number; grossSoldUsd: number } {
  const remaining: ReplayPosition[] = [];
  let cashUsd = input.cashUsd;
  let grossSoldUsd = 0;
  for (const position of input.positions) {
    const mark = currentSidePrice(
      input.histories,
      position.market,
      position.side,
      input.timeMs,
      input.maxStalenessHours
    );
    if (!mark || mark.price < input.sellThreshold) {
      remaining.push(position);
      continue;
    }
    const proceedsUsd = position.shares * mark.price;
    const pnlUsd = proceedsUsd - position.costUsd;
    cashUsd += proceedsUsd;
    grossSoldUsd += proceedsUsd;
    input.events.push({
      type: "SELL_LOCKED",
      time: new Date(input.timeMs).toISOString(),
      marketSlug: position.marketSlug,
      eventSlug: position.eventSlug,
      question: position.question,
      city: position.city,
      date: position.date,
      measure: position.measure,
      outcomeLabel: position.outcomeLabel,
      side: position.side,
      price: mark.price,
      shares: position.shares,
      proceedsUsd,
      pnlUsd,
      forecastTargetKey: position.forecastTargetKey,
      resolutionStationId: position.resolutionStationId,
      priceTime: new Date(mark.priceTimeSec * 1000).toISOString(),
      priceAgeHours: mark.ageHours
    });
  }
  return { positions: remaining, cashUsd, grossSoldUsd };
}

function sizeCandidates(input: {
  candidates: ReplayCandidate[];
  positions: ReplayPosition[];
  bankrollUsd: number;
  buyBudgetUsd: number;
  options: RequiredReplayOptions;
  skipped: WeatherReplaySkippedCounts;
}): SizedReplayCandidate[] {
  const byGroup = new Map<string, ReplayCandidate[]>();
  for (const candidate of input.candidates) {
    const key = targetGroupKey(candidate);
    const group = byGroup.get(key) ?? [];
    group.push(candidate);
    byGroup.set(key, group);
  }

  const sized: SizedReplayCandidate[] = [];
  for (const [key, group] of byGroup.entries()) {
    const first = group[0];
    const existingExposureUsd = openExposureForGroup(input.positions, key);
    const remainingGroupBudgetUsd = Math.max(0, input.bankrollUsd * input.options.maxGroupFraction - existingExposureUsd);
    if (remainingGroupBudgetUsd <= 0) {
      input.skipped.cashBudgetExhausted += group.length;
      continue;
    }
    const sizes = new Map(optimizeWeatherPortfolio(
      group.map((candidate): WeatherPortfolioCandidate => ({
        id: candidate.id,
        side: candidate.side,
        price: candidate.price,
        fair: candidate.fair,
        edge: candidate.edge,
        lowerTempC: candidate.market.parsed.outcome.lowerTempC,
        upperTempC: candidate.market.parsed.outcome.upperTempC
      })),
      {
        meanC: first.calibratedMeanC,
        sigmaC: first.sigmaC
      },
      {
        bankrollUsd: input.bankrollUsd,
        maxStakeUsd: Math.min(input.options.maxPerTradeUsd, remainingGroupBudgetUsd),
        kellyMultiplier: input.options.kellyMultiplier,
        maxKellyFraction: input.options.maxKellyFraction,
        maxPortfolioFraction: input.bankrollUsd > 0 ? remainingGroupBudgetUsd / input.bankrollUsd : 0,
        stepUsd: input.options.portfolioStepUsd
      }
    ).map((size) => [size.id, size]));

    for (const candidate of group) {
      const stakeUsd = sizes.get(candidate.id)?.stakeUsd ?? 0;
      if (stakeUsd <= 0) {
        input.skipped.optimizerZeroSize += 1;
        continue;
      }
      sized.push({
        ...candidate,
        stakeUsd
      });
    }
  }

  const ordered = sized.sort((a, b) => b.edge - a.edge);
  const selected: SizedReplayCandidate[] = [];
  let spentUsd = 0;
  for (const candidate of ordered) {
    const remainingBudget = input.buyBudgetUsd - spentUsd;
    if (remainingBudget <= 0) {
      input.skipped.cashBudgetExhausted += 1;
      continue;
    }
    const stakeUsd = Math.min(candidate.stakeUsd, remainingBudget);
    if (stakeUsd <= 0) {
      input.skipped.cashBudgetExhausted += 1;
      continue;
    }
    selected.push({ ...candidate, stakeUsd });
    spentUsd += stakeUsd;
  }

  return selected;
}

function buyCandidates(input: {
  candidates: SizedReplayCandidate[];
  positions: ReplayPosition[];
  timeMs: number;
  cashUsd: number;
  settlementLagHours: number;
  events: WeatherReplayEvent[];
}): { positions: ReplayPosition[]; cashUsd: number; grossBoughtUsd: number } {
  const positions = [...input.positions];
  let cashUsd = input.cashUsd;
  let grossBoughtUsd = 0;
  for (const candidate of input.candidates) {
    const stakeUsd = Math.min(candidate.stakeUsd, cashUsd);
    if (stakeUsd <= 0) continue;
    const shares = stakeUsd / candidate.price;
    const readyAt = settlementReadyAt({
      targetDate: candidate.market.parsed.date,
      timezone: candidate.entryTimezone,
      lagHours: input.settlementLagHours
    });
    if (!readyAt) {
      throw new Error(`Cannot buy ${candidate.market.marketSlug}: missing entry timezone for settlement timing.`);
    }
    cashUsd -= stakeUsd;
    grossBoughtUsd += stakeUsd;
    const position: ReplayPosition = {
      id: `${candidate.market.marketSlug}|${candidate.side}|${new Date(input.timeMs).toISOString()}`,
      openedAt: new Date(input.timeMs).toISOString(),
      marketSlug: candidate.market.marketSlug,
      eventSlug: candidate.market.eventSlug,
      question: candidate.market.question,
      city: candidate.market.parsed.city,
      date: candidate.market.parsed.date,
      measure: candidate.market.parsed.measure,
      outcomeLabel: candidate.market.parsed.outcome.label,
      side: candidate.side,
      shares,
      costUsd: stakeUsd,
      averagePrice: candidate.price,
      forecastTargetKey: candidate.targetKey,
      resolutionStationId: candidate.stationId,
      eventEndDate: candidate.market.eventEndDate,
      entryTimezone: candidate.entryTimezone,
      settlementReadyAt: readyAt,
      resolvedYes: candidate.market.resolvedYes as boolean,
      lastMarkedPrice: candidate.price,
      lastMarkedAt: new Date(candidate.priceTimeSec * 1000).toISOString(),
      market: candidate.market
    };
    positions.push(position);
    input.events.push({
      type: "BUY",
      time: new Date(input.timeMs).toISOString(),
      marketSlug: candidate.market.marketSlug,
      eventSlug: candidate.market.eventSlug,
      question: candidate.market.question,
      city: candidate.market.parsed.city,
      date: candidate.market.parsed.date,
      measure: candidate.market.parsed.measure,
      outcomeLabel: candidate.market.parsed.outcome.label,
      side: candidate.side,
      price: candidate.price,
      fair: candidate.fair,
      edge: candidate.edge,
      stakeUsd,
      shares,
      forecastTargetKey: candidate.targetKey,
      resolutionStationId: candidate.stationId,
      entryTimezone: candidate.entryTimezone,
      priceTime: new Date(candidate.priceTimeSec * 1000).toISOString(),
      priceAgeHours: candidate.priceAgeHours
    });
  }
  return { positions, cashUsd, grossBoughtUsd };
}

export async function runWeatherReplayBacktest(
  config: AppConfig,
  rawOptions: WeatherReplayBacktestOptions
): Promise<WeatherReplayBacktestReport> {
  const normalized = normalizeOptions(rawOptions);
  const options = normalized.options;
  const marketStartDate = addDaysIso(isoDateFromMs(normalized.startTimeMs), 0);
  const marketEndDate = addDaysIso(isoDateFromMs(normalized.endTimeMs), 2);
  const marketDates = isoDatesBetween(marketStartDate, marketEndDate);

  const [observations, previousRuns, resolutionActuals, marketLists] = await Promise.all([
    readRequiredJsonlRecords<WeatherObservationRecord>(config.weather.datasets.observationsPath, "weather observation"),
    readRequiredJsonlRecords<WeatherPreviousRunForecastRecord>(config.weather.datasets.previousRunForecastsPath, "Open-Meteo previous-run forecast"),
    readRequiredJsonlRecords<WeatherResolutionActualRecord>(config.weather.datasets.resolutionActualsPath, "weather resolution actual"),
    mapWithConcurrency(marketDates, 4, (date) =>
      fetchClosedWeatherMarkets(date, { limit: options.limit, maxPages: options.maxPages })
    )
  ]);
  const markets = marketLists.flat();
  if (markets.length === 0) {
    throw new Error(`No closed Polymarket weather markets found from ${marketStartDate} through ${marketEndDate}.`);
  }

  const actualIndex = buildWeatherActualIndex(observations, resolutionActuals);
  const forecastValuesByKey = buildPreviousRunForecastValueIndex(previousRuns, {
    leadDays: options.leadDays,
    sources: options.sources
  });
  const targetMetadata = buildForecastTargetMetadataIndex(previousRuns);
  const calibrationByDate = new Map<string, ReturnType<typeof calibrateWeatherForecasts>>();
  const forecastIndexByDate = new Map<string, ReturnType<typeof buildCalibratedForecastIndex>>();
  const skipped = initialSkippedCounts();
  const events: WeatherReplayEvent[] = [];
  const equityCurve: WeatherReplayEquityPoint[] = [];
  const ticks = replayTicks(
    normalized.startTimeMs,
    normalized.endTimeMs,
    options.cronIntervalHours,
    options.cronHourOffset,
    options.cronMinute
  );
  if (ticks.length === 0) {
    throw new Error("Replay produced zero cron ticks; check --start, --end, and cron options.");
  }

  const tokenIds = markets
    .filter((market) => marketCanEnterReplay({ market, ticks, targetMetadata, options }))
    .flatMap((market) => market.yesTokenId ? [market.yesTokenId] : []);
  const loadedPrices = await loadPriceHistories(tokenIds, {
    path: options.priceHistoryPath,
    fetchMissing: options.fetchPriceHistory,
    concurrency: options.priceHistoryConcurrency,
    strictData: options.strictData
  });

  let cashUsd = normalized.initialBankrollUsd;
  let positions: ReplayPosition[] = [];
  let grossBoughtUsd = 0;
  let grossSoldUsd = 0;
  let grossSettledUsd = 0;
  let peakValueUsd = normalized.initialBankrollUsd;
  let maxDrawdownUsd = 0;

  for (const tickMs of ticks) {
    const settled = settlePositions({ positions, timeMs: tickMs, cashUsd, events });
    positions = settled.positions;
    cashUsd = settled.cashUsd;
    grossSettledUsd += settled.grossSettledUsd;

    const sold = sellLockedPositions({
      positions,
      histories: loadedPrices.histories,
      timeMs: tickMs,
      cashUsd,
      sellThreshold: options.sellThreshold,
      maxStalenessHours: options.maxStalenessHours,
      events
    });
    positions = sold.positions;
    cashUsd = sold.cashUsd;
    grossSoldUsd += sold.grossSoldUsd;

    const openValueBeforeBuys = markOpenValue({ positions, histories: loadedPrices.histories, timeMs: tickMs });
    const bankrollUsd = cashUsd + openValueBeforeBuys;
    const deployableCashUsd = Math.max(0, cashUsd - options.targetCashReserveUsd);
    const buyBudgetUsd = Math.min(deployableCashUsd, bankrollUsd * options.maxBuySpendFraction);
    if (buyBudgetUsd > 0) {
      const holdingMarketSlugs = new Set(positions.map((position) => position.marketSlug));
      const candidates = markets.flatMap((market) => {
        const candidate = scoreCandidateAtTick({
          market,
          tickMs,
          histories: loadedPrices.histories,
          forecastValuesByKey,
          actualIndex,
          targetMetadata,
          calibrationByDate,
          forecastIndexByDate,
          options,
          skipped,
          holdingMarketSlugs
        });
        return candidate ? [candidate] : [];
      });
      const sized = sizeCandidates({
        candidates,
        positions,
        bankrollUsd,
        buyBudgetUsd,
        options,
        skipped
      });
      const bought = buyCandidates({
        candidates: sized,
        positions,
        timeMs: tickMs,
        cashUsd,
        settlementLagHours: options.settlementLagHours,
        events
      });
      positions = bought.positions;
      cashUsd = bought.cashUsd;
      grossBoughtUsd += bought.grossBoughtUsd;
    } else {
      skipped.cashBudgetExhausted += 1;
    }

    const openValueUsd = markOpenValue({ positions, histories: loadedPrices.histories, timeMs: tickMs });
    const accountValueUsd = cashUsd + openValueUsd;
    peakValueUsd = Math.max(peakValueUsd, accountValueUsd);
    maxDrawdownUsd = Math.max(maxDrawdownUsd, peakValueUsd - accountValueUsd);
    equityCurve.push({
      time: new Date(tickMs).toISOString(),
      cashUsd,
      openValueUsd,
      accountValueUsd,
      openPositions: positions.length
    });
  }

  const finalSettled = settlePositions({
    positions,
    timeMs: normalized.endTimeMs,
    cashUsd,
    events
  });
  positions = finalSettled.positions;
  cashUsd = finalSettled.cashUsd;
  grossSettledUsd += finalSettled.grossSettledUsd;

  const finalOpenValueUsd = markOpenValue({
    positions,
    histories: loadedPrices.histories,
    timeMs: normalized.endTimeMs
  });
  const finalAccountValueUsd = cashUsd + finalOpenValueUsd;
  const realizedPnlUsd = events.reduce((sum, event) => sum + (event.pnlUsd ?? 0), 0);
  const markToMarketPnlUsd = finalAccountValueUsd - normalized.initialBankrollUsd;

  if (options.strictData) {
    const hardSkips = skipped.noSettlement +
      skipped.noForecast +
      skipped.noCalibration +
      skipped.noTimezone +
      skipped.noToken +
      skipped.noPriceHistory +
      skipped.staleOrInvalidPrice;
    if (hardSkips > 0) {
      throw new Error(`Strict replay encountered ${hardSkips} hard data skips: ${JSON.stringify(skipped)}`);
    }
  }

  return {
    startTime: new Date(normalized.startTimeMs).toISOString(),
    endTime: new Date(normalized.endTimeMs).toISOString(),
    initialBankrollUsd: normalized.initialBankrollUsd,
    options: {
      minEdge: options.minEdge,
      minTradePrice: options.minTradePrice,
      maxPerTradeUsd: options.maxPerTradeUsd,
      maxBuySpendFraction: options.maxBuySpendFraction,
      maxGroupFraction: options.maxGroupFraction,
      targetCashReserveUsd: options.targetCashReserveUsd,
      sellThreshold: options.sellThreshold,
      settlementLagHours: options.settlementLagHours,
      kellyMultiplier: options.kellyMultiplier,
      maxKellyFraction: options.maxKellyFraction,
      portfolioStepUsd: options.portfolioStepUsd,
      maxStalenessHours: options.maxStalenessHours,
      leadDays: options.leadDays,
      sources: options.sources,
      cronIntervalHours: options.cronIntervalHours,
      cronHourOffset: options.cronHourOffset,
      cronMinute: options.cronMinute,
      highEntryStartLocalMinutes: options.highEntryStartLocalMinutes,
      highEntryEndLocalMinutes: options.highEntryEndLocalMinutes,
      lowEntryStartLocalMinutes: options.lowEntryStartLocalMinutes,
      lowEntryEndLocalMinutes: options.lowEntryEndLocalMinutes
    },
    data: {
      marketStartDate,
      marketEndDate,
      closedMarkets: markets.length,
      observations: observations.length,
      previousRunForecasts: previousRuns.length,
      resolutionActuals: resolutionActuals.length,
      priceHistoryPath: options.priceHistoryPath,
      priceHistoriesCached: loadedPrices.cached,
      priceHistoriesFetched: loadedPrices.fetched,
      priceHistoriesMissing: loadedPrices.missing
    },
    summary: {
      ticks: ticks.length,
      buyEvents: events.filter((event) => event.type === "BUY").length,
      sellEvents: events.filter((event) => event.type === "SELL_LOCKED").length,
      settlementEvents: events.filter((event) => event.type === "SETTLE").length,
      openPositions: positions.length,
      finalCashUsd: cashUsd,
      finalOpenValueUsd,
      finalAccountValueUsd,
      realizedPnlUsd,
      markToMarketPnlUsd,
      roi: normalized.initialBankrollUsd > 0 ? markToMarketPnlUsd / normalized.initialBankrollUsd : 0,
      maxDrawdownUsd,
      maxDrawdownPct: peakValueUsd > 0 ? maxDrawdownUsd / peakValueUsd : 0,
      grossBoughtUsd,
      grossSoldUsd,
      grossSettledUsd,
      skipped
    },
    equityCurve,
    events,
    openPositions: positions.map(compactOpenPosition)
  };
}
