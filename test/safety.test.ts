import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assertCanExecute, getTicketNotionalUsd } from "../src/safety.js";
import type { PolymarketOrderTicket, VistadexTradeTicket } from "../src/types.js";

describe("trade safety", () => {
  const polyTicket: PolymarketOrderTicket = {
    venue: "polymarket",
    side: "buy",
    tokenId: "token",
    price: 0.5,
    amountUsd: 2,
    orderType: "FOK"
  };

  const vistadexTicket: VistadexTradeTicket = {
    venue: "vistadex",
    side: "buy",
    conditionId: "a".repeat(64),
    outcomeIndex: 0,
    amountUsd: 3
  };

  it("computes notional for Polymarket amount and shares tickets", () => {
    assert.equal(getTicketNotionalUsd(polyTicket), 2);
    assert.equal(getTicketNotionalUsd({ ...polyTicket, amountUsd: undefined, shares: 4 }), 2);
  });

  it("computes Vistadex buy notional", () => {
    assert.equal(getTicketNotionalUsd(vistadexTicket), 3);
  });

  it("requires the command execute flag", () => {
    assert.throws(
      () => assertCanExecute(polyTicket, { liveEnabled: true, maxUsd: 5 }, false),
      /--execute/
    );
  });

  it("requires live trading env", () => {
    assert.throws(
      () => assertCanExecute(polyTicket, { liveEnabled: false, maxUsd: 5 }, true),
      /PREDICTION_TRADER_LIVE=1/
    );
  });

  it("blocks orders above the configured notional limit", () => {
    assert.throws(
      () => assertCanExecute(polyTicket, { liveEnabled: true, maxUsd: 1 }, true),
      /above max/
    );
  });
});
