import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AppConfig } from "./config.js";
import {
  appendExecutionLedgerRecord,
  type AppendLedgerResult
} from "./ledger.js";
import {
  executeVistadexTrade,
  getVistadexEvent,
  getVistadexPositions,
  getVistadexUSDCBalance,
  previewVistadexTrade,
  quoteVistadexTrade,
  type VistadexPosition
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
import { parseWeatherMarketQuestion } from "./weatherMarkets.js";

export type WeatherReinvestConfidence = "LOW" | "MEDIUM" | "HIGH";

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
  kellyMultiplier?: number;
  maxKellyFraction?: number;
  maxGroupFraction?: number;
  portfolioStepUsd?: number;
  minEdge?: number;
  skipClimatology?: boolean;
  sellBidThreshold?: number;
  sellMinPrice?: number;
  minSellShares?: number;
  minTradeUsd?: number;
  minCashToReinvestUsd?: number;
  maxBuys?: number;
  minConfidence?: WeatherReinvestConfidence;
  buyMinExecutableEdge?: number;
  buyQuoteDriftUsd?: number;
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
  quote?: WeatherReinvestQuoteDetails;
  fill?: WeatherReinvestQuoteDetails;
  transactionSignature?: string;
  ledger?: AppendLedgerResult;
  reason?: string;
  error?: string;
  edge?: number;
  fairPrice?: number;
  confidence?: WeatherReinvestConfidence;
  groupKey?: string;
}

export interface WeatherReinvestReport {
  execute: boolean;
  startedAt: string;
  finishedAt: string;
  ledgerPath: string;
  initial: WeatherReinvestStateSummary;
  afterSells: WeatherReinvestStateSummary;
  final: WeatherReinvestStateSummary;
  bankrollUsd: number;
  bankrollSource: "computed_vistadex_mark_to_mid" | "override";
  targetDate: string;
  weatherEdge: Pick<
    WeatherEdgeReport,
    "scannedGroups" | "targetGroups" | "pricedGroups" | "timeSkippedGroups" | "erroredGroups" | "marketCount" | "rowCount" | "signalCount" | "errors"
  >;
  sold: WeatherReinvestTradeResult[];
  bought: WeatherReinvestTradeResult[];
  skipped: WeatherReinvestTradeResult[];
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

interface VistadexMarketReference {
  slug: string;
  question?: string;
  conditionId: string;
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

function tradeMayHaveMutatedState(trade: WeatherReinvestTradeResult): boolean {
  return trade.status === "filled" || trade.status === "submitted" || trade.status === "unknown";
}

function tradeCashTotalUsd(trade: WeatherReinvestTradeResult): number | undefined {
  return trade.fill?.totalUsd ?? trade.quote?.totalUsd ?? trade.amountUsd;
}

function expectedSellProceedsUsd(trades: WeatherReinvestTradeResult[], execute: boolean): number {
  return roundUsd(trades.reduce((sum, trade) => {
    if (trade.status === "filled") return sum + (tradeCashTotalUsd(trade) ?? 0);
    if (!execute && trade.status === "quoted") return sum + (tradeCashTotalUsd(trade) ?? 0);
    return sum;
  }, 0));
}

function expectedBuySpendUsd(trades: WeatherReinvestTradeResult[], execute: boolean): number {
  return roundUsd(trades.reduce((sum, trade) => {
    if (trade.status === "filled") return sum + (tradeCashTotalUsd(trade) ?? 0);
    if (!execute && trade.status === "quoted") return sum + (tradeCashTotalUsd(trade) ?? 0);
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
  execute: boolean
): Promise<{
  execution?: TradeExecution;
  ledger?: AppendLedgerResult;
}> {
  if (!execute) return {};
  assertCanExecute(ticket, config.safety, execute);
  const preview = previewVistadexTrade(ticket);
  const execution = await executeVistadexTrade(config, ticket);
  const ledger = await appendExecutionLedgerRecord(ledgerPath, {
    command: "weather:reinvest",
    ticket,
    preview,
    execution,
    action: "order"
  });
  return { execution, ledger };
}

async function sellLockedWeatherPositions(
  config: AppConfig,
  ledgerPath: string,
  positions: VistadexPosition[],
  options: Required<Pick<WeatherReinvestOptions, "execute" | "sellBidThreshold" | "sellMinPrice" | "minSellShares">>
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
      limitPrice: options.sellMinPrice
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

    try {
      const quote = quoteDetails(await quoteVistadexTrade(config, ticket));
      if (!quote || quote.pricePerShare < options.sellMinPrice) {
        skipped.push({
          ...base,
          status: "skipped",
          quote,
          reason: quote
            ? `Sell quote ${quote.pricePerShare.toFixed(4)} below floor ${options.sellMinPrice.toFixed(4)}.`
            : "No executable sell quote."
        });
        continue;
      }

      const { execution, ledger } = await maybeExecuteVistadexTrade(config, ledgerPath, ticket, options.execute);
      const fill = execution ? fillDetails(execution) : undefined;
      if (fill && fill.pricePerShare < options.sellMinPrice) {
        warnings.push(`Locked-position sell filled below floor for ${position.slug ?? position.conditionId}: ${fill.pricePerShare}.`);
      }
      sold.push({
        ...base,
        status: execution?.status ?? "quoted",
        quote,
        fill,
        transactionSignature: execution ? transactionSignature(execution) : undefined,
        ledger
      });
    } catch (error) {
      skipped.push({
        ...base,
        status: "failed",
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
    refs.set(slug, {
      slug,
      conditionId,
      question: typeof metadata.question === "string" ? metadata.question : undefined,
      resolutionSource: typeof metadata.resolution_source === "string" ? metadata.resolution_source : undefined
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
    "execute" | "maxPerTradeUsd" | "maxGroupFraction" | "minTradeUsd" | "maxBuys" | "minConfidence" | "buyMinExecutableEdge" | "buyQuoteDriftUsd"
  >>
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

  for (const row of edgeReport.signals) {
    if (bought.length >= options.maxBuys) break;
    if (availableCash < options.minTradeUsd) break;
    const side = "buy" as const;
    const outcomeIndex = row.bestSide === "YES" ? 0 : 1;
    const fairPrice = row.bestSide === "YES" ? row.fairYes : row.fairNo;
    const edge = row.bestEdge ?? 0;
    const groupKey = groupKeyFromRow(row);
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
      groupKey
    };

    if (!row.forecastTargetMatched) {
      skipped.push({ ...base, status: "skipped", reason: "Forecast target did not match the resolution station/feed." });
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

    const amountUsd = Math.min(
      row.suggestedSizeUsd ?? 0,
      options.maxPerTradeUsd,
      availableCash,
      groupCapacityUsd
    );
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
      limitPrice: Math.max(0.001, maxAcceptablePrice)
    };

    try {
      const quote = quoteDetails(await quoteVistadexTrade(config, ticket));
      if (!quote) {
        skipped.push({ ...base, conditionId: marketRef.conditionId, status: "skipped", amountUsd: ticket.amountUsd, reason: "No executable buy quote." });
        continue;
      }
      if (quote.pricePerShare > maxAcceptablePrice) {
        skipped.push({
          ...base,
          conditionId: marketRef.conditionId,
          status: "skipped",
          amountUsd: ticket.amountUsd,
          quote,
          reason: `Buy quote ${quote.pricePerShare.toFixed(4)} above max acceptable ${maxAcceptablePrice.toFixed(4)}.`
        });
        continue;
      }

      ticket.limitPrice = Math.min(maxAcceptablePrice, quote.pricePerShare + options.buyQuoteDriftUsd);
      const { execution, ledger } = await maybeExecuteVistadexTrade(config, ledgerPath, ticket, options.execute);
      const fill = execution ? fillDetails(execution) : undefined;
      if (fill && fill.pricePerShare > maxAcceptablePrice) {
        warnings.push(`Buy filled above max acceptable for ${row.marketSlug}: ${fill.pricePerShare} > ${maxAcceptablePrice}.`);
      }
      const spentUsd = fill?.totalUsd ?? quote.totalUsd;
      availableCash -= spentUsd;
      exposure.set(groupKey, (exposure.get(groupKey) ?? 0) + spentUsd);
      heldConditionIds.add(marketRef.conditionId);
      bought.push({
        ...base,
        status: execution?.status ?? "quoted",
        conditionId: marketRef.conditionId,
        amountUsd: ticket.amountUsd,
        quote,
        fill,
        transactionSignature: execution ? transactionSignature(execution) : undefined,
        ledger
      });
    } catch (error) {
      skipped.push({
        ...base,
        conditionId: marketRef.conditionId,
        status: "failed",
        amountUsd: ticket.amountUsd,
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
  const ledgerPath = options.ledgerPath ?? config.ledger.path;
  const execute = options.execute === true;
  const sellOptions = {
    execute,
    sellBidThreshold: options.sellBidThreshold ?? 0.99,
    sellMinPrice: options.sellMinPrice ?? 0.98,
    minSellShares: options.minSellShares ?? 0.5
  };
  const buyOptions = {
    execute,
    maxPerTradeUsd: options.maxPerTradeUsd ?? 10,
    maxGroupFraction: options.maxGroupFraction ?? 0.25,
    minTradeUsd: options.minTradeUsd ?? 0.5,
    maxBuys: Math.max(0, Math.trunc(options.maxBuys ?? 8)),
    minConfidence: (options.minConfidence ?? "MEDIUM") as WeatherReinvestConfidence,
    buyMinExecutableEdge: options.buyMinExecutableEdge ?? 0.03,
    buyQuoteDriftUsd: options.buyQuoteDriftUsd ?? 0.02
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
  const minCashToReinvestUsd = Math.max(0, options.minCashToReinvestUsd ?? 5);
  const targetDate = targetDateFromOptions(options);
  const skippedBeforeScan = afterSellState.cashUsd < minCashToReinvestUsd;
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
      bankrollUsd,
      maxPerTradeUsd: buyOptions.maxPerTradeUsd,
      kellyMultiplier: options.kellyMultiplier ?? 0.25,
      maxKellyFraction: options.maxKellyFraction ?? 0.25,
      maxGroupFraction: buyOptions.maxGroupFraction,
      portfolioStepUsd: options.portfolioStepUsd ?? 0.5,
      minEdge: options.minEdge,
      skipClimatology: options.skipClimatology,
      sizingStrategy: "city_portfolio"
    });
  const buyResult = edgeReport
    ? await buyPositiveWeatherEdges(
      config,
      ledgerPath,
      edgeReport,
      afterSellState.positions,
      afterSellState.cashUsd,
      bankrollUsd,
      buyOptions
    )
    : {
      bought: [],
      skipped: [{
        action: "buy_edge" as const,
        status: "skipped" as const,
        reason: `Available cash ${afterSellState.cashUsd.toFixed(2)} is below min cash to reinvest ${minCashToReinvestUsd.toFixed(2)}; skipped WeatherEdge scan.`
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
    startedAt,
    finishedAt: new Date().toISOString(),
    ledgerPath,
    initial: initialState.summary,
    afterSells: afterSellState.summary,
    final: finalState.summary,
    bankrollUsd: roundUsd(bankrollUsd),
    bankrollSource: options.bankrollUsd === undefined ? "computed_vistadex_mark_to_mid" : "override",
    targetDate: edgeReport?.targetDate ?? targetDate,
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
    warnings: [
      ...sellResult.warnings,
      ...buyResult.warnings,
      ...cashWarnings,
      ...(skippedBeforeScan
        ? [`Skipped WeatherEdge scan because available cash ${afterSellState.cashUsd.toFixed(2)} is below ${minCashToReinvestUsd.toFixed(2)}.`]
        : [])
    ]
  };
}

export async function writeWeatherReinvestReport(path: string, report: WeatherReinvestReport): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, "utf8");
}
