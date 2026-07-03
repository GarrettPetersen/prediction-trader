import type { AppConfig } from "./config.js";
import {
  appendLedgerRecords,
  buildBackfillLedgerRecord,
  ledgerNumber,
  readLedgerRecords,
  summarizeLedger,
  type AppendLedgerResult,
  type LedgerRecord
} from "./ledger.js";
import {
  buildLedgerBackfillRecords,
  type LedgerBackfillOptions,
  type LedgerBackfillResult,
  type LedgerBackfillVenue
} from "./ledgerBackfill.js";
import { getPolymarketCollateralBalance } from "./marketplaces/polymarket.js";
import { getVistadexUSDCBalance } from "./marketplaces/vistadex.js";
import type { Venue } from "./types.js";

export interface LedgerUpdateOptions extends LedgerBackfillOptions {
  includeCash?: boolean;
  cashSnapshotId?: string;
}

export interface LedgerUpdateError {
  venue: Venue;
  stage: "activity" | "cash";
  message: string;
}

export interface LedgerCashSnapshot {
  venue: Venue;
  account: string;
  cashUsd: string;
}

export interface LedgerUpdateResult extends AppendLedgerResult {
  generated: LedgerBackfillResult["generated"] & {
    cashSnapshots: number;
  };
  cashSnapshots: LedgerCashSnapshot[];
  errors: LedgerUpdateError[];
  beforeSummary: ReturnType<typeof summarizeLedger>;
  afterSummary: ReturnType<typeof summarizeLedger>;
  appendedSummary: ReturnType<typeof summarizeLedger>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requestedVenues(venue: LedgerBackfillVenue | undefined): Venue[] {
  if (!venue || venue === "all") return ["polymarket", "vistadex"];
  return [venue];
}

function emptyGenerated(): LedgerUpdateResult["generated"] {
  return {
    polymarketFills: 0,
    polymarketPositions: 0,
    vistadexActivity: 0,
    vistadexFills: 0,
    vistadexPositions: 0,
    vistadexRedemptions: 0,
    cashSnapshots: 0
  };
}

function addGenerated(
  target: LedgerUpdateResult["generated"],
  source: LedgerBackfillResult["generated"]
): void {
  target.polymarketFills += source.polymarketFills;
  target.polymarketPositions += source.polymarketPositions;
  target.vistadexActivity += source.vistadexActivity;
  target.vistadexFills += source.vistadexFills;
  target.vistadexPositions += source.vistadexPositions;
  target.vistadexRedemptions += source.vistadexRedemptions;
}

function defaultCashSnapshotId(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

export function buildCashSnapshotLedgerRecord(input: {
  venue: Venue;
  account: string;
  cashUsd: string | number;
  snapshotId: string;
  raw: unknown;
  recordedAt?: string;
}): LedgerRecord {
  const cashUsd = String(input.cashUsd);
  const cashNumber = ledgerNumber(cashUsd);
  const dedupeKey = [
    input.venue,
    "cash_snapshot",
    input.snapshotId,
    input.account,
    cashUsd
  ].join(":");

  return buildBackfillLedgerRecord({
    venue: input.venue,
    action: "cash_snapshot",
    dedupeKey,
    occurredAt: input.recordedAt,
    recordedAt: input.recordedAt,
    status: "snapshot",
    notionalUsd: cashNumber,
    summary: `${input.venue} cash snapshot: $${cashUsd}`,
    raw: input.raw,
    notes: [
      "Backfilled from current venue cash/collateral balance; this is not an execution record."
    ]
  });
}

async function collectBackfillRecords(
  config: AppConfig,
  options: LedgerUpdateOptions
): Promise<{
  records: LedgerRecord[];
  generated: LedgerUpdateResult["generated"];
  errors: LedgerUpdateError[];
}> {
  const records: LedgerRecord[] = [];
  const generated = emptyGenerated();
  const errors: LedgerUpdateError[] = [];

  for (const venue of requestedVenues(options.venue)) {
    try {
      const result = await buildLedgerBackfillRecords(config, {
        ...options,
        venue
      });
      records.push(...result.records);
      addGenerated(generated, result.generated);
    } catch (error) {
      errors.push({
        venue,
        stage: "activity",
        message: errorMessage(error)
      });
    }
  }

  return { records, generated, errors };
}

async function collectCashSnapshotRecords(
  config: AppConfig,
  options: LedgerUpdateOptions
): Promise<{
  records: LedgerRecord[];
  cashSnapshots: LedgerCashSnapshot[];
  errors: LedgerUpdateError[];
}> {
  if (options.includeCash === false) {
    return { records: [], cashSnapshots: [], errors: [] };
  }

  const records: LedgerRecord[] = [];
  const cashSnapshots: LedgerCashSnapshot[] = [];
  const errors: LedgerUpdateError[] = [];
  const recordedAt = new Date().toISOString();
  const snapshotId = options.cashSnapshotId ?? defaultCashSnapshotId();

  for (const venue of requestedVenues(options.venue)) {
    try {
      if (venue === "polymarket") {
        const snapshot = await getPolymarketCollateralBalance(config);
        records.push(buildCashSnapshotLedgerRecord({
          venue,
          account: snapshot.funderAddress,
          cashUsd: snapshot.cashUsd,
          snapshotId,
          raw: snapshot,
          recordedAt
        }));
        cashSnapshots.push({
          venue,
          account: snapshot.funderAddress,
          cashUsd: snapshot.cashUsd
        });
      } else {
        const snapshot = await getVistadexUSDCBalance(config);
        records.push(buildCashSnapshotLedgerRecord({
          venue,
          account: snapshot.walletAddress,
          cashUsd: snapshot.cashUsd,
          snapshotId,
          raw: snapshot,
          recordedAt
        }));
        cashSnapshots.push({
          venue,
          account: snapshot.walletAddress,
          cashUsd: snapshot.cashUsd
        });
      }
    } catch (error) {
      errors.push({
        venue,
        stage: "cash",
        message: errorMessage(error)
      });
    }
  }

  return { records, cashSnapshots, errors };
}

export async function updateLedger(
  config: AppConfig,
  path: string,
  options: LedgerUpdateOptions = {}
): Promise<LedgerUpdateResult> {
  const beforeRecords = await readLedgerRecords(path);
  const backfill = await collectBackfillRecords(config, options);
  const cash = await collectCashSnapshotRecords(config, options);
  const records = [...backfill.records, ...cash.records];
  const appendResult = await appendLedgerRecords(path, records);
  const afterRecords = await readLedgerRecords(path);
  const generated = {
    ...backfill.generated,
    cashSnapshots: cash.records.length
  };

  return {
    ...appendResult,
    generated,
    cashSnapshots: cash.cashSnapshots,
    errors: [...backfill.errors, ...cash.errors],
    beforeSummary: summarizeLedger(beforeRecords, path),
    afterSummary: summarizeLedger(afterRecords, path),
    appendedSummary: summarizeLedger(appendResult.records)
  };
}
