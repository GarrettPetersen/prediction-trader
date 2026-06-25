import type { AppConfig } from "./config.js";
import {
  getPolymarketBook,
  getPolymarketPositions,
  type PolymarketBook,
  type PolymarketPosition
} from "./marketplaces/polymarketData.js";
import {
  getVistadexPositions,
  quoteVistadexTrade,
  type VistadexPosition
} from "./marketplaces/vistadex.js";
import type { PolymarketOrderTicket, TradeTicket, VistadexTradeTicket } from "./types.js";

const DEFAULT_MIN_SHARES = 0.000001;
const DEFAULT_MIN_UNLOCK_USD = 0.5;
const SHARE_DECIMALS = 6;

export type PortfolioUnlockVenue = "polymarket" | "vistadex";
export type PortfolioUnlockVenueArg = PortfolioUnlockVenue | "all";

export interface PortfolioUnlockOptions {
  venue?: PortfolioUnlockVenueArg;
  limit?: number;
  maxPairs?: number;
  minShares?: number;
  minUnlockUsd?: number;
}

export interface BinaryPairCandidate<TPosition> {
  venue: PortfolioUnlockVenue;
  conditionId: string;
  slug?: string;
  title?: string;
  question?: string;
  yes: TPosition;
  no: TPosition;
  pairShares: number;
}

export interface PortfolioUnlockSide {
  outcomeIndex: 0 | 1;
  label: string;
  sharesHeld: number;
  sellShares: number;
  price?: number;
  availableShares?: number;
  notionalUsd: number;
  tokenId?: string;
  collateralMint?: string;
  quote?: PortfolioUnlockQuoteDetails;
}

export interface PortfolioUnlockPair {
  venue: PortfolioUnlockVenue;
  conditionId: string;
  slug?: string;
  title?: string;
  question?: string;
  pairSharesHeld: number;
  sellShares: number;
  cashFloorUsd: number;
  estimatedUnlockUsd: number;
  estimatedCostUsd: number;
  priceSum?: number;
  executable: boolean;
  skipReason?: string;
  sides: [PortfolioUnlockSide, PortfolioUnlockSide];
}

export interface PortfolioUnlockPlan {
  generatedAt: string;
  venues: PortfolioUnlockVenue[];
  options: Required<Pick<PortfolioUnlockOptions, "limit" | "minShares" | "minUnlockUsd">> &
    Pick<PortfolioUnlockOptions, "maxPairs">;
  pairs: PortfolioUnlockPair[];
  skippedPairs: PortfolioUnlockPair[];
  errors: Array<{ venue: PortfolioUnlockVenue; message: string }>;
  summary: {
    pairCount: number;
    skippedPairCount: number;
    totalSellOrders: number;
    totalEstimatedUnlockUsd: number;
    totalCashFloorUsd: number;
    totalEstimatedCostUsd: number;
  };
}

export interface PortfolioUnlockQuoteDetails {
  rfqId?: string;
  filler?: string;
  pricePerShare: number;
  shares: number;
  totalUsd: number;
  feeRateBps?: number;
}

function numberValue(value: unknown): number {
  const number = Number(value ?? 0);
  return Number.isFinite(number) ? number : 0;
}

function floorShares(value: number): number {
  const factor = 10 ** SHARE_DECIMALS;
  return Math.floor(value * factor) / factor;
}

function isOutcomeIndex(value: number): value is 0 | 1 {
  return value === 0 || value === 1;
}

function normalizeOptions(options: PortfolioUnlockOptions) {
  return {
    venue: options.venue ?? "all",
    limit: Math.min(Math.max(Math.trunc(options.limit ?? 200), 1), 500),
    maxPairs: options.maxPairs,
    minShares: options.minShares ?? DEFAULT_MIN_SHARES,
    minUnlockUsd: options.minUnlockUsd ?? DEFAULT_MIN_UNLOCK_USD
  };
}

function venueList(venue: PortfolioUnlockVenueArg): PortfolioUnlockVenue[] {
  if (venue === "all") return ["polymarket", "vistadex"];
  return [venue];
}

function pairPositions<TPosition extends { conditionId?: string; outcomeIndex: number }>(
  venue: PortfolioUnlockVenue,
  positions: TPosition[],
  getShares: (position: TPosition) => number,
  getMetadata: (position: TPosition) => { slug?: string; title?: string; question?: string },
  minShares: number
): Array<BinaryPairCandidate<TPosition>> {
  const groups = new Map<string, { yes?: TPosition; no?: TPosition }>();

  for (const position of positions) {
    if (!position.conditionId || !isOutcomeIndex(position.outcomeIndex)) continue;
    if (getShares(position) < minShares) continue;

    const group = groups.get(position.conditionId) ?? {};
    if (position.outcomeIndex === 0) {
      group.yes = position;
    } else {
      group.no = position;
    }
    groups.set(position.conditionId, group);
  }

  return Array.from(groups.entries())
    .map(([conditionId, group]) => {
      if (!group.yes || !group.no) return undefined;
      const pairShares = floorShares(Math.min(getShares(group.yes), getShares(group.no)));
      if (pairShares < minShares) return undefined;
      const metadata = getMetadata(group.yes);
      return {
        venue,
        conditionId,
        ...metadata,
        yes: group.yes,
        no: group.no,
        pairShares
      };
    })
    .filter((pair): pair is BinaryPairCandidate<TPosition> => Boolean(pair));
}

export function findPolymarketBinaryPairCandidates(
  positions: PolymarketPosition[],
  minShares = DEFAULT_MIN_SHARES
): Array<BinaryPairCandidate<PolymarketPosition>> {
  return pairPositions(
    "polymarket",
    positions,
    (position) => position.size,
    (position) => ({
      slug: position.slug,
      title: position.title,
      question: position.title
    }),
    minShares
  );
}

export function findVistadexBinaryPairCandidates(
  positions: VistadexPosition[],
  minShares = DEFAULT_MIN_SHARES
): Array<BinaryPairCandidate<VistadexPosition>> {
  return pairPositions(
    "vistadex",
    positions,
    (position) => numberValue(position.balance),
    (position) => ({
      slug: position.slug,
      question: position.question
    }),
    minShares
  );
}

function emptySide(
  outcomeIndex: 0 | 1,
  label: string,
  sharesHeld: number,
  extra: Partial<PortfolioUnlockSide> = {}
): PortfolioUnlockSide {
  return {
    outcomeIndex,
    label,
    sharesHeld,
    sellShares: 0,
    notionalUsd: 0,
    ...extra
  };
}

function skippedPair<TPosition>(
  candidate: BinaryPairCandidate<TPosition>,
  skipReason: string,
  sides: [PortfolioUnlockSide, PortfolioUnlockSide]
): PortfolioUnlockPair {
  return {
    venue: candidate.venue,
    conditionId: candidate.conditionId,
    slug: candidate.slug,
    title: candidate.title,
    question: candidate.question,
    pairSharesHeld: candidate.pairShares,
    sellShares: 0,
    cashFloorUsd: 0,
    estimatedUnlockUsd: 0,
    estimatedCostUsd: 0,
    executable: false,
    skipReason,
    sides
  };
}

export function buildPolymarketUnlockPair(
  candidate: BinaryPairCandidate<PolymarketPosition>,
  yesBook: PolymarketBook,
  noBook: PolymarketBook,
  minShares = DEFAULT_MIN_SHARES
): PortfolioUnlockPair {
  const yesSide = emptySide(0, candidate.yes.outcome ?? "Outcome 0", candidate.yes.size, {
    tokenId: candidate.yes.asset,
    price: yesBook.bestBid?.price,
    availableShares: yesBook.bestBid?.size
  });
  const noSide = emptySide(1, candidate.no.outcome ?? "Outcome 1", candidate.no.size, {
    tokenId: candidate.no.asset,
    price: noBook.bestBid?.price,
    availableShares: noBook.bestBid?.size
  });

  if (!candidate.yes.asset || !candidate.no.asset) {
    return skippedPair(candidate, "Missing Polymarket token id for one side.", [yesSide, noSide]);
  }
  if (!yesBook.bestBid || !noBook.bestBid) {
    return skippedPair(candidate, "Missing best bid on one side.", [yesSide, noSide]);
  }

  const sellShares = floorShares(
    Math.min(candidate.pairShares, yesBook.bestBid.size, noBook.bestBid.size)
  );
  if (sellShares < minShares) {
    return skippedPair(candidate, "Top-of-book bid size is too small.", [yesSide, noSide]);
  }

  const yesNotional = sellShares * yesBook.bestBid.price;
  const noNotional = sellShares * noBook.bestBid.price;
  const priceSum = yesBook.bestBid.price + noBook.bestBid.price;
  const estimatedUnlockUsd = yesNotional + noNotional;
  const cashFloorUsd = sellShares;

  return {
    venue: "polymarket",
    conditionId: candidate.conditionId,
    slug: candidate.slug,
    title: candidate.title,
    question: candidate.question,
    pairSharesHeld: candidate.pairShares,
    sellShares,
    cashFloorUsd,
    estimatedUnlockUsd,
    estimatedCostUsd: cashFloorUsd - estimatedUnlockUsd,
    priceSum,
    executable: true,
    sides: [
      {
        ...yesSide,
        sellShares,
        notionalUsd: yesNotional
      },
      {
        ...noSide,
        sellShares,
        notionalUsd: noNotional
      }
    ]
  };
}

function quoteDetails(value: unknown): PortfolioUnlockQuoteDetails | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, any>;
  const quote = record.quote ?? record.summary;
  if (!quote || typeof quote !== "object") return undefined;

  const pricePerShare = numberValue(quote.pricePerShare);
  const shares = numberValue(quote.shares);
  const totalUsd = numberValue(quote.totalUsd);
  if (pricePerShare <= 0 || shares <= 0 || totalUsd <= 0) return undefined;

  return {
    rfqId: typeof record.rfqId === "string" ? record.rfqId : undefined,
    filler: typeof quote.filler === "string" ? quote.filler : undefined,
    pricePerShare,
    shares,
    totalUsd,
    feeRateBps: typeof record.feeRateBps === "number" ? record.feeRateBps : undefined
  };
}

function buildVistadexUnlockPair(
  candidate: BinaryPairCandidate<VistadexPosition>,
  yesQuoteRaw: unknown,
  noQuoteRaw: unknown,
  minShares = DEFAULT_MIN_SHARES
): PortfolioUnlockPair {
  const yesQuote = quoteDetails(yesQuoteRaw);
  const noQuote = quoteDetails(noQuoteRaw);
  const yesSharesHeld = numberValue(candidate.yes.balance);
  const noSharesHeld = numberValue(candidate.no.balance);
  const collateralMint = candidate.yes.collateralMint ?? candidate.no.collateralMint;
  const yesSide = emptySide(0, candidate.yes.outcomes[0] ?? "Outcome 0", yesSharesHeld, {
    collateralMint,
    price: yesQuote?.pricePerShare,
    availableShares: yesQuote?.shares,
    quote: yesQuote
  });
  const noSide = emptySide(1, candidate.no.outcomes[1] ?? "Outcome 1", noSharesHeld, {
    collateralMint,
    price: noQuote?.pricePerShare,
    availableShares: noQuote?.shares,
    quote: noQuote
  });

  if (!collateralMint) {
    return skippedPair(candidate, "Missing Vistadex collateral mint.", [yesSide, noSide]);
  }
  if (!yesQuote || !noQuote) {
    return skippedPair(candidate, "Missing RFQ quote on one side.", [yesSide, noSide]);
  }

  const sellShares = floorShares(Math.min(candidate.pairShares, yesQuote.shares, noQuote.shares));
  if (sellShares < minShares) {
    return skippedPair(candidate, "Quoted share size is too small.", [yesSide, noSide]);
  }

  const yesNotional = sellShares * yesQuote.pricePerShare;
  const noNotional = sellShares * noQuote.pricePerShare;
  const priceSum = yesQuote.pricePerShare + noQuote.pricePerShare;
  const estimatedUnlockUsd = yesNotional + noNotional;
  const cashFloorUsd = sellShares;

  return {
    venue: "vistadex",
    conditionId: candidate.conditionId,
    slug: candidate.slug,
    title: candidate.title,
    question: candidate.question,
    pairSharesHeld: candidate.pairShares,
    sellShares,
    cashFloorUsd,
    estimatedUnlockUsd,
    estimatedCostUsd: cashFloorUsd - estimatedUnlockUsd,
    priceSum,
    executable: true,
    sides: [
      {
        ...yesSide,
        sellShares,
        notionalUsd: yesNotional
      },
      {
        ...noSide,
        sellShares,
        notionalUsd: noNotional
      }
    ]
  };
}

async function createPolymarketPairs(
  config: AppConfig,
  options: ReturnType<typeof normalizeOptions>
): Promise<PortfolioUnlockPair[]> {
  const snapshot = await getPolymarketPositions(config, {
    includeZero: false,
    limit: options.limit
  });
  const candidates = findPolymarketBinaryPairCandidates(snapshot.positions, options.minShares);

  return Promise.all(
    candidates.map(async (candidate) => {
      if (!candidate.yes.asset || !candidate.no.asset) {
        return buildPolymarketUnlockPair(candidate, { bids: [], asks: [] }, { bids: [], asks: [] }, options.minShares);
      }

      const [yesBook, noBook] = await Promise.all([
        getPolymarketBook(config, candidate.yes.asset),
        getPolymarketBook(config, candidate.no.asset)
      ]);
      return buildPolymarketUnlockPair(candidate, yesBook, noBook, options.minShares);
    })
  );
}

async function createVistadexPairs(
  config: AppConfig,
  options: ReturnType<typeof normalizeOptions>
): Promise<PortfolioUnlockPair[]> {
  const snapshot = await getVistadexPositions(config, {
    includeZero: false,
    limit: options.limit
  });
  const candidates = findVistadexBinaryPairCandidates(snapshot.positions, options.minShares);

  return Promise.all(
    candidates.map(async (candidate) => {
      const collateralMint = candidate.yes.collateralMint ?? candidate.no.collateralMint;
      if (!collateralMint) {
        return buildVistadexUnlockPair(candidate, undefined, undefined, options.minShares);
      }

      const [yesQuote, noQuote] = await Promise.all([
        quoteVistadexTrade(config, {
          venue: "vistadex",
          side: "sell",
          conditionId: candidate.conditionId,
          outcomeIndex: 0,
          collateralMint,
          shares: candidate.pairShares
        }),
        quoteVistadexTrade(config, {
          venue: "vistadex",
          side: "sell",
          conditionId: candidate.conditionId,
          outcomeIndex: 1,
          collateralMint,
          shares: candidate.pairShares
        })
      ]);

      return buildVistadexUnlockPair(candidate, yesQuote, noQuote, options.minShares);
    })
  );
}

function isActionable(pair: PortfolioUnlockPair, minUnlockUsd: number): boolean {
  return pair.executable && pair.estimatedUnlockUsd >= minUnlockUsd;
}

export async function createPortfolioUnlockPlan(
  config: AppConfig,
  options: PortfolioUnlockOptions = {}
): Promise<PortfolioUnlockPlan> {
  const normalized = normalizeOptions(options);
  const venues = venueList(normalized.venue);
  const errors: PortfolioUnlockPlan["errors"] = [];
  const allPairs: PortfolioUnlockPair[] = [];

  for (const venue of venues) {
    try {
      const pairs = venue === "polymarket"
        ? await createPolymarketPairs(config, normalized)
        : await createVistadexPairs(config, normalized);
      allPairs.push(...pairs);
    } catch (error) {
      errors.push({
        venue,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  const actionable = allPairs
    .filter((pair) => isActionable(pair, normalized.minUnlockUsd))
    .sort((a, b) => b.estimatedUnlockUsd - a.estimatedUnlockUsd);
  const pairs = normalized.maxPairs === undefined
    ? actionable
    : actionable.slice(0, Math.max(0, Math.trunc(normalized.maxPairs)));
  const selected = new Set(pairs);
  const skippedPairs = allPairs.filter((pair) => !selected.has(pair));

  return {
    generatedAt: new Date().toISOString(),
    venues,
    options: {
      limit: normalized.limit,
      maxPairs: normalized.maxPairs,
      minShares: normalized.minShares,
      minUnlockUsd: normalized.minUnlockUsd
    },
    pairs,
    skippedPairs,
    errors,
    summary: {
      pairCount: pairs.length,
      skippedPairCount: skippedPairs.length,
      totalSellOrders: pairs.length * 2,
      totalEstimatedUnlockUsd: pairs.reduce((sum, pair) => sum + pair.estimatedUnlockUsd, 0),
      totalCashFloorUsd: pairs.reduce((sum, pair) => sum + pair.cashFloorUsd, 0),
      totalEstimatedCostUsd: pairs.reduce((sum, pair) => sum + pair.estimatedCostUsd, 0)
    }
  };
}

export function buildUnlockTickets(pair: PortfolioUnlockPair): TradeTicket[] {
  if (!pair.executable) return [];

  if (pair.venue === "polymarket") {
    return pair.sides.map((side): PolymarketOrderTicket => {
      if (!side.tokenId || side.price === undefined) {
        throw new Error("Polymarket unlock pair is missing token id or price.");
      }

      return {
        venue: "polymarket",
        side: "sell",
        tokenId: side.tokenId,
        shares: side.sellShares,
        price: side.price,
        orderType: "FOK"
      };
    });
  }

  return pair.sides.map((side): VistadexTradeTicket => {
    if (!side.collateralMint || side.price === undefined) {
      throw new Error("Vistadex unlock pair is missing collateral mint or price.");
    }

    return {
      venue: "vistadex",
      side: "sell",
      conditionId: pair.conditionId,
      outcomeIndex: side.outcomeIndex,
      collateralMint: side.collateralMint,
      shares: side.sellShares,
      limitPrice: side.price
    };
  });
}
