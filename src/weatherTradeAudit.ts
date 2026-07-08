import type { LedgerMarketRef, LedgerRecord } from "./ledger.js";
import {
  isWeatherLedgerMarket,
  ledgerPnlKey,
  ledgerRecordTime,
  type LedgerPnlMarkMode,
  type LedgerPnlVenue,
  type LedgerPositionMark
} from "./ledgerPnl.js";
import {
  parseWeatherMarketQuestion,
  type WeatherMeasure,
  type WeatherOutcomeKind
} from "./weatherMarkets.js";
import type { Venue } from "./types.js";

export interface WeatherTradeAuditOptions {
  venue?: LedgerPnlVenue;
  since?: string;
  until?: string;
  markMode?: LedgerPnlMarkMode;
  marks?: LedgerPositionMark[];
}

export interface WeatherTradeAuditClassification {
  marketType: string;
  side: "YES" | "NO";
  city?: string;
  date?: string;
  measure?: WeatherMeasure;
  outcomeKind?: WeatherOutcomeKind;
  unit?: "C" | "F";
}

export interface WeatherTradeAuditPnl {
  buyUsd: number;
  sellUsd: number;
  redemptionUsd: number;
  realizedUsd: number;
  liveShares: number;
  liveMidPrice?: number;
  liveBidPrice?: number;
  liveMidValueUsd: number;
  liveBidValueUsd: number;
  pnlMidUsd: number;
  pnlBidUsd: number;
  selectedPnlUsd: number;
  selectedRoi: number | undefined;
}

export interface WeatherTradeAuditPosition {
  key: string;
  venue: Venue;
  market: LedgerMarketRef;
  oppositeMarket: LedgerMarketRef;
  classification: WeatherTradeAuditClassification;
  firstBuyAt?: string;
  lastActivityAt?: string;
  buyShares: number;
  sellShares: number;
  redeemedShares: number;
  actual: WeatherTradeAuditPnl;
  opposite: WeatherTradeAuditPnl;
}

export interface WeatherTradeAuditBucket {
  key: string;
  positionCount: number;
  actualBuyUsd: number;
  actualSelectedPnlUsd: number;
  actualRoi: number | undefined;
  oppositeSelectedPnlUsd: number;
  oppositeRoi: number | undefined;
  oppositeAdvantageUsd: number;
}

export interface WeatherTradeAuditReport {
  venue: LedgerPnlVenue;
  since?: string;
  until?: string;
  markMode: LedgerPnlMarkMode;
  positionCount: number;
  excludedPositionCount: number;
  excludedPositions: Array<{ key: string; reason: string; question?: string; outcome?: string | number }>;
  actual: WeatherTradeAuditPnl & {
    winnerCount: number;
    loserCount: number;
  };
  opposite: WeatherTradeAuditPnl & {
    winnerCount: number;
    loserCount: number;
  };
  oppositeAdvantageUsd: number;
  buckets: {
    bySide: WeatherTradeAuditBucket[];
    byMarketType: WeatherTradeAuditBucket[];
    byMarketTypeAndSide: WeatherTradeAuditBucket[];
  };
  positions: WeatherTradeAuditPosition[];
}

interface MutableAuditPosition {
  key: string;
  venue: Venue;
  market: LedgerMarketRef;
  buys: LedgerRecord[];
  sells: LedgerRecord[];
  redeems: LedgerRecord[];
  firstBuyAt?: string;
  lastActivityAt?: string;
}

const EPSILON = 1e-9;

function isVenue(value: string | undefined): value is Venue {
  return value === "polymarket" || value === "vistadex";
}

function wantedVenue(record: LedgerRecord, venue: LedgerPnlVenue): boolean {
  return venue === "all" || record.venue === venue;
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

function wantedRecord(record: LedgerRecord, options: Required<Pick<WeatherTradeAuditOptions, "venue">> & WeatherTradeAuditOptions): boolean {
  if (record.action !== "fill" && record.action !== "order" && record.action !== "redeem") return false;
  if (!isVenue(record.venue)) return false;
  if (!wantedVenue(record, options.venue)) return false;
  if (!isWeatherLedgerMarket(record.market)) return false;
  const time = ledgerRecordTime(record);
  return isAfterOrEqual(time, options.since) && isBeforeOrEqual(time, options.until);
}

function getGroup(groups: Map<string, MutableAuditPosition>, record: LedgerRecord): MutableAuditPosition {
  const key = ledgerPnlKey(record.venue, record.market);
  if (!key) {
    throw new Error(`Cannot audit weather trade without a market key: ${record.id}`);
  }
  const existing = groups.get(key);
  if (existing) {
    existing.market = mergeMarketRef(existing.market, record.market);
    return existing;
  }
  const created: MutableAuditPosition = {
    key,
    venue: record.venue,
    market: record.market ?? {},
    buys: [],
    sells: [],
    redeems: []
  };
  groups.set(key, created);
  return created;
}

function applyRecord(group: MutableAuditPosition, record: LedgerRecord): void {
  const time = ledgerRecordTime(record);
  group.lastActivityAt = later(group.lastActivityAt, time);
  if (record.action === "fill" || record.action === "order") {
    if (record.side === "buy") {
      group.buys.push(record);
      group.firstBuyAt = earlier(group.firstBuyAt, time);
    } else if (record.side === "sell") {
      group.sells.push(record);
    }
  } else if (record.action === "redeem") {
    group.redeems.push(record);
  }
}

function finitePositive(value: number | undefined, label: string, record: LedgerRecord): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    throw new Error(`Cannot audit ${record.id}: missing or invalid ${label}.`);
  }
  return value;
}

function recordShares(record: LedgerRecord): number {
  return finitePositive(record.shares, "shares", record);
}

function recordPrice(record: LedgerRecord): number {
  if (record.price !== undefined && Number.isFinite(record.price) && record.price >= 0 && record.price <= 1) {
    return record.price;
  }
  const shares = recordShares(record);
  const notionalUsd = finitePositive(record.notionalUsd, "notionalUsd", record);
  const price = notionalUsd / shares;
  if (!Number.isFinite(price) || price < 0 || price > 1) {
    throw new Error(`Cannot audit ${record.id}: inferred price ${price} is outside [0, 1].`);
  }
  return price;
}

function recordNotionalUsd(record: LedgerRecord): number {
  if (record.notionalUsd !== undefined && Number.isFinite(record.notionalUsd) && record.notionalUsd >= 0) {
    return record.notionalUsd;
  }
  return recordShares(record) * recordPrice(record);
}

function oppositePrice(price: number, record: LedgerRecord): number {
  const opposite = 1 - price;
  if (!Number.isFinite(opposite) || opposite <= 0 || opposite >= 1) {
    throw new Error(`Cannot invert ${record.id}: opposite price ${opposite} is not executable.`);
  }
  return opposite;
}

function sideFromMarket(market: LedgerMarketRef, key: string): "YES" | "NO" {
  const outcome = market.outcome?.trim().toLowerCase();
  if (outcome === "yes") return "YES";
  if (outcome === "no") return "NO";
  if (market.outcomeIndex === 0) return "YES";
  if (market.outcomeIndex === 1) return "NO";
  throw new Error(`Cannot audit ${key}: binary outcome side is missing.`);
}

function oppositeMarket(market: LedgerMarketRef, side: "YES" | "NO"): LedgerMarketRef {
  return {
    ...market,
    tokenId: undefined,
    outcome: side === "YES" ? "No" : "Yes",
    outcomeIndex: market.outcomeIndex === 0 ? 1 : market.outcomeIndex === 1 ? 0 : undefined
  };
}

function classifyMarket(market: LedgerMarketRef, side: "YES" | "NO"): WeatherTradeAuditClassification {
  const parsed = market.question ? parseWeatherMarketQuestion(market.question) : undefined;
  if (!parsed) {
    return {
      marketType: "unparsed_weather",
      side
    };
  }
  return {
    marketType: `${parsed.measure}:${parsed.outcome.kind}:${parsed.outcome.unit}`,
    side,
    city: parsed.city,
    date: parsed.date,
    measure: parsed.measure,
    outcomeKind: parsed.outcome.kind,
    unit: parsed.outcome.unit
  };
}

function selectedPnl(pnl: Pick<WeatherTradeAuditPnl, "pnlMidUsd" | "pnlBidUsd">, markMode: LedgerPnlMarkMode): number {
  return markMode === "bid" ? pnl.pnlBidUsd : pnl.pnlMidUsd;
}

function finalizePnl(input: {
  buyUsd: number;
  sellUsd: number;
  redemptionUsd: number;
  liveShares: number;
  liveMidPrice?: number;
  liveBidPrice?: number;
  liveMidValueUsd: number;
  liveBidValueUsd: number;
  markMode: LedgerPnlMarkMode;
}): WeatherTradeAuditPnl {
  const realizedUsd = input.sellUsd + input.redemptionUsd;
  const pnlMidUsd = realizedUsd + input.liveMidValueUsd - input.buyUsd;
  const pnlBidUsd = realizedUsd + input.liveBidValueUsd - input.buyUsd;
  const selected = selectedPnl({ pnlMidUsd, pnlBidUsd }, input.markMode);
  return {
    buyUsd: input.buyUsd,
    sellUsd: input.sellUsd,
    redemptionUsd: input.redemptionUsd,
    realizedUsd,
    liveShares: input.liveShares,
    liveMidPrice: input.liveMidPrice,
    liveBidPrice: input.liveBidPrice,
    liveMidValueUsd: input.liveMidValueUsd,
    liveBidValueUsd: input.liveBidValueUsd,
    pnlMidUsd,
    pnlBidUsd,
    selectedPnlUsd: selected,
    selectedRoi: input.buyUsd > 0 ? selected / input.buyUsd : undefined
  };
}

function buildAuditPosition(
  group: MutableAuditPosition,
  mark: LedgerPositionMark | undefined,
  markMode: LedgerPnlMarkMode
): WeatherTradeAuditPosition {
  const side = sideFromMarket(group.market, group.key);
  let buyUsd = 0;
  let buyShares = 0;
  let oppositeBuyShares = 0;
  for (const buy of group.buys) {
    const notionalUsd = finitePositive(recordNotionalUsd(buy), "notionalUsd", buy);
    const shares = recordShares(buy);
    const price = recordPrice(buy);
    buyUsd += notionalUsd;
    buyShares += shares;
    oppositeBuyShares += notionalUsd / oppositePrice(price, buy);
  }

  if (buyUsd <= 0 || buyShares <= 0 || oppositeBuyShares <= 0) {
    throw new Error(`Cannot audit ${group.key}: no buy-side exposure in selected window.`);
  }

  const shareRatio = oppositeBuyShares / buyShares;
  let sellUsd = 0;
  let sellShares = 0;
  let oppositeSellUsd = 0;
  let oppositeSellShares = 0;
  for (const sell of group.sells) {
    const shares = recordShares(sell);
    const price = recordPrice(sell);
    sellShares += shares;
    sellUsd += recordNotionalUsd(sell);
    oppositeSellShares += shares * shareRatio;
    oppositeSellUsd += shares * shareRatio * oppositePrice(price, sell);
  }

  let redemptionUsd = 0;
  let redeemedShares = 0;
  let oppositeRedemptionUsd = 0;
  let oppositeRedeemedShares = 0;
  for (const redeem of group.redeems) {
    const shares = recordShares(redeem);
    const price = recordPrice(redeem);
    redeemedShares += shares;
    redemptionUsd += recordNotionalUsd(redeem);
    oppositeRedeemedShares += shares * shareRatio;
    oppositeRedemptionUsd += shares * shareRatio * (1 - price);
  }

  const exitedShares = sellShares + redeemedShares;
  if (exitedShares > buyShares + EPSILON) {
    throw new Error(`Cannot audit ${group.key}: selected window exits ${exitedShares} shares but only includes ${buyShares} bought shares.`);
  }

  const actualOpenShares = Math.max(0, buyShares - exitedShares);
  const oppositeOpenShares = Math.max(0, oppositeBuyShares - oppositeSellShares - oppositeRedeemedShares);
  if (actualOpenShares > EPSILON && !mark) {
    throw new Error(`Cannot audit ${group.key}: open position has no live mark. Increase --limit or run without a restrictive --since/--until.`);
  }

  let oppositeMidPrice: number | undefined;
  let oppositeBidPrice: number | undefined;
  if (oppositeOpenShares > EPSILON) {
    if (!mark || mark.midPrice === undefined || mark.askPrice === undefined) {
      throw new Error(`Cannot invert open position ${group.key}: live mark needs both midpoint and ask price.`);
    }
    oppositeMidPrice = 1 - mark.midPrice;
    oppositeBidPrice = 1 - mark.askPrice;
    if (oppositeMidPrice < 0 || oppositeMidPrice > 1 || oppositeBidPrice < 0 || oppositeBidPrice > 1) {
      throw new Error(`Cannot invert open position ${group.key}: complementary live prices are outside [0, 1].`);
    }
  }

  const actual = finalizePnl({
    buyUsd,
    sellUsd,
    redemptionUsd,
    liveShares: mark?.shares ?? 0,
    liveMidPrice: mark?.midPrice,
    liveBidPrice: mark?.bidPrice,
    liveMidValueUsd: mark?.midValueUsd ?? 0,
    liveBidValueUsd: mark?.bidValueUsd ?? 0,
    markMode
  });
  const opposite = finalizePnl({
    buyUsd,
    sellUsd: oppositeSellUsd,
    redemptionUsd: oppositeRedemptionUsd,
    liveShares: oppositeOpenShares,
    liveMidPrice: oppositeMidPrice,
    liveBidPrice: oppositeBidPrice,
    liveMidValueUsd: oppositeOpenShares * (oppositeMidPrice ?? 0),
    liveBidValueUsd: oppositeOpenShares * (oppositeBidPrice ?? 0),
    markMode
  });

  return {
    key: group.key,
    venue: group.venue,
    market: group.market,
    oppositeMarket: oppositeMarket(group.market, side),
    classification: classifyMarket(group.market, side),
    firstBuyAt: group.firstBuyAt,
    lastActivityAt: group.lastActivityAt,
    buyShares,
    sellShares,
    redeemedShares,
    actual,
    opposite
  };
}

function summarizePnl(positions: WeatherTradeAuditPosition[], selector: (position: WeatherTradeAuditPosition) => WeatherTradeAuditPnl) {
  const totals = positions.reduce((sum, position) => {
    const pnl = selector(position);
    sum.buyUsd += pnl.buyUsd;
    sum.sellUsd += pnl.sellUsd;
    sum.redemptionUsd += pnl.redemptionUsd;
    sum.realizedUsd += pnl.realizedUsd;
    sum.liveShares += pnl.liveShares;
    sum.liveMidValueUsd += pnl.liveMidValueUsd;
    sum.liveBidValueUsd += pnl.liveBidValueUsd;
    sum.pnlMidUsd += pnl.pnlMidUsd;
    sum.pnlBidUsd += pnl.pnlBidUsd;
    sum.selectedPnlUsd += pnl.selectedPnlUsd;
    return sum;
  }, {
    buyUsd: 0,
    sellUsd: 0,
    redemptionUsd: 0,
    realizedUsd: 0,
    liveShares: 0,
    liveMidValueUsd: 0,
    liveBidValueUsd: 0,
    pnlMidUsd: 0,
    pnlBidUsd: 0,
    selectedPnlUsd: 0,
    selectedRoi: undefined as number | undefined,
    winnerCount: 0,
    loserCount: 0
  });
  totals.selectedRoi = totals.buyUsd > 0 ? totals.selectedPnlUsd / totals.buyUsd : undefined;
  totals.winnerCount = positions.filter((position) => selector(position).selectedPnlUsd > 0).length;
  totals.loserCount = positions.filter((position) => selector(position).selectedPnlUsd < 0).length;
  return totals;
}

function bucketPositions(
  positions: WeatherTradeAuditPosition[],
  keyForPosition: (position: WeatherTradeAuditPosition) => string
): WeatherTradeAuditBucket[] {
  const buckets = new Map<string, WeatherTradeAuditPosition[]>();
  for (const position of positions) {
    const key = keyForPosition(position);
    const bucket = buckets.get(key) ?? [];
    bucket.push(position);
    buckets.set(key, bucket);
  }
  return [...buckets.entries()]
    .map(([key, bucket]) => {
      const actualBuyUsd = bucket.reduce((sum, position) => sum + position.actual.buyUsd, 0);
      const actualSelectedPnlUsd = bucket.reduce((sum, position) => sum + position.actual.selectedPnlUsd, 0);
      const oppositeSelectedPnlUsd = bucket.reduce((sum, position) => sum + position.opposite.selectedPnlUsd, 0);
      return {
        key,
        positionCount: bucket.length,
        actualBuyUsd,
        actualSelectedPnlUsd,
        actualRoi: actualBuyUsd > 0 ? actualSelectedPnlUsd / actualBuyUsd : undefined,
        oppositeSelectedPnlUsd,
        oppositeRoi: actualBuyUsd > 0 ? oppositeSelectedPnlUsd / actualBuyUsd : undefined,
        oppositeAdvantageUsd: oppositeSelectedPnlUsd - actualSelectedPnlUsd
      };
    })
    .sort((a, b) => b.oppositeAdvantageUsd - a.oppositeAdvantageUsd);
}

export function computeWeatherTradeAudit(
  records: LedgerRecord[],
  options: WeatherTradeAuditOptions = {}
): WeatherTradeAuditReport {
  const venue = options.venue ?? "vistadex";
  const markMode = options.markMode ?? "bid";
  const groups = new Map<string, MutableAuditPosition>();
  for (const record of records) {
    if (!wantedRecord(record, { ...options, venue })) continue;
    const group = getGroup(groups, record);
    applyRecord(group, record);
  }

  const marks = new Map((options.marks ?? []).map((mark) => [mark.key, mark]));
  const excludedPositions: WeatherTradeAuditReport["excludedPositions"] = [];
  const positions = [...groups.values()]
    .flatMap((group) => {
      if (group.buys.length === 0) {
        excludedPositions.push({
          key: group.key,
          reason: "No buy in the selected window.",
          question: group.market.question,
          outcome: group.market.outcome ?? group.market.outcomeIndex
        });
        return [];
      }
      return [buildAuditPosition(group, marks.get(group.key), markMode)];
    })
    .sort((a, b) => a.actual.selectedPnlUsd - b.actual.selectedPnlUsd);
  const actual = summarizePnl(positions, (position) => position.actual);
  const opposite = summarizePnl(positions, (position) => position.opposite);

  return {
    venue,
    since: options.since,
    until: options.until,
    markMode,
    positionCount: positions.length,
    excludedPositionCount: excludedPositions.length,
    excludedPositions,
    actual,
    opposite,
    oppositeAdvantageUsd: opposite.selectedPnlUsd - actual.selectedPnlUsd,
    buckets: {
      bySide: bucketPositions(positions, (position) => position.classification.side),
      byMarketType: bucketPositions(positions, (position) => position.classification.marketType),
      byMarketTypeAndSide: bucketPositions(positions, (position) => `${position.classification.marketType}|${position.classification.side}`)
    },
    positions
  };
}
