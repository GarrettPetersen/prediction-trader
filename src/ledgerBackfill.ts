import type { AppConfig } from "./config.js";
import {
  getPolymarketTradeHistory,
  type PolymarketTradeHistoryOptions
} from "./marketplaces/polymarket.js";
import {
  getPolymarketPositions,
  type PolymarketPosition
} from "./marketplaces/polymarketData.js";
import {
  getVistadexPublicActivity,
  getVistadexPositions,
  type VistadexActivityItem,
  type VistadexActivityOptions,
  type VistadexPosition
} from "./marketplaces/vistadex.js";
import {
  appendLedgerRecords,
  buildBackfillLedgerRecord,
  ledgerNumber,
  ledgerStringFrom,
  normalizeLedgerTimestamp,
  readLedgerRecords,
  summarizeLedger,
  type AppendLedgerResult,
  type LedgerRecord
} from "./ledger.js";
import type { TradeSide, Venue } from "./types.js";

export type LedgerBackfillVenue = Venue | "all";

export interface LedgerBackfillOptions {
  venue?: LedgerBackfillVenue;
  includePositions?: boolean;
  includeFills?: boolean;
  polymarketOnlyFirstPage?: boolean;
  polymarketTradeParams?: PolymarketTradeHistoryOptions;
  vistadexActivityParams?: VistadexActivityOptions;
  positionLimit?: number;
}

export interface LedgerBackfillResult extends AppendLedgerResult {
  summary: ReturnType<typeof summarizeLedger>;
  generated: {
    polymarketFills: number;
    polymarketPositions: number;
    vistadexActivity: number;
    vistadexFills: number;
    vistadexPositions: number;
    vistadexRedemptions: number;
  };
}

function normalizeSide(value: unknown): TradeSide | undefined {
  const text = String(value ?? "").toLowerCase();
  if (text === "buy" || text === "sell") return text;
  return undefined;
}

function recordFromPolymarketTrade(trade: unknown): LedgerRecord {
  const id = ledgerStringFrom(trade, ["id"]) ?? JSON.stringify(trade);
  const price = ledgerNumber(ledgerStringFrom(trade, ["price"]));
  const shares = ledgerNumber(ledgerStringFrom(trade, ["size"]));
  const notionalUsd = price !== undefined && shares !== undefined ? price * shares : undefined;
  const side = normalizeSide(ledgerStringFrom(trade, ["side"]));
  const outcome = ledgerStringFrom(trade, ["outcome"]);
  const market = ledgerStringFrom(trade, ["market"]);
  const assetId = ledgerStringFrom(trade, ["asset_id", "assetId"]);
  const orderId = ledgerStringFrom(trade, ["taker_order_id", "takerOrderId", "orderID", "orderId"]);
  const transactionHash = ledgerStringFrom(trade, ["transaction_hash", "transactionHash"]);

  return buildBackfillLedgerRecord({
    venue: "polymarket",
    action: "fill",
    dedupeKey: `polymarket:fill:${id}`,
    occurredAt: normalizeLedgerTimestamp(ledgerStringFrom(trade, ["match_time", "matchTime"])),
    status: ledgerStringFrom(trade, ["status"]),
    side,
    price,
    shares,
    notionalUsd,
    summary: [
      side?.toUpperCase(),
      shares === undefined ? undefined : `${shares} shares`,
      outcome,
      price === undefined ? undefined : `at ${price}`
    ].filter(Boolean).join(" "),
    market: {
      conditionId: market,
      tokenId: assetId,
      outcome
    },
    ids: {
      tradeId: id,
      orderId,
      transactionHash
    },
    raw: trade
  });
}

function recordFromPolymarketPosition(position: PolymarketPosition): LedgerRecord {
  const key = [
    "polymarket:position",
    position.asset ?? position.slug ?? position.conditionId ?? "unknown",
    position.outcomeIndex,
    position.size,
    position.avgPrice,
    position.currentValue,
    position.redeemable
  ].join(":");

  return buildBackfillLedgerRecord({
    venue: "polymarket",
    action: "position_snapshot",
    dedupeKey: key,
    status: position.redeemable ? "redeemable" : "open",
    price: position.avgPrice,
    shares: position.size,
    notionalUsd: position.avgPrice * position.size,
    summary: `${position.title ?? position.slug ?? "Polymarket position"}: ${position.outcome ?? "outcome"} ${position.size} shares`,
    market: {
      conditionId: position.conditionId,
      tokenId: position.asset,
      slug: position.slug,
      eventSlug: position.eventSlug,
      question: position.title,
      outcome: position.outcome,
      outcomeIndex: position.outcomeIndex
    },
    raw: position,
    notes: [
      "Backfilled from current Polymarket position state; this is not the original execution record."
    ]
  });
}

function recordFromVistadexPosition(position: VistadexPosition): LedgerRecord {
  const price = position.price?.midpoint;
  const shares = ledgerNumber(position.balance);
  const key = [
    "vistadex:position",
    position.conditionId ?? position.slug ?? "unknown",
    position.outcomeIndex,
    position.balance,
    price,
    position.status
  ].join(":");

  return buildBackfillLedgerRecord({
    venue: "vistadex",
    action: "position_snapshot",
    dedupeKey: key,
    status: position.status ?? (position.closed ? "closed" : "open"),
    price,
    shares,
    notionalUsd: price !== undefined && shares !== undefined ? price * shares : undefined,
    summary: `${position.question ?? position.slug ?? "Vistadex position"}: outcome ${position.outcomeIndex} ${position.balance} shares`,
    market: {
      conditionId: position.conditionId,
      slug: position.slug,
      question: position.question,
      outcome: position.outcomes[position.outcomeIndex],
      outcomeIndex: position.outcomeIndex
    },
    raw: position,
    notes: [
      "Backfilled from current Vistadex position state; this is not the original execution record."
    ]
  });
}

function vistadexActivityOutcome(item: VistadexActivityItem): string | undefined {
  return item.metadata?.outcomes?.[item.outcomeIndex]
    ?? (item.type === "redemption" ? item.outcomeLabel : undefined);
}

function recordFromVistadexActivity(item: VistadexActivityItem): LedgerRecord {
  const outcome = vistadexActivityOutcome(item);
  const metadata = item.metadata;
  const price = item.type === "trade"
    ? ledgerNumber(item.pricePerShare)
    : ledgerNumber(item.payout);
  const shares = item.type === "trade"
    ? ledgerNumber(item.shares)
    : ledgerNumber(item.quantity);
  const notionalUsd = item.type === "trade"
    ? ledgerNumber(item.totalUsd)
    : ledgerNumber(item.valueUsd);
  const action = item.type === "trade" ? "fill" : "redeem";
  const status = item.type === "trade"
    ? item.status
    : price === undefined
      ? "redeemed"
      : price > 0
        ? "redeemed_win"
        : "redeemed_loss";
  const side = item.type === "trade" ? item.side : undefined;
  const valueDescription = item.type === "trade"
    ? [
        side?.toUpperCase(),
        shares === undefined ? undefined : `${shares} shares`,
        outcome,
        price === undefined ? undefined : `at ${price}`
      ].filter(Boolean).join(" ")
    : [
        "REDEEM",
        shares === undefined ? undefined : `${shares} shares`,
        outcome,
        notionalUsd === undefined ? undefined : `for $${notionalUsd}`
      ].filter(Boolean).join(" ");

  return buildBackfillLedgerRecord({
    venue: "vistadex",
    action,
    dedupeKey: `vistadex:activity:${item.type}:${item.id}`,
    occurredAt: normalizeLedgerTimestamp(item.timestamp),
    status,
    side,
    price,
    shares,
    notionalUsd,
    summary: valueDescription,
    market: {
      conditionId: item.conditionId,
      slug: metadata?.slug,
      question: metadata?.question,
      outcome,
      outcomeIndex: item.outcomeIndex
    },
    ids: {
      activityId: item.id,
      transactionSignature: item.transactionSignature
    },
    raw: item,
    notes: [
      "Backfilled from Vistadex public profile activity."
    ]
  });
}

function wantsVenue(requested: LedgerBackfillVenue | undefined, venue: Venue): boolean {
  return requested === undefined || requested === "all" || requested === venue;
}

export async function buildLedgerBackfillRecords(
  config: AppConfig,
  options: LedgerBackfillOptions = {}
): Promise<{
  records: LedgerRecord[];
  generated: LedgerBackfillResult["generated"];
}> {
  const includePositions = options.includePositions ?? true;
  const includeFills = options.includeFills ?? true;
  const records: LedgerRecord[] = [];
  const generated = {
    polymarketFills: 0,
    polymarketPositions: 0,
    vistadexActivity: 0,
    vistadexFills: 0,
    vistadexRedemptions: 0,
    vistadexPositions: 0
  };

  if (wantsVenue(options.venue, "polymarket")) {
    if (includeFills) {
      const trades = await getPolymarketTradeHistory(config, {
        ...options.polymarketTradeParams,
        onlyFirstPage: options.polymarketOnlyFirstPage
      });
      const tradeRecords = trades.map(recordFromPolymarketTrade);
      generated.polymarketFills = tradeRecords.length;
      records.push(...tradeRecords);
    }

    if (includePositions) {
      const snapshot = await getPolymarketPositions(config, {
        includeZero: true,
        limit: options.positionLimit
      });
      const positionRecords = snapshot.positions.map(recordFromPolymarketPosition);
      generated.polymarketPositions = positionRecords.length;
      records.push(...positionRecords);
    }
  }

  if (wantsVenue(options.venue, "vistadex")) {
    if (includeFills) {
      const snapshot = await getVistadexPublicActivity(config, options.vistadexActivityParams);
      const activityRecords = snapshot.items.map(recordFromVistadexActivity);
      generated.vistadexActivity = activityRecords.length;
      generated.vistadexFills = activityRecords.filter((record) => record.action === "fill").length;
      generated.vistadexRedemptions = activityRecords.filter((record) => record.action === "redeem").length;
      records.push(...activityRecords);
    }

    if (includePositions) {
      const snapshot = await getVistadexPositions(config, {
        includeZero: true,
        limit: options.positionLimit
      });
      const positionRecords = snapshot.positions.map(recordFromVistadexPosition);
      generated.vistadexPositions = positionRecords.length;
      records.push(...positionRecords);
    }
  }

  return { records, generated };
}

export async function backfillLedger(
  config: AppConfig,
  path: string,
  options: LedgerBackfillOptions = {}
): Promise<LedgerBackfillResult> {
  const { records, generated } = await buildLedgerBackfillRecords(config, options);
  const appendResult = await appendLedgerRecords(path, records);
  const allRecords = await readLedgerRecords(path);
  return {
    ...appendResult,
    generated,
    summary: summarizeLedger(allRecords, path)
  };
}
