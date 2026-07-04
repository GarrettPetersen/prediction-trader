import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { optimizeWeatherPortfolio } from "../src/weatherPortfolioOptimizer.js";

function stakeById(sizes: ReturnType<typeof optimizeWeatherPortfolio>, id: string): number {
  return sizes.find((size) => size.id === id)?.stakeUsd ?? 0;
}

describe("weather portfolio optimizer", () => {
  it("can prefer a concentrated YES over several broad but expensive NOs", () => {
    const sizes = optimizeWeatherPortfolio(
      [
        {
          id: "target-yes",
          side: "YES",
          price: 0.16,
          fair: 0.55,
          edge: 0.39,
          lowerTempC: 19.5,
          upperTempC: 20.5
        },
        {
          id: "low-no",
          side: "NO",
          price: 0.82,
          fair: 0.95,
          edge: 0.13,
          lowerTempC: 17.5,
          upperTempC: 18.5
        },
        {
          id: "high-no",
          side: "NO",
          price: 0.82,
          fair: 0.95,
          edge: 0.13,
          lowerTempC: 21.5,
          upperTempC: 22.5
        }
      ],
      { meanC: 20, sigmaC: 0.55 },
      {
        bankrollUsd: 100,
        kellyMultiplier: 0.25,
        maxKellyFraction: 0.2,
        maxPortfolioFraction: 0.5,
        maxStakeUsd: 20,
        stepUsd: 1
      }
    );

    assert.ok(stakeById(sizes, "target-yes") > stakeById(sizes, "low-no"));
    assert.ok(stakeById(sizes, "target-yes") > stakeById(sizes, "high-no"));
  });

  it("sizes mutually exclusive NO buckets as a portfolio rather than independent coin flips", () => {
    const sizes = optimizeWeatherPortfolio(
      [
        {
          id: "bucket-a-no",
          side: "NO",
          price: 0.6,
          fair: 0.75,
          edge: 0.15,
          lowerTempC: 18,
          upperTempC: 19
        },
        {
          id: "bucket-b-no",
          side: "NO",
          price: 0.6,
          fair: 0.75,
          edge: 0.15,
          lowerTempC: 20,
          upperTempC: 21
        }
      ],
      { meanC: 19.5, sigmaC: 1.4 },
      {
        bankrollUsd: 100,
        kellyMultiplier: 0.25,
        maxKellyFraction: 0.15,
        maxPortfolioFraction: 0.5,
        maxStakeUsd: 15,
        stepUsd: 1
      }
    );

    assert.ok(stakeById(sizes, "bucket-a-no") > 0);
    assert.ok(stakeById(sizes, "bucket-b-no") > 0);
    assert.ok(stakeById(sizes, "bucket-a-no") + stakeById(sizes, "bucket-b-no") <= 30);
  });
});

