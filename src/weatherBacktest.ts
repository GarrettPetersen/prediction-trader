import type { AppConfig } from "./config.js";
import { parseGammaList } from "./marketplaces/polymarketData.js";
import { type WeatherObservationRecord, type WeatherPreviousRunForecastRecord, readJsonlRecords } from "./weatherDatasets.js";
import { parseWeatherMarketQuestion, type ParsedWeatherMarket, type WeatherMeasure } from "./weatherMarkets.js";
import { probabilityInRange } from "./weatherPricing.js";
import {
  DEFAULT_KELLY_MULTIPLIER,
  DEFAULT_MAX_KELLY_FRACTION,
  DEFAULT_MAX_PORTFOLIO_FRACTION,
  sizeBinaryKellyPortfolio
} from "./kelly.js";

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
}

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
  date: string;
  measure: WeatherMeasure;
  outcomeLabel: string;
  side: "YES" | "NO";
  price: number;
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
  decisionTime: string;
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
  sizing: {
    method: "fractional_kelly";
    kellyMultiplier: number;
    maxKellyFraction: number;
    maxPortfolioFraction: number;
    maxPerTradeUsd?: number;
  };
  trades: WeatherBacktestTrade[];
}

interface ClosedWeatherMarket {
  eventSlug: string;
  eventTitle: string;
  eventEndDate?: string;
  marketSlug: string;
  question: string;
  parsed: ParsedWeatherMarket;
  yesTokenId?: string;
  resolutionSource?: string;
  resolvedYes?: boolean;
}

interface PricePoint {
  t: number;
  p: number;
}

interface ForecastAggregate {
  meanC: number;
  rawMeanC: number;
  sourceCount: number;
}

interface ActualIndexValue {
  maxTempC?: number;
  minTempC?: number;
}

interface Calibration {
  biasC: number;
  sigmaC: number;
  meanAbsoluteErrorC: number;
  samples: number;
  halfLifeDays: number;
  cityBiasPriorWeight: number;
  cityBiases: Map<string, { biasC: number; samples: number; effectiveWeight: number }>;
  sourceCalibrations: Map<string, {
    biasC: number;
    sigmaC: number;
    meanAbsoluteErrorC: number;
    samples: number;
    effectiveWeight: number;
    ensembleWeight: number;
  }>;
}

type SourceCalibration = Calibration["sourceCalibrations"] extends Map<string, infer T> ? T : never;

interface SourceForecastValue {
  source: string;
  valueC: number;
}

interface ResidualSample {
  cityKey: string;
  date: string;
  residualC: number;
  weight: number;
}

interface WeightedValue {
  value: number;
  weight: number;
}

const DEFAULT_CALIBRATION_HALF_LIFE_DAYS = 365;
const DEFAULT_CITY_BIAS_PRIOR_WEIGHT = 30;
const SOURCE_CALIBRATION_PRIOR_SAMPLES = 30;

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

function normalizeCityKey(value: string | undefined): string {
  const normalized = (value ?? "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  if (normalized === "new york city") return "new york";
  return normalized;
}

function observationKey(city: string | undefined, date: string): string {
  return `${normalizeCityKey(city)}|${date}`;
}

function forecastKey(city: string, date: string, measure: WeatherMeasure): string {
  return `${normalizeCityKey(city)}|${date}|${measure}`;
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function stdDev(values: number[]): number {
  if (values.length === 0) return 0;
  const avg = mean(values);
  return Math.sqrt(values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / values.length);
}

function weightedMean(values: WeightedValue[]): number {
  const weightTotal = values.reduce((sum, item) => sum + item.weight, 0);
  if (weightTotal <= 0) return mean(values.map((item) => item.value));
  return values.reduce((sum, item) => sum + item.value * item.weight, 0) / weightTotal;
}

function weightedStdDev(values: WeightedValue[], center = weightedMean(values)): number {
  const weightTotal = values.reduce((sum, item) => sum + item.weight, 0);
  if (weightTotal <= 0) return stdDev(values.map((item) => item.value));
  return Math.sqrt(values.reduce((sum, item) => sum + ((item.value - center) ** 2) * item.weight, 0) / weightTotal);
}

function weightedMeanAbsolute(values: WeightedValue[]): number {
  const weightTotal = values.reduce((sum, item) => sum + item.weight, 0);
  if (weightTotal <= 0) return mean(values.map((item) => Math.abs(item.value)));
  return values.reduce((sum, item) => sum + Math.abs(item.value) * item.weight, 0) / weightTotal;
}

function daysBetween(olderDate: string, newerDate: string): number {
  const older = Date.parse(`${olderDate}T00:00:00Z`);
  const newer = Date.parse(`${newerDate}T00:00:00Z`);
  if (!Number.isFinite(older) || !Number.isFinite(newer)) return 0;
  return Math.max(0, (newer - older) / 86_400_000);
}

function recencyWeight(date: string, targetDate: string, halfLifeDays: number): number {
  const halfLife = Math.max(1, halfLifeDays);
  return 0.5 ** (daysBetween(date, targetDate) / halfLife);
}

function actualValue(actual: ActualIndexValue | undefined, measure: WeatherMeasure): number | undefined {
  if (!actual) return undefined;
  return measure === "temperature_high" ? actual.maxTempC : actual.minTempC;
}

function marketResolvesYes(parsed: ParsedWeatherMarket, actualC: number): boolean {
  const lower = parsed.outcome.lowerTempC;
  const upper = parsed.outcome.upperTempC;
  return (lower === undefined || actualC >= lower) && (upper === undefined || actualC < upper);
}

function parseResolvedYes(outcomesRaw: unknown, outcomePricesRaw: unknown): boolean | undefined {
  const outcomes = parseGammaList(outcomesRaw);
  const prices = parseGammaList(outcomePricesRaw).map((price) => Number(price));
  const yesIndex = outcomes.findIndex((outcome) => outcome.toLowerCase() === "yes");
  if (yesIndex < 0 || prices.length <= yesIndex) return undefined;
  if (!prices.every((price) => Number.isFinite(price))) return undefined;

  const yesPrice = prices[yesIndex];
  const maxPrice = Math.max(...prices);
  const minPrice = Math.min(...prices);
  if (maxPrice < 0.99 || minPrice > 0.01) return undefined;
  return yesPrice >= 0.99;
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
          parsed,
          yesTokenId: yesIndex >= 0 ? tokenIds[yesIndex] : undefined,
          resolutionSource: stringValue(marketRaw.resolutionSource),
          resolvedYes: parseResolvedYes(marketRaw.outcomes, marketRaw.outcomePrices)
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

function buildActualIndex(records: WeatherObservationRecord[]): Map<string, ActualIndexValue> {
  const index = new Map<string, ActualIndexValue>();
  for (const record of records) {
    const key = observationKey(record.city, record.date);
    const existing = index.get(key) ?? {};
    index.set(key, {
      maxTempC: record.maxTempC ?? existing.maxTempC,
      minTempC: record.minTempC ?? existing.minTempC
    });
  }
  return index;
}

function buildForecastValueIndex(
  records: WeatherPreviousRunForecastRecord[],
  options: { leadDays: number; sources: string[] }
): Map<string, SourceForecastValue[]> {
  const byKey = new Map<string, Map<string, SourceForecastValue>>();
  const sourceSet = new Set(options.sources);
  for (const record of records) {
    if (!record.ok || record.valueC === undefined || record.leadDays !== options.leadDays) continue;
    if (!sourceSet.has(record.source)) continue;
    const key = forecastKey(record.city, record.date, record.measure);
    const values = byKey.get(key) ?? new Map<string, SourceForecastValue>();
    values.set(record.source, { source: record.source, valueC: record.valueC });
    byKey.set(key, values);
  }

  return new Map([...byKey.entries()].map(([key, values]) => [key, [...values.values()]]));
}

function calibrateByMeasure(
  forecastValuesByKey: Map<string, SourceForecastValue[]>,
  actualIndex: Map<string, ActualIndexValue>,
  targetDate: string,
  options: { halfLifeDays: number; cityBiasPriorWeight: number }
): Map<WeatherMeasure, Calibration> {
  const sourceResiduals: Record<WeatherMeasure, Map<string, WeightedValue[]>> = {
    temperature_high: new Map(),
    temperature_low: new Map()
  };
  const sourceResidualPool: Record<WeatherMeasure, WeightedValue[]> = {
    temperature_high: [],
    temperature_low: []
  };

  for (const [key, sourceValues] of forecastValuesByKey.entries()) {
    const [cityKey, date, measureRaw] = key.split("|");
    if (date >= targetDate) continue;
    const measure = measureRaw as WeatherMeasure;
    const actual = actualValue(actualIndex.get(`${cityKey}|${date}`), measure);
    if (actual === undefined) continue;
    const weight = recencyWeight(date, targetDate, options.halfLifeDays);
    for (const sourceValue of sourceValues) {
      const residual = actual - sourceValue.valueC;
      const sourceItems = sourceResiduals[measure].get(sourceValue.source) ?? [];
      sourceItems.push({ value: residual, weight });
      sourceResiduals[measure].set(sourceValue.source, sourceItems);
      sourceResidualPool[measure].push({ value: residual, weight });
    }
  }

  return new Map((["temperature_high", "temperature_low"] as const).map((measure) => {
    const sourcePool = sourceResidualPool[measure];
    const fallbackSourceBias = sourcePool.length > 0 ? weightedMean(sourcePool) : 0;
    const fallbackSourceSigma = sourcePool.length > 0
      ? Math.max(0.5, weightedStdDev(sourcePool, fallbackSourceBias))
      : 2.5;
    const sourceCalibrations = new Map<string, SourceCalibration>();

    for (const [source, values] of sourceResiduals[measure].entries()) {
      const sourceMean = weightedMean(values);
      const shrinkage = values.length / (values.length + SOURCE_CALIBRATION_PRIOR_SAMPLES);
      const biasC = fallbackSourceBias + (sourceMean - fallbackSourceBias) * shrinkage;
      const rawSigma = Math.max(0.5, weightedStdDev(values, sourceMean));
      const sigmaC = Math.sqrt(
        ((rawSigma ** 2) * values.length + (fallbackSourceSigma ** 2) * SOURCE_CALIBRATION_PRIOR_SAMPLES) /
        (values.length + SOURCE_CALIBRATION_PRIOR_SAMPLES)
      );
      sourceCalibrations.set(source, {
        biasC,
        sigmaC,
        meanAbsoluteErrorC: weightedMeanAbsolute(values),
        samples: values.length,
        effectiveWeight: values.reduce((sum, item) => sum + item.weight, 0),
        ensembleWeight: 1 / Math.max(0.25, sigmaC ** 2)
      });
    }

    const ensembleResiduals: ResidualSample[] = [];
    for (const [key, sourceValues] of forecastValuesByKey.entries()) {
      const [cityKey, date, measureRaw] = key.split("|");
      if (measureRaw !== measure || date >= targetDate) continue;
      const actual = actualValue(actualIndex.get(`${cityKey}|${date}`), measure);
      if (actual === undefined) continue;
      const forecast = aggregateForecast(sourceValues, sourceCalibrations);
      ensembleResiduals.push({
        cityKey,
        date,
        residualC: actual - forecast.meanC,
        weight: recencyWeight(date, targetDate, options.halfLifeDays)
      });
    }

    if (ensembleResiduals.length === 0) {
      return [measure, {
        samples: 0,
        biasC: 0,
        sigmaC: 2.5,
        meanAbsoluteErrorC: 2.5,
        halfLifeDays: options.halfLifeDays,
        cityBiasPriorWeight: options.cityBiasPriorWeight,
        cityBiases: new Map(),
        sourceCalibrations
      }];
    }

    const residualValues = ensembleResiduals.map((sample) => ({ value: sample.residualC, weight: sample.weight }));
    const globalBiasC = weightedMean(residualValues);
    const byCity = new Map<string, WeightedValue[]>();
    for (const sample of ensembleResiduals) {
      const values = byCity.get(sample.cityKey) ?? [];
      values.push({ value: sample.residualC, weight: sample.weight });
      byCity.set(sample.cityKey, values);
    }
    const cityBiases = new Map<string, { biasC: number; samples: number; effectiveWeight: number }>();
    for (const [cityKey, values] of byCity.entries()) {
      const cityWeight = values.reduce((sum, item) => sum + item.weight, 0);
      const cityMean = weightedMean(values);
      const shrinkage = cityWeight / (cityWeight + Math.max(0, options.cityBiasPriorWeight));
      cityBiases.set(cityKey, {
        biasC: globalBiasC + (cityMean - globalBiasC) * shrinkage,
        samples: values.length,
        effectiveWeight: cityWeight
      });
    }

    const centered = ensembleResiduals.map((sample) => ({
      value: sample.residualC - (cityBiases.get(sample.cityKey)?.biasC ?? globalBiasC),
      weight: sample.weight
    }));
    return [measure, {
      samples: ensembleResiduals.length,
      biasC: globalBiasC,
      sigmaC: Math.max(0.5, weightedStdDev(centered, 0)),
      meanAbsoluteErrorC: weightedMeanAbsolute(centered),
      halfLifeDays: options.halfLifeDays,
      cityBiasPriorWeight: options.cityBiasPriorWeight,
      cityBiases,
      sourceCalibrations
    }];
  }));
}

function aggregateForecast(
  sourceValues: SourceForecastValue[],
  sourceCalibrations: Calibration["sourceCalibrations"]
): ForecastAggregate {
  const rawMeanC = mean(sourceValues.map((item) => item.valueC));
  const weightedValues = sourceValues.map((item) => {
    const calibration = sourceCalibrations.get(item.source);
    return {
      value: item.valueC + (calibration?.biasC ?? 0),
      weight: calibration?.ensembleWeight ?? 1
    };
  });
  return {
    meanC: weightedMean(weightedValues),
    rawMeanC,
    sourceCount: sourceValues.length
  };
}

function buildForecastIndex(
  forecastValuesByKey: Map<string, SourceForecastValue[]>,
  calibration: Map<WeatherMeasure, Calibration>
): Map<string, ForecastAggregate> {
  return new Map([...forecastValuesByKey.entries()].map(([key, sourceValues]) => {
    const [, , measureRaw] = key.split("|");
    const sourceCalibrations = calibration.get(measureRaw as WeatherMeasure)?.sourceCalibrations ?? new Map();
    return [key, aggregateForecast(sourceValues, sourceCalibrations)];
  }));
}

function calibrationBiasForCity(calibration: Calibration, city: string): number {
  return calibration.cityBiases.get(normalizeCityKey(city))?.biasC ?? calibration.biasC;
}

function brierScore(items: Array<{ probability: number; actual: boolean }>): number | undefined {
  if (items.length === 0) return undefined;
  return mean(items.map((item) => (item.probability - (item.actual ? 1 : 0)) ** 2));
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
  const maxPerTradeUsd = options.maxPerTradeUsd === undefined
    ? undefined
    : Math.max(0, options.maxPerTradeUsd);
  const calibrationHalfLifeDays = Math.max(
    1,
    Math.trunc(options.calibrationHalfLifeDays ?? DEFAULT_CALIBRATION_HALF_LIFE_DAYS)
  );
  const cityBiasPriorWeight = Math.max(0, options.cityBiasPriorWeight ?? DEFAULT_CITY_BIAS_PRIOR_WEIGHT);

  const [observations, previousRuns, markets] = await Promise.all([
    readJsonlRecords<WeatherObservationRecord>(config.weather.datasets.observationsPath),
    readJsonlRecords<WeatherPreviousRunForecastRecord>(config.weather.datasets.previousRunForecastsPath),
    fetchClosedWeatherMarkets(options.date, {
      limit: Math.min(Math.max(Math.trunc(options.limit ?? 100), 1), 100),
      maxPages: Math.max(Math.trunc(options.maxPages ?? 20), 1)
    })
  ]);
  const actualIndex = buildActualIndex(observations);
  const forecastValuesByKey = buildForecastValueIndex(previousRuns, { leadDays, sources });
  const calibration = calibrateByMeasure(forecastValuesByKey, actualIndex, options.date, {
    halfLifeDays: calibrationHalfLifeDays,
    cityBiasPriorWeight
  });
  const forecastIndex = buildForecastIndex(forecastValuesByKey, calibration);
  const candidates: Omit<
    WeatherBacktestTrade,
    "fullKellyFraction" | "kellyFraction" | "rawStakeUsd" | "stakeUsd" | "payoutUsd" | "pnlUsd"
  >[] = [];
  const scoredMarkets: Array<{ probability: number; actual: boolean }> = [];
  const candidateScores: Array<{ probability: number; actual: boolean }> = [];

  let skippedNoForecast = 0;
  let skippedNoActual = 0;
  let skippedNoSettlement = 0;
  let skippedNoPrice = 0;

  const priceEntries = await mapWithConcurrency(markets, 20, async (market) => {
    if (!market.yesTokenId || !market.eventEndDate) return { market };
    const decisionTimeMs = Date.parse(market.eventEndDate) - leadDays * 86_400_000;
    if (!Number.isFinite(decisionTimeMs)) return { market };
    try {
      const history = await fetchTokenPriceHistory(market.yesTokenId);
      return {
        market,
        entry: bestEntryPriceAtOrBefore(history, Math.trunc(decisionTimeMs / 1000), maxStalenessHours),
        decisionTimeMs
      };
    } catch {
      return { market, decisionTimeMs };
    }
  });

  for (const { market, entry, decisionTimeMs } of priceEntries) {
    const parsed = market.parsed;
    const forecast = forecastIndex.get(forecastKey(parsed.city, parsed.date, parsed.measure));
    if (!forecast) {
      skippedNoForecast += 1;
      continue;
    }
    const actualC = actualValue(actualIndex.get(observationKey(parsed.city, parsed.date)), parsed.measure);
    if (actualC === undefined) skippedNoActual += 1;
    if (!entry || decisionTimeMs === undefined) {
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
    const calibratedMeanC = forecast.meanC + calibrationBiasForCity(calibrationForMeasure, parsed.city);
    const fairYes = probabilityInRange(
      calibratedMeanC,
      calibrationForMeasure.sigmaC,
      parsed.outcome.lowerTempC,
      parsed.outcome.upperTempC
    );
    const yesPrice = entry.price;
    const noPrice = 1 - yesPrice;
    const yesEdge = fairYes - yesPrice;
    const fairNo = 1 - fairYes;
    const noEdge = fairNo - noPrice;
    const side = yesEdge >= noEdge ? "YES" : "NO";
    const edge = side === "YES" ? yesEdge : noEdge;
    const proxyActualYes = actualC === undefined ? undefined : marketResolvesYes(parsed, actualC);
    scoredMarkets.push({ probability: fairYes, actual: resolvedYes });
    const price = side === "YES" ? yesPrice : noPrice;
    if (edge < minEdge || price < minTradePrice) continue;

    const won = side === "YES" ? resolvedYes : !resolvedYes;
    const fair = side === "YES" ? fairYes : fairNo;
    candidateScores.push({ probability: fair, actual: won });
    candidates.push({
      eventSlug: market.eventSlug,
      eventEndDate: market.eventEndDate,
      marketSlug: market.marketSlug,
      question: market.question,
      city: parsed.city,
      date: parsed.date,
      measure: parsed.measure,
      outcomeLabel: parsed.outcome.label,
      side,
      price,
      fair,
      edge,
      forecastMeanC: forecast.meanC,
      calibratedMeanC,
      sigmaC: calibrationForMeasure.sigmaC,
      actualC,
      resolvedYes,
      proxyActualYes,
      won,
      decisionTime: new Date(decisionTimeMs).toISOString(),
      priceTime: new Date(entry.timeSec * 1000).toISOString(),
      priceAgeHours: entry.ageHours
    });
  }

  const sizes = sizeBinaryKellyPortfolio(
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
  const trades = candidates.map((trade, index) => {
    const sizing = sizes[index];
    const stakeUsd = sizing?.stakeUsd ?? 0;
    const payoutUsd = trade.won ? stakeUsd / trade.price : 0;
    return {
      ...trade,
      fullKellyFraction: sizing?.fullKellyFraction ?? 0,
      kellyFraction: sizing?.kellyFraction ?? 0,
      rawStakeUsd: sizing?.rawStakeUsd ?? 0,
      stakeUsd,
      payoutUsd,
      pnlUsd: payoutUsd - stakeUsd
    };
  }).filter((trade) => trade.stakeUsd > 0)
    .sort((a, b) => b.edge - a.edge);
  const payoutUsd = trades.reduce((sum, trade) => sum + trade.payoutUsd, 0);
  const totalStakeUsd = trades.reduce((sum, trade) => sum + trade.stakeUsd, 0);
  const pnlUsd = payoutUsd - totalStakeUsd;

  return {
    date: options.date,
    leadDays,
    bankrollUsd,
    minEdge,
    strategy: "For each resolved Polymarket weather binary, estimate fair probability from calibrated day-ahead Open-Meteo previous-run forecasts; buy the better YES/NO side when edge >= minEdge; size candidates with fractional Kelly, cap each trade, and scale the day if total suggested risk exceeds the portfolio cap.",
    calibration: [...calibration.entries()].map(([measure, item]) => {
      const weightTotal = [...item.sourceCalibrations.values()]
        .reduce((sum, sourceCalibration) => sum + sourceCalibration.ensembleWeight, 0);
      return {
        measure,
        samples: item.samples,
        biasC: item.biasC,
        sigmaC: item.sigmaC,
        meanAbsoluteErrorC: item.meanAbsoluteErrorC,
        halfLifeDays: item.halfLifeDays,
        cityBiases: item.cityBiases.size,
        sourceWeights: Object.fromEntries([...item.sourceCalibrations.entries()].map(([source, sourceCalibration]) => [
          source,
          weightTotal > 0 ? sourceCalibration.ensembleWeight / weightTotal : 0
        ])),
        sourceBiasC: Object.fromEntries([...item.sourceCalibrations.entries()].map(([source, sourceCalibration]) => [
          source,
          sourceCalibration.biasC
        ]))
      };
    }),
    summary: {
      closedEvents: new Set(markets.map((market) => market.eventSlug)).size,
      binaryMarkets: markets.length,
      skippedNoForecast,
      skippedNoActual,
      skippedNoSettlement,
      skippedNoPrice,
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
    sizing: {
      method: "fractional_kelly",
      kellyMultiplier,
      maxKellyFraction,
      maxPortfolioFraction,
      maxPerTradeUsd
    },
    trades
  };
}
