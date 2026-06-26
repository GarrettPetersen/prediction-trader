import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  fitSoccerPoissonModel,
  parseSoccerMatchesCsv,
  predictSoccerScore
} from "../src/models/soccerPoisson.js";

describe("soccer Poisson score model", () => {
  it("parses canonical and football-data style CSV rows", () => {
    const canonical = parseSoccerMatchesCsv(`date,home_team,away_team,home_score,away_score,neutral
2026-01-01,Alpha FC,Beta FC,2,0,false
`);
    const footballData = parseSoccerMatchesCsv(`Date,HomeTeam,AwayTeam,FTHG,FTAG,Div
02/01/2026,Gamma,Delta,1,3,E0
`);

    assert.equal(canonical[0].homeTeam, "Alpha FC");
    assert.equal(canonical[0].homeScore, 2);
    assert.equal(footballData[0].awayTeam, "Delta");
    assert.equal(footballData[0].awayScore, 3);
  });

  it("fits attack and defense rates from historical match results", () => {
    const matches = parseSoccerMatchesCsv(`date,home_team,away_team,home_score,away_score
2026-01-01,Alpha,Beta,3,0
2026-01-08,Alpha,Gamma,2,0
2026-01-15,Beta,Alpha,0,2
2026-01-22,Gamma,Alpha,1,3
2026-01-29,Beta,Gamma,1,1
2026-02-05,Gamma,Beta,0,0
`);
    const model = fitSoccerPoissonModel(matches, {
      source: ["fixture.csv"],
      priorWeight: 2
    });
    const prediction = predictSoccerScore(model, {
      homeTeam: "Alpha",
      awayTeam: "Beta",
      scoreQueries: ["2-0"],
      simulations: 5_000,
      seed: "alpha-beta"
    });

    assert.ok(prediction.expectedGoals.home > prediction.expectedGoals.away);
    assert.ok(prediction.exact.summary.homeWin > prediction.exact.summary.awayWin);
    assert.ok(prediction.exact.summary.queriedScores[0].probability > 0);
    assert.ok(prediction.monteCarlo);
    assert.equal(prediction.warnings.length, 0);
  });

  it("shrinks unknown teams to league average and reports warnings", () => {
    const matches = parseSoccerMatchesCsv(`home_team,away_team,home_score,away_score
Alpha,Beta,1,1
`);
    const model = fitSoccerPoissonModel(matches);
    const prediction = predictSoccerScore(model, {
      homeTeam: "Unknown A",
      awayTeam: "Unknown B"
    });

    assert.equal(prediction.warnings.length, 2);
    assert.ok(prediction.expectedGoals.total > 0);
  });
});
