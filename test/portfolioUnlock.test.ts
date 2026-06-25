import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { PolymarketPosition } from "../src/marketplaces/polymarketData.js";
import type { VistadexPosition } from "../src/marketplaces/vistadex.js";
import {
  buildPolymarketUnlockPair,
  buildUnlockTickets,
  findPolymarketBinaryPairCandidates,
  findVistadexBinaryPairCandidates
} from "../src/portfolioUnlock.js";

function polymarketPosition(overrides: Partial<PolymarketPosition>): PolymarketPosition {
  return {
    title: "Example market",
    outcome: overrides.outcome,
    size: 0,
    avgPrice: 0,
    currentValue: 0,
    curPrice: 0,
    cashPnl: 0,
    percentPnl: 0,
    redeemable: false,
    slug: "example-market",
    conditionId: "0xabc",
    asset: "token",
    outcomeIndex: 0,
    negativeRisk: false,
    ...overrides
  };
}

function vistadexPosition(overrides: Partial<VistadexPosition>): VistadexPosition {
  return {
    slug: "example-market",
    question: "Example market",
    outcomes: ["Yes", "No"],
    conditionId: "abc",
    outcomeIndex: 0,
    collateralMint: "USDC",
    balance: "0",
    ...overrides
  };
}

describe("portfolio unlock helpers", () => {
  it("finds same-condition Polymarket YES/NO pairs only", () => {
    const pairs = findPolymarketBinaryPairCandidates([
      polymarketPosition({ conditionId: "a", outcomeIndex: 0, outcome: "Yes", size: 10 }),
      polymarketPosition({ conditionId: "a", outcomeIndex: 1, outcome: "No", size: 4 }),
      polymarketPosition({ conditionId: "b", outcomeIndex: 0, outcome: "Yes", size: 20 })
    ]);

    assert.equal(pairs.length, 1);
    assert.equal(pairs[0].conditionId, "a");
    assert.equal(pairs[0].pairShares, 4);
  });

  it("finds same-condition Vistadex binary pairs from balance strings", () => {
    const pairs = findVistadexBinaryPairCandidates([
      vistadexPosition({ conditionId: "a", outcomeIndex: 0, balance: "2.5" }),
      vistadexPosition({ conditionId: "a", outcomeIndex: 1, balance: "3.5" }),
      vistadexPosition({ conditionId: "b", outcomeIndex: 1, balance: "5" })
    ]);

    assert.equal(pairs.length, 1);
    assert.equal(pairs[0].pairShares, 2.5);
  });

  it("builds a Polymarket unlock pair from the smaller position and top-of-book size", () => {
    const [candidate] = findPolymarketBinaryPairCandidates([
      polymarketPosition({
        conditionId: "a",
        outcomeIndex: 0,
        outcome: "Yes",
        asset: "yes-token",
        size: 35
      }),
      polymarketPosition({
        conditionId: "a",
        outcomeIndex: 1,
        outcome: "No",
        asset: "no-token",
        size: 4.6666
      })
    ]);

    const pair = buildPolymarketUnlockPair(
      candidate,
      { bids: [{ price: 0.182, size: 10 }], asks: [], bestBid: { price: 0.182, size: 10 } },
      { bids: [{ price: 0.817, size: 20 }], asks: [], bestBid: { price: 0.817, size: 20 } }
    );

    assert.equal(pair.executable, true);
    assert.equal(pair.sellShares, 4.6666);
    assert.ok(pair.priceSum !== undefined && Math.abs(pair.priceSum - 0.999) < 0.0000001);
    assert.ok(Math.abs(pair.estimatedUnlockUsd - 4.6619334) < 0.0000001);
    assert.ok(Math.abs(pair.estimatedCostUsd - 0.0046666) < 0.0000001);

    const tickets = buildUnlockTickets(pair);
    assert.deepEqual(tickets.map((ticket) => ticket.side), ["sell", "sell"]);
    assert.deepEqual(tickets.map((ticket) => ticket.venue), ["polymarket", "polymarket"]);
  });
});
