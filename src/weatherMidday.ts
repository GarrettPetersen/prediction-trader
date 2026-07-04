import type { AppConfig } from "./config.js";
import { sizeBinaryKellyBet } from "./kelly.js";
import {
  getVistadexEvent,
  getVistadexPositions,
  type VistadexPosition
} from "./marketplaces/vistadex.js";
import {
  fetchWeatherEdgeSources,
  type WeatherLocation,
  type WeatherSourceId,
  type WeatherSourceResult
} from "./weatherEdge.js";
import {
  parseWeatherMarketQuestion,
  type WeatherMarketCandidate,
  type WeatherMarketGroup,
  type WeatherMeasure
} from "./weatherMarkets.js";
import {
  calculateBaseSigma,
  probabilityInRange
} from "./weatherPricing.js";
import {
  resolveStationForecastTarget,
  type WeatherStationForecastTarget,
  type WeatherStationInfo
} from "./weatherStations.js";

const DEFAULT_MIDDAY_SOURCES: WeatherSourceId[] = [
  "openmeteo_ecmwf",
  "openmeteo_gfs",
  "openmeteo_ukmo",
  "nws",
  "hko"
];

const MIDDAY_SOURCE_WEIGHTS: Partial<Record<WeatherSourceId, number>> = {
  openmeteo_ecmwf: 0.3,
  openmeteo_gfs: 0.2,
  openmeteo_ukmo: 0.2,
  nws: 0.2,
  hko: 0.35
};

const HONG_KONG_OBSERVATORY_STATION: WeatherStationInfo = {
  id: "HKO",
  site: "Hong Kong Observatory",
  latitude: 22.3027,
  longitude: 114.1772,
  country: "HK"
};

export interface AviationMetarObservation {
  stationId: string;
  observedAt: string;
  tempC: number;
  raw?: unknown;
}

export interface MiddayStationObservation {
  stationId: string;
  timezone: string;
  targetDate: string;
  observationCount: number;
  latestObservedAt?: string;
  latestTempC?: number;
  highSoFarC?: number;
  lowSoFarC?: number;
  observations: AviationMetarObservation[];
}

export interface MiddayForecastPoint {
  source: WeatherSourceId;
  provider: string;
  valueC: number;
  weight: number;
  hourlyCount: number;
}

export interface MiddayWeatherConsensus {
  measure: WeatherMeasure;
  targetDate: string;
  stationId: string;
  station?: WeatherStationInfo;
  timezone: string;
  observedExtremeC?: number;
  forecastExtremeMeanC: number;
  finalMeanC: number;
  sigmaC: number;
  modelStdDevC: number;
  remainingHourCount: number;
  forecastPoints: MiddayForecastPoint[];
  observation: MiddayStationObservation;
}

export interface MiddayPricingOptions {
  date?: string;
  slugs?: string[];
  heldVistadex?: boolean;
  sources?: WeatherSourceId[];
  metarHours?: number;
  now?: Date;
  bankrollUsd?: number;
  maxPerTradeUsd?: number;
  kellyMultiplier?: number;
  maxKellyFraction?: number;
  minEdge?: number;
}

export interface MiddayWeatherOutcomePricing {
  eventSlug: string;
  eventTitle: string;
  marketSlug: string;
  question: string;
  conditionId?: string;
  outcomeLabel: string;
  city: string;
  date: string;
  measure: WeatherMeasure;
  fairYes: number;
  fairNo: number;
  yesBid?: number;
  yesAsk?: number;
  noBid?: number;
  noAsk?: number;
  yesEdge?: number;
  noEdge?: number;
  bestSide: "YES" | "NO";
  signal: "BUY_YES" | "BUY_NO" | "SKIP";
  edge?: number;
  price?: number;
  kellyFraction: number;
  suggestedSizeUsd?: number;
  confidence: "HIGH" | "MEDIUM" | "LOW";
  lockedByObservation?: "YES" | "NO";
  held?: {
    outcome: string;
    outcomeIndex: number;
    balance: number;
    midpoint?: number;
    bestBid?: number;
    bestAsk?: number;
  };
  reason: string;
}

export interface MiddayWeatherGroupReport {
  group: Omit<WeatherMarketGroup, "markets" | "unparsed"> & {
    marketCount: number;
  };
  station?: WeatherStationInfo;
  resolutionSource?: string;
  location?: WeatherLocation;
  observation?: MiddayStationObservation;
  consensus?: MiddayWeatherConsensus;
  sourceSummary: Array<Pick<WeatherSourceResult, "source" | "provider" | "ok" | "skipped" | "note" | "error">>;
  outcomes: MiddayWeatherOutcomePricing[];
  errors: string[];
}

export interface MiddayWeatherReport {
  targetDate: string;
  scannedEvents: number;
  groupCount: number;
  rowCount: number;
  signalCount: number;
  groups: MiddayWeatherGroupReport[];
  rows: MiddayWeatherOutcomePricing[];
  signals: MiddayWeatherOutcomePricing[];
  errors: Array<{ slug?: string; eventSlug?: string; error: string }>;
}

interface VistadexEventShape {
  event?: Record<string, unknown>;
  markets?: Array<Record<string, unknown>>;
}

interface HeldPositionRef {
  outcome: string;
  outcomeIndex: number;
  balance: number;
  midpoint?: number;
  bestBid?: number;
  bestAsk?: number;
}

function groupSummary(group: WeatherMarketGroup): MiddayWeatherGroupReport["group"] {
  return {
    eventSlug: group.eventSlug,
    eventTitle: group.eventTitle,
    eventEndDate: group.eventEndDate,
    city: group.city,
    date: group.date,
    measure: group.measure,
    marketCount: group.markets.length
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function boolValue(value: unknown): boolean {
  return value === true;
}

function unknownArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
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

function roundDateParts(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

export function localDateString(date: Date, timezone: string): string {
  const parts = roundDateParts(date, timezone);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function localMinuteString(date: Date, timezone: string): string {
  const parts = roundDateParts(date, timezone);
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
}

function hasExplicitOffset(value: string): boolean {
  return /(?:Z|[+-]\d{2}:?\d{2})$/i.test(value);
}

function hourlyPointDate(time: string, timezone: string): string {
  return hasExplicitOffset(time)
    ? localDateString(new Date(time), timezone)
    : time.slice(0, 10);
}

function hourlyPointIsAfter(time: string, now: Date, timezone: string): boolean {
  if (hasExplicitOffset(time)) return Date.parse(time) > now.getTime();
  return time.slice(0, 16) > localMinuteString(now, timezone);
}

function rawTimezone(result: WeatherSourceResult): string | undefined {
  if (!isRecord(result.raw)) return undefined;
  return stringValue(result.raw.timezone);
}

function celsiusToFahrenheit(value: number | undefined): number | undefined {
  return value === undefined ? undefined : value * 9 / 5 + 32;
}

function sourceWeight(source: WeatherSourceId): number {
  return MIDDAY_SOURCE_WEIGHTS[source] ?? 0.1;
}

function dailyExtremeForMeasure(
  point: NonNullable<WeatherSourceResult["daily"]>[number] | undefined,
  measure: WeatherMeasure
): number | undefined {
  if (!point) return undefined;
  return measure === "temperature_high" ? point.maxTempC : point.minTempC;
}

function remainingHoursInLocalDay(now: Date, timezone: string, targetDate: string): number {
  const parts = roundDateParts(now, timezone);
  const localDate = `${parts.year}-${parts.month}-${parts.day}`;
  if (localDate < targetDate) return 24;
  if (localDate > targetDate) return 0;

  const hour = Number(parts.hour);
  const minute = Number(parts.minute);
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return 0;
  return Math.max(0, Math.ceil(24 - hour - minute / 60));
}

function dynamicMiddayEdgeThreshold(sigmaC: number, override?: number): number {
  return override ?? clamp(sigmaC * 0.015, 0.015, 0.05);
}

function confidenceForConsensus(consensus: MiddayWeatherConsensus): "HIGH" | "MEDIUM" | "LOW" {
  if (consensus.forecastPoints.length >= 3 && consensus.modelStdDevC <= 0.75) return "HIGH";
  if (consensus.forecastPoints.length >= 2 && consensus.modelStdDevC <= 1.5) return "MEDIUM";
  return "LOW";
}

function bestSide(yesEdge?: number, noEdge?: number): "YES" | "NO" {
  return (yesEdge ?? -Infinity) >= (noEdge ?? -Infinity) ? "YES" : "NO";
}

function marketPrice(candidate: WeatherMarketCandidate, outcome: "Yes" | "No"): number | undefined {
  return candidate.outcomes.find((item) => item.outcome.toLowerCase() === outcome.toLowerCase())?.price;
}

function outcomeLabel(position: VistadexPosition): string {
  return position.outcomes[position.outcomeIndex] ?? String(position.outcomeIndex);
}

function heldPositionKey(conditionId: string | undefined, outcomeIndex: number): string | undefined {
  return conditionId ? `${conditionId}:${outcomeIndex}` : undefined;
}

function sameEventSlug(slug: string): string {
  return slug
    .replace(/-\d+forbelow$/i, "")
    .replace(/-\d+forhigher$/i, "")
    .replace(/-\d+-\d+f$/i, "")
    .replace(/-\d+-\d+c$/i, "");
}

function targetDateFromNow(now: Date): string {
  return localDateString(now, "America/Vancouver");
}

function looksLikeHkoText(value: string | undefined): boolean {
  return /hong\s*kong\s+observatory|\bhko\b|weather\.gov\.hk/i.test(value ?? "");
}

function looksLikeHkoSettlementGroup(group: WeatherMarketGroup): boolean {
  return looksLikeHkoText(group.eventTitle) ||
    group.markets.some((market) =>
      looksLikeHkoText(market.resolutionSource) ||
      looksLikeHkoText(market.question)
    );
}

function hongKongFallbackTarget(
  group: WeatherMarketGroup,
  target: WeatherStationForecastTarget
): WeatherStationForecastTarget | undefined {
  if (!looksLikeHkoSettlementGroup(group)) return undefined;

  return {
    resolutionSource: target.resolutionSource,
    resolution: target.resolution,
    station: HONG_KONG_OBSERVATORY_STATION,
    location: {
      name: "Hong Kong Observatory",
      latitude: HONG_KONG_OBSERVATORY_STATION.latitude,
      longitude: HONG_KONG_OBSERVATORY_STATION.longitude,
      timezone: "Asia/Hong_Kong",
      countryCode: "HK",
      country: "HK"
    },
    matched: true,
    note: target.note
      ? `${target.note} Using Hong Kong Observatory as the same-day fallback.`
      : "Using Hong Kong Observatory as the same-day fallback."
  };
}

function isHkoSettlementTarget(target: WeatherStationForecastTarget): boolean {
  return target.station?.id.toUpperCase() === "HKO" ||
    looksLikeHkoText(target.resolutionSource);
}

function sourcesForMiddayTarget(
  target: WeatherStationForecastTarget,
  requestedSources: WeatherSourceId[] | undefined
): WeatherSourceId[] {
  const sources = requestedSources ?? DEFAULT_MIDDAY_SOURCES;
  return isHkoSettlementTarget(target)
    ? sources
    : sources.filter((source) => source !== "hko");
}

function hkoCurrentObservation(result: WeatherSourceResult): AviationMetarObservation | undefined {
  if (result.source !== "hko" || !result.ok || !isRecord(result.current)) return undefined;
  const tempC = numberValue(result.current.tempC);
  const recordTime = stringValue(result.current.recordTime);
  if (tempC === undefined || !recordTime) return undefined;

  const millis = Date.parse(recordTime);
  if (Number.isNaN(millis)) return undefined;

  return {
    stationId: "HKO",
    observedAt: new Date(millis).toISOString(),
    tempC,
    raw: result.current
  };
}

function sourceCurrentObservations(
  results: WeatherSourceResult[],
  options: { useHko: boolean }
): AviationMetarObservation[] {
  if (!options.useHko) return [];
  return results.flatMap((result) => {
    const observation = hkoCurrentObservation(result);
    return observation ? [observation] : [];
  });
}

export function parseAviationMetars(raw: unknown): AviationMetarObservation[] {
  return unknownArray(raw).flatMap((item) => {
    if (!isRecord(item)) return [];
    const stationId = stringValue(item.icaoId);
    const observedAt = stringValue(item.reportTime) ??
      (numberValue(item.obsTime) === undefined ? undefined : new Date((numberValue(item.obsTime) as number) * 1000).toISOString());
    const tempC = numberValue(item.temp);
    if (!stationId || !observedAt || tempC === undefined) return [];
    return [{ stationId, observedAt, tempC, raw: item }];
  });
}

export async function fetchAviationMetars(
  stationId: string,
  options: { hours?: number; fetchImpl?: typeof fetch } = {}
): Promise<AviationMetarObservation[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const url = new URL("https://aviationweather.gov/api/data/metar");
  url.searchParams.set("ids", stationId);
  url.searchParams.set("format", "json");
  url.searchParams.set("hours", String(Math.max(1, Math.trunc(options.hours ?? 36))));

  const response = await fetchImpl(url);
  if (!response.ok) {
    throw new Error(`AviationWeather METAR request for ${stationId} failed with ${response.status}.`);
  }
  return parseAviationMetars(await response.json());
}

export function summarizeStationObservations(
  stationId: string,
  timezone: string,
  targetDate: string,
  observations: AviationMetarObservation[]
): MiddayStationObservation {
  const sameDay = observations
    .filter((observation) => localDateString(new Date(observation.observedAt), timezone) === targetDate)
    .sort((a, b) => Date.parse(b.observedAt) - Date.parse(a.observedAt));
  const temps = sameDay.map((observation) => observation.tempC);

  return {
    stationId,
    timezone,
    targetDate,
    observationCount: sameDay.length,
    latestObservedAt: sameDay[0]?.observedAt,
    latestTempC: sameDay[0]?.tempC,
    highSoFarC: temps.length > 0 ? Math.max(...temps) : undefined,
    lowSoFarC: temps.length > 0 ? Math.min(...temps) : undefined,
    observations: sameDay
  };
}

function forecastExtremeForSource(
  result: WeatherSourceResult,
  date: string,
  measure: WeatherMeasure,
  timezone: string,
  now: Date
): MiddayForecastPoint | undefined {
  if (!result.ok) return undefined;
  const values = (result.hourly ?? [])
    .filter((point) =>
      point.tempC !== undefined &&
      hourlyPointDate(point.time, timezone) === date &&
      hourlyPointIsAfter(point.time, now, timezone)
    )
    .map((point) => point.tempC as number);

  if (values.length > 0) {
    return {
      source: result.source,
      provider: result.provider,
      valueC: measure === "temperature_high" ? Math.max(...values) : Math.min(...values),
      weight: sourceWeight(result.source),
      hourlyCount: values.length
    };
  }

  const dailyValue = dailyExtremeForMeasure(
    result.daily?.find((point) => point.date === date),
    measure
  );
  if (dailyValue === undefined) return undefined;

  return {
    source: result.source,
    provider: result.provider,
    valueC: dailyValue,
    weight: sourceWeight(result.source),
    hourlyCount: remainingHoursInLocalDay(now, timezone, date)
  };
}

export function calculateMiddaySigmaC(
  remainingHourCount: number,
  modelStdDevC: number,
  forecastPointCount: number
): number {
  if (remainingHourCount <= 0) return 0.2;
  const horizonSigma = calculateBaseSigma(Math.min(24, Math.max(1, remainingHourCount))) * 0.65;
  const sourcePenalty = forecastPointCount >= 3 ? 1 : forecastPointCount === 2 ? 1.15 : 1.35;
  return clamp(Math.sqrt(horizonSigma ** 2 + (modelStdDevC * 0.65) ** 2) * sourcePenalty, 0.25, 2.5);
}

export function buildMiddayConsensus(input: {
  measure: WeatherMeasure;
  targetDate: string;
  stationId: string;
  station?: WeatherStationInfo;
  timezone: string;
  observation: MiddayStationObservation;
  sourceResults: WeatherSourceResult[];
  now?: Date;
}): MiddayWeatherConsensus {
  const now = input.now ?? new Date();
  const forecastPoints = input.sourceResults.flatMap((result) => {
    const point = forecastExtremeForSource(result, input.targetDate, input.measure, input.timezone, now);
    return point ? [point] : [];
  });
  const observedExtremeC = input.measure === "temperature_high"
    ? input.observation.highSoFarC
    : input.observation.lowSoFarC;
  const weightTotal = forecastPoints.reduce((sum, point) => sum + point.weight, 0);
  const forecastExtremeMeanC = forecastPoints.length > 0
    ? forecastPoints.reduce((sum, point) => sum + point.valueC * point.weight, 0) / (weightTotal || forecastPoints.length)
    : observedExtremeC ?? 0;
  const modelStdDevC = stdDev(forecastPoints.map((point) => point.valueC));
  const remainingHourCount = Math.max(0, ...forecastPoints.map((point) => point.hourlyCount));
  const sigmaC = calculateMiddaySigmaC(remainingHourCount, modelStdDevC, forecastPoints.length);
  const finalMeanC = observedExtremeC === undefined
    ? forecastExtremeMeanC
    : input.measure === "temperature_high"
      ? Math.max(observedExtremeC, forecastExtremeMeanC)
      : Math.min(observedExtremeC, forecastExtremeMeanC);

  return {
    measure: input.measure,
    targetDate: input.targetDate,
    stationId: input.stationId,
    station: input.station,
    timezone: input.timezone,
    observedExtremeC,
    forecastExtremeMeanC,
    finalMeanC,
    sigmaC,
    modelStdDevC,
    remainingHourCount,
    forecastPoints,
    observation: input.observation
  };
}

export function partialDayProbabilityInRange(
  consensus: Pick<MiddayWeatherConsensus, "measure" | "observedExtremeC" | "forecastExtremeMeanC" | "sigmaC">,
  lowerC?: number,
  upperC?: number
): number {
  const observed = consensus.observedExtremeC;
  if (observed === undefined) {
    return probabilityInRange(consensus.forecastExtremeMeanC, consensus.sigmaC, lowerC, upperC);
  }

  if (consensus.measure === "temperature_high") {
    if (upperC !== undefined && observed >= upperC) return 0;
    if (lowerC !== undefined && observed < lowerC) {
      return probabilityInRange(consensus.forecastExtremeMeanC, consensus.sigmaC, lowerC, upperC);
    }
    if (upperC === undefined) return 1;
    return probabilityInRange(consensus.forecastExtremeMeanC, consensus.sigmaC, undefined, upperC);
  }

  if (lowerC !== undefined && observed < lowerC) return 0;
  if (upperC !== undefined && observed >= upperC) {
    return probabilityInRange(consensus.forecastExtremeMeanC, consensus.sigmaC, lowerC, upperC);
  }
  if (lowerC === undefined) return 1;
  return probabilityInRange(consensus.forecastExtremeMeanC, consensus.sigmaC, lowerC, undefined);
}

function lockedByObservation(
  consensus: MiddayWeatherConsensus,
  lowerC?: number,
  upperC?: number
): "YES" | "NO" | undefined {
  const observed = consensus.observedExtremeC;
  if (observed === undefined) return undefined;

  if (consensus.measure === "temperature_high") {
    if (upperC !== undefined && observed >= upperC) return "NO";
    if (lowerC !== undefined && observed >= lowerC && upperC === undefined) return "YES";
    return undefined;
  }

  if (lowerC !== undefined && observed < lowerC) return "NO";
  if (upperC !== undefined && observed < upperC && lowerC === undefined) return "YES";
  return undefined;
}

function priceMiddayCandidate(
  group: WeatherMarketGroup,
  candidate: WeatherMarketCandidate,
  consensus: MiddayWeatherConsensus,
  options: MiddayPricingOptions,
  held?: HeldPositionRef
): MiddayWeatherOutcomePricing {
  const fairYes = partialDayProbabilityInRange(
    consensus,
    candidate.parsed.outcome.lowerTempC,
    candidate.parsed.outcome.upperTempC
  );
  const fairNo = 1 - fairYes;
  const yesAsk = candidate.bestAsk ?? marketPrice(candidate, "Yes");
  const yesBid = candidate.bestBid ?? marketPrice(candidate, "Yes");
  const noAsk = yesBid === undefined ? marketPrice(candidate, "No") : 1 - yesBid;
  const noBid = yesAsk === undefined ? marketPrice(candidate, "No") : 1 - yesAsk;
  const yesEdge = yesAsk === undefined ? undefined : fairYes - yesAsk;
  const noEdge = noAsk === undefined ? undefined : fairNo - noAsk;
  const side = bestSide(yesEdge, noEdge);
  const edge = side === "YES" ? yesEdge : noEdge;
  const price = side === "YES" ? yesAsk : noAsk;
  const threshold = dynamicMiddayEdgeThreshold(consensus.sigmaC, options.minEdge);
  const signal = edge !== undefined && price !== undefined && edge >= threshold
    ? side === "YES" ? "BUY_YES" : "BUY_NO"
    : "SKIP";
  const probability = side === "YES" ? fairYes : fairNo;
  const sizing = signal === "SKIP" || price === undefined
    ? { kellyFraction: 0, stakeUsd: undefined }
    : sizeBinaryKellyBet(
      { probability, price },
      {
        bankrollUsd: options.bankrollUsd,
        maxStakeUsd: options.maxPerTradeUsd,
        kellyMultiplier: options.kellyMultiplier,
        maxKellyFraction: options.maxKellyFraction
      }
    );

  return {
    eventSlug: group.eventSlug,
    eventTitle: group.eventTitle,
    marketSlug: candidate.marketSlug,
    question: candidate.question,
    conditionId: candidate.conditionId,
    outcomeLabel: candidate.parsed.outcome.label,
    city: group.city,
    date: group.date,
    measure: group.measure,
    fairYes,
    fairNo,
    yesBid,
    yesAsk,
    noBid,
    noAsk,
    yesEdge,
    noEdge,
    bestSide: side,
    signal,
    edge,
    price: signal === "SKIP" ? undefined : price,
    kellyFraction: sizing.kellyFraction,
    suggestedSizeUsd: sizing.stakeUsd,
    confidence: confidenceForConsensus(consensus),
    lockedByObservation: lockedByObservation(
      consensus,
      candidate.parsed.outcome.lowerTempC,
      candidate.parsed.outcome.upperTempC
    ),
    held,
    reason: signal === "SKIP"
      ? `Best edge ${(edge ?? 0).toFixed(3)} is below threshold ${threshold.toFixed(3)}.`
      : `${signal} edge ${(edge ?? 0).toFixed(3)} >= threshold ${threshold.toFixed(3)}.`
  };
}

function normalizeVistadexEvent(raw: unknown): VistadexEventShape {
  if (!isRecord(raw)) return {};
  return {
    event: isRecord(raw.event) ? raw.event : undefined,
    markets: unknownArray(raw.markets).filter(isRecord)
  };
}

export function vistadexEventToWeatherGroups(raw: unknown): WeatherMarketGroup[] {
  const eventShape = normalizeVistadexEvent(raw);
  const event = eventShape.event ?? {};
  const eventSlug = stringValue(event.slug) ?? "";
  const eventTitle = stringValue(event.title) ?? "";
  const eventEndDate = stringValue(event.end_date) ?? stringValue(event.endDate);
  const groups = new Map<string, WeatherMarketGroup>();

  for (const item of eventShape.markets ?? []) {
    const metadata = isRecord(item.metadata) ? item.metadata : {};
    const stats = isRecord(item.stats) ? item.stats : {};
    const question = stringValue(metadata.question);
    const marketSlug = stringValue(metadata.slug);
    const conditionId = stringValue(metadata.condition_id);
    const candidateEndDate = stringValue(metadata.end_date) ?? eventEndDate;
    if (!question || !marketSlug) continue;

    const parsed = parseWeatherMarketQuestion(question, candidateEndDate);
    if (!parsed) continue;

    const outcomePrices = unknownArray(stats.outcome_prices).map(numberValue);
    const outcomes = unknownArray(metadata.outcomes)
      .map(String)
      .map((outcome, index) => ({
        outcome,
        price: outcomePrices[index]
      }));
    const candidate: WeatherMarketCandidate = {
      eventSlug,
      eventTitle,
      eventEndDate: candidateEndDate,
      marketSlug,
      question,
      resolutionSource: stringValue(metadata.resolution_source),
      conditionId,
      active: boolValue(metadata.active),
      closed: boolValue(metadata.closed),
      acceptingOrders: boolValue(metadata.accepting_orders),
      bestBid: numberValue(stats.best_bid),
      bestAsk: numberValue(stats.best_ask),
      liquidity: numberValue(stats.liquidity),
      volume: numberValue(stats.volume),
      outcomes,
      parsed
    };
    const key = `${eventSlug}|${parsed.city}|${parsed.date}|${parsed.measure}`;
    const existing = groups.get(key);
    if (existing) {
      existing.markets.push(candidate);
    } else {
      groups.set(key, {
        eventSlug,
        eventTitle,
        eventEndDate: candidateEndDate,
        city: parsed.city,
        date: parsed.date,
        measure: parsed.measure,
        markets: [candidate],
        unparsed: []
      });
    }
  }

  return [...groups.values()].map((group) => ({
    ...group,
    markets: group.markets.sort((a, b) => a.marketSlug.localeCompare(b.marketSlug))
  }));
}

async function priceMiddayWeatherGroup(
  config: AppConfig,
  group: WeatherMarketGroup,
  options: MiddayPricingOptions,
  heldPositions: Map<string, HeldPositionRef>
): Promise<MiddayWeatherGroupReport> {
  const sourceSummary: MiddayWeatherGroupReport["sourceSummary"] = [];
  const errors: string[] = [];
  let target = await resolveStationForecastTarget(group);
  if (!target.matched || !target.station || !target.location) {
    const fallback = hongKongFallbackTarget(group, target);
    if (!fallback) {
      return {
        group: groupSummary(group),
        resolutionSource: target.resolutionSource,
        sourceSummary,
        outcomes: [],
        errors: [target.note ?? "Could not resolve weather station for same-day model."]
      };
    }

    target = fallback;
    if (fallback.note) errors.push(fallback.note);
  }
  const station = target.station;
  const location = target.location;
  if (!station || !location) {
    return {
      group: groupSummary(group),
      resolutionSource: target.resolutionSource,
      sourceSummary,
      outcomes: [],
      errors: [target.note ?? "Could not resolve weather station for same-day model."]
    };
  }

  const sourcesReport = await fetchWeatherEdgeSources(config, {
    city: location.name,
    latitude: location.latitude,
    longitude: location.longitude,
    countryCode: location.countryCode,
    days: 2,
    sources: sourcesForMiddayTarget(target, options.sources)
  });
  sourceSummary.push(...sourcesReport.results.map((result) => ({
    source: result.source,
    provider: result.provider,
    ok: result.ok,
    skipped: result.skipped,
    note: result.note,
    error: result.error
  })));
  const timezone = location.timezone ??
    sourcesReport.results.flatMap((result) => rawTimezone(result) ?? [])[0] ??
    "UTC";

  const metars = station.id.toUpperCase() === "HKO"
    ? []
    : await fetchAviationMetars(station.id, {
      hours: options.metarHours
    });
  const observations = [
    ...metars,
    ...sourceCurrentObservations(sourcesReport.results, {
      useHko: isHkoSettlementTarget(target)
    })
  ];
  const observation = summarizeStationObservations(station.id, timezone, group.date, observations);
  if (observation.observationCount === 0) {
    errors.push(`No ${station.id} same-day observations found for ${group.date} in ${timezone}.`);
  }
  const consensus = buildMiddayConsensus({
    measure: group.measure,
    targetDate: group.date,
    stationId: station.id,
    station,
    timezone,
    observation,
    sourceResults: sourcesReport.results,
    now: options.now
  });

  return {
    group: groupSummary(group),
    station,
    resolutionSource: target.resolutionSource,
    location,
    observation,
    consensus,
    sourceSummary,
    outcomes: group.markets.map((candidate) => {
      const yesKey = heldPositionKey(candidate.conditionId, 0);
      const noKey = heldPositionKey(candidate.conditionId, 1);
      const held = (yesKey ? heldPositions.get(yesKey) : undefined) ??
        (noKey ? heldPositions.get(noKey) : undefined);
      return priceMiddayCandidate(
        group,
        candidate,
        consensus,
        options,
        held
      );
    }),
    errors
  };
}

async function heldVistadexWeatherSlugs(
  config: AppConfig,
  targetDate: string
): Promise<{ slugs: string[]; heldPositions: Map<string, HeldPositionRef> }> {
  const snapshot = await getVistadexPositions(config);
  const slugs = new Set<string>();
  const heldPositions = new Map<string, HeldPositionRef>();

  for (const position of snapshot.positions) {
    if (!position.slug || !position.conditionId || !/temperature/i.test(position.question ?? "")) continue;
    const parsed = position.question ? parseWeatherMarketQuestion(position.question) : undefined;
    if (!parsed || parsed.date !== targetDate) continue;
    slugs.add(sameEventSlug(position.slug));
    const key = heldPositionKey(position.conditionId, position.outcomeIndex);
    if (key) {
      heldPositions.set(key, {
        outcome: outcomeLabel(position),
        outcomeIndex: position.outcomeIndex,
        balance: Number(position.balance ?? 0),
        midpoint: position.price?.midpoint,
        bestBid: position.price?.bestBid,
        bestAsk: position.price?.bestAsk
      });
    }
  }

  return { slugs: [...slugs], heldPositions };
}

export async function computeVistadexMiddayWeatherReport(
  config: AppConfig,
  options: MiddayPricingOptions = {}
): Promise<MiddayWeatherReport> {
  const now = options.now ?? new Date();
  const targetDate = options.date ?? targetDateFromNow(now);
  const errors: MiddayWeatherReport["errors"] = [];
  const held = options.heldVistadex
    ? await heldVistadexWeatherSlugs(config, targetDate)
    : { slugs: [] as string[], heldPositions: new Map<string, HeldPositionRef>() };
  const slugs = [...new Set([...(options.slugs ?? []), ...held.slugs])];
  const groups: MiddayWeatherGroupReport[] = [];

  for (const slug of slugs) {
    try {
      const rawEvent = await getVistadexEvent(config, slug);
      const rawGroups = vistadexEventToWeatherGroups(rawEvent)
        .filter((group) => group.date === targetDate);
      for (const group of rawGroups) {
        groups.push(await priceMiddayWeatherGroup(config, group, { ...options, now }, held.heldPositions));
      }
    } catch (error) {
      errors.push({
        slug,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  const rows = groups
    .flatMap((group) => group.outcomes)
    .sort((a, b) => (b.edge ?? -Infinity) - (a.edge ?? -Infinity));
  const signals = rows.filter((row) => row.signal !== "SKIP");
  return {
    targetDate,
    scannedEvents: slugs.length,
    groupCount: groups.length,
    rowCount: rows.length,
    signalCount: signals.length,
    groups,
    rows,
    signals,
    errors
  };
}

export function formatFahrenheit(valueC: number | undefined): number | undefined {
  const valueF = celsiusToFahrenheit(valueC);
  return valueF === undefined ? undefined : Math.round(valueF * 10) / 10;
}
