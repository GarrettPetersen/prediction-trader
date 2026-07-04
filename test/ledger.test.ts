import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  appendLedgerRecords,
  buildBackfillLedgerRecord,
  buildExecutionLedgerRecord,
  readLedgerRecords,
  summarizeLedger
} from "../src/ledger.js";

async function withTempLedger<T>(run: (path: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "prediction-trader-ledger-"));
  try {
    return await run(join(dir, "ledger.jsonl"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("trade ledger", () => {
  it("appends records once by dedupe key", async () => {
    await withTempLedger(async (path) => {
      const record = buildBackfillLedgerRecord({
        venue: "polymarket",
        action: "fill",
        dedupeKey: "polymarket:fill:abc",
        status: "matched",
        price: 0.42,
        shares: 10,
        notionalUsd: 4.2,
        raw: { id: "abc" },
        recordedAt: "2026-06-26T00:00:00.000Z"
      });

      const first = await appendLedgerRecords(path, [record]);
      const second = await appendLedgerRecords(path, [record]);
      const records = await readLedgerRecords(path);

      assert.equal(first.appended, 1);
      assert.equal(second.appended, 0);
      assert.equal(second.skipped, 1);
      assert.equal(records.length, 1);
    });
  });

  it("extracts execution ids and summarizes notional", () => {
    const record = buildExecutionLedgerRecord({
      command: "polymarket:order",
      ticket: {
        venue: "polymarket",
        side: "buy",
        tokenId: "123",
        price: 0.5,
        amountUsd: 5,
        orderType: "FOK"
      },
      preview: {
        venue: "polymarket",
        summary: "BUY $5.00 of 123 at price 0.5 (FOK)",
        notionalUsd: 5,
        details: {}
      },
      execution: {
        venue: "polymarket",
        status: "filled",
        details: {
          orderID: "0xorder",
          transactionHash: "0xtx"
        }
      },
      recordedAt: "2026-06-26T00:00:00.000Z"
    });

    const summary = summarizeLedger([record]);

    assert.equal(record.dedupeKey, "polymarket:order:0xorder");
    assert.equal(record.ids?.orderId, "0xorder");
    assert.equal(summary.count, 1);
    assert.equal(summary.byVenue.polymarket, 1);
    assert.equal(summary.byAction.order, 1);
    assert.equal(summary.estimatedNotionalUsd, 5);
  });

  it("records Vistadex fill economics from the winning quote", () => {
    const record = buildExecutionLedgerRecord({
      command: "vistadex:trade",
      ticket: {
        venue: "vistadex",
        side: "sell",
        conditionId: "0xcondition",
        outcomeIndex: 1,
        shares: 21.2,
        limitPrice: 0.99
      },
      preview: {
        venue: "vistadex",
        summary: "SELL 21.2 shares on condition 0xcondition, outcome 1",
        notionalUsd: 20.988,
        details: {}
      },
      execution: {
        venue: "vistadex",
        status: "filled",
        details: {
          rfqId: "rfq_123",
          transactionSignature: "sig_123",
          winningQuote: {
            pricePerShare: 0.9989,
            shares: 21.2,
            totalUsd: 21.17668
          }
        }
      },
      recordedAt: "2026-07-04T00:00:00.000Z"
    });

    assert.equal(record.dedupeKey, "vistadex:trade:sig_123");
    assert.equal(record.price, 0.9989);
    assert.equal(record.shares, 21.2);
    assert.equal(record.notionalUsd, 21.17668);
  });
});
