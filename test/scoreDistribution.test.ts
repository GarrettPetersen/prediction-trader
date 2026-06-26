import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildIndependentPoissonScoreDistribution,
  buildMonteCarloScoreDistribution,
  inferPoissonMeansFromThreeWayProbabilities,
  summarizeScoreDistribution
} from "../src/models/scoreDistribution.js";

describe("score distribution helpers", () => {
  it("builds a normalized exact score distribution", () => {
    const distribution = buildIndependentPoissonScoreDistribution({
      sport: "soccer",
      homeTeam: "Home",
      awayTeam: "Away",
      homeMean: 1.6,
      awayMean: 0.9,
      maxScore: 8
    });
    const summary = summarizeScoreDistribution(distribution, {
      scoreQueries: ["1-0", "1:1"],
      totalLines: [1.5, 2.5]
    });

    const total = distribution.scorelines.reduce((sum, scoreline) => sum + scoreline.probability, 0);
    assert.ok(Math.abs(total - 1) < 0.0000001);
    assert.ok(distribution.coveredMass > 0.999);
    assert.ok(summary.homeWin > summary.awayWin);
    assert.equal(summary.queriedScores[0].score, "1-0");
    assert.ok(summary.queriedScores[0].probability > 0);
  });

  it("runs deterministic Monte Carlo simulations with a seed", () => {
    const first = buildMonteCarloScoreDistribution({
      sport: "soccer",
      homeTeam: "Home",
      awayTeam: "Away",
      homeMean: 1.2,
      awayMean: 1.2,
      simulations: 5_000,
      seed: "same-seed"
    });
    const second = buildMonteCarloScoreDistribution({
      sport: "soccer",
      homeTeam: "Home",
      awayTeam: "Away",
      homeMean: 1.2,
      awayMean: 1.2,
      simulations: 5_000,
      seed: "same-seed"
    });

    assert.deepEqual(first.scorelines, second.scorelines);
  });

  it("infers Poisson means from three-way probabilities", () => {
    const inferred = inferPoissonMeansFromThreeWayProbabilities(
      { homeWin: 0.5, draw: 0.27, awayWin: 0.23 },
      2.6
    );

    assert.ok(inferred.homeMean > inferred.awayMean);
    assert.ok(inferred.fittedProbabilities.homeWin > inferred.fittedProbabilities.awayWin);
    assert.ok(inferred.loss < 0.01);
  });
});
