import { inspect } from "node:util";
import { loadConfig } from "./config.js";
import { assertCanExecute, assertLiveMutation } from "./safety.js";
import {
  appendExecutionLedgerRecord,
  filterLedgerRecords,
  readLedgerRecords,
  summarizeLedger,
  type LedgerRecord
} from "./ledger.js";
import {
  backfillLedger,
  type LedgerBackfillVenue
} from "./ledgerBackfill.js";
import {
  executePolymarketOrder,
  executePolymarketRedeem,
  previewPolymarketRedeem,
  previewPolymarketOrder
} from "./marketplaces/polymarket.js";
import {
  getPolymarketEvent,
  getPolymarketPositions
} from "./marketplaces/polymarketData.js";
import {
  executeVistadexTrade,
  getVistadexEvent,
  getVistadexPositions,
  previewVistadexTrade,
  quoteVistadexTrade
} from "./marketplaces/vistadex.js";
import {
  estimateMatchProbabilities,
  loadFootballEloDataset,
  lookupFootballTeam,
  parseFootballFixtureTitle,
  pricePolymarketFootballEvent
} from "./models/footballElo.js";
import {
  fitSoccerPoissonModel,
  loadSoccerMatchesFromCsvFiles,
  predictSoccerScore,
  type SoccerScorePrediction
} from "./models/soccerPoisson.js";
import {
  buildIndependentPoissonScoreDistribution,
  buildMonteCarloScoreDistribution,
  inferPoissonMeansFromThreeWayProbabilities,
  summarizeScoreDistribution,
  type ScoreSummary
} from "./models/scoreDistribution.js";
import {
  buildUnlockTickets,
  createPortfolioUnlockPlan,
  type PortfolioUnlockVenueArg
} from "./portfolioUnlock.js";
import type {
  PolymarketOrderTicket,
  PolymarketRedeemTicket,
  TradeSide,
  VistadexTradeTicket
} from "./types.js";

type Args = Record<string, string | boolean>;
const POLYMARKET_ORDER_TYPES = new Set(["GTC", "GTD", "FOK", "FAK"]);

function parseArgs(argv: string[]): { command: string; args: Args } {
  const [command = "help", ...rest] = argv;
  const args: Args = {};

  for (let i = 0; i < rest.length; i += 1) {
    const item = rest[i];
    if (!item.startsWith("--")) continue;

    const key = item.slice(2);
    const next = rest[i + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }

  return { command, args };
}

function stringArg(args: Args, key: string, required = true): string | undefined {
  const value = args[key];
  if (typeof value === "string" && value.length > 0) return value;
  if (required) throw new Error(`Missing --${key}.`);
  return undefined;
}

function requiredStringArg(args: Args, key: string): string {
  return stringArg(args, key, true) as string;
}

function numberArg(args: Args, key: string, required = true): number | undefined {
  const raw = stringArg(args, key, required);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`--${key} must be a number.`);
  return value;
}

function requiredNumberArg(args: Args, key: string): number {
  return numberArg(args, key, true) as number;
}

function listArg(args: Args, key: string, required = false): string[] {
  const raw = stringArg(args, key, required);
  if (raw === undefined) return [];
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function numberListArg(args: Args, key: string): number[] | undefined {
  const values = listArg(args, key, false);
  if (values.length === 0) return undefined;
  return values.map((value) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) throw new Error(`--${key} must be a comma-separated list of numbers.`);
    return parsed;
  });
}

function sideArg(args: Args): TradeSide {
  const side = requiredStringArg(args, "side");
  if (side !== "buy" && side !== "sell") {
    throw new Error("--side must be buy or sell.");
  }
  return side;
}

function polymarketOrderTypeArg(args: Args): PolymarketOrderTicket["orderType"] {
  const orderType = (stringArg(args, "order-type", false) ?? "FOK").toUpperCase();
  if (!POLYMARKET_ORDER_TYPES.has(orderType)) {
    throw new Error("--order-type must be one of GTC, GTD, FOK, FAK.");
  }
  return orderType as PolymarketOrderTicket["orderType"];
}

function portfolioUnlockVenueArg(args: Args): PortfolioUnlockVenueArg {
  const venue = stringArg(args, "venue", false) ?? "all";
  if (venue !== "all" && venue !== "polymarket" && venue !== "vistadex") {
    throw new Error("--venue must be all, polymarket, or vistadex.");
  }
  return venue;
}

function ledgerBackfillVenueArg(args: Args): LedgerBackfillVenue {
  return portfolioUnlockVenueArg(args);
}

function validatePolymarketTicket(ticket: PolymarketOrderTicket): void {
  const isMarketType = ticket.orderType === "FOK" || ticket.orderType === "FAK";
  if (ticket.amountUsd !== undefined && ticket.shares !== undefined) {
    throw new Error("Pass only one of --amount-usd or --shares.");
  }
  if (isMarketType && ticket.side === "buy" && ticket.amountUsd === undefined) {
    throw new Error("Polymarket market buys require --amount-usd.");
  }
  if (isMarketType && ticket.side === "sell" && ticket.shares === undefined) {
    throw new Error("Polymarket market sells require --shares.");
  }
  if (!isMarketType && ticket.shares === undefined) {
    throw new Error("Polymarket limit orders require --shares.");
  }
}

function validatePolymarketRedeemTicket(ticket: PolymarketRedeemTicket): void {
  const targets = [ticket.conditionId, ticket.marketId, ticket.positionId].filter(Boolean);
  if (targets.length !== 1) {
    throw new Error("Pass exactly one of --condition-id, --market-id, or --position-id.");
  }
}

function validateVistadexTicket(ticket: VistadexTradeTicket): void {
  if (ticket.side === "buy" && ticket.amountUsd === undefined) {
    throw new Error("Vistadex buys require --amount-usd.");
  }
  if (ticket.side === "sell" && ticket.shares === undefined) {
    throw new Error("Vistadex sells require --shares.");
  }
}

function print(value: unknown): void {
  console.log(inspect(value, { depth: null, colors: true }));
}

function compactScoreSummary(summary: ScoreSummary) {
  return {
    expectedGoals: {
      home: summary.expectedHomeScore,
      away: summary.expectedAwayScore,
      total: summary.expectedTotalScore
    },
    threeWay: {
      homeWin: summary.homeWin,
      draw: summary.draw,
      awayWin: summary.awayWin
    },
    bothTeamsToScore: summary.bothTeamsToScore,
    totals: summary.totals,
    queriedScores: summary.queriedScores,
    topScores: summary.topScores.map((score) => ({
      score: `${score.homeScore}-${score.awayScore}`,
      probability: score.probability
    }))
  };
}

function compactLedgerRecord(record: LedgerRecord) {
  return {
    id: record.id,
    dedupeKey: record.dedupeKey,
    source: record.source,
    venue: record.venue,
    action: record.action,
    occurredAt: record.occurredAt,
    recordedAt: record.recordedAt,
    status: record.status,
    side: record.side,
    price: record.price,
    shares: record.shares,
    notionalUsd: record.notionalUsd,
    summary: record.summary,
    market: record.market,
    ids: record.ids,
    notes: record.notes
  };
}

function compactTeamRates(teamRates: SoccerScorePrediction["teamRates"]) {
  return {
    home: {
      team: teamRates.home.team,
      homeWeight: teamRates.home.homeWeight,
      awayWeight: teamRates.home.awayWeight,
      homeAttack: teamRates.home.homeAttack,
      awayAttack: teamRates.home.awayAttack,
      homeDefense: teamRates.home.homeDefense,
      awayDefense: teamRates.home.awayDefense
    },
    away: {
      team: teamRates.away.team,
      homeWeight: teamRates.away.homeWeight,
      awayWeight: teamRates.away.awayWeight,
      homeAttack: teamRates.away.homeAttack,
      awayAttack: teamRates.away.awayAttack,
      homeDefense: teamRates.away.homeDefense,
      awayDefense: teamRates.away.awayDefense
    }
  };
}

function compactSoccerPrediction(prediction: SoccerScorePrediction) {
  return {
    model: prediction.model,
    fixture: prediction.fixture,
    expectedGoals: prediction.expectedGoals,
    warnings: prediction.warnings,
    teamRates: compactTeamRates(prediction.teamRates),
    exact: {
      method: prediction.exact.distribution.method,
      maxScore: prediction.exact.distribution.maxScore,
      coveredMass: prediction.exact.distribution.coveredMass,
      summary: compactScoreSummary(prediction.exact.summary)
    },
    monteCarlo: prediction.monteCarlo
      ? {
        method: prediction.monteCarlo.distribution.method,
        simulations: prediction.monteCarlo.distribution.parameters.simulations,
        seed: prediction.monteCarlo.distribution.parameters.seed,
        coveredMass: prediction.monteCarlo.distribution.coveredMass,
        summary: compactScoreSummary(prediction.monteCarlo.summary)
      }
      : undefined
  };
}

async function historicalSoccerScoreReport(args: Args, fixture: { home: string; away: string }) {
  const historyPaths = listArg(args, "history", true);
  const matches = await loadSoccerMatchesFromCsvFiles(historyPaths);
  const model = fitSoccerPoissonModel(matches, {
    source: historyPaths,
    priorWeight: numberArg(args, "prior-weight", false),
    halfLifeDays: numberArg(args, "half-life-days", false)
  });
  return compactSoccerPrediction(predictSoccerScore(model, {
    homeTeam: fixture.home,
    awayTeam: fixture.away,
    neutral: args.neutral === true,
    maxScore: numberArg(args, "max-score", false),
    simulations: numberArg(args, "simulations", false),
    seed: stringArg(args, "seed", false),
    totalLines: numberListArg(args, "total-lines"),
    scoreQueries: listArg(args, "scores", false),
    topN: numberArg(args, "top", false)
  }));
}

function usage(): void {
  console.log(`Prediction Trader

Commands:
  polymarket:positions [--redeemable] [--include-zero] [--limit N]
  polymarket:event --slug SLUG [--orderbook]
  polymarket:order --side buy|sell --token-id ID --price N (--amount-usd N | --shares N) [--order-type FOK|FAK|GTC|GTD] [--execute]
  polymarket:redeem (--condition-id HEX | --market-id ID | --position-id ID) [--execute]
  vistadex:event --slug SLUG
  vistadex:positions [--include-zero] [--limit N]
  vistadex:quote --side buy|sell --condition-id HEX --outcome-index 0|1 (--amount-usd N | --shares N) [--limit-price N]
  vistadex:trade --side buy|sell --condition-id HEX --outcome-index 0|1 (--amount-usd N | --shares N) [--limit-price N] [--execute]
  portfolio:unlock [--venue all|polymarket|vistadex] [--min-unlock-usd N] [--max-pairs N] [--execute]
  ledger:list [--ledger PATH] [--venue polymarket|vistadex] [--source execution|backfill] [--action ACTION] [--limit N]
  ledger:summary [--ledger PATH]
  ledger:backfill [--ledger PATH] [--venue all|polymarket|vistadex] [--no-positions] [--no-fills] [--polymarket-first-page]
  football:ratings [--refresh] [--team TEAM] [--limit N]
  football:price --slug SLUG [--refresh] [--home TEAM --away TEAM] [--edge-threshold N]
  football:screen --slugs SLUG[,SLUG...] [--refresh] [--edge-threshold N]
  football:score (--slug SLUG | --home TEAM --away TEAM) [--history CSV[,CSV...]] [--simulations N] [--scores 0-0,1-1] [--total-lines 1.5,2.5,3.5]
  score:predict --sport soccer --home TEAM --away TEAM --history CSV[,CSV...] [--simulations N] [--scores 0-0,1-1] [--total-lines 1.5,2.5,3.5]

Live trading requires --execute and PREDICTION_TRADER_LIVE=1.
`);
}

async function run(): Promise<void> {
  const { command, args } = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const execute = args.execute === true;
  const maxUsd = numberArg(args, "max-usd", false);
  const safety = {
    ...config.safety,
    maxUsd: maxUsd ?? config.safety.maxUsd
  };
  const ledgerPath = stringArg(args, "ledger", false) ?? config.ledger.path;

  if (command === "help" || command === "--help" || command === "-h") {
    usage();
    return;
  }

  if (command === "ledger:list") {
    const records = filterLedgerRecords(await readLedgerRecords(ledgerPath), {
      venue: stringArg(args, "venue", false),
      source: stringArg(args, "source", false),
      action: stringArg(args, "action", false),
      limit: numberArg(args, "limit", false)
    });
    print({
      path: ledgerPath,
      count: records.length,
      records: args.raw === true ? records : records.map(compactLedgerRecord)
    });
    return;
  }

  if (command === "ledger:summary") {
    print(summarizeLedger(await readLedgerRecords(ledgerPath), ledgerPath));
    return;
  }

  if (command === "ledger:backfill") {
    const result = await backfillLedger(config, ledgerPath, {
      venue: ledgerBackfillVenueArg(args),
      includePositions: args["no-positions"] !== true,
      includeFills: args["no-fills"] !== true,
      polymarketOnlyFirstPage: args["polymarket-first-page"] === true,
      positionLimit: numberArg(args, "limit", false),
      polymarketTradeParams: {
        market: stringArg(args, "market", false),
        assetId: stringArg(args, "asset-id", false),
        after: stringArg(args, "after", false),
        before: stringArg(args, "before", false)
      }
    });
    print({
      ...result,
      records: result.records.slice(0, 20).map(compactLedgerRecord),
      omittedRecords: Math.max(0, result.records.length - 20)
    });
    return;
  }

  if (command === "polymarket:positions") {
    print(await getPolymarketPositions(config, {
      includeZero: args["include-zero"] === true,
      limit: numberArg(args, "limit", false),
      redeemableOnly: args.redeemable === true
    }));
    return;
  }

  if (command === "polymarket:event") {
    print(await getPolymarketEvent(config, requiredStringArg(args, "slug"), {
      includeOrderbook: args.orderbook === true
    }));
    return;
  }

  if (command === "polymarket:order") {
    const ticket: PolymarketOrderTicket = {
      venue: "polymarket",
      side: sideArg(args),
      tokenId: requiredStringArg(args, "token-id"),
      price: requiredNumberArg(args, "price"),
      orderType: polymarketOrderTypeArg(args),
      amountUsd: numberArg(args, "amount-usd", false),
      shares: numberArg(args, "shares", false),
      tickSize: stringArg(args, "tick-size", false),
      negRisk: args["neg-risk"] === true ? true : undefined,
      postOnly: args["post-only"] === true
    };
    validatePolymarketTicket(ticket);

    const preview = previewPolymarketOrder(ticket);
    print({ execute, preview, safety });
    if (!execute) return;

    assertCanExecute(ticket, safety, execute);
    const executionResult = await executePolymarketOrder(config, ticket);
    const ledger = await appendExecutionLedgerRecord(ledgerPath, {
      command,
      ticket,
      preview,
      execution: executionResult,
      action: "order"
    });
    print({ execution: executionResult, ledger });
    return;
  }

  if (command === "polymarket:redeem") {
    const ticket: PolymarketRedeemTicket = {
      venue: "polymarket",
      conditionId: stringArg(args, "condition-id", false),
      marketId: stringArg(args, "market-id", false),
      positionId: stringArg(args, "position-id", false)
    };
    validatePolymarketRedeemTicket(ticket);

    print({ execute, preview: previewPolymarketRedeem(ticket), safety });
    if (!execute) return;

    assertLiveMutation(safety, execute);
    const preview = previewPolymarketRedeem(ticket);
    const executionResult = await executePolymarketRedeem(config, ticket);
    const ledger = await appendExecutionLedgerRecord(ledgerPath, {
      command,
      ticket,
      preview,
      execution: executionResult,
      action: "redeem"
    });
    print({ execution: executionResult, ledger });
    return;
  }

  if (command === "portfolio:unlock") {
    const plan = await createPortfolioUnlockPlan(config, {
      venue: portfolioUnlockVenueArg(args),
      limit: numberArg(args, "limit", false),
      maxPairs: numberArg(args, "max-pairs", false),
      minShares: numberArg(args, "min-shares", false),
      minUnlockUsd: numberArg(args, "min-unlock-usd", false)
    });
    const ticketsByPair = plan.pairs.map((pair) => ({
      venue: pair.venue,
      conditionId: pair.conditionId,
      slug: pair.slug,
      question: pair.question ?? pair.title,
      estimatedUnlockUsd: pair.estimatedUnlockUsd,
      estimatedCostUsd: pair.estimatedCostUsd,
      tickets: buildUnlockTickets(pair)
    }));

    print({ execute, safety, plan, ticketsByPair });
    if (!execute) return;

    const tickets = ticketsByPair.flatMap((pair) => pair.tickets);
    for (const ticket of tickets) {
      assertCanExecute(ticket, safety, execute);
    }

    const executions = [];
    for (const pair of plan.pairs) {
      const pairResult = {
        venue: pair.venue,
        conditionId: pair.conditionId,
        question: pair.question ?? pair.title,
        executions: [] as unknown[]
      };
      for (const ticket of buildUnlockTickets(pair)) {
        const preview = ticket.venue === "polymarket"
          ? previewPolymarketOrder(ticket)
          : previewVistadexTrade(ticket);
        const result = ticket.venue === "polymarket"
          ? await executePolymarketOrder(config, ticket)
          : await executeVistadexTrade(config, ticket);
        const ledger = await appendExecutionLedgerRecord(ledgerPath, {
          command,
          ticket,
          preview,
          execution: result,
          action: "order"
        });
        pairResult.executions.push({ ticket, result, ledger });
        if (result.status === "failed") break;
      }
      executions.push(pairResult);
    }
    print({ executions });
    return;
  }

  if (command === "football:ratings") {
    const dataset = await loadFootballEloDataset({ refresh: args.refresh === true });
    const team = stringArg(args, "team", false);
    if (team) {
      print({
        source: dataset.sourceUrls,
        cache: dataset.cachePaths,
        team: lookupFootballTeam(dataset, team)
      });
      return;
    }

    print({
      source: dataset.sourceUrls,
      cache: dataset.cachePaths,
      count: dataset.ratings.length,
      ratings: dataset.ratings.slice(0, Math.trunc(numberArg(args, "limit", false) ?? 25))
    });
    return;
  }

  if (command === "football:price") {
    print(await pricePolymarketFootballEvent(config, requiredStringArg(args, "slug"), {
      refresh: args.refresh === true,
      home: stringArg(args, "home", false),
      away: stringArg(args, "away", false),
      edgeThreshold: numberArg(args, "edge-threshold", false),
      homeAdvantage: numberArg(args, "home-advantage", false),
      drawBase: numberArg(args, "draw-base", false),
      drawMin: numberArg(args, "draw-min", false),
      drawScale: numberArg(args, "draw-scale", false),
      eloScale: numberArg(args, "elo-scale", false)
    }));
    return;
  }

  if (command === "football:screen") {
    const slugs = requiredStringArg(args, "slugs")
      .split(",")
      .map((slug) => slug.trim())
      .filter(Boolean);
    const reports = await Promise.all(
      slugs.map(async (slug) => {
        try {
          return {
            ok: true as const,
            report: await pricePolymarketFootballEvent(config, slug, {
              refresh: args.refresh === true,
              edgeThreshold: numberArg(args, "edge-threshold", false),
              homeAdvantage: numberArg(args, "home-advantage", false),
              drawBase: numberArg(args, "draw-base", false),
              drawMin: numberArg(args, "draw-min", false),
              drawScale: numberArg(args, "draw-scale", false),
              eloScale: numberArg(args, "elo-scale", false)
            })
          };
        } catch (error) {
          return {
            ok: false as const,
            slug,
            error: error instanceof Error ? error.message : String(error)
          };
        }
      })
    );
    print(reports.map((result) => {
      if (!result.ok) {
        return {
          event: { slug: result.slug },
          error: result.error
        };
      }

      const { report } = result;
      return {
        event: report.event,
        teams: {
          home: `${report.teams.home.name} (${report.teams.home.rating})`,
          away: `${report.teams.away.name} (${report.teams.away.rating})`
        },
        probabilities: {
          homeWin: report.probabilities.homeWin,
          draw: report.probabilities.draw,
          awayWin: report.probabilities.awayWin,
          eloDiff: report.probabilities.eloDiff
        },
        buySignals: report.markets
          .filter((market) => market.buyYesSignal === "buy")
          .sort((a, b) => (b.buyYesEdge ?? -Infinity) - (a.buyYesEdge ?? -Infinity))
      };
    }));
    return;
  }

  if (command === "football:score") {
    const slug = stringArg(args, "slug", false);
    const event = slug
      ? await getPolymarketEvent(config, slug, { includeOrderbook: false })
      : undefined;
    const parsedFixture = event
      ? parseFootballFixtureTitle((event as { title?: unknown }).title)
      : undefined;
    const fixture = {
      home: stringArg(args, "home", false) ?? parsedFixture?.home,
      away: stringArg(args, "away", false) ?? parsedFixture?.away
    };
    if (!fixture.home || !fixture.away) {
      throw new Error("Pass --slug or both --home and --away.");
    }

    if (listArg(args, "history", false).length > 0) {
      print({
        event: event
          ? {
            slug,
            title: (event as { title?: unknown }).title,
            live: (event as { live?: unknown }).live,
            score: (event as { score?: unknown }).score,
            elapsed: (event as { elapsed?: unknown }).elapsed,
            period: (event as { period?: unknown }).period
          }
          : undefined,
        report: await historicalSoccerScoreReport(args, {
          home: fixture.home,
          away: fixture.away
        })
      });
      return;
    }

    const dataset = await loadFootballEloDataset({ refresh: args.refresh === true });
    const home = lookupFootballTeam(dataset, fixture.home);
    const away = lookupFootballTeam(dataset, fixture.away);
    const probabilities = estimateMatchProbabilities(home, away, {
      homeAdvantage: numberArg(args, "home-advantage", false),
      drawBase: numberArg(args, "draw-base", false),
      drawMin: numberArg(args, "draw-min", false),
      drawScale: numberArg(args, "draw-scale", false),
      eloScale: numberArg(args, "elo-scale", false)
    });
    const maxScore = numberArg(args, "max-score", false);
    const inferred = inferPoissonMeansFromThreeWayProbabilities(
      {
        homeWin: probabilities.homeWin,
        draw: probabilities.draw,
        awayWin: probabilities.awayWin
      },
      numberArg(args, "expected-total-goals", false) ?? 2.6,
      { maxScore }
    );
    const exactDistribution = buildIndependentPoissonScoreDistribution({
      sport: "soccer",
      homeTeam: home.name,
      awayTeam: away.name,
      homeMean: inferred.homeMean,
      awayMean: inferred.awayMean,
      maxScore
    });
    const summaryOptions = {
      topN: numberArg(args, "top", false),
      totalLines: numberListArg(args, "total-lines"),
      scoreQueries: listArg(args, "scores", false)
    };
    const exactSummary = summarizeScoreDistribution(exactDistribution, summaryOptions);
    const simulations = numberArg(args, "simulations", false);
    const seed = stringArg(args, "seed", false);
    const monteCarloDistribution = simulations
      ? buildMonteCarloScoreDistribution({
        sport: "soccer",
        homeTeam: home.name,
        awayTeam: away.name,
        homeMean: inferred.homeMean,
        awayMean: inferred.awayMean,
        maxScore,
        simulations,
        seed
      })
      : undefined;

    print({
      source: {
        type: "football-elo-score-model",
        ratingsUrl: dataset.sourceUrls.ratings,
        teamsUrl: dataset.sourceUrls.teams,
        ratingsCachePath: dataset.cachePaths.ratings,
        teamsCachePath: dataset.cachePaths.teams,
        note: "Elo gives the 1X2 prior; Poisson means are fitted to that prior at the requested expected total goals."
      },
      warning: event && (event as { live?: unknown }).live === true
        ? "This score model is pre-match only; it does not use the live score or in-game stats."
        : undefined,
      event: event
        ? {
          slug,
          title: (event as { title?: unknown }).title,
          live: (event as { live?: unknown }).live,
          score: (event as { score?: unknown }).score,
          elapsed: (event as { elapsed?: unknown }).elapsed,
          period: (event as { period?: unknown }).period
        }
        : undefined,
      fixture: {
        home: home.name,
        away: away.name
      },
      teams: { home, away },
      eloThreeWay: probabilities,
      inferredPoisson: inferred,
      exact: {
        method: exactDistribution.method,
        maxScore: exactDistribution.maxScore,
        coveredMass: exactDistribution.coveredMass,
        summary: compactScoreSummary(exactSummary)
      },
      monteCarlo: monteCarloDistribution
        ? {
          method: monteCarloDistribution.method,
          simulations: monteCarloDistribution.parameters.simulations,
          seed: monteCarloDistribution.parameters.seed,
          coveredMass: monteCarloDistribution.coveredMass,
          summary: compactScoreSummary(summarizeScoreDistribution(monteCarloDistribution, summaryOptions))
        }
        : undefined
    });
    return;
  }

  if (command === "score:predict") {
    const sport = requiredStringArg(args, "sport");
    if (sport !== "soccer") {
      throw new Error("Only --sport soccer is implemented so far.");
    }
    print(await historicalSoccerScoreReport(args, {
      home: requiredStringArg(args, "home"),
      away: requiredStringArg(args, "away")
    }));
    return;
  }

  if (command === "vistadex:event") {
    print(await getVistadexEvent(config, requiredStringArg(args, "slug")));
    return;
  }

  if (command === "vistadex:positions") {
    print(await getVistadexPositions(config, {
      includeZero: args["include-zero"] === true,
      limit: numberArg(args, "limit", false)
    }));
    return;
  }

  if (command === "vistadex:quote" || command === "vistadex:trade") {
    const outcomeIndex = requiredNumberArg(args, "outcome-index");
    if (outcomeIndex !== 0 && outcomeIndex !== 1) {
      throw new Error("--outcome-index must be 0 or 1.");
    }

    const ticket: VistadexTradeTicket = {
      venue: "vistadex",
      side: sideArg(args),
      conditionId: requiredStringArg(args, "condition-id"),
      outcomeIndex,
      collateralMint: stringArg(args, "collateral-mint", false),
      amountUsd: numberArg(args, "amount-usd", false),
      shares: numberArg(args, "shares", false),
      limitPrice: numberArg(args, "limit-price", false)
    };
    validateVistadexTicket(ticket);

    const preview = previewVistadexTrade(ticket);
    print({ execute, preview, safety });
    if (command === "vistadex:quote") {
      print(await quoteVistadexTrade(config, ticket));
      return;
    }
    if (!execute) return;

    assertCanExecute(ticket, safety, execute);
    const executionResult = await executeVistadexTrade(config, ticket);
    const ledger = await appendExecutionLedgerRecord(ledgerPath, {
      command,
      ticket,
      preview,
      execution: executionResult,
      action: "order"
    });
    print({ execution: executionResult, ledger });
    return;
  }

  usage();
  throw new Error(`Unknown command: ${command}`);
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
