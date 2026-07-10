import type { LedgerRecord, LedgerMarketRef } from "./ledger.js";
import type { PolymarketPosition } from "./marketplaces/polymarketData.js";
import type { VistadexPosition } from "./marketplaces/vistadex.js";
import type { Venue } from "./types.js";

export type LedgerPnlVenue = Venue | "all";
export type LedgerPnlCategory = "all" | "weather" | "non-weather";
export type LedgerPnlMarkMode = "mid" | "bid";

export interface LedgerPositionMark {
  venue: Venue;
  key: string;
  market: LedgerMarketRef;
  status?: string;
  shares: number;
  midValueUsd: number;
  bidValueUsd: number;
  midPrice?: number;
  bidPrice?: number;
  askPrice?: number;
}

export interface LedgerPnlOptions {
  venue?: LedgerPnlVenue;
  category?: LedgerPnlCategory;
  since?: string;
  until?: string;
  includeSellOnly?: boolean;
  markMode?: LedgerPnlMarkMode;
  marks?: LedgerPositionMark[];
}

export interface LedgerPnlPosition {
  key: string;
  venue: Venue;
  category: "weather" | "non-weather";
  market: LedgerMarketRef;
  firstActivityAt?: string;
  firstBuyAt?: string;
  lastActivityAt?: string;
  buyUsd: number;
  sellUsd: number;
  redemptionUsd: number;
  realizedUsd: number;
  buyShares: number;
  sellShares: number;
  redeemedShares: number;
  liveShares: number;
  liveMidPrice?: number;
  liveBidPrice?: number;
  liveMidValueUsd: number;
  liveBidValueUsd: number;
  pnlMidUsd: number;
  pnlBidUsd: number;
  selectedPnlUsd: number;
  status?: string;
}

export interface LedgerPnlReport {
  venue: LedgerPnlVenue;
  category: LedgerPnlCategory;
  since?: string;
  until?: string;
  markMode: LedgerPnlMarkMode;
  positionCount: number;
  winnerCount: number;
  loserCount: number;
  breakEvenCount: number;
  totals: {
    buyUsd: number;
    sellUsd: number;
    redemptionUsd: number;
    realizedUsd: number;
    liveMidValueUsd: number;
    liveBidValueUsd: number;
    pnlMidUsd: number;
    pnlBidUsd: number;
    selectedPnlUsd: number;
    selectedRoi: number | undefined;
  };
  positions: LedgerPnlPosition[];
}

interface MutablePnlPosition {
  key: string;
  venue: Venue;
  category: "weather" | "non-weather";
  market: LedgerMarketRef;
  firstActivityAt?: string;
  firstBuyAt?: string;
  lastActivityAt?: string;
  buyUsd: number;
  sellUsd: number;
  redemptionUsd: number;
  buyShares: number;
  sellShares: number;
  redeemedShares: number;
}

const WEATHER_PATTERN = /temperature|weather|rain|snow|wind/i;

function isVenue(value: string | undefined): value is Venue {
  return value === "polymarket" || value === "vistadex";
}

export function isWeatherLedgerMarket(market: LedgerMarketRef | undefined): boolean {
  return WEATHER_PATTERN.test(`${market?.question ?? ""} ${market?.slug ?? ""} ${market?.eventSlug ?? ""}`);
}

export function ledgerRecordTime(record: LedgerRecord): string | undefined {
  return record.occurredAt ?? record.recordedAt;
}

function isAfterOrEqual(value: string | undefined, boundary: string | undefined): boolean {
  if (!boundary) return true;
  if (!value) throw new Error(`Ledger record is missing a timestamp required by --since ${boundary}.`);
  const valueMs = Date.parse(value);
  const boundaryMs = Date.parse(boundary);
  if (Number.isNaN(valueMs)) throw new Error(`Ledger record has an invalid timestamp: ${value}`);
  if (Number.isNaN(boundaryMs)) throw new Error(`Invalid --since timestamp: ${boundary}`);
  return valueMs >= boundaryMs;
}

function isBeforeOrEqual(value: string | undefined, boundary: string | undefined): boolean {
  if (!boundary) return true;
  if (!value) throw new Error(`Ledger record is missing a timestamp required by --until ${boundary}.`);
  const valueMs = Date.parse(value);
  const boundaryMs = Date.parse(boundary);
  if (Number.isNaN(valueMs)) throw new Error(`Ledger record has an invalid timestamp: ${value}`);
  if (Number.isNaN(boundaryMs)) throw new Error(`Invalid --until timestamp: ${boundary}`);
  return valueMs <= boundaryMs;
}

function earlier(a: string | undefined, b: string | undefined): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return Date.parse(a) <= Date.parse(b) ? a : b;
}

function later(a: string | undefined, b: string | undefined): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return Date.parse(a) >= Date.parse(b) ? a : b;
}

function cleanOutcome(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function ledgerPnlKey(venue: Venue, market: LedgerMarketRef | undefined): string | undefined {
  if (!market) return undefined;
  if (venue === "polymarket" && market.tokenId) return `polymarket:token:${market.tokenId}`;
  if (market.conditionId && market.outcomeIndex !== undefined) {
    return `${venue}:condition:${market.conditionId}:outcome:${market.outcomeIndex}`;
  }
  if (market.conditionId && market.outcome) {
    return `${venue}:condition:${market.conditionId}:outcome:${market.outcome}`;
  }
  if (market.slug && market.outcomeIndex !== undefined) {
    return `${venue}:slug:${market.slug}:outcome:${market.outcomeIndex}`;
  }
  if (market.slug && market.outcome) {
    return `${venue}:slug:${market.slug}:outcome:${market.outcome}`;
  }
  return undefined;
}

function mergeMarketRef(current: LedgerMarketRef, next: LedgerMarketRef | undefined): LedgerMarketRef {
  if (!next) return current;
  return {
    conditionId: current.conditionId ?? next.conditionId,
    marketId: current.marketId ?? next.marketId,
    positionId: current.positionId ?? next.positionId,
    tokenId: current.tokenId ?? next.tokenId,
    slug: current.slug ?? next.slug,
    eventSlug: current.eventSlug ?? next.eventSlug,
    question: current.question ?? next.question,
    outcome: current.outcome ?? next.outcome,
    outcomeIndex: current.outcomeIndex ?? next.outcomeIndex
  };
}

function wantedVenue(record: LedgerRecord, venue: LedgerPnlVenue): boolean {
  return venue === "all" || record.venue === venue;
}

function wantedCategory(record: LedgerRecord, category: LedgerPnlCategory): boolean {
  if (category === "all") return true;
  const weather = isWeatherLedgerMarket(record.market);
  return category === "weather" ? weather : !weather;
}

function wantedRecord(record: LedgerRecord, options: Required<Pick<LedgerPnlOptions, "venue" | "category">> & LedgerPnlOptions): boolean {
  const time = ledgerRecordTime(record);
  return wantedVenue(record, options.venue)
    && wantedCategory(record, options.category)
    && isAfterOrEqual(time, options.since)
    && isBeforeOrEqual(time, options.until);
}

function addAmount(value: number | undefined): number {
  return value === undefined ? 0 : value;
}

function getGroup(groups: Map<string, MutablePnlPosition>, record: LedgerRecord): MutablePnlPosition | undefined {
  const key = ledgerPnlKey(record.venue, record.market);
  if (!key) return undefined;
  const existing = groups.get(key);
  if (existing) {
    existing.market = mergeMarketRef(existing.market, record.market);
    return existing;
  }

  const created: MutablePnlPosition = {
    key,
    venue: record.venue,
    category: isWeatherLedgerMarket(record.market) ? "weather" : "non-weather",
    market: record.market ?? {},
    buyUsd: 0,
    sellUsd: 0,
    redemptionUsd: 0,
    buyShares: 0,
    sellShares: 0,
    redeemedShares: 0
  };
  groups.set(key, created);
  return created;
}

function applyRecord(group: MutablePnlPosition, record: LedgerRecord): void {
  const time = ledgerRecordTime(record);
  group.firstActivityAt = earlier(group.firstActivityAt, time);
  group.lastActivityAt = later(group.lastActivityAt, time);

  if (record.action === "fill" || record.action === "order") {
    if (record.side === "buy") {
      group.firstBuyAt = earlier(group.firstBuyAt, time);
      group.buyUsd += addAmount(record.notionalUsd);
      group.buyShares += addAmount(record.shares);
    } else if (record.side === "sell") {
      group.sellUsd += addAmount(record.notionalUsd);
      group.sellShares += addAmount(record.shares);
    }
    return;
  }

  if (record.action === "redeem") {
    group.redemptionUsd += addAmount(record.notionalUsd);
    group.redeemedShares += addAmount(record.shares);
  }
}

function finalizePosition(
  group: MutablePnlPosition,
  mark: LedgerPositionMark | undefined,
  markMode: LedgerPnlMarkMode
): LedgerPnlPosition {
  const realizedUsd = group.sellUsd + group.redemptionUsd;
  const liveMidValueUsd = mark?.midValueUsd ?? 0;
  const liveBidValueUsd = mark?.bidValueUsd ?? 0;
  const pnlMidUsd = realizedUsd + liveMidValueUsd - group.buyUsd;
  const pnlBidUsd = realizedUsd + liveBidValueUsd - group.buyUsd;

  return {
    ...group,
    realizedUsd,
    liveShares: mark?.shares ?? 0,
    liveMidPrice: mark?.midPrice,
    liveBidPrice: mark?.bidPrice,
    liveMidValueUsd,
    liveBidValueUsd,
    pnlMidUsd,
    pnlBidUsd,
    selectedPnlUsd: markMode === "bid" ? pnlBidUsd : pnlMidUsd,
    status: mark?.status
  };
}

function summarizePositions(
  positions: LedgerPnlPosition[],
  venue: LedgerPnlVenue,
  category: LedgerPnlCategory,
  markMode: LedgerPnlMarkMode,
  since?: string,
  until?: string
): LedgerPnlReport {
  const totals = positions.reduce((sum, position) => {
    sum.buyUsd += position.buyUsd;
    sum.sellUsd += position.sellUsd;
    sum.redemptionUsd += position.redemptionUsd;
    sum.realizedUsd += position.realizedUsd;
    sum.liveMidValueUsd += position.liveMidValueUsd;
    sum.liveBidValueUsd += position.liveBidValueUsd;
    sum.pnlMidUsd += position.pnlMidUsd;
    sum.pnlBidUsd += position.pnlBidUsd;
    sum.selectedPnlUsd += position.selectedPnlUsd;
    return sum;
  }, {
    buyUsd: 0,
    sellUsd: 0,
    redemptionUsd: 0,
    realizedUsd: 0,
    liveMidValueUsd: 0,
    liveBidValueUsd: 0,
    pnlMidUsd: 0,
    pnlBidUsd: 0,
    selectedPnlUsd: 0,
    selectedRoi: undefined as number | undefined
  });
  totals.selectedRoi = totals.buyUsd > 0 ? totals.selectedPnlUsd / totals.buyUsd : undefined;

  return {
    venue,
    category,
    since,
    until,
    markMode,
    positionCount: positions.length,
    winnerCount: positions.filter((position) => position.selectedPnlUsd > 0).length,
    loserCount: positions.filter((position) => position.selectedPnlUsd < 0).length,
    breakEvenCount: positions.filter((position) => position.selectedPnlUsd === 0).length,
    totals,
    positions
  };
}

export function computeLedgerPnl(records: LedgerRecord[], options: LedgerPnlOptions = {}): LedgerPnlReport {
  const venue = options.venue ?? "vistadex";
  const category = options.category ?? "all";
  const markMode = options.markMode ?? "mid";
  const includeSellOnly = options.includeSellOnly ?? false;
  const groups = new Map<string, MutablePnlPosition>();

  for (const record of records) {
    if (record.action !== "fill" && record.action !== "order" && record.action !== "redeem") continue;
    if (!isVenue(record.venue)) continue;
    if (!wantedRecord(record, { ...options, venue, category })) continue;
    const group = getGroup(groups, record);
    if (!group) continue;
    applyRecord(group, record);
  }

  const marks = new Map((options.marks ?? []).map((mark) => [mark.key, mark]));
  const positions = [...groups.values()]
    .filter((group) => includeSellOnly || group.buyUsd > 0)
    .map((group) => finalizePosition(group, marks.get(group.key), markMode))
    .sort((a, b) => a.selectedPnlUsd - b.selectedPnlUsd);

  return summarizePositions(positions, venue, category, markMode, options.since, options.until);
}

export function markFromVistadexPosition(position: VistadexPosition): LedgerPositionMark | undefined {
  const market: LedgerMarketRef = {
    conditionId: position.conditionId,
    slug: position.slug,
    question: position.question,
    outcome: cleanOutcome(position.outcomes[position.outcomeIndex]),
    outcomeIndex: position.outcomeIndex
  };
  const key = ledgerPnlKey("vistadex", market);
  if (!key) return undefined;
  const shares = Number(position.balance);
  if (!Number.isFinite(shares)) {
    throw new Error(`Invalid Vistadex position balance for ${position.slug ?? position.conditionId ?? key}: ${position.balance}`);
  }
  const isTradable = position.status === "active" && position.closed !== true;
  const midPrice = isTradable ? position.price?.midpoint : undefined;
  const bidPrice = isTradable ? position.price?.bestBid : undefined;
  const askPrice = isTradable ? position.price?.bestAsk : undefined;

  return {
    venue: "vistadex",
    key,
    market,
    status: position.closed === true ? "closed" : position.status,
    shares: isTradable ? shares : 0,
    midPrice,
    bidPrice,
    askPrice,
    midValueUsd: isTradable && midPrice !== undefined ? shares * midPrice : 0,
    bidValueUsd: isTradable && bidPrice !== undefined ? shares * bidPrice : 0
  };
}

export function markFromPolymarketPosition(position: PolymarketPosition): LedgerPositionMark | undefined {
  const market: LedgerMarketRef = {
    conditionId: position.conditionId,
    tokenId: position.asset,
    slug: position.slug,
    eventSlug: position.eventSlug,
    question: position.title,
    outcome: position.outcome,
    outcomeIndex: position.outcomeIndex
  };
  const key = ledgerPnlKey("polymarket", market);
  if (!key) return undefined;

  return {
    venue: "polymarket",
    key,
    market,
    status: position.redeemable ? "redeemable" : "open",
    shares: position.size,
    midPrice: position.curPrice,
    bidPrice: position.curPrice,
    askPrice: position.curPrice,
    midValueUsd: position.currentValue,
    bidValueUsd: position.currentValue
  };
}
