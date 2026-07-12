import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AppConfig } from "./config.js";
import {
  appendExecutionLedgerRecord,
  readLedgerRecords,
  type AppendLedgerResult
} from "./ledger.js";
import {
  markFromVistadexPosition
} from "./ledgerPnl.js";
import {
  createVistadexTradeQuote,
  executeVistadexQuotedTrade,
  getVistadexEvent,
  getVistadexPositions,
  getVistadexUSDCBalance,
  previewVistadexTrade,
  type VistadexPosition,
  type VistadexTradeQuote
} from "./marketplaces/vistadex.js";
import { assertCanExecute } from "./safety.js";
import type { TradeExecution, VistadexTradeTicket } from "./types.js";
import {
  computeWeatherEdgeReport,
  localIsoDateDaysFrom,
  type WeatherEdgeReport,
  type WeatherEdgeRow,
  type WeatherEdgeReportOptions
} from "./weatherEdges.js";
import {
  computeWeatherTradeAudit,
  type WeatherTradeAuditReport
} from "./weatherTradeAudit.js";
import { parseWeatherMarketQuestion } from "./weatherMarkets.js";
import { resolutionSourceFromText } from "./weatherStations.js";
import {
  assessWeatherEntryWindow,
  assertWeatherEntryWindowMinutes,
  DEFAULT_HIGH_ENTRY_END_MINUTES,
  DEFAULT_HIGH_ENTRY_START_MINUTES,
  DEFAULT_LOW_ENTRY_END_MINUTES,
  DEFAULT_LOW_ENTRY_START_MINUTES,
  type WeatherEntryWindowAssessment
} from "./weatherTradingWindow.js";
import {
  fetchOpenMeteoForecastFreshness,
  type WeatherForecastFreshnessAssessment
} from "./weatherForecastFreshness.js";
import type {
  WeatherMarketAnchorPricingOptions,
  WeatherTradingStrategy
} from "./weatherPricing.js";

export type WeatherReinvestConfidence = "LOW" | "MEDIUM" | "HIGH";

const DEFAULT_VISTADEX_QUOTE_TIMEOUT_MS = 90_000;
const DEFAULT_VISTADEX_FILLER_TIMEOUT_MS = 120_000;
const DEFAULT_VISTADEX_EXECUTION_ATTEMPTS = 2;
const DEFAULT_VISTADEX_RETRY_BACKOFF_MS = 10_000;

export interface WeatherReinvestOptions extends Pick<
  WeatherEdgeReportOptions,
  | "date"
  | "daysAhead"
  | "limit"
  | "maxPages"
  | "maxEvents"
  | "concurrency"
  | "minLiquidity"
  | "highGraceMinutes"
  | "lowGraceMinutes"
> {
  execute?: boolean;
  ledgerPath?: string;
  bankrollUsd?: number;
  maxPerTradeUsd?: number;
  strategy?: WeatherTradingStrategy;
  marketAnchorCoefficient?: number;
  marketAnchorMinOppositeMarketProbability?: number;
  kellyMultiplier?: number;
  maxKellyFraction?: number;
  maxGroupFraction?: number;
  maxBuySpendUsd?: number;
  maxBuySpendFraction?: number;
  portfolioStepUsd?: number;
  minEdge?: number;
  skipClimatology?: boolean;
  skipCalibration?: boolean;
  calibrationHalfLifeDays?: number;
  cityBiasPriorWeight?: number;
  sellBidThreshold?: number;
  sellMinPrice?: number;
  minSellShares?: number;
  minTradeUsd?: number;
  minCashToReinvestUsd?: number;
  targetCashReserveUsd?: number;
  maxBuys?: number;
  minConfidence?: WeatherReinvestConfidence;
  buyMinExecutableEdge?: number;
  buyQuoteDriftUsd?: number;
  pauseBuys?: boolean;
  highEntryStartLocalMinutes?: number;
  highEntryEndLocalMinutes?: number;
  lowEntryStartLocalMinutes?: number;
  lowEntryEndLocalMinutes?: number;
  maxModelRunAgeHours?: number;
  requireRecentAuditPositive?: boolean;
  auditLookbackHours?: number;
  auditMinPositions?: number;
  vistadexQuoteTimeoutMs?: number;
  vistadexFillerTimeoutMs?: number;
  vistadexMaxAttempts?: number;
  vistadexRetryBackoffMs?: number;
  now?: Date;
}

export interface WeatherReinvestQuoteDetails {
  pricePerShare: number;
  shares: number;
  totalUsd: number;
  filler?: string;
}

export interface WeatherReinvestTradeResult {
  action: "sell_locked" | "buy_edge";
  status: "filled" | "submitted" | "unknown" | "quoted" | "skipped" | "failed";
  slug?: string;
  question?: string;
  conditionId?: string;
  outcomeIndex?: number;
  outcome?: string;
  side?: "buy" | "sell";
  amountUsd?: number;
  shares?: number;
  rfqId?: string;
  quote?: WeatherReinvestQuoteDetails;
  fill?: WeatherReinvestQuoteDetails;
  transactionSignature?: string;
  ledger?: AppendLedgerResult;
  attempts?: WeatherReinvestExecutionAttempt[];
  reason?: string;
  error?: string;
  edge?: number;
  fairPrice?: number;
  confidence?: WeatherReinvestConfidence;
  groupKey?: string;
  modelMode?: WeatherEdgeRow["modelMode"];
  calibrationTargetKey?: string;
  calibrationSamples?: number;
  calibrationBiasC?: number;
  calibrationTargetBiasC?: number;
  calibrationMeanAbsoluteErrorC?: number;
  consensusMeanC?: number;
  consensusSigmaC?: number;
  strategy?: WeatherEdgeRow["strategy"];
  originalBestSide?: WeatherEdgeRow["originalBestSide"];
  originalEdge?: number;
  originalFair?: number;
  originalReferencePrice?: number;
  oppositeMarketProbability?: number;
  marketAnchorCoefficient?: number;
  entryWindow?: WeatherEntryWindowAssessment;
}

export interface WeatherReinvestExecutionAttempt {
  attempt: number;
  maxAttempts: number;
  startedAt: string;
  finishedAt: string;
  rfqId?: string;
  status: "filled" | "submitted" | "unknown" | "failed";
  error?: string;
  retryable?: boolean;
  nextDelayMs?: number;
}

export interface WeatherReinvestReport {
  execute: boolean;
  pauseBuys: boolean;
  strategy: WeatherTradingStrategy;
  startedAt: string;
  finishedAt: string;
  ledgerPath: string;
  initial: WeatherReinvestStateSummary;
  afterSells: WeatherReinvestStateSummary;
  final: WeatherReinvestStateSummary;
  bankrollUsd: number;
  bankrollSource: "computed_vistadex_mark_to_mid" | "override";
  targetCashReserveUsd: number;
  deployableCashUsd: number;
  buyCashBudgetUsd: number;
  targetDate: string;
  vistadexExecution: {
    quoteTimeoutMs: number;
    fillerTimeoutMs: number;
    maxAttempts: number;
    retryBackoffMs: number;
  };
  weatherEdge: Pick<
    WeatherEdgeReport,
    "scannedGroups" | "targetGroups" | "pricedGroups" | "timeSkippedGroups" | "erroredGroups" | "marketCount" | "rowCount" | "signalCount" | "errors"
  >;
  sold: WeatherReinvestTradeResult[];
  bought: WeatherReinvestTradeResult[];
  skipped: WeatherReinvestTradeResult[];
  forecastFreshness?: WeatherForecastFreshnessAssessment;
  auditGate?: WeatherReinvestAuditGate;
  warnings: string[];
}

export interface WeatherReinvestStateSummary {
  cashUsd: number;
  positionCount: number;
  weatherPositionCount: number;
  markedPositionValueUsd: number;
  markedWeatherValueUsd: number;
  computedBankrollUsd: number;
}

export function weatherReinvestExecutionFailures(report: WeatherReinvestReport): WeatherReinvestTradeResult[] {
  return [...report.sold, ...report.bought, ...report.skipped].filter((trade) =>
    trade.status === "failed" &&
    (trade.attempts ?? []).some((attempt) => attempt.status === "failed")
  );
}

export interface WeatherReinvestAuditGate {
  enabled: boolean;
  passed: boolean;
  since: string;
  lookbackHours: number;
  minPositions: number;
  positionCount: number;
  actualPnlUsd: number;
  oppositePnlUsd: number;
  oppositeAdvantageUsd: number;
  reason: string;
}

interface VistadexMarketReference {
  slug: string;
  question?: string;
  conditionId: string;
  description?: string;
  resolutionSource?: string;
}

type WeatherEdgeSummary = WeatherReinvestReport["weatherEdge"];

const WEATHER_QUESTION_PATTERN = /temperature|weather|rain|snow|wind|humidity|precip/i;

const CONFIDENCE_RANK: Record<WeatherReinvestConfidence, number> = {
  LOW: 0,
  MEDIUM: 1,
  HIGH: 2
};

function numberValue(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function positiveInteger(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved < 1) {
    throw new Error(`${label} must be a positive integer.`);
  }
  return Math.trunc(resolved);
}

function nonNegativeFinite(value: number | undefined, fallback: number, label: string): number {
  const resolved = value ?? fallback;
  if (!Number.isFinite(resolved) || resolved < 0) {
    throw new Error(`${label} must be a non-negative number.`);
  }
  return resolved;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function isRetryableVistadexExecutionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /timed out waiting for filler action|timed out waiting for rfq websocket subscription|websocket closed while waiting for filler action|websocket closed while waiting for auction result|fetch failed|network|socket|econnreset|etimedout|eai_again/i.test(message);
}

export function vistadexExecutionRetryDelayMs(baseDelayMs: number, attempt: number): number {
  if (!Number.isFinite(baseDelayMs) || baseDelayMs < 0) {
    throw new Error("Vistadex retry backoff must be a non-negative number.");
  }
  if (!Number.isFinite(attempt) || attempt < 1) {
    throw new Error("Vistadex retry attempt must be a positive number.");
  }
  return Math.round(baseDelayMs * (2 ** Math.max(0, Math.trunc(attempt) - 1)));
}

export function deployableWeatherCash(cashUsd: number, targetCashReserveUsd = 0): number {
  return roundUsd(Math.max(0, cashUsd - Math.max(0, targetCashReserveUsd)));
}

export function weatherBuyCashBudget(input: {
  deployableCashUsd: number;
  bankrollUsd: number;
  maxBuySpendUsd?: number;
  maxBuySpendFraction?: number;
}): number {
  if (!Number.isFinite(input.deployableCashUsd) || input.deployableCashUsd < 0) {
    throw new Error("WeatherEdge deployable cash must be a non-negative number.");
  }
  if (!Number.isFinite(input.bankrollUsd) || input.bankrollUsd < 0) {
    throw new Error("WeatherEdge bankroll must be a non-negative number.");
  }
  let budget = input.deployableCashUsd;
  if (input.maxBuySpendUsd !== undefined) {
    if (!Number.isFinite(input.maxBuySpendUsd) || input.maxBuySpendUsd < 0) {
      throw new Error("WeatherEdge max buy spend USD must be a non-negative number.");
    }
    budget = Math.min(budget, input.maxBuySpendUsd);
  }
  if (input.maxBuySpendFraction !== undefined) {
    if (!Number.isFinite(input.maxBuySpendFraction) || input.maxBuySpendFraction < 0 || input.maxBuySpendFraction > 1) {
      throw new Error("WeatherEdge max buy spend fraction must be between 0 and 1.");
    }
    budget = Math.min(budget, input.bankrollUsd * input.maxBuySpendFraction);
  }
  return roundUsd(budget);
}

export function requireReinvestMinEdge(minEdge?: number): number {
  if (minEdge === undefined || !Number.isFinite(minEdge)) {
    throw new Error("weather:reinvest requires --min-edge; do not rely on implicit live-trading edge thresholds.");
  }
  return minEdge;
}

export function requireReinvestPricingStrategy(options: Pick<
  WeatherReinvestOptions,
  "strategy" | "marketAnchorCoefficient" | "marketAnchorMinOppositeMarketProbability" | "buyMinExecutableEdge"
>): {
  strategy: WeatherTradingStrategy;
  marketAnchor?: WeatherMarketAnchorPricingOptions;
} {
  if (options.strategy === undefined) {
    throw new Error("weather:reinvest requires --strategy; do not rely on an implicit live-trading model.");
  }
  if (options.strategy === "forecast_edge") {
    if (
      options.marketAnchorCoefficient !== undefined ||
      options.marketAnchorMinOppositeMarketProbability !== undefined
    ) {
      throw new Error("Market-anchor parameters are only valid with --strategy market-informed-inverse.");
    }
    return { strategy: options.strategy };
  }
  if (options.strategy !== "market_informed_inverse") {
    throw new Error(`Unsupported WeatherEdge strategy: ${String(options.strategy)}.`);
  }
  const coefficient = options.marketAnchorCoefficient;
  const minOppositeMarketProbability = options.marketAnchorMinOppositeMarketProbability;
  if (coefficient === undefined || !Number.isFinite(coefficient) || coefficient >= 0) {
    throw new Error("market-informed-inverse requires --market-anchor-coefficient with a finite negative value.");
  }
  if (
    minOppositeMarketProbability === undefined ||
    !Number.isFinite(minOppositeMarketProbability) ||
    minOppositeMarketProbability < 0 ||
    minOppositeMarketProbability > 1
  ) {
    throw new Error("market-informed-inverse requires --market-anchor-min-opposite-probability between 0 and 1.");
  }
  const minExecutableEdge = options.buyMinExecutableEdge ?? 0.03;
  return {
    strategy: options.strategy,
    marketAnchor: {
      coefficient,
      minOppositeMarketProbability,
      minExecutableEdge
    }
  };
}

export function assertReinvestCalibrationEnabled(skipCalibration?: boolean): void {
  if (skipCalibration === true) {
    throw new Error("weather:reinvest requires calibrated historical residuals; --no-calibration is only for diagnostics.");
  }
}

export function requirePositiveModelRunAgeHours(value: number | undefined): number {
  const maxAgeHours = value ?? 12;
  if (!Number.isFinite(maxAgeHours) || maxAgeHours <= 0) {
    throw new Error("WeatherEdge max model run age must be a positive number of hours.");
  }
  return maxAgeHours;
}

function isWeatherPosition(position: VistadexPosition): boolean {
  return WEATHER_QUESTION_PATTERN.test(position.question ?? "");
}

function positionBalance(position: VistadexPosition): number {
  return numberValue(position.balance) ?? 0;
}

function positionMarkUsd(position: VistadexPosition): number {
  const price = position.price?.midpoint ?? position.price?.bestBid ?? 0;
  return positionBalance(position) * price;
}

function stateSummary(cashUsd: number, positions: VistadexPosition[]): WeatherReinvestStateSummary {
  const weatherPositions = positions.filter(isWeatherPosition);
  const markedPositionValueUsd = positions.reduce((sum, position) => sum + positionMarkUsd(position), 0);
  const markedWeatherValueUsd = weatherPositions.reduce((sum, position) => sum + positionMarkUsd(position), 0);
  return {
    cashUsd: roundUsd(cashUsd),
    positionCount: positions.length,
    weatherPositionCount: weatherPositions.length,
    markedPositionValueUsd: roundUsd(markedPositionValueUsd),
    markedWeatherValueUsd: roundUsd(markedWeatherValueUsd),
    computedBankrollUsd: roundUsd(cashUsd + markedPositionValueUsd)
  };
}

function quoteDetails(value: unknown): WeatherReinvestQuoteDetails | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const source = (record.quote && typeof record.quote === "object")
    ? record.quote as Record<string, unknown>
    : (record.summary && typeof record.summary === "object")
      ? record.summary as Record<string, unknown>
      : record;
  const pricePerShare = numberValue(source.pricePerShare ?? source.price_per_share);
  const shares = numberValue(source.shares);
  const totalUsd = numberValue(source.totalUsd ?? source.total_usd);
  if (pricePerShare === undefined || shares === undefined || totalUsd === undefined) return undefined;
  return {
    pricePerShare,
    shares,
    totalUsd,
    filler: typeof source.filler === "string" ? source.filler : undefined
  };
}

function fillDetails(execution: TradeExecution): WeatherReinvestQuoteDetails | undefined {
  const details = execution.details as Record<string, unknown>;
  return quoteDetails(details.winningQuote);
}

function transactionSignature(execution: TradeExecution): string | undefined {
  const value = (execution.details as Record<string, unknown>).transactionSignature;
  return typeof value === "string" ? value : undefined;
}

function groupKeyFromQuestion(question?: string): string | undefined {
  if (!question) return undefined;
  const parsed = parseWeatherMarketQuestion(question);
  if (!parsed) return undefined;
  return `${parsed.city.toLowerCase()}|${parsed.date}`;
}

function groupKeyFromRow(row: WeatherEdgeRow): string {
  return `${row.city.toLowerCase()}|${row.date}`;
}

function entryWindowFromRow(
  row: WeatherEdgeRow,
  options: Pick<
    WeatherReinvestOptions,
    | "highEntryStartLocalMinutes"
    | "highEntryEndLocalMinutes"
    | "lowEntryStartLocalMinutes"
    | "lowEntryEndLocalMinutes"
    | "now"
  >
): WeatherEntryWindowAssessment {
  return assessWeatherEntryWindow({
    targetDate: row.date,
    measure: row.measure,
    timezone: row.tradingWindow?.timezone,
    now: options.now,
    highEntryStartMinutes: options.highEntryStartLocalMinutes,
    highEntryEndMinutes: options.highEntryEndLocalMinutes,
    lowEntryStartMinutes: options.lowEntryStartLocalMinutes,
    lowEntryEndMinutes: options.lowEntryEndLocalMinutes
  });
}

function currentGroupExposure(positions: VistadexPosition[]): Map<string, number> {
  const exposure = new Map<string, number>();
  for (const position of positions) {
    if (!isWeatherPosition(position)) continue;
    const key = groupKeyFromQuestion(position.question);
    if (!key) continue;
    exposure.set(key, (exposure.get(key) ?? 0) + positionMarkUsd(position));
  }
  return exposure;
}

function targetDateFromOptions(options: WeatherReinvestOptions): string {
  return options.date ?? localIsoDateDaysFrom(new Date(), options.daysAhead ?? 1);
}

function emptyWeatherEdgeSummary(): WeatherEdgeSummary {
  return {
    scannedGroups: 0,
    targetGroups: 0,
    pricedGroups: 0,
    timeSkippedGroups: 0,
    erroredGroups: 0,
    marketCount: 0,
    rowCount: 0,
    signalCount: 0,
    errors: []
  };
}

export function evaluateReinvestAuditGate(input: {
  report: {
    positionCount: number;
    actual: Pick<WeatherTradeAuditReport["actual"], "selectedPnlUsd">;
    opposite: Pick<WeatherTradeAuditReport["opposite"], "selectedPnlUsd">;
    oppositeAdvantageUsd: number;
  };
  since: string;
  lookbackHours: number;
  minPositions: number;
}): WeatherReinvestAuditGate {
  const actualPnlUsd = input.report.actual.selectedPnlUsd;
  const oppositePnlUsd = input.report.opposite.selectedPnlUsd;
  const enoughPositions = input.report.positionCount >= input.minPositions;
  const actualOutperformedOpposite = actualPnlUsd >= oppositePnlUsd;
  const actualNonNegative = actualPnlUsd >= 0;
  const passed = enoughPositions && actualOutperformedOpposite && actualNonNegative;
  const reason = !enoughPositions
    ? `Only ${input.report.positionCount} audited WeatherEdge positions since ${input.since}; need at least ${input.minPositions}.`
    : !actualNonNegative
      ? `Recent WeatherEdge PnL is negative (${actualPnlUsd.toFixed(2)}).`
      : !actualOutperformedOpposite
        ? `Recent WeatherEdge PnL (${actualPnlUsd.toFixed(2)}) trails market-informed opposite PnL (${oppositePnlUsd.toFixed(2)}).`
        : `Recent WeatherEdge PnL (${actualPnlUsd.toFixed(2)}) is non-negative and beats market-informed opposite PnL (${oppositePnlUsd.toFixed(2)}).`;

  return {
    enabled: true,
    passed,
    since: input.since,
    lookbackHours: input.lookbackHours,
    minPositions: input.minPositions,
    positionCount: input.report.positionCount,
    actualPnlUsd,
    oppositePnlUsd,
    oppositeAdvantageUsd: input.report.oppositeAdvantageUsd,
    reason
  };
}

async function assessRecentAuditGate(
  ledgerPath: string,
  positions: VistadexPosition[],
  options: Required<Pick<WeatherReinvestOptions, "auditLookbackHours" | "auditMinPositions">> & Pick<WeatherReinvestOptions, "now">
): Promise<WeatherReinvestAuditGate> {
  const now = options.now ?? new Date();
  const since = new Date(now.getTime() - options.auditLookbackHours * 3_600_000).toISOString();
  const marks = positions.flatMap((position) => {
    const mark = markFromVistadexPosition(position);
    return mark ? [mark] : [];
  });
  const report = computeWeatherTradeAudit(await readLedgerRecords(ledgerPath), {
    venue: "vistadex",
    since,
    markMode: "bid",
    marks
  });
  return evaluateReinvestAuditGate({
    report,
    since,
    lookbackHours: options.auditLookbackHours,
    minPositions: options.auditMinPositions
  });
}

function tradeMayHaveMutatedState(trade: WeatherReinvestTradeResult): boolean {
  return trade.status === "filled" || trade.status === "submitted" || trade.status === "unknown";
}

function tradeCashTotalUsd(trade: WeatherReinvestTradeResult): number | undefined {
  return trade.fill?.totalUsd ?? trade.quote?.totalUsd ?? trade.amountUsd;
}

function expectedSellProceedsUsd(trades: WeatherReinvestTradeResult[], execute: boolean): number {
  return roundUsd(trades.reduce((sum, trade) => {
    if (trade.status === "filled") return sum + (tradeCashTotalUsd(trade) ?? 0);
    if (execute && (trade.status === "submitted" || trade.status === "unknown")) return sum + (tradeCashTotalUsd(trade) ?? 0);
    return sum;
  }, 0));
}

function expectedBuySpendUsd(trades: WeatherReinvestTradeResult[], execute: boolean): number {
  return roundUsd(trades.reduce((sum, trade) => {
    if (trade.status === "filled") return sum + (tradeCashTotalUsd(trade) ?? 0);
    if (execute && (trade.status === "submitted" || trade.status === "unknown")) return sum + (tradeCashTotalUsd(trade) ?? 0);
    return sum;
  }, 0));
}

function withCashUsd<T extends { cashUsd: number; positions: VistadexPosition[]; summary: WeatherReinvestStateSummary }>(
  state: T,
  cashUsd: number
): T {
  return {
    ...state,
    cashUsd,
    summary: stateSummary(cashUsd, state.positions)
  };
}

async function loadVistadexState(config: AppConfig): Promise<{
  cashUsd: number;
  positions: VistadexPosition[];
  summary: WeatherReinvestStateSummary;
}> {
  const [cash, snapshot] = await Promise.all([
    getVistadexUSDCBalance(config),
    getVistadexPositions(config, { limit: 250 })
  ]);
  const cashUsd = numberValue(cash.cashUsd) ?? 0;
  return {
    cashUsd,
    positions: snapshot.positions,
    summary: stateSummary(cashUsd, snapshot.positions)
  };
}

async function maybeExecuteVistadexTrade(
  config: AppConfig,
  ledgerPath: string,
  ticket: VistadexTradeTicket,
  execute: boolean,
  options: {
    quote: VistadexTradeQuote;
    refreshQuote?: () => Promise<VistadexTradeQuote>;
    validateQuote?: (quote: VistadexTradeQuote) => void;
    maxAttempts: number;
    retryBackoffMs: number;
  }
): Promise<{
  execution?: TradeExecution;
  ledger?: AppendLedgerResult;
  attempts: WeatherReinvestExecutionAttempt[];
  quote?: VistadexTradeQuote;
}> {
  if (!execute) return { attempts: [] };
  assertCanExecute(ticket, config.safety, execute);
  const preview = previewVistadexTrade(ticket);
  const attempts: WeatherReinvestExecutionAttempt[] = [];
  let lastError: unknown;
  let activeQuote = options.quote;

  for (let attempt = 1; attempt <= options.maxAttempts; attempt += 1) {
    const startedAt = new Date().toISOString();
    let rfqId = activeQuote.rfqId;
    try {
      if (attempt > 1 && options.refreshQuote) {
        activeQuote = await options.refreshQuote();
        rfqId = activeQuote.rfqId;
      }
      options.validateQuote?.(activeQuote);
      const execution = await executeVistadexQuotedTrade(config, ticket, activeQuote);
      const executionRfqId = (execution.details as Record<string, unknown>).rfqId;
      rfqId = typeof executionRfqId === "string" ? executionRfqId : rfqId;
      attempts.push({
        attempt,
        maxAttempts: options.maxAttempts,
        startedAt,
        finishedAt: new Date().toISOString(),
        rfqId,
        status: execution.status
      });
      const ledger = await appendExecutionLedgerRecord(ledgerPath, {
        command: "weather:reinvest",
        ticket,
        preview,
        execution,
        action: "order"
      });
      return { execution, ledger, attempts, quote: activeQuote };
    } catch (error) {
      lastError = error;
      const retryable = isRetryableVistadexExecutionError(error);
      const shouldRetry = retryable && attempt < options.maxAttempts;
      const nextDelayMs = shouldRetry ? vistadexExecutionRetryDelayMs(options.retryBackoffMs, attempt) : undefined;
      attempts.push({
        attempt,
        maxAttempts: options.maxAttempts,
        startedAt,
        finishedAt: new Date().toISOString(),
        rfqId,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
        retryable,
        nextDelayMs
      });
      if (!shouldRetry) break;
      if (nextDelayMs && nextDelayMs > 0) await sleep(nextDelayMs);
    }
  }

  const executionError = lastError instanceof Error ? lastError : new Error(String(lastError));
  (executionError as Error & { attempts?: WeatherReinvestExecutionAttempt[] }).attempts = attempts;
  throw executionError;
}

async function sellLockedWeatherPositions(
  config: AppConfig,
  ledgerPath: string,
  positions: VistadexPosition[],
  options: Required<Pick<
    WeatherReinvestOptions,
    | "execute"
    | "sellBidThreshold"
    | "sellMinPrice"
    | "minSellShares"
    | "vistadexQuoteTimeoutMs"
    | "vistadexFillerTimeoutMs"
    | "vistadexMaxAttempts"
    | "vistadexRetryBackoffMs"
  >>
): Promise<{
  sold: WeatherReinvestTradeResult[];
  skipped: WeatherReinvestTradeResult[];
  warnings: string[];
}> {
  const sold: WeatherReinvestTradeResult[] = [];
  const skipped: WeatherReinvestTradeResult[] = [];
  const warnings: string[] = [];
  const candidates = positions
    .filter((position) =>
      isWeatherPosition(position) &&
      position.closed !== true &&
      position.conditionId &&
      (position.outcomeIndex === 0 || position.outcomeIndex === 1) &&
      positionBalance(position) >= options.minSellShares &&
      (position.price?.bestBid ?? 0) >= options.sellBidThreshold
    );

  for (const position of candidates) {
    const shares = positionBalance(position);
    const ticket: VistadexTradeTicket = {
      venue: "vistadex",
      side: "sell",
      conditionId: position.conditionId as string,
      outcomeIndex: position.outcomeIndex as 0 | 1,
      shares,
      limitPrice: options.sellMinPrice,
      quoteTimeoutMs: options.vistadexQuoteTimeoutMs,
      fillerTimeoutMs: options.vistadexFillerTimeoutMs
    };
    const base = {
      action: "sell_locked" as const,
      slug: position.slug,
      question: position.question,
      conditionId: position.conditionId,
      outcomeIndex: position.outcomeIndex,
      outcome: position.outcomes[position.outcomeIndex],
      side: "sell" as const,
      shares,
      groupKey: groupKeyFromQuestion(position.question)
    };

    let attempts: WeatherReinvestExecutionAttempt[] = [];
    let rfqId: string | undefined;
    try {
      const quoteResult = await createVistadexTradeQuote(config, ticket);
      rfqId = quoteResult.rfqId;
      const quote = quoteDetails(quoteResult);
      if (!quote || quote.pricePerShare < options.sellMinPrice) {
        skipped.push({
          ...base,
          status: "skipped",
          rfqId: quoteResult.rfqId,
          quote,
          reason: quote
            ? `Sell quote ${quote.pricePerShare.toFixed(4)} below floor ${options.sellMinPrice.toFixed(4)}.`
            : "No executable sell quote."
        });
        continue;
      }

      const validateSellQuote = (candidate: VistadexTradeQuote) => {
        const candidateQuote = quoteDetails(candidate);
        if (!candidateQuote) {
          throw new Error("Retry sell RFQ did not return an executable quote.");
        }
        if (candidateQuote.pricePerShare < options.sellMinPrice) {
          throw new Error(`Retry sell quote ${candidateQuote.pricePerShare.toFixed(4)} below floor ${options.sellMinPrice.toFixed(4)}.`);
        }
      };
      const { execution, ledger, attempts: executionAttempts, quote: submittedQuote } = await maybeExecuteVistadexTrade(
        config,
        ledgerPath,
        ticket,
        options.execute,
        {
          quote: quoteResult,
          refreshQuote: () => createVistadexTradeQuote(config, ticket),
          validateQuote: validateSellQuote,
          maxAttempts: options.vistadexMaxAttempts,
          retryBackoffMs: options.vistadexRetryBackoffMs
        }
      );
      attempts = executionAttempts;
      const finalQuoteResult = submittedQuote ?? quoteResult;
      const finalQuote = quoteDetails(finalQuoteResult) ?? quote;
      const fill = execution ? fillDetails(execution) : undefined;
      if (fill && fill.pricePerShare < options.sellMinPrice) {
        warnings.push(`Locked-position sell filled below floor for ${position.slug ?? position.conditionId}: ${fill.pricePerShare}.`);
      }
      sold.push({
        ...base,
        status: execution?.status ?? "quoted",
        rfqId: finalQuoteResult.rfqId,
        quote: finalQuote,
        fill,
        transactionSignature: execution ? transactionSignature(execution) : undefined,
        ledger,
        attempts
      });
    } catch (error) {
      skipped.push({
        ...base,
        status: "failed",
        rfqId,
        attempts: (error as Error & { attempts?: WeatherReinvestExecutionAttempt[] }).attempts ?? attempts,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  return { sold, skipped, warnings };
}

function confidenceAtLeast(value: WeatherReinvestConfidence, minimum: WeatherReinvestConfidence): boolean {
  return CONFIDENCE_RANK[value] >= CONFIDENCE_RANK[minimum];
}

async function loadVistadexEventMarkets(
  config: AppConfig,
  eventSlug: string
): Promise<Map<string, VistadexMarketReference>> {
  const event = await getVistadexEvent(config, eventSlug);
  const eventRecord = (event as { event?: unknown }).event;
  const eventDescription = eventRecord && typeof eventRecord === "object"
    ? typeof (eventRecord as Record<string, unknown>).description === "string"
      ? (eventRecord as Record<string, unknown>).description as string
      : undefined
    : undefined;
  const markets = Array.isArray((event as { markets?: unknown }).markets)
    ? (event as { markets: unknown[] }).markets
    : [];
  const refs = new Map<string, VistadexMarketReference>();
  for (const item of markets) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, any>;
    const metadata = record.metadata ?? {};
    const market = record.market ?? {};
    const slug = typeof metadata.slug === "string" ? metadata.slug : undefined;
    const conditionId = typeof market.condition_id === "string"
      ? market.condition_id
      : typeof metadata.condition_id === "string"
        ? metadata.condition_id
        : undefined;
    if (!slug || !conditionId) continue;
    const description = typeof metadata.description === "string"
      ? metadata.description
      : eventDescription;
    refs.set(slug, {
      slug,
      conditionId,
      question: typeof metadata.question === "string" ? metadata.question : undefined,
      description,
      resolutionSource: typeof metadata.resolution_source === "string"
        ? metadata.resolution_source
        : resolutionSourceFromText(description)
    });
  }
  return refs;
}

async function buyPositiveWeatherEdges(
  config: AppConfig,
  ledgerPath: string,
  edgeReport: WeatherEdgeReport,
  positions: VistadexPosition[],
  cashUsd: number,
  bankrollUsd: number,
  options: Required<Pick<
    WeatherReinvestOptions,
    | "execute"
    | "maxGroupFraction"
    | "minTradeUsd"
    | "maxBuys"
    | "minConfidence"
    | "buyMinExecutableEdge"
    | "buyQuoteDriftUsd"
    | "highEntryStartLocalMinutes"
    | "highEntryEndLocalMinutes"
    | "lowEntryStartLocalMinutes"
    | "lowEntryEndLocalMinutes"
    | "vistadexQuoteTimeoutMs"
    | "vistadexFillerTimeoutMs"
    | "vistadexMaxAttempts"
    | "vistadexRetryBackoffMs"
  >> & Pick<WeatherReinvestOptions, "maxPerTradeUsd" | "now">
): Promise<{
  bought: WeatherReinvestTradeResult[];
  skipped: WeatherReinvestTradeResult[];
  warnings: string[];
}> {
  const bought: WeatherReinvestTradeResult[] = [];
  const skipped: WeatherReinvestTradeResult[] = [];
  const warnings: string[] = [];
  const eventCache = new Map<string, Map<string, VistadexMarketReference>>();
  const heldConditionIds = new Set(positions.flatMap((position) => position.conditionId ? [position.conditionId] : []));
  const exposure = currentGroupExposure(positions);
  let availableCash = cashUsd;
  let submittedBuyAttempts = 0;

  for (const row of edgeReport.signals) {
    if (bought.length >= options.maxBuys || submittedBuyAttempts >= options.maxBuys) break;
    if (availableCash < options.minTradeUsd) break;
    const side = "buy" as const;
    const outcomeIndex = row.bestSide === "YES" ? 0 : 1;
    const fairPrice = row.bestSide === "YES" ? row.fairYes : row.fairNo;
    const edge = row.bestEdge ?? 0;
    const groupKey = groupKeyFromRow(row);
    const entryWindow = entryWindowFromRow(row, options);
    const groupCapUsd = bankrollUsd * options.maxGroupFraction;
    const groupUsedUsd = exposure.get(groupKey) ?? 0;
    const groupCapacityUsd = Math.max(0, groupCapUsd - groupUsedUsd);
    const base = {
      action: "buy_edge" as const,
      slug: row.marketSlug,
      question: row.question,
      outcomeIndex,
      outcome: row.bestSide === "YES" ? "Yes" : "No",
      side,
      edge,
      fairPrice,
      confidence: row.confidence,
      groupKey,
      modelMode: row.modelMode,
      calibrationTargetKey: row.calibrationTargetKey,
      calibrationSamples: row.calibrationSamples,
      calibrationBiasC: row.calibrationBiasC,
      calibrationTargetBiasC: row.calibrationTargetBiasC,
      calibrationMeanAbsoluteErrorC: row.calibrationMeanAbsoluteErrorC,
      consensusMeanC: row.consensusMeanC,
      consensusSigmaC: row.consensusSigmaC,
      strategy: row.strategy,
      originalBestSide: row.originalBestSide,
      originalEdge: row.originalEdge,
      originalFair: row.originalFair,
      originalReferencePrice: row.originalReferencePrice,
      oppositeMarketProbability: row.oppositeMarketProbability,
      marketAnchorCoefficient: row.marketAnchorCoefficient,
      entryWindow
    };

    if (!entryWindow.shouldEnter) {
      skipped.push({
        ...base,
        status: "skipped",
        reason: `Outside station-local day-ahead entry window: ${entryWindow.reason}`
      });
      continue;
    }
    if (!row.forecastTargetMatched) {
      skipped.push({ ...base, status: "skipped", reason: "Forecast target did not match the resolution station/feed." });
      continue;
    }
    if (row.modelMode !== "historical_residuals") {
      skipped.push({
        ...base,
        status: "skipped",
        reason: "WeatherEdge live reinvestment requires calibrated historical residuals; heuristic pricing is diagnostics-only."
      });
      continue;
    }
    if (!confidenceAtLeast(row.confidence, options.minConfidence)) {
      skipped.push({ ...base, status: "skipped", reason: `Confidence ${row.confidence} below minimum ${options.minConfidence}.` });
      continue;
    }
    if ((row.suggestedSizeUsd ?? 0) < options.minTradeUsd) {
      skipped.push({ ...base, status: "skipped", reason: "Suggested size below minimum trade size." });
      continue;
    }
    if (groupCapacityUsd < options.minTradeUsd) {
      skipped.push({ ...base, status: "skipped", reason: "City/day exposure cap reached." });
      continue;
    }

    const eventMarkets = eventCache.get(row.eventSlug)
      ?? await loadVistadexEventMarkets(config, row.eventSlug);
    eventCache.set(row.eventSlug, eventMarkets);
    const marketRef = eventMarkets.get(row.marketSlug);
    if (!marketRef) {
      skipped.push({ ...base, status: "skipped", reason: "Could not map market slug to a Vistadex condition id." });
      continue;
    }
    if (heldConditionIds.has(marketRef.conditionId)) {
      skipped.push({
        ...base,
        conditionId: marketRef.conditionId,
        status: "skipped",
        reason: "Already holding this condition; skipping to avoid same-market doubling or opposite-side exposure."
      });
      continue;
    }
    if (row.resolutionSource && marketRef.resolutionSource && row.resolutionSource !== marketRef.resolutionSource) {
      skipped.push({
        ...base,
        conditionId: marketRef.conditionId,
        status: "skipped",
        reason: `Vistadex resolution source mismatch: ${marketRef.resolutionSource} vs model ${row.resolutionSource}.`
      });
      continue;
    }

    const amountLimits = [
      row.suggestedSizeUsd ?? 0,
      availableCash,
      groupCapacityUsd
    ];
    if (options.maxPerTradeUsd !== undefined) amountLimits.push(options.maxPerTradeUsd);
    const amountUsd = Math.min(...amountLimits);
    if (amountUsd < options.minTradeUsd) {
      skipped.push({ ...base, conditionId: marketRef.conditionId, status: "skipped", reason: "Trade size clipped below minimum." });
      continue;
    }

    const maxAcceptablePrice = fairPrice - options.buyMinExecutableEdge;
    if (maxAcceptablePrice <= 0) {
      skipped.push({ ...base, conditionId: marketRef.conditionId, status: "skipped", reason: "No fair-value cushion after executable edge requirement." });
      continue;
    }
    const ticket: VistadexTradeTicket = {
      venue: "vistadex",
      side: "buy",
      conditionId: marketRef.conditionId,
      outcomeIndex,
      amountUsd: roundUsd(amountUsd),
      limitPrice: Math.max(0.001, maxAcceptablePrice),
      quoteTimeoutMs: options.vistadexQuoteTimeoutMs,
      fillerTimeoutMs: options.vistadexFillerTimeoutMs
    };

    let attempts: WeatherReinvestExecutionAttempt[] = [];
    let rfqId: string | undefined;
    try {
      const quoteResult = await createVistadexTradeQuote(config, ticket);
      rfqId = quoteResult.rfqId;
      const quote = quoteDetails(quoteResult);
      if (!quote) {
        skipped.push({ ...base, conditionId: marketRef.conditionId, status: "skipped", amountUsd: ticket.amountUsd, rfqId, reason: "No executable buy quote." });
        continue;
      }
      if (quote.pricePerShare > maxAcceptablePrice) {
        skipped.push({
          ...base,
          conditionId: marketRef.conditionId,
          status: "skipped",
          amountUsd: ticket.amountUsd,
          rfqId,
          quote,
          reason: `Buy quote ${quote.pricePerShare.toFixed(4)} above max acceptable ${maxAcceptablePrice.toFixed(4)}.`
        });
        continue;
      }

      ticket.limitPrice = Math.min(maxAcceptablePrice, quote.pricePerShare + options.buyQuoteDriftUsd);
      submittedBuyAttempts += 1;
      const validateBuyQuote = (candidate: VistadexTradeQuote) => {
        const candidateQuote = quoteDetails(candidate);
        if (!candidateQuote) {
          throw new Error("Retry buy RFQ did not return an executable quote.");
        }
        if (candidateQuote.pricePerShare > maxAcceptablePrice) {
          throw new Error(`Retry buy quote ${candidateQuote.pricePerShare.toFixed(4)} above max acceptable ${maxAcceptablePrice.toFixed(4)}.`);
        }
      };
      const { execution, ledger, attempts: executionAttempts, quote: submittedQuote } = await maybeExecuteVistadexTrade(
        config,
        ledgerPath,
        ticket,
        options.execute,
        {
          quote: quoteResult,
          refreshQuote: () => createVistadexTradeQuote(config, ticket),
          validateQuote: validateBuyQuote,
          maxAttempts: options.vistadexMaxAttempts,
          retryBackoffMs: options.vistadexRetryBackoffMs
        }
      );
      attempts = executionAttempts;
      const finalQuoteResult = submittedQuote ?? quoteResult;
      const finalQuote = quoteDetails(finalQuoteResult) ?? quote;
      const fill = execution ? fillDetails(execution) : undefined;
      if (fill && fill.pricePerShare > maxAcceptablePrice) {
        warnings.push(`Buy filled above max acceptable for ${row.marketSlug}: ${fill.pricePerShare} > ${maxAcceptablePrice}.`);
      }
      const spentUsd = fill?.totalUsd ?? finalQuote.totalUsd;
      availableCash -= spentUsd;
      exposure.set(groupKey, (exposure.get(groupKey) ?? 0) + spentUsd);
      heldConditionIds.add(marketRef.conditionId);
      bought.push({
        ...base,
        status: execution?.status ?? "quoted",
        conditionId: marketRef.conditionId,
        amountUsd: ticket.amountUsd,
        rfqId: finalQuoteResult.rfqId,
        quote: finalQuote,
        fill,
        transactionSignature: execution ? transactionSignature(execution) : undefined,
        ledger,
        attempts
      });
    } catch (error) {
      skipped.push({
        ...base,
        conditionId: marketRef.conditionId,
        status: "failed",
        amountUsd: ticket.amountUsd,
        rfqId,
        attempts: (error as Error & { attempts?: WeatherReinvestExecutionAttempt[] }).attempts ?? attempts,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  return { bought, skipped, warnings };
}

export async function runWeatherReinvestment(
  config: AppConfig,
  options: WeatherReinvestOptions = {}
): Promise<WeatherReinvestReport> {
  const startedAt = new Date().toISOString();
  assertReinvestCalibrationEnabled(options.skipCalibration);
  const pricingStrategy = requireReinvestPricingStrategy(options);
  if (
    options.maxPerTradeUsd !== undefined &&
    (!Number.isFinite(options.maxPerTradeUsd) || options.maxPerTradeUsd <= 0)
  ) {
    throw new Error("WeatherEdge max per trade must be a positive number when configured.");
  }
  const ledgerPath = options.ledgerPath ?? config.ledger.path;
  const execute = options.execute === true;
  const vistadexExecution = {
    quoteTimeoutMs: positiveInteger(options.vistadexQuoteTimeoutMs, DEFAULT_VISTADEX_QUOTE_TIMEOUT_MS, "Vistadex quote timeout"),
    fillerTimeoutMs: positiveInteger(options.vistadexFillerTimeoutMs, DEFAULT_VISTADEX_FILLER_TIMEOUT_MS, "Vistadex filler timeout"),
    maxAttempts: positiveInteger(options.vistadexMaxAttempts, DEFAULT_VISTADEX_EXECUTION_ATTEMPTS, "Vistadex max attempts"),
    retryBackoffMs: nonNegativeFinite(options.vistadexRetryBackoffMs, DEFAULT_VISTADEX_RETRY_BACKOFF_MS, "Vistadex retry backoff")
  };
  const sellOptions = {
    execute,
    sellBidThreshold: options.sellBidThreshold ?? 0.99,
    sellMinPrice: options.sellMinPrice ?? 0.98,
    minSellShares: options.minSellShares ?? 0.5,
    vistadexQuoteTimeoutMs: vistadexExecution.quoteTimeoutMs,
    vistadexFillerTimeoutMs: vistadexExecution.fillerTimeoutMs,
    vistadexMaxAttempts: vistadexExecution.maxAttempts,
    vistadexRetryBackoffMs: vistadexExecution.retryBackoffMs
  };
  const highEntryStartLocalMinutes = options.highEntryStartLocalMinutes ?? DEFAULT_HIGH_ENTRY_START_MINUTES;
  const highEntryEndLocalMinutes = options.highEntryEndLocalMinutes ?? DEFAULT_HIGH_ENTRY_END_MINUTES;
  const lowEntryStartLocalMinutes = options.lowEntryStartLocalMinutes ?? DEFAULT_LOW_ENTRY_START_MINUTES;
  const lowEntryEndLocalMinutes = options.lowEntryEndLocalMinutes ?? DEFAULT_LOW_ENTRY_END_MINUTES;
  assertWeatherEntryWindowMinutes("temperature_high", highEntryStartLocalMinutes, highEntryEndLocalMinutes);
  assertWeatherEntryWindowMinutes("temperature_low", lowEntryStartLocalMinutes, lowEntryEndLocalMinutes);
  const buyOptions = {
    execute,
    maxPerTradeUsd: options.maxPerTradeUsd,
    maxGroupFraction: options.maxGroupFraction ?? 0.25,
    minTradeUsd: options.minTradeUsd ?? 0.5,
    maxBuys: Math.max(0, Math.trunc(options.maxBuys ?? 8)),
    minConfidence: (options.minConfidence ?? "MEDIUM") as WeatherReinvestConfidence,
    buyMinExecutableEdge: options.buyMinExecutableEdge ?? 0.03,
    buyQuoteDriftUsd: options.buyQuoteDriftUsd ?? 0.02,
    highEntryStartLocalMinutes,
    highEntryEndLocalMinutes,
    lowEntryStartLocalMinutes,
    lowEntryEndLocalMinutes,
    vistadexQuoteTimeoutMs: vistadexExecution.quoteTimeoutMs,
    vistadexFillerTimeoutMs: vistadexExecution.fillerTimeoutMs,
    vistadexMaxAttempts: vistadexExecution.maxAttempts,
    vistadexRetryBackoffMs: vistadexExecution.retryBackoffMs,
    now: options.now
  };

  const initialState = await loadVistadexState(config);
  const sellResult = await sellLockedWeatherPositions(
    config,
    ledgerPath,
    initialState.positions,
    sellOptions
  );
  const observedAfterSellState = execute && sellResult.sold.some(tradeMayHaveMutatedState)
    ? await loadVistadexState(config)
    : initialState;
  const sellProceedsUsd = expectedSellProceedsUsd(sellResult.sold, execute);
  const fillImpliedPostSellCashUsd = roundUsd(initialState.cashUsd + sellProceedsUsd);
  const effectivePostSellCashUsd = sellProceedsUsd > 0
    ? Math.max(observedAfterSellState.cashUsd, fillImpliedPostSellCashUsd)
    : observedAfterSellState.cashUsd;
  const afterSellState = effectivePostSellCashUsd === observedAfterSellState.cashUsd
    ? observedAfterSellState
    : withCashUsd(observedAfterSellState, effectivePostSellCashUsd);
  const bankrollUsd = options.bankrollUsd ?? afterSellState.summary.computedBankrollUsd;
  const minCashToReinvestUsd = Math.max(0, options.minCashToReinvestUsd ?? 1);
  const targetCashReserveUsd = Math.max(0, options.targetCashReserveUsd ?? 0);
  const deployableCashUsd = deployableWeatherCash(afterSellState.cashUsd, targetCashReserveUsd);
  const buyCashBudgetUsd = weatherBuyCashBudget({
    deployableCashUsd,
    bankrollUsd,
    maxBuySpendUsd: options.maxBuySpendUsd,
    maxBuySpendFraction: options.maxBuySpendFraction
  });
  const pauseBuys = options.pauseBuys === true;
  const auditLookbackHours = Math.max(1, options.auditLookbackHours ?? 48);
  const auditMinPositions = Math.max(1, Math.trunc(options.auditMinPositions ?? 5));
  const auditGate = options.requireRecentAuditPositive === true
    ? await assessRecentAuditGate(ledgerPath, afterSellState.positions, {
      auditLookbackHours,
      auditMinPositions,
      now: options.now
    })
    : undefined;
  const targetDate = targetDateFromOptions(options);
  const skippedForCash = buyCashBudgetUsd < minCashToReinvestUsd;
  const skippedForAuditGate = auditGate !== undefined && !auditGate.passed;
  const maxModelRunAgeHours = requirePositiveModelRunAgeHours(options.maxModelRunAgeHours);
  const forecastFreshness = pauseBuys || skippedForCash || skippedForAuditGate
    ? undefined
    : await fetchOpenMeteoForecastFreshness(config, {
      now: options.now,
      maxRunAgeHours: maxModelRunAgeHours
    });
  const skippedForForecastFreshness = forecastFreshness !== undefined && !forecastFreshness.ok;
  const skippedBeforeScan = pauseBuys || skippedForCash || skippedForAuditGate || skippedForForecastFreshness;
  const edgeReport = skippedBeforeScan
    ? undefined
    : await computeWeatherEdgeReport(config, {
      date: options.date,
      daysAhead: options.daysAhead ?? 1,
      limit: options.limit ?? 100,
      maxPages: options.maxPages ?? 20,
      maxEvents: options.maxEvents,
      concurrency: options.concurrency ?? 4,
      minLiquidity: options.minLiquidity,
      highGraceMinutes: options.highGraceMinutes,
      lowGraceMinutes: options.lowGraceMinutes,
      now: options.now,
      bankrollUsd,
      maxPerTradeUsd: buyOptions.maxPerTradeUsd,
      kellyMultiplier: options.kellyMultiplier ?? 0.25,
      maxKellyFraction: options.maxKellyFraction ?? 0.25,
      maxGroupFraction: buyOptions.maxGroupFraction,
      portfolioStepUsd: options.portfolioStepUsd ?? 0.5,
      minEdge: requireReinvestMinEdge(options.minEdge),
      skipClimatology: options.skipClimatology,
      skipCalibration: options.skipCalibration,
      calibrationHalfLifeDays: options.calibrationHalfLifeDays,
      cityBiasPriorWeight: options.cityBiasPriorWeight,
      sizingStrategy: "city_portfolio",
      strategy: pricingStrategy.strategy,
      marketAnchor: pricingStrategy.marketAnchor
    });
  const buyResult = edgeReport
    ? await buyPositiveWeatherEdges(
      config,
      ledgerPath,
      edgeReport,
      afterSellState.positions,
      buyCashBudgetUsd,
      bankrollUsd,
      buyOptions
    )
    : {
      bought: [],
      skipped: [{
        action: "buy_edge" as const,
        status: "skipped" as const,
        reason: pauseBuys
          ? "Fresh WeatherEdge buys are paused by --pause-buys."
          : skippedForAuditGate
          ? `Recent audit gate blocked new WeatherEdge buys: ${auditGate?.reason}`
          : skippedForForecastFreshness
          ? `Forecast freshness gate blocked new WeatherEdge buys: ${forecastFreshness?.reason}`
          : `Buy cash budget ${buyCashBudgetUsd.toFixed(2)} from deployable cash ${deployableCashUsd.toFixed(2)} is below min cash to reinvest ${minCashToReinvestUsd.toFixed(2)}; skipped WeatherEdge scan.`
      }],
      warnings: []
    };
  const observedFinalState = execute && (
    sellResult.sold.some(tradeMayHaveMutatedState) ||
    buyResult.bought.some(tradeMayHaveMutatedState)
  )
    ? await loadVistadexState(config)
    : afterSellState;
  const buySpendUsd = expectedBuySpendUsd(buyResult.bought, execute);
  const fillImpliedFinalCashUsd = roundUsd(Math.max(0, afterSellState.cashUsd - buySpendUsd));
  const expectedCashChanged = sellProceedsUsd > 0 || buySpendUsd > 0;
  const finalState = expectedCashChanged && Math.abs(observedFinalState.cashUsd - fillImpliedFinalCashUsd) > 0.01
    ? withCashUsd(observedFinalState, fillImpliedFinalCashUsd)
    : observedFinalState;
  const cashWarnings = [
    ...(sellProceedsUsd > 0 && Math.abs(observedAfterSellState.cashUsd - effectivePostSellCashUsd) > 0.01
      ? [`Observed post-sell cash ${observedAfterSellState.cashUsd.toFixed(2)} lagged fill-implied cash ${effectivePostSellCashUsd.toFixed(2)}; using fill-implied cash for threshold and sizing.`]
      : []),
    ...(expectedCashChanged && Math.abs(observedFinalState.cashUsd - finalState.cashUsd) > 0.01
      ? [`Observed final cash ${observedFinalState.cashUsd.toFixed(2)} differed from fill-implied cash ${finalState.cashUsd.toFixed(2)}; reporting fill-implied cash.`]
      : [])
  ];

  return {
    execute,
    pauseBuys,
    strategy: pricingStrategy.strategy,
    startedAt,
    finishedAt: new Date().toISOString(),
    ledgerPath,
    initial: initialState.summary,
    afterSells: afterSellState.summary,
    final: finalState.summary,
    bankrollUsd: roundUsd(bankrollUsd),
    bankrollSource: options.bankrollUsd === undefined ? "computed_vistadex_mark_to_mid" : "override",
    targetCashReserveUsd: roundUsd(targetCashReserveUsd),
    deployableCashUsd: roundUsd(deployableWeatherCash(finalState.cashUsd, targetCashReserveUsd)),
    buyCashBudgetUsd: roundUsd(buyCashBudgetUsd),
    targetDate: edgeReport?.targetDate ?? targetDate,
    vistadexExecution,
    weatherEdge: edgeReport
      ? {
        scannedGroups: edgeReport.scannedGroups,
        targetGroups: edgeReport.targetGroups,
        pricedGroups: edgeReport.pricedGroups,
        timeSkippedGroups: edgeReport.timeSkippedGroups,
        erroredGroups: edgeReport.erroredGroups,
        marketCount: edgeReport.marketCount,
        rowCount: edgeReport.rowCount,
        signalCount: edgeReport.signalCount,
        errors: edgeReport.errors
      }
      : emptyWeatherEdgeSummary(),
    sold: sellResult.sold,
    bought: buyResult.bought,
    skipped: [...sellResult.skipped, ...buyResult.skipped],
    forecastFreshness,
    auditGate,
    warnings: [
      ...sellResult.warnings,
      ...buyResult.warnings,
      ...cashWarnings,
      ...(pauseBuys
        ? ["Skipped WeatherEdge scan because fresh buys are paused by --pause-buys."]
        : []),
      ...(skippedForCash
        ? [`Skipped WeatherEdge scan because buy cash budget ${buyCashBudgetUsd.toFixed(2)} from deployable cash ${deployableCashUsd.toFixed(2)} after target reserve ${targetCashReserveUsd.toFixed(2)} is below ${minCashToReinvestUsd.toFixed(2)}.`]
        : []),
      ...(skippedForAuditGate && auditGate
        ? [`Skipped WeatherEdge scan because recent audited performance failed the market-informed opposite-side gate: ${auditGate.reason}`]
        : []),
      ...(skippedForForecastFreshness && forecastFreshness
        ? [`Skipped WeatherEdge scan because forecast freshness failed: ${forecastFreshness.reason}`]
        : [])
    ]
  };
}

export async function writeWeatherReinvestReport(path: string, report: WeatherReinvestReport): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}
