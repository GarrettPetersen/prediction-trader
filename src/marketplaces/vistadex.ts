import { readFileSync } from "node:fs";
import type { AppConfig } from "../config.js";
import type { TradeExecution, TradePreview, VistadexTradeTicket } from "../types.js";
import { keypairFromVistadexSecret } from "../vistadexWallet.js";

type VistadexModule = typeof import("vistadex");
const NON_ZERO_POSITION_EPSILON = 0.000001;

export interface VistadexPositionPrice {
  midpoint: number;
  bestBid: number;
  bestAsk: number;
}

export interface VistadexPosition {
  slug?: string;
  question?: string;
  outcomes: string[];
  conditionId?: string;
  outcomeIndex: number;
  collateralMint?: string;
  balance: string;
  balanceRaw?: string;
  price?: VistadexPositionPrice;
  payout?: number;
  status?: string;
  closed?: boolean;
}

export interface VistadexPositionsSnapshot {
  walletAddress: string;
  total: number;
  hasMore: boolean;
  nextCursor?: string | null;
  count: number;
  positions: VistadexPosition[];
}

export interface VistadexPositionsOptions {
  includeZero?: boolean;
  limit?: number;
}

async function loadVistadex() {
  return await import("vistadex") as VistadexModule & Record<string, unknown>;
}

async function createVistadexClient(config: AppConfig) {
  if (!config.vistadex.apiKey) {
    throw new Error("VISTADEX_CLIENT_API_KEY is required.");
  }

  const mod = await loadVistadex();
  const VistadexClient = mod.VistadexClient as any;

  return {
    client: new VistadexClient({
      apiKey: config.vistadex.apiKey,
      rpcUrl: config.vistadex.rpcUrl,
      positionsBaseUrl: config.vistadex.positionsBaseUrl
    }),
    mod
  };
}

function readSecretKey(config: AppConfig): string {
  if (config.vistadex.secretKey) return config.vistadex.secretKey;
  if (config.vistadex.keypairPath) return readFileSync(config.vistadex.keypairPath, "utf8");
  throw new Error("VISTADEX_SECRET_KEY or VISTADEX_KEYPAIR_PATH is required.");
}

async function loadWallet(config: AppConfig) {
  return keypairFromVistadexSecret(readSecretKey(config));
}

function numberValue(value: unknown): number {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

function normalizePrice(value: unknown): VistadexPositionPrice | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  return {
    midpoint: numberValue(record.midpoint),
    bestBid: numberValue(record.best_bid ?? record.bestBid),
    bestAsk: numberValue(record.best_ask ?? record.bestAsk)
  };
}

function normalizeOutcomes(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

function sanitizeVistadexQuoteResult(response: any) {
  return {
    rfqId: response?.rfqId,
    walletAddress: response?.walletAddress,
    auctionDurationMs: response?.auctionDurationMs,
    auctionEndTime: response?.auctionEndTime,
    hasQuote: response?.hasQuote === true,
    quote: response?.quote
      ? {
          filler: response.quote.filler,
          pricePerShare: response.quote.pricePerShare,
          shares: response.quote.shares,
          totalUsd: response.quote.totalUsd
        }
      : null,
    summary: response?.summary,
    feeRateBps: response?.feeRateBps
  };
}

function sanitizeVistadexTradeResult(response: any) {
  return {
    rfqId: response?.rfqId,
    side: response?.side,
    walletAddress: response?.walletAddress,
    winningQuote: response?.winningQuote,
    transactionSignature: response?.transactionSignature,
    feeRateBps: response?.feeRateBps
  };
}

export function previewVistadexTrade(ticket: VistadexTradeTicket): TradePreview {
  const notionalUsd = ticket.amountUsd ?? 0;
  const sizeDescription = ticket.amountUsd
    ? `$${ticket.amountUsd.toFixed(2)}`
    : `${ticket.shares} shares`;

  return {
    venue: "vistadex",
    summary: `${ticket.side.toUpperCase()} ${sizeDescription} on condition ${ticket.conditionId}, outcome ${ticket.outcomeIndex}`,
    notionalUsd,
    details: {
      ...ticket,
      collateralMint: ticket.collateralMint ?? "USDC_MINT"
    }
  };
}

export async function getVistadexEvent(config: AppConfig, slug: string): Promise<unknown> {
  const { client } = await createVistadexClient(config);
  return client.getEvent(slug);
}

export async function getVistadexPositions(
  config: AppConfig,
  options: VistadexPositionsOptions = {}
): Promise<VistadexPositionsSnapshot> {
  const { client } = await createVistadexClient(config);
  const wallet = await loadWallet(config);
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 200), 1), 200);
  const page = await client.getPositions({
    walletAddress: wallet.publicKey.toBase58(),
    limit
  });
  const positions = Array.isArray(page.positions) ? page.positions : [];
  const normalized = positions
    .map((position: Record<string, any>) => ({
      slug: position.metadata?.slug,
      question: position.metadata?.question,
      outcomes: normalizeOutcomes(position.metadata?.outcomes),
      conditionId: position.conditionId ?? position.condition_id,
      outcomeIndex: position.outcomeIndex ?? position.outcome_index,
      collateralMint: position.collateralMint ?? position.collateral_mint,
      balance: position.balance,
      balanceRaw: position.balanceRaw ?? position.balance_raw,
      price: normalizePrice(position.price),
      payout: position.payout,
      status: position.status,
      closed: position.metadata?.closed
    }))
    .filter((position: { balance?: string }) =>
      options.includeZero ? true : Number(position.balance ?? 0) > NON_ZERO_POSITION_EPSILON
    );

  return {
    walletAddress: wallet.publicKey.toBase58(),
    total: page.total,
    hasMore: page.hasMore,
    nextCursor: page.nextCursor,
    count: normalized.length,
    positions: normalized
  };
}

export async function quoteVistadexTrade(
  config: AppConfig,
  ticket: VistadexTradeTicket
): Promise<unknown> {
  const { client, mod } = await createVistadexClient(config);
  const wallet = await loadWallet(config);
  const collateralMint = ticket.collateralMint ?? (mod as any).USDC_MINT;

  const response = await client.quote({
    walletAddress: wallet.publicKey.toBase58(),
    conditionId: ticket.conditionId,
    collateralMint,
      outcomeIndex: ticket.outcomeIndex,
      side: ticket.side,
      quoteBasis: ticket.side === "buy" ? "usd" : "shares",
      usdAmount: ticket.side === "buy" ? ticket.amountUsd : undefined,
      shareAmount: ticket.side === "sell" ? ticket.shares : undefined,
      orderType: ticket.limitPrice === undefined ? "market" : "limit",
      limitPrice: ticket.limitPrice
    });
  return sanitizeVistadexQuoteResult(response);
}

export async function executeVistadexTrade(
  config: AppConfig,
  ticket: VistadexTradeTicket
): Promise<TradeExecution> {
  const { client, mod } = await createVistadexClient(config);
  const wallet = await loadWallet(config);
  const collateralMint = ticket.collateralMint ?? (mod as any).USDC_MINT;

  if (!collateralMint) {
    throw new Error("Vistadex USDC_MINT export was not found; pass --collateral-mint explicitly.");
  }

  let response: unknown;
  if (ticket.side === "buy") {
    if (ticket.amountUsd === undefined) {
      throw new Error("Vistadex buy requires amountUsd.");
    }
    response = await client.buy({
      wallet,
      conditionId: ticket.conditionId,
      collateralMint,
      outcomeIndex: ticket.outcomeIndex,
      usdAmount: ticket.amountUsd,
      orderType: ticket.limitPrice === undefined ? "market" : "limit",
      limitPrice: ticket.limitPrice
    });
  } else {
    if (ticket.shares === undefined) {
      throw new Error("Vistadex sell requires shares.");
    }
    response = await client.sell({
      wallet,
      conditionId: ticket.conditionId,
      collateralMint,
      outcomeIndex: ticket.outcomeIndex,
      shareAmount: ticket.shares,
      orderType: ticket.limitPrice === undefined ? "market" : "limit",
      limitPrice: ticket.limitPrice
    });
  }

  const details = sanitizeVistadexTradeResult(response);
  return {
    venue: "vistadex",
    status: details.transactionSignature ? "filled" : "submitted",
    details: details as Record<string, unknown>
  };
}
