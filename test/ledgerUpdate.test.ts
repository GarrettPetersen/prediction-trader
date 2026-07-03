import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { appendLedgerRecords, readLedgerRecords } from "../src/ledger.js";
import { buildCashSnapshotLedgerRecord } from "../src/ledgerUpdate.js";

async function withTempLedger<T>(run: (path: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "prediction-trader-ledger-update-"));
  try {
    return await run(join(dir, "ledger.jsonl"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("ledger update", () => {
  it("dedupes daily cash snapshots by venue, account, and balance", async () => {
    await withTempLedger(async (path) => {
      const record = buildCashSnapshotLedgerRecord({
        venue: "vistadex",
        account: "wallet-1",
        cashUsd: "12.34",
        snapshotId: "2026-07-03",
        raw: { cashUsd: "12.34" },
        recordedAt: "2026-07-03T12:00:00.000Z"
      });

      const first = await appendLedgerRecords(path, [record]);
      const second = await appendLedgerRecords(path, [record]);
      const records = await readLedgerRecords(path);

      assert.equal(record.action, "cash_snapshot");
      assert.equal(record.notionalUsd, 12.34);
      assert.equal(first.appended, 1);
      assert.equal(second.appended, 0);
      assert.equal(records.length, 1);
    });
  });
});
