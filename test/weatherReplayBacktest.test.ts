import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { settlementReadyAt } from "../src/weatherReplayBacktest.js";

describe("weather replay backtest", () => {
  it("waits for the station-local target day to finish before settlement", () => {
    assert.equal(
      settlementReadyAt({
        targetDate: "2026-07-04",
        timezone: "America/New_York",
        lagHours: 6
      }),
      "2026-07-05T10:00:00.000Z"
    );
    assert.equal(
      settlementReadyAt({
        targetDate: "2026-07-05",
        timezone: "Asia/Tokyo",
        lagHours: 6
      }),
      "2026-07-05T21:00:00.000Z"
    );
    assert.equal(
      settlementReadyAt({
        targetDate: "2026-07-05",
        timezone: "Europe/London",
        lagHours: 6
      }),
      "2026-07-06T05:00:00.000Z"
    );
  });

  it("returns undefined rather than inventing settlement timing without a timezone", () => {
    assert.equal(
      settlementReadyAt({
        targetDate: "2026-07-04",
        timezone: undefined,
        lagHours: 6
      }),
      undefined
    );
  });
});
