import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { oppositeWeatherBacktestEntryPrice } from "../src/weatherBacktest.js";

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
});
