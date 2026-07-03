import type { AppConfig } from "./config.js";
import { parseGammaList } from "./marketplaces/polymarketData.js";
import { type WeatherObservationRecord, type WeatherPreviousRunForecastRecord, readJsonlRecords } from "./weatherDatasets.js";
import { parseWeatherMarketQuestion, type ParsedWeatherMarket, type WeatherMeasure } from "./weatherMarkets.js";
import { probabilityInRange } from "./weatherPricing.js";

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
}

export interface WeatherCalibrationSummary {
  measure: WeatherMeasure;
  samples: number;
  biasC: number;
  sigmaC: number;
  meanAbsoluteErrorC: number;
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
  actualC: number;
  actualYes: boolean;
  won: boolean;
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
    skippedNoPrice: number;
    candidates: number;
    wins: number;
    losses: number;
    stakeUsd: number;
    payoutUsd: number;
    pnlUsd: number;
    roi: number;
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
}

interface PricePoint {
  t: number;
  p: number;
}

interface ForecastAggregate {
  meanC: number;
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

function actualValue(actual: ActualIndexValue | undefined, measure: WeatherMeasure): number | undefined {
  if (!actual) return undefined;
  return measure === "temperature_high" ? actual.maxTempC : actual.minTempC;
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
          yesTokenId: yesIndex >= 0 ? tokenIds[yesIndex] : undefined
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

function buildForecastIndex(
  records: WeatherPreviousRunForecastRecord[],
  options: { leadDays: number; sources: string[] }
): Map<string, ForecastAggregate> {
  const byKey = new Map<string, number[]>();
  const sourceSet = new Set(options.sources);
  for (const record of records) {
    if (!record.ok || record.valueC === undefined || record.leadDays !== options.leadDays) continue;
    if (!sourceSet.has(record.source)) continue;
    const key = forecastKey(record.city, record.date, record.measure);
    const values = byKey.get(key) ?? [];
    values.push(record.valueC);
    byKey.set(key, values);
  }

  return new Map([...byKey.entries()].map(([key, values]) => [key, {
    meanC: mean(values),
    sourceCount: values.length
  }]));
}

function calibrateByMeasure(
  forecastIndex: Map<string, ForecastAggregate>,
  actualIndex: Map<string, ActualIndexValue>,
  targetDate: string
): Map<WeatherMeasure, Calibration> {
  const residuals: Record<WeatherMeasure, number[]> = {
    temperature_high: [],
    temperature_low: []
  };

  for (const [key, forecast] of forecastIndex.entries()) {
    const [cityKey, date, measureRaw] = key.split("|");
    if (date >= targetDate) continue;
    const measure = measureRaw as WeatherMeasure;
    const actual = actualValue(actualIndex.get(`${cityKey}|${date}`), measure);
    if (actual === undefined) continue;
    residuals[measure].push(actual - forecast.meanC);
  }

  return new Map((["temperature_high", "temperature_low"] as const).map((measure) => {
    const values = residuals[measure];
    if (values.length === 0) {
      return [measure, { samples: 0, biasC: 0, sigmaC: 2.5, meanAbsoluteErrorC: 2.5 }];
    }
    const biasC = mean(values);
    const centered = values.map((value) => value - biasC);
    return [measure, {
      samples: values.length,
      biasC,
      sigmaC: Math.max(0.5, stdDev(centered)),
      meanAbsoluteErrorC: mean(values.map((value) => Math.abs(value)))
    }];
  }));
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

  const [observations, previousRuns, markets] = await Promise.all([
    readJsonlRecords<WeatherObservationRecord>(config.weather.datasets.observationsPath),
    readJsonlRecords<WeatherPreviousRunForecastRecord>(config.weather.datasets.previousRunForecastsPath),
    fetchClosedWeatherMarkets(options.date, {
      limit: Math.min(Math.max(Math.trunc(options.limit ?? 100), 1), 100),
      maxPages: Math.max(Math.trunc(options.maxPages ?? 20), 1)
    })
  ]);
  const actualIndex = buildActualIndex(observations);
  const forecastIndex = buildForecastIndex(previousRuns, { leadDays, sources });
  const calibration = calibrateByMeasure(forecastIndex, actualIndex, options.date);
  const candidates: Omit<WeatherBacktestTrade, "stakeUsd" | "payoutUsd" | "pnlUsd">[] = [];

  let skippedNoForecast = 0;
  let skippedNoActual = 0;
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
    if (actualC === undefined) {
      skippedNoActual += 1;
      continue;
    }
    if (!entry || decisionTimeMs === undefined) {
      skippedNoPrice += 1;
      continue;
    }

    const calibrationForMeasure = calibration.get(parsed.measure) ?? {
      biasC: 0,
      sigmaC: 2.5,
      meanAbsoluteErrorC: 2.5,
      samples: 0
    };
    const calibratedMeanC = forecast.meanC + calibrationForMeasure.biasC;
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
    if (edge < minEdge) continue;

    const actualYes = marketResolvesYes(parsed, actualC);
    const won = side === "YES" ? actualYes : !actualYes;
    const price = side === "YES" ? yesPrice : noPrice;
    const fair = side === "YES" ? fairYes : fairNo;
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
      actualYes,
      won,
      decisionTime: new Date(decisionTimeMs).toISOString(),
      priceTime: new Date(entry.timeSec * 1000).toISOString(),
      priceAgeHours: entry.ageHours
    });
  }

  const stakeUsd = candidates.length > 0 ? bankrollUsd / candidates.length : 0;
  const trades = candidates.map((trade) => {
    const payoutUsd = trade.won ? stakeUsd / trade.price : 0;
    return {
      ...trade,
      stakeUsd,
      payoutUsd,
      pnlUsd: payoutUsd - stakeUsd
    };
  }).sort((a, b) => b.edge - a.edge);
  const payoutUsd = trades.reduce((sum, trade) => sum + trade.payoutUsd, 0);
  const totalStakeUsd = trades.reduce((sum, trade) => sum + trade.stakeUsd, 0);
  const pnlUsd = payoutUsd - totalStakeUsd;

  return {
    date: options.date,
    leadDays,
    bankrollUsd,
    minEdge,
    strategy: "For each resolved Polymarket weather binary, estimate fair probability from calibrated day-ahead Open-Meteo previous-run forecasts; buy the better YES/NO side when edge >= minEdge; split the whole bankroll equally across all qualifying bets.",
    calibration: [...calibration.entries()].map(([measure, item]) => ({
      measure,
      samples: item.samples,
      biasC: item.biasC,
      sigmaC: item.sigmaC,
      meanAbsoluteErrorC: item.meanAbsoluteErrorC
    })),
    summary: {
      closedEvents: new Set(markets.map((market) => market.eventSlug)).size,
      binaryMarkets: markets.length,
      skippedNoForecast,
      skippedNoActual,
      skippedNoPrice,
      candidates: trades.length,
      wins: trades.filter((trade) => trade.won).length,
      losses: trades.filter((trade) => !trade.won).length,
      stakeUsd: totalStakeUsd,
      payoutUsd,
      pnlUsd,
      roi: bankrollUsd > 0 ? pnlUsd / bankrollUsd : 0
    },
    trades
  };
}
