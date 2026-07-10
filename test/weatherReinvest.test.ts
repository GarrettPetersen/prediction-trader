import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isRetryableVistadexExecutionError,
  vistadexExecutionRetryDelayMs
} from "../src/weatherReinvest.js";

describe("WeatherEdge Vistadex execution retry helpers", () => {
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
});
