import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  estimateMatchProbabilities,
  lookupFootballTeam,
  parseTeamAliases,
  parseWorldEloRatings,
  type FootballEloDataset
} from "../src/models/footballElo.js";

const teams = parseTeamAliases(`MX\tMexico
CZ\tCzechia
US\tUnited States\tUSA
`);

const ratings = parseWorldEloRatings(`1\t1\tMX\t1896\t4
2\t2\tCZ\t1696\t1
3\t3\tUS\t1820\t9
`, teams);

const dataset: FootballEloDataset = {
  ratings,
  ratingsByCode: new Map(ratings.map((rating) => [rating.code, rating])),
  ratingsByAlias: new Map(
    ratings.flatMap((rating) =>
      [rating.code, rating.name, ...rating.aliases].map((alias) => [
        alias.toLowerCase(),
        rating
      ] as const)
    )
  ),
  sourceUrls: { ratings: "ratings", teams: "teams" },
  cachePaths: { ratings: "ratings.tsv", teams: "teams.tsv" }
};

describe("football Elo helpers", () => {
  it("parses ratings with team names", () => {
    assert.equal(ratings[0].name, "Mexico");
    assert.equal(ratings[0].rating, 1896);
  });

  it("adds common international-market aliases", () => {
    const aliasTeams = parseTeamAliases(`CI\tIvory Coast
CV\tCape Verde
IR\tIran
TR\tTurkey
`);
    const aliasRatings = parseWorldEloRatings(`1\t1\tCI\t1800\t4
2\t2\tCV\t1700\t3
3\t3\tIR\t1600\t2
4\t4\tTR\t1500\t1
`, aliasTeams);

    assert.ok(aliasRatings[0].aliases.includes("Côte d'Ivoire"));
    assert.ok(aliasRatings[1].aliases.includes("Cabo Verde"));
    assert.ok(aliasRatings[2].aliases.includes("IR Iran"));
    assert.ok(aliasRatings[3].aliases.includes("Türkiye"));
  });

  it("looks up aliases", () => {
    assert.equal(lookupFootballTeam(dataset, "USA").name, "United States");
  });

  it("produces sane 1X2 probabilities", () => {
    const mexico = lookupFootballTeam(dataset, "Mexico");
    const czechia = lookupFootballTeam(dataset, "Czechia");
    const probabilities = estimateMatchProbabilities(mexico, czechia);
    const total = probabilities.homeWin + probabilities.draw + probabilities.awayWin;

    assert.ok(Math.abs(total - 1) < 0.0000001);
    assert.ok(probabilities.homeWin > probabilities.awayWin);
    assert.ok(probabilities.draw > 0.1);
  });
});
