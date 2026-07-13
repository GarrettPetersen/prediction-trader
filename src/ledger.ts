import { createHash } from "node:crypto";
import { mkdir, readFile, appendFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type {
  PolymarketOrderTicket,
  PolymarketRedeemTicket,
  TradeExecution,
  TradePreview,
  TradeSide,
  Venue,
  VistadexTradeTicket
} from "./types.js";

export type LedgerSource = "execution" | "backfill" | "manual";
export type LedgerAction = "order" | "redeem" | "fill" | "position_snapshot" | "cash_snapshot";
export type LedgerTicket = PolymarketOrderTicket | PolymarketRedeemTicket | VistadexTradeTicket;

export interface LedgerMarketRef {
  conditionId?: string;
  marketId?: string;
  positionId?: string;
  tokenId?: string;
  slug?: string;
  eventSlug?: string;
  question?: string;
  outcome?: string;
  outcomeIndex?: number;
}

export interface LedgerIds {
  activityId?: string;
  orderId?: string;
  tradeId?: string;
  transactionHash?: string;
  transactionId?: string;
  transactionSignature?: string;
  rfqId?: string;
}

export interface LedgerRecord {
  version: 1;
  id: string;
  dedupeKey: string;
  source: LedgerSource;
  venue: Venue;
  action: LedgerAction;
  recordedAt: string;
  occurredAt?: string;
  command?: string;
  status?: string;
  side?: TradeSide;
  price?: number;
  shares?: number;
  notionalUsd?: number;
  summary?: string;
  market?: LedgerMarketRef;
  ids?: LedgerIds;
  ticket?: LedgerTicket;
  preview?: TradePreview;
  execution?: TradeExecution;
  metadata?: Record<string, unknown>;
  raw?: unknown;
  notes?: string[];
}

export interface AppendLedgerResult {
  path: string;
  attempted: number;
  appended: number;
  skipped: number;
  records: LedgerRecord[];
}

export interface LedgerSummary {
  path?: string;
  count: number;
  byVenue: Record<string, number>;
  bySource: Record<string, number>;
  byAction: Record<string, number>;
  byStatus: Record<string, number>;
  estimatedNotionalUsd: number;
  firstOccurredAt?: string;
  lastOccurredAt?: string;
}

export interface ExecutionLedgerInput {
  command: string;
  ticket: LedgerTicket;
  preview: TradePreview;
  execution: TradeExecution;
  action?: LedgerAction;
  market?: LedgerMarketRef;
  metadata?: Record<string, unknown>;
  recordedAt?: string;
}

function hashJson(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(value))
    .digest("hex");
}

export function resolveLedgerPath(path: string): string {
  return resolve(process.cwd(), path);
}

function ledgerId(dedupeKey: string): string {
  return `ledger_${hashJson(dedupeKey).slice(0, 24)}`;
}

function recordForJson(record: LedgerRecord): string {
  return `${JSON.stringify(record)}\n`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function stringField(value: unknown, keys: string[]): string | undefined {
  const record = asRecord(value);
  for (const key of keys) {
    const field = record[key];
    if (typeof field === "string" && field.length > 0) return field;
    if (typeof field === "number" && Number.isFinite(field)) return String(field);
  }
  return undefined;
}

function numberField(value: unknown, keys: string[]): number | undefined {
  const record = asRecord(value);
  for (const key of keys) {
    const field = record[key];
    const number = Number(field);
    if (Number.isFinite(number)) return number;
  }
  return undefined;
}

function idsFromExecution(execution: TradeExecution): LedgerIds {
  const details = asRecord(execution.details);
  const market = asRecord(details.market);
  return {
    orderId: stringField(details, ["orderID", "orderId", "order_id", "id"]),
    tradeId: stringField(details, ["tradeID", "tradeId", "trade_id"]),
    transactionHash: stringField(details, ["transactionHash", "transaction_hash"]),
    transactionId: stringField(details, ["transactionId", "transaction_id"]),
    transactionSignature: stringField(details, ["transactionSignature", "transaction_signature"]),
    rfqId: stringField(details, ["rfqId", "rfq_id"]) ?? stringField(market, ["rfqId", "rfq_id"])
  };
}

function marketFromTicket(ticket: LedgerTicket): LedgerMarketRef {
  if (ticket.venue === "polymarket" && "tokenId" in ticket) {
    return { tokenId: ticket.tokenId };
  }
  if (ticket.venue === "polymarket") {
    return {
      conditionId: ticket.conditionId,
      marketId: ticket.marketId,
      positionId: ticket.positionId
    };
  }
  return {
    conditionId: ticket.conditionId,
    outcomeIndex: ticket.outcomeIndex
  };
}

function marketFromExecutionInput(input: ExecutionLedgerInput): LedgerMarketRef {
  const ticketMarket = marketFromTicket(input.ticket);
  if (!input.market) return ticketMarket;

  const keys: Array<keyof LedgerMarketRef> = [
    "conditionId",
    "marketId",
    "positionId",
    "tokenId",
    "slug",
    "eventSlug",
    "question",
    "outcome",
    "outcomeIndex"
  ];
  for (const key of keys) {
    const ticketValue = ticketMarket[key];
    const suppliedValue = input.market[key];
    if (ticketValue !== undefined && suppliedValue !== undefined && ticketValue !== suppliedValue) {
      throw new Error(`Execution ledger market ${key} conflicts with the trade ticket.`);
    }
  }

  return {
    conditionId: input.market.conditionId ?? ticketMarket.conditionId,
    marketId: input.market.marketId ?? ticketMarket.marketId,
    positionId: input.market.positionId ?? ticketMarket.positionId,
    tokenId: input.market.tokenId ?? ticketMarket.tokenId,
    slug: input.market.slug ?? ticketMarket.slug,
    eventSlug: input.market.eventSlug ?? ticketMarket.eventSlug,
    question: input.market.question ?? ticketMarket.question,
    outcome: input.market.outcome ?? ticketMarket.outcome,
    outcomeIndex: input.market.outcomeIndex ?? ticketMarket.outcomeIndex
  };
}

function dedupeKeyFromExecution(input: ExecutionLedgerInput, ids: LedgerIds): string {
  if (input.ticket.venue === "polymarket" && input.action === "redeem") {
    return ids.transactionHash
      ? `polymarket:redeem:${ids.transactionHash}`
      : `polymarket:redeem:${hashJson({ ticket: input.ticket, execution: input.execution.details })}`;
  }
  if (input.ticket.venue === "polymarket") {
    return ids.orderId
      ? `polymarket:order:${ids.orderId}`
      : `polymarket:order:${hashJson({ ticket: input.ticket, execution: input.execution.details })}`;
  }
  return ids.transactionSignature
    ? `vistadex:trade:${ids.transactionSignature}`
    : ids.rfqId
      ? `vistadex:trade:${ids.rfqId}`
      : `vistadex:trade:${hashJson({ ticket: input.ticket, execution: input.execution.details })}`;
}

function vistadexFillFromExecution(execution: TradeExecution): {
  price?: number;
  shares?: number;
  notionalUsd?: number;
} {
  const details = asRecord(execution.details);
  const winningQuote = asRecord(details.winningQuote);
  return {
    price: numberField(winningQuote, ["pricePerShare", "price_per_share"]),
    shares: numberField(winningQuote, ["shares"]),
    notionalUsd: numberField(winningQuote, ["totalUsd", "total_usd"])
  };
}

export function buildExecutionLedgerRecord(input: ExecutionLedgerInput): LedgerRecord {
  const action = input.action ?? (input.ticket.venue === "polymarket" && "positionId" in input.ticket ? "redeem" : "order");
  const ids = idsFromExecution(input.execution);
  const dedupeKey = dedupeKeyFromExecution({ ...input, action }, ids);
  const fill = input.ticket.venue === "vistadex" ? vistadexFillFromExecution(input.execution) : {};
  const ticketShares = "shares" in input.ticket ? input.ticket.shares : undefined;
  const ticketPrice = "price" in input.ticket
    ? input.ticket.price
    : "limitPrice" in input.ticket
      ? input.ticket.limitPrice
      : undefined;
  const shares = fill.shares ?? ticketShares;
  const price = fill.price ?? ticketPrice;

  return {
    version: 1,
    id: ledgerId(dedupeKey),
    dedupeKey,
    source: "execution",
    venue: input.ticket.venue,
    action,
    recordedAt: input.recordedAt ?? new Date().toISOString(),
    command: input.command,
    status: input.execution.status,
    side: "side" in input.ticket ? input.ticket.side : undefined,
    price,
    shares,
    notionalUsd: fill.notionalUsd ?? input.preview.notionalUsd,
    summary: input.preview.summary,
    market: marketFromExecutionInput(input),
    ids,
    ticket: input.ticket,
    preview: input.preview,
    execution: input.execution,
    metadata: input.metadata
  };
}

export async function readLedgerRecords(path: string): Promise<LedgerRecord[]> {
  const absolutePath = resolveLedgerPath(path);
  let text: string;
  try {
    text = await readFile(absolutePath, "utf8");
  } catch (error) {
    if (asRecord(error).code === "ENOENT") return [];
    throw error;
  }

  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => {
      try {
        return JSON.parse(line) as LedgerRecord;
      } catch (error) {
        throw new Error(`Failed to parse ledger line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
}

export async function appendLedgerRecords(
  path: string,
  records: LedgerRecord[]
): Promise<AppendLedgerResult> {
  const absolutePath = resolveLedgerPath(path);
  const existing = await readLedgerRecords(path);
  const seen = new Set(existing.flatMap((record) => [record.id, record.dedupeKey]));
  const appendable = records.filter((record) => {
    if (seen.has(record.id) || seen.has(record.dedupeKey)) return false;
    seen.add(record.id);
    seen.add(record.dedupeKey);
    return true;
  });

  if (appendable.length > 0) {
    await mkdir(dirname(absolutePath), { recursive: true });
    await appendFile(absolutePath, appendable.map(recordForJson).join(""), "utf8");
  }

  return {
    path: absolutePath,
    attempted: records.length,
    appended: appendable.length,
    skipped: records.length - appendable.length,
    records: appendable
  };
}

export async function appendExecutionLedgerRecord(
  path: string,
  input: ExecutionLedgerInput
): Promise<AppendLedgerResult> {
  return appendLedgerRecords(path, [buildExecutionLedgerRecord(input)]);
}

function increment(target: Record<string, number>, key: string | undefined): void {
  const safeKey = key && key.length > 0 ? key : "unknown";
  target[safeKey] = (target[safeKey] ?? 0) + 1;
}

function sortDateStrings(values: string[]): string[] {
  return values
    .filter((value) => !Number.isNaN(Date.parse(value)))
    .sort((a, b) => Date.parse(a) - Date.parse(b));
}

export function summarizeLedger(records: LedgerRecord[], path?: string): LedgerSummary {
  const summary: LedgerSummary = {
    path: path ? resolveLedgerPath(path) : undefined,
    count: records.length,
    byVenue: {},
    bySource: {},
    byAction: {},
    byStatus: {},
    estimatedNotionalUsd: 0
  };

  for (const record of records) {
    increment(summary.byVenue, record.venue);
    increment(summary.bySource, record.source);
    increment(summary.byAction, record.action);
    increment(summary.byStatus, record.status);
    summary.estimatedNotionalUsd += record.notionalUsd ?? 0;
  }

  const occurredAt = sortDateStrings(records.flatMap((record) => record.occurredAt ?? record.recordedAt));
  summary.firstOccurredAt = occurredAt[0];
  summary.lastOccurredAt = occurredAt.at(-1);
  return summary;
}

export function filterLedgerRecords(
  records: LedgerRecord[],
  filters: {
    venue?: string;
    source?: string;
    action?: string;
    limit?: number;
  } = {}
): LedgerRecord[] {
  let filtered = records;
  if (filters.venue) filtered = filtered.filter((record) => record.venue === filters.venue);
  if (filters.source) filtered = filtered.filter((record) => record.source === filters.source);
  if (filters.action) filtered = filtered.filter((record) => record.action === filters.action);
  const limit = Math.trunc(filters.limit ?? filtered.length);
  return filtered.slice(Math.max(0, filtered.length - limit));
}

export function buildBackfillLedgerRecord(input: {
  venue: Venue;
  action: LedgerAction;
  dedupeKey: string;
  occurredAt?: string;
  status?: string;
  side?: TradeSide;
  price?: number;
  shares?: number;
  notionalUsd?: number;
  summary?: string;
  market?: LedgerMarketRef;
  ids?: LedgerIds;
  raw: unknown;
  notes?: string[];
  recordedAt?: string;
}): LedgerRecord {
  return {
    version: 1,
    id: ledgerId(input.dedupeKey),
    dedupeKey: input.dedupeKey,
    source: "backfill",
    venue: input.venue,
    action: input.action,
    recordedAt: input.recordedAt ?? new Date().toISOString(),
    occurredAt: input.occurredAt,
    status: input.status,
    side: input.side,
    price: input.price,
    shares: input.shares,
    notionalUsd: input.notionalUsd,
    summary: input.summary,
    market: input.market,
    ids: input.ids,
    raw: input.raw,
    notes: input.notes
  };
}

export function normalizeLedgerTimestamp(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  if (typeof value === "number" && Number.isFinite(value)) {
    const millis = value > 10_000_000_000 ? value : value * 1000;
    return new Date(millis).toISOString();
  }
  const text = String(value);
  const numeric = Number(text);
  if (Number.isFinite(numeric) && text.trim() !== "") {
    const millis = numeric > 10_000_000_000 ? numeric : numeric * 1000;
    return new Date(millis).toISOString();
  }
  const millis = Date.parse(text);
  return Number.isNaN(millis) ? undefined : new Date(millis).toISOString();
}

export function ledgerNumber(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

export function ledgerNumberFrom(value: unknown, keys: string[]): number | undefined {
  return numberField(value, keys);
}

export function ledgerStringFrom(value: unknown, keys: string[]): string | undefined {
  return stringField(value, keys);
}
