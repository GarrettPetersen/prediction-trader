import type { AppConfig } from "../config.js";

const POLYMARKET_DATA_API_BASE_URL = "https://data-api.polymarket.com";
const POLYMARKET_GAMMA_BASE_URL = "https://gamma-api.polymarket.com";
const NON_ZERO_POSITION_EPSILON = 0.000001;

export interface PolymarketPositionsOptions {
  includeZero?: boolean;
  limit?: number;
  redeemableOnly?: boolean;
}

export interface PolymarketEventOptions {
  includeOrderbook?: boolean;
}

export function parseGammaList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value !== "string" || value.length === 0) return [];

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function numberValue(value: unknown): number {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

async function fetchJson(url: URL): Promise<unknown> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Polymarket data request failed with HTTP ${response.status}: ${await response.text()}`);
  }
  return response.json();
}

function normalizePosition(position: Record<string, unknown>) {
  return {
    title: typeof position.title === "string" ? position.title : undefined,
    outcome: typeof position.outcome === "string" ? position.outcome : undefined,
    size: numberValue(position.size),
    avgPrice: numberValue(position.avgPrice),
    currentValue: numberValue(position.currentValue),
    curPrice: numberValue(position.curPrice),
    cashPnl: numberValue(position.cashPnl),
    percentPnl: numberValue(position.percentPnl),
    redeemable: position.redeemable === true,
    slug: typeof position.slug === "string" ? position.slug : undefined,
    eventSlug: typeof position.eventSlug === "string" ? position.eventSlug : undefined,
    conditionId: typeof position.conditionId === "string" ? position.conditionId : undefined,
    asset: typeof position.asset === "string" ? position.asset : undefined,
    outcomeIndex: numberValue(position.outcomeIndex),
    negativeRisk: position.negativeRisk === true,
    endDate: typeof position.endDate === "string" ? position.endDate : undefined
  };
}

export async function getPolymarketPositions(
  config: AppConfig,
  options: PolymarketPositionsOptions = {}
) {
  const user = config.polymarket.funderAddress;
  if (!user) {
    throw new Error("POLYMARKET_FUNDER_ADDRESS is required for polymarket:positions.");
  }

  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 200), 1), 500);
  const url = new URL("/positions", POLYMARKET_DATA_API_BASE_URL);
  url.searchParams.set("user", user);
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("sortBy", "CURRENT");
  url.searchParams.set("sortDirection", "DESC");

  const rawPositions = await fetchJson(url);
  if (!Array.isArray(rawPositions)) {
    throw new Error("Polymarket positions response was not an array.");
  }

  let positions = rawPositions
    .filter((position): position is Record<string, unknown> => Boolean(position && typeof position === "object"))
    .map(normalizePosition);
  if (!options.includeZero) {
    positions = positions.filter((position) => position.size > NON_ZERO_POSITION_EPSILON);
  }
  if (options.redeemableOnly) {
    positions = positions.filter((position) => position.redeemable);
  }

  const redeemable = positions.filter((position) => position.redeemable);

  return {
    user,
    count: positions.length,
    totalCurrentValue: positions.reduce((sum, position) => sum + position.currentValue, 0),
    redeemableCount: redeemable.length,
    redeemableCurrentValue: redeemable.reduce((sum, position) => sum + position.currentValue, 0),
    positions
  };
}

async function getPolymarketBook(config: AppConfig, tokenId: string) {
  const url = new URL("/book", config.polymarket.host);
  url.searchParams.set("token_id", tokenId);
  const book = await fetchJson(url);
  if (!book || typeof book !== "object") return {};

  const rawBook = book as Record<string, unknown>;
  const bids = Array.isArray(rawBook.bids) ? rawBook.bids : [];
  const asks = Array.isArray(rawBook.asks) ? rawBook.asks : [];
  const normalizeLevel = (level: unknown) => {
    if (!level || typeof level !== "object") return undefined;
    const record = level as Record<string, unknown>;
    return {
      price: numberValue(record.price),
      size: numberValue(record.size)
    };
  };
  const bidLevels = bids
    .map(normalizeLevel)
    .filter((level): level is { price: number; size: number } => Boolean(level))
    .sort((a, b) => b.price - a.price);
  const askLevels = asks
    .map(normalizeLevel)
    .filter((level): level is { price: number; size: number } => Boolean(level))
    .sort((a, b) => a.price - b.price);

  return {
    bestBid: bidLevels[0],
    bestAsk: askLevels[0]
  };
}

export async function getPolymarketEvent(
  config: AppConfig,
  slug: string,
  options: PolymarketEventOptions = {}
) {
  const url = new URL("/events", POLYMARKET_GAMMA_BASE_URL);
  url.searchParams.set("slug", slug);

  const events = await fetchJson(url);
  if (!Array.isArray(events) || events.length === 0) {
    throw new Error(`No Polymarket event found for slug ${slug}.`);
  }

  const event = events[0] as Record<string, unknown>;
  const markets = Array.isArray(event.markets) ? event.markets : [];

  return {
    slug: event.slug,
    title: event.title,
    active: event.active,
    closed: event.closed,
    live: event.live,
    score: event.score,
    elapsed: event.elapsed,
    period: event.period,
    ended: event.ended,
    finishedTimestamp: event.finishedTimestamp,
    startTime: event.startTime,
    endDate: event.endDate,
    markets: await Promise.all(
      markets
        .filter((market): market is Record<string, unknown> => Boolean(market && typeof market === "object"))
        .map(async (market) => {
          const outcomes = parseGammaList(market.outcomes);
          const tokenIds = parseGammaList(market.clobTokenIds);
          const prices = parseGammaList(market.outcomePrices).map(numberValue);
          return {
            slug: market.slug,
            question: market.question,
            conditionId: market.conditionId,
            outcomes: await Promise.all(
              outcomes.map(async (outcome, index) => {
                const tokenId = tokenIds[index];
                return {
                  outcome,
                  tokenId,
                  price: prices[index],
                  orderbook:
                    options.includeOrderbook && tokenId
                      ? await getPolymarketBook(config, tokenId)
                      : undefined
                };
              })
            )
          };
        })
    )
  };
}
