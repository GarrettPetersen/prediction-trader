import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { WeatherBacktestTrade } from "../src/weatherBacktest.js";
import {
  evaluateWeatherInverseGrid,
  evaluateWeatherMarketAnchorModelDay,
  type WeatherInverseModelOptions,
  type WeatherMarketAnchorModel
} from "../src/weatherInverseModels.js";

const options: WeatherInverseModelOptions = {
  bankrollUsd: 100,
  kellyMultiplier: 0.25,
  maxKellyFraction: 0.25,
  maxPerTradeUsd: 1,
  maxPortfolioFraction: 1,
  maxGroupFraction: 1,
  minExecutableEdge: 0.03,
  minTradePrice: 0.001
};

function trade(overrides: Partial<WeatherBacktestTrade> = {}): WeatherBacktestTrade {
  return {
    eventSlug: "weather-event",
    marketSlug: "weather-market",
    question: "Weather?",
    city: "Test City",
    forecastTargetKey: "station:TEST",
    date: "2026-07-01",
    measure: "temperature_high",
    outcomeLabel: "30C",
    marketType: "temperature_high:exact:C",
    side: "YES",
    referencePrice: 0.3,
    price: 0.32,
    fillSlippage: 0.02,
    fair: 0.6,
    edge: 0.28,
    forecastMeanC: 30,
    calibratedMeanC: 30,
    sigmaC: 2,
    resolvedYes: false,
    won: false,
    fullKellyFraction: 0.1,
    kellyFraction: 0.025,
    rawStakeUsd: 2.5,
    stakeUsd: 1,
    payoutUsd: 0,
    pnlUsd: -1,
    oppositePrice: 0.72,
    oppositeWon: true,
    oppositePayoutUsd: 1 / 0.72,
    oppositePnlUsd: 1 / 0.72 - 1,
    decisionTime: "2026-06-30T20:15:00.000Z",
    entryMode: "cron_entry_window",
    entryTimezone: "UTC",
    priceTime: "2026-06-30T20:00:00.000Z",
    priceAgeHours: 0.25,
    ...overrides
  };
}

describe("weather inverse model grid", () => {
  it("sizes the opposite side from a negative market-anchor coefficient", () => {
    const result = evaluateWeatherMarketAnchorModelDay(
      { date: "2026-07-01", trades: [trade()] },
      {
        id: "inverse",
        coefficient: -0.5,
        minOriginalEdge: 0.2,
        minOppositeMarketProbability: 0
      },
      options
    );

    assert.equal(result.tradeCount, 1);
    assert.equal(result.wins, 1);
    assert.ok(result.pnlUsd > 0);
  });

  it("enforces an opposite-market confidence gate", () => {
    const result = evaluateWeatherMarketAnchorModelDay(
      { date: "2026-07-01", trades: [trade({ referencePrice: 0.6, price: 0.62, fair: 0.9, edge: 0.28 })] },
      {
        id: "market-majority-only",
        coefficient: -1,
        minOriginalEdge: 0.2,
        minOppositeMarketProbability: 0.5
      },
      options
    );

    assert.equal(result.tradeCount, 0);
  });

  it("selects on training PnL without peeking at holdout PnL", () => {
    const inverse: WeatherMarketAnchorModel = {
      id: "inverse",
      coefficient: -1,
      minOriginalEdge: 0.2,
      minOppositeMarketProbability: 0
    };
    const forecast: WeatherMarketAnchorModel = {
      id: "forecast",
      coefficient: 1,
      minOriginalEdge: 0.2,
      minOppositeMarketProbability: 0
    };
    const result = evaluateWeatherInverseGrid({
      train: [{ date: "2026-07-01", trades: [trade()] }],
      holdout: [{
        date: "2026-07-02",
        trades: [trade({ date: "2026-07-02", resolvedYes: true, won: true, oppositeWon: false })]
      }],
      models: [forecast, inverse],
      minTrainingTrades: 1,
      options
    });

    assert.equal(result.selectedModel.id, "inverse");
    assert.ok(result.selectedTrain.pnlUsd > 0);
    assert.ok(result.selectedHoldout.pnlUsd < 0);
    assert.equal(result.holdout[0].model.id, "forecast");
  });
});
