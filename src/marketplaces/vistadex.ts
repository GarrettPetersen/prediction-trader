import { readFileSync } from "node:fs";
import { getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Connection, PublicKey } from "@solana/web3.js";
import type { AppConfig } from "../config.js";
import type { TradeExecution, TradePreview, TradeSide, VistadexTradeTicket } from "../types.js";
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

export interface VistadexUSDCBalanceSnapshot {
  walletAddress: string;
  tokenAccount: string;
  mint: string;
  balanceRaw: string;
  decimals: number;
  cashUsd: string;
}

export interface VistadexTradeQuote {
  rfqId?: string;
  walletAddress?: string;
  auctionDurationMs?: number;
  auctionEndTime?: number;
  hasQuote: boolean;
  quote: {
    filler?: string;
    pricePerShare?: number;
    shares?: number;
    totalUsd?: number;
  } | null;
  summary?: unknown;
  feeRateBps?: number;
  unsignedTransaction?: string | null;
}

export interface VistadexPublicUser {
  username: string;
  walletAddress?: string;
  createdAt?: string;
  avatarUrl?: string | null;
  isPrivate?: boolean;
}

export interface VistadexPublicUserStats {
  totalTrades?: number;
}

export interface VistadexActivityMetadata {
  question?: string;
  slug?: string;
  icon?: string | null;
  image?: string | null;
  category?: string | null;
  outcomes?: string[];
}

export interface VistadexActivityTrade {
  type: "trade";
  id: string;
  timestamp: string;
  conditionId: string;
  outcomeIndex: number;
  side: TradeSide;
  shares: number;
  pricePerShare: number;
  totalUsd: number;
  status?: string;
  transactionSignature?: string;
  metadata?: VistadexActivityMetadata;
}

export interface VistadexActivityRedemption {
  type: "redemption";
  id: string;
  timestamp: string;
  conditionId: string;
  outcomeIndex: number;
  outcomeLabel?: string;
  quantity: number;
  payout: number;
  valueUsd: number;
  transactionSignature?: string;
  metadata?: VistadexActivityMetadata;
}

export type VistadexActivityItem = VistadexActivityTrade | VistadexActivityRedemption;

export interface VistadexActivityOptions {
  username?: string;
  walletAddress?: string;
  limit?: number;
  maxPages?: number;
}

export interface VistadexActivitySnapshot {
  username?: string;
  walletAddress: string;
  stats?: VistadexPublicUserStats;
  count: number;
  pages: number;
  hasMore: boolean;
  nextCursor?: string | null;
  items: VistadexActivityItem[];
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

function normalizeUsername(username: string): string {
  return username.replace(/^@/, "").trim().toLowerCase();
}

function vistadexAppUrl(config: AppConfig, path: string, params?: Record<string, string | number | undefined>): URL {
  const url = new URL(path, config.vistadex.appBaseUrl);
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  return url;
}

async function fetchVistadexAppJson<T>(config: AppConfig, path: string, params?: Record<string, string | number | undefined>): Promise<T> {
  const url = vistadexAppUrl(config, path, params);
  const response = await fetch(url, {
    headers: {
      accept: "application/json"
    }
  });
  const text = await response.text();
  const body = text.length > 0 ? JSON.parse(text) : {};

  if (!response.ok) {
    const message = body && typeof body === "object" && "error" in body
      ? String((body as { error?: unknown }).error)
      : `Vistadex app API request failed with ${response.status}`;
    throw new Error(message);
  }

  return body as T;
}

function sanitizeVistadexQuoteResult(response: any, options: { includeUnsignedTransaction?: boolean } = {}): VistadexTradeQuote {
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
    feeRateBps: response?.feeRateBps,
    unsignedTransaction: options.includeUnsignedTransaction ? response?.unsignedTransaction : undefined
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
  const notionalUsd = ticket.amountUsd ??
    (ticket.shares !== undefined && ticket.limitPrice !== undefined ? ticket.shares * ticket.limitPrice : 0);
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

export async function getVistadexPublicUser(
  config: AppConfig,
  username: string
): Promise<{
  user?: VistadexPublicUser;
  stats?: VistadexPublicUserStats;
}> {
  return fetchVistadexAppJson(config, "/api/public/user", {
    username: normalizeUsername(username)
  });
}

export async function getVistadexPublicActivity(
  config: AppConfig,
  options: VistadexActivityOptions = {}
): Promise<VistadexActivitySnapshot> {
  const username = options.username ? normalizeUsername(options.username) : undefined;
  const publicUser = username ? await getVistadexPublicUser(config, username) : undefined;
  const walletAddress = options.walletAddress
    ?? publicUser?.user?.walletAddress
    ?? (await loadWallet(config)).publicKey.toBase58();

  if (!walletAddress) {
    throw new Error("Vistadex public activity requires a wallet address or public profile username.");
  }

  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 50), 1), 100);
  const maxPages = Math.max(Math.trunc(options.maxPages ?? 20), 1);
  const items: VistadexActivityItem[] = [];
  let cursor: string | undefined;
  let nextCursor: string | null | undefined;
  let hasMore = false;
  let pages = 0;

  while (pages < maxPages) {
    const page = await fetchVistadexAppJson<{
      items?: VistadexActivityItem[];
      hasMore?: boolean;
      nextCursor?: string | null;
    }>(config, "/api/public/order-history", {
      wallet: walletAddress,
      limit,
      cursor
    });
    pages += 1;
    items.push(...(Array.isArray(page.items) ? page.items : []));
    hasMore = page.hasMore === true;
    nextCursor = page.nextCursor ?? null;
    if (!hasMore || !nextCursor) break;
    cursor = nextCursor;
  }

  return {
    username,
    walletAddress,
    stats: publicUser?.stats,
    count: items.length,
    pages,
    hasMore,
    nextCursor,
    items
  };
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

export async function getVistadexUSDCBalance(config: AppConfig): Promise<VistadexUSDCBalanceSnapshot> {
  const mod = await loadVistadex();
  const wallet = await loadWallet(config);
  const mintAddress = (mod as any).USDC_MINT;
  if (!mintAddress) {
    throw new Error("Vistadex USDC_MINT export was not found.");
  }

  const mint = new PublicKey(mintAddress);
  const tokenAccount = getAssociatedTokenAddressSync(mint, wallet.publicKey);
  const connection = new Connection(config.vistadex.rpcUrl);

  try {
    const balance = await connection.getTokenAccountBalance(tokenAccount);
    return {
      walletAddress: wallet.publicKey.toBase58(),
      tokenAccount: tokenAccount.toBase58(),
      mint: mint.toBase58(),
      balanceRaw: balance.value.amount,
      decimals: balance.value.decimals,
      cashUsd: balance.value.uiAmountString ?? "0"
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!/could not find account|invalid param|account not found/i.test(message)) {
      throw error;
    }

    return {
      walletAddress: wallet.publicKey.toBase58(),
      tokenAccount: tokenAccount.toBase58(),
      mint: mint.toBase58(),
      balanceRaw: "0",
      decimals: 6,
      cashUsd: "0"
    };
  }
}

export async function quoteVistadexTrade(
  config: AppConfig,
  ticket: VistadexTradeTicket
): Promise<unknown> {
  const { unsignedTransaction: _unsignedTransaction, ...safeQuote } = await createVistadexTradeQuote(config, ticket);
  return safeQuote;
}

export async function createVistadexTradeQuote(
  config: AppConfig,
  ticket: VistadexTradeTicket
): Promise<VistadexTradeQuote> {
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
      limitPrice: ticket.limitPrice,
      quoteTimeoutMs: ticket.quoteTimeoutMs
    });
  return sanitizeVistadexQuoteResult(response, { includeUnsignedTransaction: true });
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
      limitPrice: ticket.limitPrice,
      quoteTimeoutMs: ticket.quoteTimeoutMs,
      fillerTimeoutMs: ticket.fillerTimeoutMs
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
      limitPrice: ticket.limitPrice,
      quoteTimeoutMs: ticket.quoteTimeoutMs,
      fillerTimeoutMs: ticket.fillerTimeoutMs
    });
  }

  const details = sanitizeVistadexTradeResult(response);
  return {
    venue: "vistadex",
    status: details.transactionSignature ? "filled" : "submitted",
    details: details as Record<string, unknown>
  };
}

export async function executeVistadexQuotedTrade(
  config: AppConfig,
  ticket: VistadexTradeTicket,
  quote: VistadexTradeQuote
): Promise<TradeExecution> {
  if (!quote.rfqId) {
    throw new Error("Cannot submit Vistadex quote without an rfqId.");
  }
  if (!quote.unsignedTransaction) {
    throw new Error(`Cannot submit Vistadex RFQ ${quote.rfqId}: unsigned transaction is missing.`);
  }

  const { client } = await createVistadexClient(config);
  const wallet = await loadWallet(config);
  const response = await client.submitTrade({
    rfqId: quote.rfqId,
    walletAddress: wallet.publicKey.toBase58(),
    unsignedTransaction: quote.unsignedTransaction,
    wallet,
    quoteTimeoutMs: ticket.quoteTimeoutMs,
    fillerTimeoutMs: ticket.fillerTimeoutMs
  });

  const details = {
    ...sanitizeVistadexTradeResult(response),
    side: ticket.side,
    winningQuote: quote.quote,
    feeRateBps: quote.feeRateBps
  };
  return {
    venue: "vistadex",
    status: details.transactionSignature ? "filled" : "submitted",
    details: details as Record<string, unknown>
  };
}
