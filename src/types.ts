export type Venue = "polymarket" | "vistadex";
export type TradeSide = "buy" | "sell";

export interface SafetyLimits {
  liveEnabled: boolean;
  maxUsd: number;
}

export interface PolymarketOrderTicket {
  venue: "polymarket";
  side: TradeSide;
  tokenId: string;
  price: number;
  orderType: "GTC" | "GTD" | "FOK" | "FAK";
  amountUsd?: number;
  shares?: number;
  tickSize?: string;
  negRisk?: boolean;
  postOnly?: boolean;
}

export interface PolymarketRedeemTicket {
  venue: "polymarket";
  conditionId?: string;
  marketId?: string;
  positionId?: string;
}

export interface VistadexTradeTicket {
  venue: "vistadex";
  side: TradeSide;
  conditionId: string;
  outcomeIndex: 0 | 1;
  collateralMint?: string;
  amountUsd?: number;
  shares?: number;
  limitPrice?: number;
}

export type TradeTicket = PolymarketOrderTicket | VistadexTradeTicket;

export interface TradePreview {
  venue: Venue;
  summary: string;
  notionalUsd: number;
  details: Record<string, unknown>;
}

export interface TradeExecution {
  venue: Venue;
  status: "submitted" | "filled" | "failed" | "unknown";
  details: Record<string, unknown>;
}
