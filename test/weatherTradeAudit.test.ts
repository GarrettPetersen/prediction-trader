import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildBackfillLedgerRecord,
  type LedgerRecord
} from "../src/ledger.js";
import {
  ledgerPnlKey,
  type LedgerPositionMark
} from "../src/ledgerPnl.js";
import { computeWeatherTradeAudit } from "../src/weatherTradeAudit.js";

function fill(input: {
  id: string;
  side: "buy" | "sell";
  question: string;
  slug: string;
  conditionId: string;
  outcomeIndex: number;
  outcome: string;
  price: number;
  shares: number;
  occurredAt: string;
}): LedgerRecord {
  return buildBackfillLedgerRecord({
    venue: "vistadex",
    action: "fill",
    dedupeKey: `fill:${input.id}`,
    occurredAt: input.occurredAt,
    status: "filled",
    side: input.side,
    price: input.price,
    shares: input.shares,
    notionalUsd: input.price * input.shares,
    market: {
      conditionId: input.conditionId,
      slug: input.slug,
      question: input.question,
      outcome: input.outcome,
      outcomeIndex: input.outcomeIndex
    },
    raw: input
  });
}

function redeem(input: {
  id: string;
  question: string;
  slug: string;
  conditionId: string;
  outcomeIndex: number;
  outcome: string;
  price: number;
  shares: number;
  occurredAt: string;
}): LedgerRecord {
  return buildBackfillLedgerRecord({
    venue: "vistadex",
    action: "redeem",
    dedupeKey: `redeem:${input.id}`,
    occurredAt: input.occurredAt,
    status: input.price > 0 ? "redeemed_win" : "redeemed_loss",
    price: input.price,
    shares: input.shares,
    notionalUsd: input.price * input.shares,
    market: {
      conditionId: input.conditionId,
      slug: input.slug,
      question: input.question,
      outcome: input.outcome,
      outcomeIndex: input.outcomeIndex
    },
    raw: input
  });
}

function mark(input: {
  question: string;
  slug: string;
  conditionId: string;
  outcomeIndex: number;
  outcome: string;
  shares: number;
  midPrice: number;
  bidPrice: number;
  askPrice: number;
}): LedgerPositionMark {
  const market = {
    conditionId: input.conditionId,
    slug: input.slug,
    question: input.question,
    outcome: input.outcome,
    outcomeIndex: input.outcomeIndex
  };
  const key = ledgerPnlKey("vistadex", market);
  assert.ok(key);
  return {
    venue: "vistadex",
    key,
    market,
    status: "active",
    shares: input.shares,
    midPrice: input.midPrice,
    bidPrice: input.bidPrice,
    askPrice: input.askPrice,
    midValueUsd: input.shares * input.midPrice,
    bidValueUsd: input.shares * input.bidPrice
  };
}

describe("weather trade audit", () => {
  it("marks the opposite side using the complementary ask price", () => {
    const question = "Will the highest temperature in Warsaw be 20°C on July 8?";
    const records = [
      fill({
        id: "warsaw-no",
        side: "buy",
        question,
        slug: "highest-temperature-in-warsaw-on-july-8-2026-20c",
        conditionId: "warsaw",
        outcomeIndex: 1,
        outcome: "No",
        price: 0.5,
        shares: 20,
        occurredAt: "2026-07-08T00:00:00.000Z"
      })
    ];
    const report = computeWeatherTradeAudit(records, {
      marks: [
        mark({
          question,
          slug: "highest-temperature-in-warsaw-on-july-8-2026-20c",
          conditionId: "warsaw",
          outcomeIndex: 1,
          outcome: "No",
          shares: 20,
          midPrice: 0.125,
          bidPrice: 0.1,
          askPrice: 0.15
        })
      ]
    });

    assert.equal(report.positionCount, 1);
    assert.equal(report.actual.buyUsd, 10);
    assert.equal(report.actual.liveBidValueUsd, 2);
    assert.equal(report.actual.selectedPnlUsd, -8);
    assert.equal(report.opposite.liveBidValueUsd, 17);
    assert.equal(report.opposite.selectedPnlUsd, 7);
    assert.equal(report.oppositeAdvantageUsd, 15);
    assert.equal(report.positions[0]?.classification.marketType, "temperature_high:exact:C");
  });

  it("inverts settled winners and losers from redemption price", () => {
    const question = "Will the highest temperature in Atlanta be between 94-95°F on July 8?";
    const records = [
      fill({
        id: "atlanta-no-buy",
        side: "buy",
        question,
        slug: "highest-temperature-in-atlanta-on-july-8-2026-94-95f",
        conditionId: "atlanta",
        outcomeIndex: 1,
        outcome: "No",
        price: 0.25,
        shares: 20,
        occurredAt: "2026-07-08T00:00:00.000Z"
      }),
      redeem({
        id: "atlanta-no-win",
        question,
        slug: "highest-temperature-in-atlanta-on-july-8-2026-94-95f",
        conditionId: "atlanta",
        outcomeIndex: 1,
        outcome: "No",
        price: 1,
        shares: 20,
        occurredAt: "2026-07-09T00:00:00.000Z"
      })
    ];

    const report = computeWeatherTradeAudit(records);

    assert.equal(report.actual.buyUsd, 5);
    assert.equal(report.actual.redemptionUsd, 20);
    assert.equal(report.actual.selectedPnlUsd, 15);
    assert.equal(report.opposite.buyUsd, 5);
    assert.equal(report.opposite.redemptionUsd, 0);
    assert.equal(report.opposite.selectedPnlUsd, -5);
  });

  it("buckets results by side and weather market type", () => {
    const records = [
      fill({
        id: "paris-yes-buy",
        side: "buy",
        question: "Will the lowest temperature in Paris be 20°C on July 8?",
        slug: "lowest-temperature-in-paris-on-july-8-2026-20c",
        conditionId: "paris-low",
        outcomeIndex: 0,
        outcome: "Yes",
        price: 0.3,
        shares: 10,
        occurredAt: "2026-07-08T00:00:00.000Z"
      }),
      redeem({
        id: "paris-yes-loss",
        question: "Will the lowest temperature in Paris be 20°C on July 8?",
        slug: "lowest-temperature-in-paris-on-july-8-2026-20c",
        conditionId: "paris-low",
        outcomeIndex: 0,
        outcome: "Yes",
        price: 0,
        shares: 10,
        occurredAt: "2026-07-09T00:00:00.000Z"
      })
    ];

    const report = computeWeatherTradeAudit(records);

    assert.equal(report.buckets.bySide[0]?.key, "YES");
    assert.equal(report.buckets.byMarketType[0]?.key, "temperature_low:exact:C");
    assert.equal(report.buckets.byMarketTypeAndSide[0]?.key, "temperature_low:exact:C|YES");
  });

  it("fails fast when an open position has no live mark", () => {
    const records = [
      fill({
        id: "milan-no-open",
        side: "buy",
        question: "Will the highest temperature in Milan be 36°C on July 8?",
        slug: "highest-temperature-in-milan-on-july-8-2026-36c",
        conditionId: "milan",
        outcomeIndex: 1,
        outcome: "No",
        price: 0.5,
        shares: 20,
        occurredAt: "2026-07-08T00:00:00.000Z"
      })
    ];

    assert.throws(
      () => computeWeatherTradeAudit(records),
      /open position has no live mark/
    );
  });

  it("fails a bounded audit when a ledger record has no usable timestamp", () => {
    const record = fill({
      id: "missing-time",
      side: "buy",
      question: "Will the highest temperature in Milan be 36°C on July 8?",
      slug: "highest-temperature-in-milan-on-july-8-2026-36c",
      conditionId: "milan",
      outcomeIndex: 1,
      outcome: "No",
      price: 0.5,
      shares: 20,
      occurredAt: "2026-07-08T00:00:00.000Z"
    });
    const malformed = {
      ...record,
      occurredAt: undefined,
      recordedAt: undefined as unknown as string
    };

    assert.throws(
      () => computeWeatherTradeAudit([malformed], {
        since: "2026-07-07T00:00:00.000Z"
      }),
      /missing a timestamp/
    );
  });
});
