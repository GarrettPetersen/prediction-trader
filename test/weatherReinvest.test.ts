import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isRetryableVistadexExecutionError,
  requireReinvestEntryWindows,
  requireReinvestPricingStrategy,
  vistadexExecutionRetryDelayMs,
  weatherHybridLaneBudgets,
  weatherReinvestEntryWindow,
  weatherReinvestExecutionFailures
} from "../src/weatherReinvest.js";

describe("WeatherEdge Vistadex execution retry helpers", () => {
  it("requires an explicit live pricing strategy", () => {
    assert.throws(
      () => requireReinvestPricingStrategy({}),
      /requires --strategy/
    );
  });

  it("requires explicit parameters for market-informed inversion", () => {
    assert.throws(
      () => requireReinvestPricingStrategy({ strategy: "market_informed_inverse" }),
      /market-anchor-coefficient/
    );
    assert.deepEqual(requireReinvestPricingStrategy({
      strategy: "market_informed_inverse",
      marketAnchorCoefficient: -0.25,
      marketAnchorMinOppositeMarketProbability: 0.5
    }), {
      strategy: "market_informed_inverse",
      marketAnchor: {
        coefficient: -0.25,
        minOppositeMarketProbability: 0.5,
        minExecutableEdge: 0.03
      }
    });
  });

  it("requires explicit routing parameters for the market-informed hybrid", () => {
    assert.throws(
      () => requireReinvestPricingStrategy({
        strategy: "market_informed_hybrid",
        marketAnchorCoefficient: -0.25,
        marketAnchorMinOppositeMarketProbability: 0.5
      }),
      /hybrid-normal-min-market-probability/
    );
    assert.throws(
      () => requireReinvestPricingStrategy({
        strategy: "market_informed_hybrid",
        marketAnchorCoefficient: -0.25,
        marketAnchorMinOppositeMarketProbability: 0.5,
        hybridNormalMinMarketProbability: 0.5
      }),
      /hybrid-normal-buy-budget-fraction/
    );
    assert.deepEqual(requireReinvestPricingStrategy({
      strategy: "market_informed_hybrid",
      marketAnchorCoefficient: -0.25,
      marketAnchorMinOppositeMarketProbability: 0.5,
      hybridNormalMinMarketProbability: 0.5,
      hybridNormalBuyBudgetFraction: 1 / 3
    }), {
      strategy: "market_informed_hybrid",
      marketAnchor: {
        coefficient: -0.25,
        minOppositeMarketProbability: 0.5,
        minExecutableEdge: 0.03
      },
      hybrid: {
        normalMinMarketProbability: 0.5
      },
      hybridNormalBuyBudgetFraction: 1 / 3
    });
  });

  it("reserves independent normal and inverse lane budgets", () => {
    assert.deepEqual(weatherHybridLaneBudgets(30, 1 / 3), {
      normalAgreement: 10,
      inverseDisagreement: 20
    });
    assert.throws(() => weatherHybridLaneBudgets(30, 1.1), /between 0 and 1/);
  });

  it("requires a separate inverse-low window for market-informed strategies", () => {
    assert.throws(
      () => requireReinvestEntryWindows({}, "market_informed_hybrid"),
      /explicit inverse-low entry start and end times/
    );
    assert.deepEqual(requireReinvestEntryWindows({
      inverseLowEntryStartLocalMinutes: 20 * 60,
      inverseLowEntryEndLocalMinutes: 23 * 60 + 30
    }, "market_informed_hybrid"), {
      high: { startLocalMinutes: 20 * 60, endLocalMinutes: 23 * 60 + 30 },
      low: { startLocalMinutes: 11 * 60, endLocalMinutes: 14 * 60 + 30 },
      inverseLow: { startLocalMinutes: 20 * 60, endLocalMinutes: 23 * 60 + 30 }
    });
  });

  it("routes inverse lows to late evening while normal lows stay midday", () => {
    const entryWindows = requireReinvestEntryWindows({
      inverseLowEntryStartLocalMinutes: 20 * 60,
      inverseLowEntryEndLocalMinutes: 23 * 60 + 30
    }, "market_informed_hybrid");
    const inverseLate = weatherReinvestEntryWindow({
      date: "2026-07-14",
      measure: "temperature_low",
      strategy: "market_informed_hybrid",
      strategyLane: "inverse_disagreement",
      timezone: "Europe/London",
      now: new Date("2026-07-13T21:15:00.000Z"),
      entryWindows
    });
    const normalLate = weatherReinvestEntryWindow({
      date: "2026-07-14",
      measure: "temperature_low",
      strategy: "forecast_edge",
      timezone: "Europe/London",
      now: new Date("2026-07-13T21:15:00.000Z"),
      entryWindows
    });
    const normalMidday = weatherReinvestEntryWindow({
      date: "2026-07-14",
      measure: "temperature_low",
      strategy: "forecast_edge",
      timezone: "Europe/London",
      now: new Date("2026-07-13T11:15:00.000Z"),
      entryWindows
    });

    assert.equal(inverseLate.policy, "inverse_low_late");
    assert.equal(inverseLate.shouldEnter, true);
    assert.equal(normalLate.policy, "low_midday");
    assert.equal(normalLate.status, "after_entry_window");
    assert.equal(normalMidday.shouldEnter, true);
  });

  it("still blocks inverse lows once the target day starts", () => {
    const entryWindows = requireReinvestEntryWindows({
      inverseLowEntryStartLocalMinutes: 20 * 60,
      inverseLowEntryEndLocalMinutes: 23 * 60 + 30
    }, "market_informed_hybrid");
    const assessment = weatherReinvestEntryWindow({
      date: "2026-07-14",
      measure: "temperature_low",
      strategy: "market_informed_hybrid",
      strategyLane: "inverse_disagreement",
      timezone: "Europe/London",
      now: new Date("2026-07-14T00:15:00.000Z"),
      entryWindows
    });

    assert.equal(assessment.policy, "inverse_low_late");
    assert.equal(assessment.shouldEnter, false);
    assert.equal(assessment.status, "market_day_started");
  });

  it("retries transient Vistadex filler and transport failures", () => {
    assert.equal(isRetryableVistadexExecutionError(new Error("Timed out waiting for filler action")), true);
    assert.equal(isRetryableVistadexExecutionError(new Error("WebSocket closed while waiting for filler action")), true);
    assert.equal(isRetryableVistadexExecutionError(new Error("fetch failed")), true);
  });

  it("does not retry deterministic trade validation failures", () => {
    assert.equal(isRetryableVistadexExecutionError(new Error("Retry buy quote 0.9000 above max acceptable 0.8000.")), false);
    assert.equal(isRetryableVistadexExecutionError(new Error("Vistadex buy requires amountUsd.")), false);
  });

  it("uses exponential retry backoff", () => {
    assert.equal(vistadexExecutionRetryDelayMs(10_000, 1), 10_000);
    assert.equal(vistadexExecutionRetryDelayMs(10_000, 2), 20_000);
    assert.equal(vistadexExecutionRetryDelayMs(10_000, 3), 40_000);
  });

  it("surfaces failed live execution attempts", () => {
    const failures = weatherReinvestExecutionFailures({
      sold: [],
      bought: [],
      skipped: [
        {
          action: "buy_edge",
          status: "failed",
          attempts: [{
            attempt: 1,
            maxAttempts: 1,
            startedAt: "2026-07-10T00:00:00.000Z",
            finishedAt: "2026-07-10T00:02:00.000Z",
            status: "failed",
            error: "Timed out waiting for filler action",
            retryable: true
          }]
        },
        {
          action: "buy_edge",
          status: "skipped",
          reason: "Outside station-local day-ahead entry window."
        }
      ]
    } as any);

    assert.equal(failures.length, 1);
    assert.equal(failures[0].status, "failed");
  });

  it("does not fail a healthy no-op run", () => {
    const failures = weatherReinvestExecutionFailures({
      sold: [],
      bought: [],
      skipped: [{
        action: "buy_edge",
        status: "skipped",
        reason: "No edge."
      }]
    } as any);

    assert.deepEqual(failures, []);
  });
});
