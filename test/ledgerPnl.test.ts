import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildBackfillLedgerRecord,
  type LedgerRecord
} from "../src/ledger.js";
import {
  computeLedgerPnl,
  ledgerPnlKey,
  type LedgerPositionMark
} from "../src/ledgerPnl.js";

function fill(input: {
  id: string;
  side: "buy" | "sell";
  question: string;
  slug: string;
  conditionId: string;
  outcomeIndex: number;
  outcome: string;
  shares: number;
  notionalUsd: number;
  occurredAt: string;
}): LedgerRecord {
  return buildBackfillLedgerRecord({
    venue: "vistadex",
    action: "fill",
    dedupeKey: `fill:${input.id}`,
    occurredAt: input.occurredAt,
    status: "filled",
    side: input.side,
    shares: input.shares,
    notionalUsd: input.notionalUsd,
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
  shares: number;
  notionalUsd: number;
  occurredAt: string;
}): LedgerRecord {
  return buildBackfillLedgerRecord({
    venue: "vistadex",
    action: "redeem",
    dedupeKey: `redeem:${input.id}`,
    occurredAt: input.occurredAt,
    status: input.notionalUsd > 0 ? "redeemed_win" : "redeemed_loss",
    price: input.shares > 0 ? input.notionalUsd / input.shares : 0,
    shares: input.shares,
    notionalUsd: input.notionalUsd,
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
    midValueUsd: input.shares * input.midPrice,
    bidValueUsd: input.shares * input.bidPrice
  };
}

describe("ledger PnL", () => {
  it("counts sold winners and open live marks in one report", () => {
    const records = [
      fill({
        id: "winner-buy",
        side: "buy",
        question: "Will the highest temperature in Paris be 34°C on July 8?",
        slug: "highest-temperature-in-paris-on-july-8-2026-34c",
        conditionId: "paris",
        outcomeIndex: 1,
        outcome: "No",
        shares: 20,
        notionalUsd: 10,
        occurredAt: "2026-07-08T00:00:00.000Z"
      }),
      fill({
        id: "winner-sell",
        side: "sell",
        question: "Will the highest temperature in Paris be 34°C on July 8?",
        slug: "highest-temperature-in-paris-on-july-8-2026-34c",
        conditionId: "paris",
        outcomeIndex: 1,
        outcome: "No",
        shares: 20,
        notionalUsd: 16,
        occurredAt: "2026-07-08T06:00:00.000Z"
      }),
      fill({
        id: "open-buy",
        side: "buy",
        question: "Will the highest temperature in Warsaw be 20°C on July 8?",
        slug: "highest-temperature-in-warsaw-on-july-8-2026-20c",
        conditionId: "warsaw",
        outcomeIndex: 1,
        outcome: "No",
        shares: 20,
        notionalUsd: 10,
        occurredAt: "2026-07-08T00:00:00.000Z"
      })
    ];
    const report = computeLedgerPnl(records, {
      category: "weather",
      marks: [
        mark({
          question: "Will the highest temperature in Warsaw be 20°C on July 8?",
          slug: "highest-temperature-in-warsaw-on-july-8-2026-20c",
          conditionId: "warsaw",
          outcomeIndex: 1,
          outcome: "No",
          shares: 20,
          midPrice: 0.15,
          bidPrice: 0.1
        })
      ]
    });

    assert.equal(report.positionCount, 2);
    assert.equal(report.winnerCount, 1);
    assert.equal(report.loserCount, 1);
    assert.equal(report.totals.buyUsd, 20);
    assert.equal(report.totals.sellUsd, 16);
    assert.equal(report.totals.liveMidValueUsd, 3);
    assert.equal(report.totals.pnlMidUsd, -1);
    assert.equal(report.totals.pnlBidUsd, -2);
  });

  it("excludes sell-only liquidation rows unless requested", () => {
    const records = [
      fill({
        id: "sell-only",
        side: "sell",
        question: "Will the highest temperature in Helsinki be 18°C on July 8?",
        slug: "highest-temperature-in-helsinki-on-july-8-2026-18c",
        conditionId: "helsinki",
        outcomeIndex: 1,
        outcome: "No",
        shares: 20,
        notionalUsd: 16,
        occurredAt: "2026-07-08T00:00:00.000Z"
      })
    ];

    assert.equal(computeLedgerPnl(records, { category: "weather" }).positionCount, 0);

    const report = computeLedgerPnl(records, {
      category: "weather",
      includeSellOnly: true
    });
    assert.equal(report.positionCount, 1);
    assert.equal(report.totals.pnlMidUsd, 16);
  });

  it("counts redemption proceeds as realized PnL", () => {
    const records = [
      fill({
        id: "redeem-buy",
        side: "buy",
        question: "Will the highest temperature in Atlanta be between 94-95°F on July 8?",
        slug: "highest-temperature-in-atlanta-on-july-8-2026-94-95f",
        conditionId: "atlanta",
        outcomeIndex: 1,
        outcome: "No",
        shares: 20,
        notionalUsd: 10,
        occurredAt: "2026-07-08T00:00:00.000Z"
      }),
      redeem({
        id: "redeem-win",
        question: "Will the highest temperature in Atlanta be between 94-95°F on July 8?",
        slug: "highest-temperature-in-atlanta-on-july-8-2026-94-95f",
        conditionId: "atlanta",
        outcomeIndex: 1,
        outcome: "No",
        shares: 20,
        notionalUsd: 20,
        occurredAt: "2026-07-09T00:00:00.000Z"
      })
    ];
    const report = computeLedgerPnl(records, { category: "weather" });

    assert.equal(report.totals.buyUsd, 10);
    assert.equal(report.totals.redemptionUsd, 20);
    assert.equal(report.totals.realizedUsd, 20);
    assert.equal(report.totals.pnlMidUsd, 10);
  });

  it("filters by category and timestamp", () => {
    const records = [
      fill({
        id: "old-weather",
        side: "buy",
        question: "Will the highest temperature in Milan be 36°C on July 8?",
        slug: "highest-temperature-in-milan-on-july-8-2026-36c",
        conditionId: "milan",
        outcomeIndex: 1,
        outcome: "No",
        shares: 20,
        notionalUsd: 10,
        occurredAt: "2026-07-07T00:00:00.000Z"
      }),
      fill({
        id: "new-weather",
        side: "buy",
        question: "Will the highest temperature in Chicago be between 88-89°F on July 8?",
        slug: "highest-temperature-in-chicago-on-july-8-2026-88-89f",
        conditionId: "chicago",
        outcomeIndex: 1,
        outcome: "No",
        shares: 20,
        notionalUsd: 10,
        occurredAt: "2026-07-08T00:00:00.000Z"
      }),
      fill({
        id: "new-prop",
        side: "buy",
        question: "Will Ronaldo Cry at the World Cup?",
        slug: "will-ronaldo-cry-at-the-world-cup",
        conditionId: "ronaldo",
        outcomeIndex: 1,
        outcome: "No",
        shares: 1000,
        notionalUsd: 1,
        occurredAt: "2026-07-08T00:00:00.000Z"
      })
    ];
    const report = computeLedgerPnl(records, {
      category: "weather",
      since: "2026-07-07T12:00:00.000Z"
    });

    assert.equal(report.positionCount, 1);
    assert.equal(report.positions[0]?.market.conditionId, "chicago");
  });

  it("fails a bounded report when a ledger record has no usable timestamp", () => {
    const record = fill({
      id: "missing-time",
      side: "buy",
      question: "Will the highest temperature in Milan be 36°C on July 8?",
      slug: "highest-temperature-in-milan-on-july-8-2026-36c",
      conditionId: "milan",
      outcomeIndex: 1,
      outcome: "No",
      shares: 20,
      notionalUsd: 10,
      occurredAt: "2026-07-08T00:00:00.000Z"
    });
    const malformed = {
      ...record,
      occurredAt: undefined,
      recordedAt: undefined as unknown as string
    };

    assert.throws(
      () => computeLedgerPnl([malformed], {
        category: "weather",
        since: "2026-07-07T00:00:00.000Z"
      }),
      /missing a timestamp/
    );
  });
});
