import type { AppConfig } from "./config.js";
import { fahrenheitToCelsius } from "./weatherEdge.js";
import { parseGammaList } from "./marketplaces/polymarketData.js";
import {
  parseResolutionSource,
  resolutionSourceFromText
} from "./weatherStations.js";

const POLYMARKET_GAMMA_BASE_URL = "https://gamma-api.polymarket.com";
const KALSHI_PUBLIC_API_BASE_URL = "https://external-api.kalshi.com/trade-api/v2";
const KALSHI_SEARCH_URL = "https://api.elections.kalshi.com/v1/search/series";
const KALSHI_SEARCH_PAGE_SIZE = 200;
const MONTHS: Record<string, number> = {
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  may: 5,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12
};

export type WeatherMeasure = "temperature_high" | "temperature_low";
export type WeatherOutcomeKind = "exact" | "or_below" | "or_above" | "range";
export type WeatherReferencePlatform = "polymarket" | "kalshi";

export interface ParsedWeatherOutcome {
  kind: WeatherOutcomeKind;
  label: string;
  unit: "C" | "F";
  lowerTempC?: number;
  upperTempC?: number;
  exactTempC?: number;
  rawValue: number;
  rawUpperValue?: number;
}

export interface ParsedWeatherMarket {
  city: string;
  date: string;
  measure: WeatherMeasure;
  outcome: ParsedWeatherOutcome;
}

export interface WeatherMarketOutcomeToken {
  outcome: string;
  tokenId?: string;
  price?: number;
  bestBid?: number;
  bestAsk?: number;
}

export interface WeatherMarketCandidate {
  referencePlatform?: WeatherReferencePlatform;
  eventSlug: string;
  eventTitle: string;
  eventEndDate?: string;
  marketSlug: string;
  question: string;
  description?: string;
  resolutionSource?: string;
  conditionId?: string;
  active: boolean;
  closed: boolean;
  acceptingOrders?: boolean;
  negRisk?: boolean;
  bestBid?: number;
  bestAsk?: number;
  liquidity?: number;
  volume?: number;
  resolvedYes?: boolean;
  outcomes: WeatherMarketOutcomeToken[];
  parsed: ParsedWeatherMarket;
}

export interface WeatherMarketGroup {
  referencePlatform?: WeatherReferencePlatform;
  eventSlug: string;
  eventTitle: string;
  eventEndDate?: string;
  city: string;
  date: string;
  measure: WeatherMeasure;
  markets: WeatherMarketCandidate[];
  unparsed: Array<{ slug?: string; question?: string; reason: string }>;
}

export interface WeatherScanOptions {
  date?: string;
  limit?: number;
  maxPages?: number;
  includeExpired?: boolean;
  includeUnparsed?: boolean;
  active?: boolean;
  closed?: boolean;
  ascending?: boolean;
}

export interface KalshiWeatherSeries {
  ticker: string;
  title: string;
  category?: string;
  frequency?: string;
  settlement_sources?: Array<{ name?: string; url?: string }>;
}

export interface KalshiWeatherMarket {
  ticker: string;
  event_ticker: string;
  title?: string;
  subtitle?: string;
  status?: string;
  open_time?: string;
  close_time?: string;
  rules_primary?: string;
  rules_secondary?: string;
  yes_bid_dollars?: string;
  yes_ask_dollars?: string;
  no_bid_dollars?: string;
  no_ask_dollars?: string;
  last_price_dollars?: string;
  volume?: number;
  volume_fp?: string;
  liquidity_dollars?: string;
}

interface KalshiSearchMarket {
  ticker?: string;
  yes_subtitle?: string;
  yes_bid_dollars?: string;
  yes_ask_dollars?: string;
  last_price_dollars?: string;
  close_ts?: string;
  open_ts?: string;
  volume?: number;
}

interface KalshiSearchEvent {
  type?: string;
  series_ticker?: string;
  event_ticker?: string;
  event_subtitle?: string;
  event_title?: string;
  category?: string;
  active_market_count?: number;
  markets?: KalshiSearchMarket[];
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

function kalshiOrderPrice(value: unknown): number | undefined {
  const price = numberValue(value);
  return price !== undefined && price > 0 && price <= 1 ? price : undefined;
}

export function resolvedYesFromOutcomeTokens(
  outcomes: WeatherMarketOutcomeToken[]
): boolean | undefined {
  const yesToken = outcomes.find((item) => item.outcome.toLowerCase() === "yes");
  const prices = outcomes.flatMap((item) =>
    item.price === undefined || !Number.isFinite(item.price) ? [] : [item.price]
  );
  if (!yesToken || yesToken.price === undefined || prices.length !== outcomes.length) return undefined;

  const maxPrice = Math.max(...prices);
  const minPrice = Math.min(...prices);
  if (maxPrice < 0.99 || minPrice > 0.01) return undefined;
  return yesToken.price >= 0.99;
}

export function resolvedYesFromGammaOutcomePrices(
  outcomesRaw: unknown,
  outcomePricesRaw: unknown
): boolean | undefined {
  const outcomes = parseGammaList(outcomesRaw);
  const prices = parseGammaList(outcomePricesRaw).map(Number);
  return resolvedYesFromOutcomeTokens(outcomes.map((outcome, index) => ({
    outcome,
    price: Number.isFinite(prices[index]) ? prices[index] : undefined
  })));
}

function isoDateFromMonthDay(monthDay: string, year: number): string | undefined {
  const match = monthDay.trim().match(/^([A-Za-z]+)\s+(\d{1,2})$/);
  if (!match) return undefined;
  const month = MONTHS[match[1].toLowerCase()];
  const day = Number(match[2]);
  if (!month || day < 1 || day > 31) return undefined;
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function marketYear(eventEndDate?: string): number {
  const parsed = eventEndDate ? new Date(eventEndDate) : new Date();
  const year = parsed.getUTCFullYear();
  return Number.isFinite(year) ? year : new Date().getUTCFullYear();
}

function toCelsius(value: number, unit: "C" | "F"): number {
  return unit === "F" ? fahrenheitToCelsius(value) : value;
}

function boundaryToCelsius(value: number, unit: "C" | "F"): number {
  return toCelsius(value, unit);
}

function unitBinWidth(unit: "C" | "F"): number {
  return unit === "F" ? 5 / 9 : 1;
}

function normalizeUnit(value: string): "C" | "F" {
  return value.toUpperCase() === "F" ? "F" : "C";
}

function parseMeasure(text: string): WeatherMeasure | undefined {
  if (/highest temperature|high temperature|maximum temperature/i.test(text)) return "temperature_high";
  if (/lowest temperature|low temperature|minimum temperature/i.test(text)) return "temperature_low";
  return undefined;
}

export function parseWeatherMarketQuestion(
  question: string,
  eventEndDate?: string
): ParsedWeatherMarket | undefined {
  const measure = parseMeasure(question);
  if (!measure) return undefined;

  const cityDate = question.match(/temperature in (.+?) be .+? on ([A-Za-z]+ \d{1,2})\??$/i);
  if (!cityDate) return undefined;

  const city = cityDate[1].trim();
  const date = isoDateFromMonthDay(cityDate[2], marketYear(eventEndDate));
  if (!date) return undefined;

  const between = question.match(
    /be between (-?\d+(?:\.\d+)?)(?:\s*(?:°|º)?([CF]))?\s*(?:and|-|to)\s*(-?\d+(?:\.\d+)?)\s*(?:°|º)?([CF])/i
  );
  if (between) {
    const lowerRaw = Number(between[1]);
    const unit = normalizeUnit(between[2] ?? between[4]);
    const upperRaw = Number(between[3]);
    const halfBin = unitBinWidth(unit) / 2;
    return {
      city,
      date,
      measure,
      outcome: {
        kind: "range",
        label: `${lowerRaw}-${upperRaw}${unit}`,
        unit,
        lowerTempC: boundaryToCelsius(lowerRaw, unit) - halfBin,
        upperTempC: boundaryToCelsius(upperRaw, unit) + halfBin,
        rawValue: lowerRaw,
        rawUpperValue: upperRaw
      }
    };
  }

  const orBelow = question.match(/be (-?\d+(?:\.\d+)?)\s*(?:°|º)?([CF]) or below/i);
  if (orBelow) {
    const raw = Number(orBelow[1]);
    const unit = normalizeUnit(orBelow[2]);
    return {
      city,
      date,
      measure,
      outcome: {
        kind: "or_below",
        label: `${raw}${unit} or below`,
        unit,
        upperTempC: boundaryToCelsius(raw, unit) + unitBinWidth(unit) / 2,
        rawValue: raw
      }
    };
  }

  const orAbove = question.match(/be (-?\d+(?:\.\d+)?)\s*(?:°|º)?([CF]) or (?:above|higher)/i);
  if (orAbove) {
    const raw = Number(orAbove[1]);
    const unit = normalizeUnit(orAbove[2]);
    return {
      city,
      date,
      measure,
      outcome: {
        kind: "or_above",
        label: `${raw}${unit} or above`,
        unit,
        lowerTempC: boundaryToCelsius(raw, unit) - unitBinWidth(unit) / 2,
        rawValue: raw
      }
    };
  }

  const exact = question.match(/be (-?\d+(?:\.\d+)?)\s*(?:°|º)?([CF])(?:\s+on|\?)/i);
  if (exact) {
    const raw = Number(exact[1]);
    const unit = normalizeUnit(exact[2]);
    const exactTempC = toCelsius(raw, unit);
    const halfBin = unitBinWidth(unit) / 2;
    return {
      city,
      date,
      measure,
      outcome: {
        kind: "exact",
        label: `${raw}${unit}`,
        unit,
        lowerTempC: exactTempC - halfBin,
        upperTempC: exactTempC + halfBin,
        exactTempC,
        rawValue: raw
      }
    };
  }

  return undefined;
}

function kalshiSeriesMeasure(title: string): WeatherMeasure | undefined {
  if (/\b(?:lowest|minimum|min|low)\b.*\btemp(?:erature)?\b|\blow\s+temp(?:erature)?\b/i.test(title)) {
    return "temperature_low";
  }
  if (/\b(?:highest|maximum|max|high)\b.*\btemp(?:erature)?\b|\bhigh\s+temp(?:erature)?\b/i.test(title)) {
    return "temperature_high";
  }
  return undefined;
}

const KALSHI_CITY_ALIASES: Record<string, string> = {
  dc: "Washington, DC",
  la: "Los Angeles",
  lv: "Las Vegas",
  minnesota: "Minneapolis",
  nola: "New Orleans",
  ny: "New York City",
  nyc: "New York City",
  okc: "Oklahoma City",
  satx: "San Antonio",
  sfo: "San Francisco"
};

function normalizeKalshiCity(value: string): string | undefined {
  const city = value.replace(/\s+/g, " ").replace(/[?.]+$/, "").trim();
  if (!city || /^(?:cities|united states)$/i.test(city)) return undefined;
  return KALSHI_CITY_ALIASES[city.toLowerCase()] ?? city;
}

export function parseKalshiWeatherSeries(
  series: Pick<KalshiWeatherSeries, "ticker" | "title">
): { city: string; measure: WeatherMeasure } | undefined {
  if (!series.ticker.toUpperCase().startsWith("KX")) return undefined;
  const measure = kalshiSeriesMeasure(series.title);
  if (!measure) return undefined;

  const title = series.title.replace(/\s+/g, " ").trim();
  const patterns = [
    /^(?:highest|lowest)\s+temperature(?:\s+in)?\s+(.+)$/i,
    /^(.+?)\s+(?:daily\s+)?(?:maximum\s+high|minimum\s+low|maximum|minimum|max|min|high|low)(?:\s+daily)?\s+temp(?:erature)?(?:\s+daily)?$/i,
    /^(?:daily\s+)?(?:maximum|minimum|max|min|high|low)(?:\s+daily)?\s+temp(?:erature)?\s+(.+)$/i,
    /^(.+?)\s+(?:maximum|minimum|max|min|high|low)\s+temp(?:erature)?(?:\s+daily)?$/i
  ];
  for (const pattern of patterns) {
    const match = title.match(pattern);
    const city = match?.[1] ? normalizeKalshiCity(match[1]) : undefined;
    if (city) return { city, measure };
  }
  return undefined;
}

function monthNumber(value: string): number | undefined {
  const normalized = value.toLowerCase();
  return MONTHS[normalized] ?? Object.entries(MONTHS)
    .find(([month]) => month.startsWith(normalized.slice(0, 3)))?.[1];
}

function kalshiMarketDate(...texts: Array<string | undefined>): string | undefined {
  for (const text of texts) {
    const match = text?.match(/(?:on|for)\s+([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})/i);
    if (!match) continue;
    const month = monthNumber(match[1]);
    const day = Number(match[2]);
    const year = Number(match[3]);
    if (!month || !Number.isInteger(day) || day < 1 || day > 31 || !Number.isInteger(year)) {
      return undefined;
    }
    return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  }
  return undefined;
}

function kalshiOutcomeFromRules(rules: string): ParsedWeatherOutcome | undefined {
  const range = rules.match(/(?:\bbetween\s+)?(-?\d+(?:\.\d+)?)\s*(?:°|º)?\s*(?:and|-|to)\s*(-?\d+(?:\.\d+)?)\s*(?:°|º)?(?:\s*degrees?)?(?:\s*fahrenheit|\s*F)?/i);
  if (range) {
    const lowerRaw = Number(range[1]);
    const upperRaw = Number(range[2]);
    const halfBin = unitBinWidth("F") / 2;
    return {
      kind: "range",
      label: `${lowerRaw}-${upperRaw}F`,
      unit: "F",
      lowerTempC: boundaryToCelsius(lowerRaw, "F") - halfBin,
      upperTempC: boundaryToCelsius(upperRaw, "F") + halfBin,
      rawValue: lowerRaw,
      rawUpperValue: upperRaw
    };
  }

  const orAbove = rules.match(/(-?\d+(?:\.\d+)?)\s*(?:°|º)?(?:\s*F)?\s+or\s+(?:above|higher)/i);
  if (orAbove) {
    const raw = Number(orAbove[1]);
    return {
      kind: "or_above",
      label: `${raw}F or above`,
      unit: "F",
      lowerTempC: boundaryToCelsius(raw, "F") - unitBinWidth("F") / 2,
      rawValue: raw
    };
  }

  const orBelow = rules.match(/(-?\d+(?:\.\d+)?)\s*(?:°|º)?(?:\s*F)?\s+or\s+(?:below|lower)/i);
  if (orBelow) {
    const raw = Number(orBelow[1]);
    return {
      kind: "or_below",
      label: `${raw}F or below`,
      unit: "F",
      upperTempC: boundaryToCelsius(raw, "F") + unitBinWidth("F") / 2,
      rawValue: raw
    };
  }

  const greater = rules.match(/\bgreater\s+than\s+(-?\d+(?:\.\d+)?)\s*(?:°|º)?/i);
  if (greater) {
    const threshold = Number(greater[1]);
    const raw = threshold + 1;
    return {
      kind: "or_above",
      label: `${raw}F or above`,
      unit: "F",
      lowerTempC: boundaryToCelsius(raw, "F") - unitBinWidth("F") / 2,
      rawValue: raw
    };
  }

  const less = rules.match(/\bless\s+than\s+(-?\d+(?:\.\d+)?)\s*(?:°|º)?/i);
  if (less) {
    const threshold = Number(less[1]);
    const raw = threshold - 1;
    return {
      kind: "or_below",
      label: `${raw}F or below`,
      unit: "F",
      upperTempC: boundaryToCelsius(raw, "F") + unitBinWidth("F") / 2,
      rawValue: raw
    };
  }

  return undefined;
}

function kalshiCanonicalQuestion(parsed: ParsedWeatherMarket): string {
  const measure = parsed.measure === "temperature_high" ? "highest" : "lowest";
  const date = new Date(`${parsed.date}T12:00:00Z`).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    timeZone: "UTC"
  });
  const outcome = parsed.outcome.kind === "range"
    ? `between ${parsed.outcome.rawValue}-${parsed.outcome.rawUpperValue}°F`
    : parsed.outcome.kind === "or_above"
      ? `${parsed.outcome.rawValue}°F or above`
      : `${parsed.outcome.rawValue}°F or below`;
  return `Will the ${measure} temperature in ${parsed.city} be ${outcome} on ${date}?`;
}

function kalshiResolutionSource(series: KalshiWeatherSeries): string {
  const urls = (series.settlement_sources ?? [])
    .map((source) => source.url?.trim())
    .filter((url): url is string => Boolean(url));
  const source = urls.find((url) => parseResolutionSource(url).provider === "nws_cli");
  if (!source) {
    throw new Error(`Kalshi weather series ${series.ticker} does not expose a supported NWS CLI settlement source.`);
  }
  return source;
}

function midpoint(bid: number | undefined, ask: number | undefined): number | undefined {
  if (bid !== undefined && ask !== undefined) return (bid + ask) / 2;
  return ask ?? bid;
}

export function normalizeKalshiWeatherMarket(
  series: KalshiWeatherSeries,
  market: KalshiWeatherMarket
): WeatherMarketCandidate | undefined {
  const parsedSeries = parseKalshiWeatherSeries(series);
  if (!parsedSeries) return undefined;
  const rules = [market.rules_primary, market.rules_secondary].filter(Boolean).join(" ");
  const date = kalshiMarketDate(market.title, rules);
  const outcome = kalshiOutcomeFromRules(rules);
  if (!date) {
    throw new Error(`Could not parse the settlement date for Kalshi weather market ${market.ticker}.`);
  }
  if (!outcome) {
    throw new Error(`Could not parse the temperature payoff for Kalshi weather market ${market.ticker}.`);
  }

  const parsed: ParsedWeatherMarket = {
    city: parsedSeries.city,
    date,
    measure: parsedSeries.measure,
    outcome
  };
  const yesBid = kalshiOrderPrice(market.yes_bid_dollars);
  const yesAsk = kalshiOrderPrice(market.yes_ask_dollars);
  const directNoBid = kalshiOrderPrice(market.no_bid_dollars);
  const directNoAsk = kalshiOrderPrice(market.no_ask_dollars);
  const noBid = directNoBid ?? (yesAsk === undefined || yesAsk >= 1 ? undefined : 1 - yesAsk);
  const noAsk = directNoAsk ?? (yesBid === undefined ? undefined : 1 - yesBid);
  const lastPrice = kalshiOrderPrice(market.last_price_dollars);
  const yesReference = midpoint(yesBid, yesAsk) ?? lastPrice;
  const noReference = yesReference === undefined ? midpoint(noBid, noAsk) : 1 - yesReference;
  const status = market.status?.toLowerCase();
  if (!status) throw new Error(`Kalshi weather market ${market.ticker} is missing its status.`);
  const active = status === "open" || status === "active" || status === "trading";
  const closed = status === "closed" || status === "settled" || status === "finalized";
  if (!active && !closed) {
    throw new Error(`Unsupported Kalshi weather market status ${market.status} for ${market.ticker}.`);
  }

  return {
    referencePlatform: "kalshi",
    eventSlug: market.event_ticker.toLowerCase(),
    eventTitle: `${parsedSeries.measure === "temperature_high" ? "Highest" : "Lowest"} temperature in ${parsedSeries.city} on ${date}`,
    eventEndDate: market.close_time,
    marketSlug: market.ticker.toLowerCase(),
    question: kalshiCanonicalQuestion(parsed),
    description: rules,
    resolutionSource: kalshiResolutionSource(series),
    active,
    closed,
    acceptingOrders: active && !closed,
    bestBid: yesBid,
    bestAsk: yesAsk,
    liquidity: numberValue(market.liquidity_dollars),
    volume: numberValue(market.volume_fp ?? market.volume),
    outcomes: [
      {
        outcome: "Yes",
        tokenId: `${market.ticker.toUpperCase()}:YES`,
        price: yesReference,
        bestBid: yesBid,
        bestAsk: yesAsk
      },
      {
        outcome: "No",
        tokenId: `${market.ticker.toUpperCase()}:NO`,
        price: noReference,
        bestBid: noBid,
        bestAsk: noAsk
      }
    ],
    parsed
  };
}

function normalizeWeatherMarketCandidate(
  event: Record<string, unknown>,
  market: Record<string, unknown>
): WeatherMarketCandidate | { unparsed: WeatherMarketGroup["unparsed"][number] } {
  const question = stringValue(market.question);
  const marketSlug = stringValue(market.slug);
  const eventSlug = stringValue(event.slug) ?? "";
  const eventTitle = stringValue(event.title) ?? "";
  const eventEndDate = stringValue(event.endDate);
  const description = stringValue(market.description) ?? stringValue(event.description);

  if (!question || !marketSlug) {
    return { unparsed: { slug: marketSlug, question, reason: "missing question or slug" } };
  }

  const parsed = parseWeatherMarketQuestion(question, eventEndDate);
  if (!parsed) {
    return { unparsed: { slug: marketSlug, question, reason: "unsupported weather market shape" } };
  }

  const outcomes = parseGammaList(market.outcomes);
  const tokenIds = parseGammaList(market.clobTokenIds);
  const prices = parseGammaList(market.outcomePrices).map(Number);
  const closed = boolValue(market.closed);
  const outcomeTokens = outcomes.map((outcome, index) => ({
    outcome,
    tokenId: tokenIds[index],
    price: Number.isFinite(prices[index]) ? prices[index] : undefined
  }));

  return {
    referencePlatform: "polymarket",
    eventSlug,
    eventTitle,
    eventEndDate,
    marketSlug,
    question,
    description,
    resolutionSource: stringValue(market.resolutionSource) ?? resolutionSourceFromText(description),
    conditionId: stringValue(market.conditionId),
    active: boolValue(market.active),
    closed,
    acceptingOrders: market.acceptingOrders === undefined ? undefined : boolValue(market.acceptingOrders),
    negRisk: market.negRisk === undefined ? undefined : boolValue(market.negRisk),
    bestBid: numberValue(market.bestBid),
    bestAsk: numberValue(market.bestAsk),
    liquidity: numberValue(market.liquidityNum ?? market.liquidity),
    volume: numberValue(market.volumeNum ?? market.volume),
    resolvedYes: closed ? resolvedYesFromOutcomeTokens(outcomeTokens) : undefined,
    outcomes: outcomeTokens,
    parsed
  };
}

function groupKey(candidate: WeatherMarketCandidate): string {
  return [
    candidate.referencePlatform ?? "polymarket",
    candidate.eventSlug,
    candidate.parsed.city.toLowerCase(),
    candidate.parsed.date,
    candidate.parsed.measure
  ].join("|");
}

async function fetchPolymarketJson(url: URL): Promise<unknown> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Polymarket Gamma request failed with HTTP ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

export async function fetchPolymarketWeatherMarkets(
  _config: AppConfig,
  options: WeatherScanOptions = {}
): Promise<WeatherMarketGroup[]> {
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 50), 1), 100);
  const maxPages = Math.min(Math.max(Math.trunc(options.maxPages ?? 4), 1), 20);
  const groups = new Map<string, WeatherMarketGroup>();
  const now = Date.now();
  const closed = options.closed ?? false;
  const ascending = options.ascending ?? !closed;

  for (let page = 0; page < maxPages; page += 1) {
    const url = new URL("/events", POLYMARKET_GAMMA_BASE_URL);
    url.searchParams.set("tag_slug", "weather");
    url.searchParams.set("closed", String(closed));
    if (options.active !== undefined) {
      url.searchParams.set("active", String(options.active));
    } else if (!closed) {
      url.searchParams.set("active", "true");
    }
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("offset", String(page * limit));
    url.searchParams.set("order", "endDate");
    url.searchParams.set("ascending", String(ascending));

    const raw = await fetchPolymarketJson(url);
    if (!Array.isArray(raw) || raw.length === 0) break;

    for (const item of raw) {
      if (!isRecord(item)) continue;
      const eventEndDate = stringValue(item.endDate);
      if (!options.includeExpired && eventEndDate && Date.parse(eventEndDate) < now) continue;
      const markets = Array.isArray(item.markets) ? item.markets : [];
      const eventUnparsed: WeatherMarketGroup["unparsed"] = [];

      for (const rawMarket of markets) {
        if (!isRecord(rawMarket)) continue;
        const normalized = normalizeWeatherMarketCandidate(item, rawMarket);
        if ("unparsed" in normalized) {
          if (options.includeUnparsed) eventUnparsed.push(normalized.unparsed);
          continue;
        }
        if (closed) {
          if (!normalized.closed) continue;
        } else if (!normalized.active || normalized.closed || normalized.acceptingOrders === false) {
          continue;
        }

        const key = groupKey(normalized);
        const existing = groups.get(key) ?? {
          referencePlatform: "polymarket" as const,
          eventSlug: normalized.eventSlug,
          eventTitle: normalized.eventTitle,
          eventEndDate: normalized.eventEndDate,
          city: normalized.parsed.city,
          date: normalized.parsed.date,
          measure: normalized.parsed.measure,
          markets: [],
          unparsed: []
        };
        existing.markets.push(normalized);
        groups.set(key, existing);
      }

      if (options.includeUnparsed && eventUnparsed.length > 0) {
        const eventSlug = stringValue(item.slug) ?? "";
        const eventTitle = stringValue(item.title) ?? "";
        const key = `${eventSlug}|unparsed`;
        const existing = groups.get(key) ?? {
          referencePlatform: "polymarket" as const,
          eventSlug,
          eventTitle,
          eventEndDate,
          city: "",
          date: "",
          measure: "temperature_high",
          markets: [],
          unparsed: []
        };
        existing.unparsed.push(...eventUnparsed);
        groups.set(key, existing);
      }
    }
  }

  return [...groups.values()]
    .filter((group) => group.markets.length > 0 || (options.includeUnparsed && group.unparsed.length > 0))
    .sort((a, b) => (a.eventEndDate ?? "").localeCompare(b.eventEndDate ?? ""));
}

export async function fetchPolymarketWeatherEventBySlug(
  _config: AppConfig,
  slug: string,
  options: Pick<WeatherScanOptions, "includeUnparsed"> = {}
): Promise<WeatherMarketGroup[]> {
  const url = new URL("/events", POLYMARKET_GAMMA_BASE_URL);
  url.searchParams.set("slug", slug);
  const raw = await fetchPolymarketJson(url);
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error(`No Polymarket weather event found for slug ${slug}.`);
  }

  const event = raw[0];
  if (!isRecord(event)) throw new Error(`Malformed Polymarket event for slug ${slug}.`);
  const groups = new Map<string, WeatherMarketGroup>();
  const eventUnparsed: WeatherMarketGroup["unparsed"] = [];

  for (const rawMarket of Array.isArray(event.markets) ? event.markets : []) {
    if (!isRecord(rawMarket)) continue;
    const normalized = normalizeWeatherMarketCandidate(event, rawMarket);
    if ("unparsed" in normalized) {
      if (options.includeUnparsed) eventUnparsed.push(normalized.unparsed);
      continue;
    }
    const key = groupKey(normalized);
    const existing = groups.get(key) ?? {
      referencePlatform: "polymarket" as const,
      eventSlug: normalized.eventSlug,
      eventTitle: normalized.eventTitle,
      eventEndDate: normalized.eventEndDate,
      city: normalized.parsed.city,
      date: normalized.parsed.date,
      measure: normalized.parsed.measure,
      markets: [],
      unparsed: []
    };
    existing.markets.push(normalized);
    groups.set(key, existing);
  }

  if (options.includeUnparsed && eventUnparsed.length > 0) {
    const eventSlug = stringValue(event.slug) ?? slug;
    groups.set(`${eventSlug}|unparsed`, {
      referencePlatform: "polymarket",
      eventSlug,
      eventTitle: stringValue(event.title) ?? "",
      eventEndDate: stringValue(event.endDate),
      city: "",
      date: "",
      measure: "temperature_high",
      markets: [],
      unparsed: eventUnparsed
    });
  }

  return [...groups.values()].sort((a, b) => a.date.localeCompare(b.date));
}

async function fetchKalshiJson(url: URL): Promise<unknown> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Kalshi public API request failed with HTTP ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

function kalshiSearchDate(date: string): string {
  const parsed = new Date(`${date}T12:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
    throw new Error(`Kalshi weather discovery requires a valid YYYY-MM-DD date; received ${date}.`);
  }
  return parsed.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC"
  });
}

function normalizeKalshiSearchMarket(
  event: KalshiSearchEvent,
  market: KalshiSearchMarket
): KalshiWeatherMarket {
  if (!event.event_ticker || !event.event_subtitle || !market.ticker || !market.yes_subtitle) {
    throw new Error("Kalshi weather search returned an incomplete event or market record.");
  }
  return {
    ticker: market.ticker,
    event_ticker: event.event_ticker,
    title: event.event_subtitle,
    subtitle: market.yes_subtitle,
    status: "open",
    open_time: market.open_ts,
    close_time: market.close_ts,
    rules_primary: `${event.event_subtitle}: ${market.yes_subtitle}`,
    yes_bid_dollars: market.yes_bid_dollars,
    yes_ask_dollars: market.yes_ask_dollars,
    last_price_dollars: market.last_price_dollars,
    volume: market.volume,
    volume_fp: market.volume === undefined ? undefined : String(market.volume)
  };
}

export async function fetchKalshiWeatherMarkets(
  _config: AppConfig,
  options: WeatherScanOptions = {}
): Promise<WeatherMarketGroup[]> {
  if (options.closed === true || options.active === false) {
    throw new Error("Kalshi weather discovery currently supports open markets only.");
  }
  if (!options.date) {
    throw new Error("Kalshi weather discovery requires an explicit target date.");
  }
  const seriesUrl = new URL(`${KALSHI_PUBLIC_API_BASE_URL}/series`);
  seriesUrl.searchParams.set("category", "Climate and Weather");
  const rawSeries = await fetchKalshiJson(seriesUrl);
  if (!isRecord(rawSeries) || !Array.isArray(rawSeries.series)) {
    throw new Error("Malformed Kalshi series response.");
  }
  const series = rawSeries.series
    .filter(isRecord)
    .map((item) => item as unknown as KalshiWeatherSeries)
    .filter((item) => (item.settlement_sources ?? []).some((source) =>
      parseResolutionSource(source.url).provider === "nws_cli"
    ))
    .filter((item) => parseKalshiWeatherSeries(item) !== undefined);
  if (series.length === 0) {
    throw new Error("Kalshi returned no supported daily high/low weather series.");
  }

  const seriesByTicker = new Map(series.map((item) => [item.ticker.toUpperCase(), item]));
  const searchUrl = new URL(KALSHI_SEARCH_URL);
  searchUrl.searchParams.set("query", `temperature on ${kalshiSearchDate(options.date)}`);
  searchUrl.searchParams.set("page_size", String(KALSHI_SEARCH_PAGE_SIZE));
  searchUrl.searchParams.set("order_by", "volume");
  searchUrl.searchParams.set("status", "open");
  const rawSearch = await fetchKalshiJson(searchUrl);
  if (!isRecord(rawSearch) || !Array.isArray(rawSearch.current_page)) {
    throw new Error("Malformed Kalshi weather search response.");
  }
  const totalResults = numberValue(rawSearch.total_results_count);
  if (totalResults === undefined || totalResults > rawSearch.current_page.length) {
    throw new Error(`Kalshi weather search was truncated: received ${rawSearch.current_page.length} of ${totalResults ?? "unknown"} results.`);
  }

  const groups = new Map<string, WeatherMarketGroup>();
  const now = Date.now();

  for (const rawEvent of rawSearch.current_page) {
    if (!isRecord(rawEvent)) continue;
    const event = rawEvent as unknown as KalshiSearchEvent;
    const item = event.series_ticker ? seriesByTicker.get(event.series_ticker.toUpperCase()) : undefined;
    if (!item) continue;
    if (event.type !== "contract" || event.category !== "Climate and Weather") continue;
    const openMarkets = Array.isArray(event.markets) ? event.markets : [];
    if ((event.active_market_count ?? 0) !== openMarkets.length) {
      throw new Error(`Kalshi weather search returned ${openMarkets.length} of ${event.active_market_count ?? "unknown"} active markets for ${event.event_ticker ?? item.ticker}.`);
    }
    for (const searchMarket of openMarkets) {
      const rawMarket = normalizeKalshiSearchMarket(event, searchMarket);
      const candidate = normalizeKalshiWeatherMarket(item, rawMarket);
      if (!candidate || !candidate.active || candidate.closed || candidate.acceptingOrders === false) continue;
      if (candidate.parsed.date !== options.date) continue;
      if (!options.includeExpired && candidate.eventEndDate && Date.parse(candidate.eventEndDate) < now) continue;
      const key = groupKey(candidate);
      const existing = groups.get(key) ?? {
        referencePlatform: "kalshi" as const,
        eventSlug: candidate.eventSlug,
        eventTitle: candidate.eventTitle,
        eventEndDate: candidate.eventEndDate,
        city: candidate.parsed.city,
        date: candidate.parsed.date,
        measure: candidate.parsed.measure,
        markets: [],
        unparsed: []
      };
      existing.markets.push(candidate);
      groups.set(key, existing);
    }
  }

  return [...groups.values()].sort((a, b) => {
    const endDate = (a.eventEndDate ?? "").localeCompare(b.eventEndDate ?? "");
    if (endDate !== 0) return endDate;
    return a.eventSlug.localeCompare(b.eventSlug);
  });
}

export async function fetchWeatherMarkets(
  config: AppConfig,
  options: WeatherScanOptions = {}
): Promise<WeatherMarketGroup[]> {
  const [polymarket, kalshi] = await Promise.all([
    fetchPolymarketWeatherMarkets(config, options),
    fetchKalshiWeatherMarkets(config, options)
  ]);
  return [...polymarket, ...kalshi]
    .filter((group) => options.date === undefined || group.date === options.date)
    .sort((a, b) => {
    const endDate = (a.eventEndDate ?? "").localeCompare(b.eventEndDate ?? "");
    if (endDate !== 0) return endDate;
    return a.eventSlug.localeCompare(b.eventSlug);
  });
}
