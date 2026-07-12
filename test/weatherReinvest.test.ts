import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isRetryableVistadexExecutionError,
  requireReinvestPricingStrategy,
  vistadexExecutionRetryDelayMs,
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
