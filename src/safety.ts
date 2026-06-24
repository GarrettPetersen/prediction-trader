import type { SafetyLimits, TradeTicket } from "./types.js";

export const LIVE_TRADING_ENV_VALUE = "1";

export function getTicketNotionalUsd(ticket: TradeTicket): number {
  if (ticket.venue === "polymarket") {
    if (ticket.amountUsd !== undefined) return ticket.amountUsd;
    if (ticket.shares !== undefined) return ticket.shares * ticket.price;
    return 0;
  }

  if (ticket.amountUsd !== undefined) return ticket.amountUsd;
  if (ticket.shares !== undefined && ticket.limitPrice !== undefined) {
    return ticket.shares * ticket.limitPrice;
  }
  return 0;
}

export function assertCanExecute(ticket: TradeTicket, limits: SafetyLimits, execute: boolean): void {
  if (!execute) {
    throw new Error("Refusing to execute without --execute.");
  }

  if (!limits.liveEnabled) {
    throw new Error("Refusing to execute unless PREDICTION_TRADER_LIVE=1.");
  }

  const notionalUsd = getTicketNotionalUsd(ticket);
  if (notionalUsd <= 0) {
    throw new Error("Cannot verify notional size; refusing to execute.");
  }

  if (notionalUsd > limits.maxUsd) {
    throw new Error(
      `Refusing to execute $${notionalUsd.toFixed(2)} order above max $${limits.maxUsd.toFixed(2)}.`
    );
  }
}

export function assertLiveMutation(limits: SafetyLimits, execute: boolean): void {
  if (!execute) {
    throw new Error("Refusing to execute without --execute.");
  }

  if (!limits.liveEnabled) {
    throw new Error("Refusing to execute unless PREDICTION_TRADER_LIVE=1.");
  }
}
