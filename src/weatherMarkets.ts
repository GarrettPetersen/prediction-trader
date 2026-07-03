import type { AppConfig } from "./config.js";
import { fahrenheitToCelsius } from "./weatherEdge.js";
import { parseGammaList } from "./marketplaces/polymarketData.js";

const POLYMARKET_GAMMA_BASE_URL = "https://gamma-api.polymarket.com";
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
}

export interface WeatherMarketCandidate {
  eventSlug: string;
  eventTitle: string;
  eventEndDate?: string;
  marketSlug: string;
  question: string;
  conditionId?: string;
  active: boolean;
  closed: boolean;
  acceptingOrders?: boolean;
  negRisk?: boolean;
  bestBid?: number;
  bestAsk?: number;
  liquidity?: number;
  volume?: number;
  outcomes: WeatherMarketOutcomeToken[];
  parsed: ParsedWeatherMarket;
}

export interface WeatherMarketGroup {
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
  limit?: number;
  maxPages?: number;
  includeExpired?: boolean;
  includeUnparsed?: boolean;
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

function normalizeWeatherMarketCandidate(
  event: Record<string, unknown>,
  market: Record<string, unknown>
): WeatherMarketCandidate | { unparsed: WeatherMarketGroup["unparsed"][number] } {
  const question = stringValue(market.question);
  const marketSlug = stringValue(market.slug);
  const eventSlug = stringValue(event.slug) ?? "";
  const eventTitle = stringValue(event.title) ?? "";
  const eventEndDate = stringValue(event.endDate);

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

  return {
    eventSlug,
    eventTitle,
    eventEndDate,
    marketSlug,
    question,
    conditionId: stringValue(market.conditionId),
    active: boolValue(market.active),
    closed: boolValue(market.closed),
    acceptingOrders: market.acceptingOrders === undefined ? undefined : boolValue(market.acceptingOrders),
    negRisk: market.negRisk === undefined ? undefined : boolValue(market.negRisk),
    bestBid: numberValue(market.bestBid),
    bestAsk: numberValue(market.bestAsk),
    liquidity: numberValue(market.liquidityNum ?? market.liquidity),
    volume: numberValue(market.volumeNum ?? market.volume),
    outcomes: outcomes.map((outcome, index) => ({
      outcome,
      tokenId: tokenIds[index],
      price: Number.isFinite(prices[index]) ? prices[index] : undefined
    })),
    parsed
  };
}

function groupKey(candidate: WeatherMarketCandidate): string {
  return [
    candidate.eventSlug,
    candidate.parsed.city.toLowerCase(),
    candidate.parsed.date,
    candidate.parsed.measure
  ].join("|");
}

async function fetchJson(url: URL): Promise<unknown> {
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

  for (let page = 0; page < maxPages; page += 1) {
    const url = new URL("/events", POLYMARKET_GAMMA_BASE_URL);
    url.searchParams.set("tag_slug", "weather");
    url.searchParams.set("active", "true");
    url.searchParams.set("closed", "false");
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("offset", String(page * limit));
    url.searchParams.set("order", "endDate");
    url.searchParams.set("ascending", "true");

    const raw = await fetchJson(url);
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
        if (!normalized.active || normalized.closed || normalized.acceptingOrders === false) continue;

        const key = groupKey(normalized);
        const existing = groups.get(key) ?? {
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
  const raw = await fetchJson(url);
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
