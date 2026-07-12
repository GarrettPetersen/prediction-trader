import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  closedWeatherMarketsFromSnapshots,
  oppositeWeatherBacktestEntryPrice
} from "../src/weatherBacktest.js";
import type { WeatherMarketSnapshotRecord } from "../src/weatherDatasets.js";

describe("weather market backtest strategy comparison", () => {
  it("prices the inverse side at its own adverse-slippage entry price", () => {
    assert.equal(oppositeWeatherBacktestEntryPrice({
      side: "YES",
      yesPrice: 0.37,
      noPrice: 0.67
    }), 0.67);

    assert.equal(oppositeWeatherBacktestEntryPrice({
      side: "NO",
      yesPrice: 0.37,
      noPrice: 0.67
    }), 0.37);
  });

  it("uses the largest stable stored capture for a backtest date", () => {
    const record = (
      capturedAt: string,
      marketSlug: string
    ): WeatherMarketSnapshotRecord => ({
      id: `${capturedAt}:${marketSlug}`,
      source: "polymarket_gamma",
      capturedAt,
      eventSlug: `event-${capturedAt}`,
      eventTitle: "Highest temperature",
      eventEndDate: "2026-07-01T23:59:00Z",
      city: "Test City",
      date: "2026-07-01",
      measure: "temperature_high",
      marketSlug,
      question: "Will the highest temperature in Test City be 30C on July 1?",
      active: false,
      closed: true,
      resolvedYes: marketSlug.endsWith("yes"),
      outcome: {
        kind: "exact",
        label: "30C",
        unit: "C",
        lowerTempC: 29.5,
        upperTempC: 30.5,
        exactTempC: 30,
        rawValue: 30
      },
      tokens: [{ outcome: "Yes", tokenId: `token-${marketSlug}` }]
    });
    const result = closedWeatherMarketsFromSnapshots([
      record("2026-07-02T00:00:00Z", "small"),
      record("2026-07-01T00:00:00Z", "large-no"),
      record("2026-07-01T00:00:00Z", "large-yes")
    ], "2026-07-01");

    assert.equal(result.capturedAt, "2026-07-01T00:00:00Z");
    assert.deepEqual(result.markets.map((market) => market.marketSlug).sort(), ["large-no", "large-yes"]);
  });
});
