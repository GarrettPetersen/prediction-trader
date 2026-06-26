import { readFile } from "node:fs/promises";
import {
  buildIndependentPoissonScoreDistribution,
  buildMonteCarloScoreDistribution,
  summarizeScoreDistribution,
  type ScoreDistribution,
  type ScoreSummary
} from "./scoreDistribution.js";

export interface SoccerMatchResult {
  date?: string;
  competition?: string;
  season?: string;
  homeTeam: string;
  awayTeam: string;
  homeScore: number;
  awayScore: number;
  neutral?: boolean;
}

export interface SoccerTeamRates {
  team: string;
  homeWeight: number;
  awayWeight: number;
  homeAttack: number;
  homeDefense: number;
  awayAttack: number;
  awayDefense: number;
  blendedHomeGoalsFor: number;
  blendedHomeGoalsAgainst: number;
  blendedAwayGoalsFor: number;
  blendedAwayGoalsAgainst: number;
}

export interface SoccerPoissonModel {
  sport: "soccer";
  source: string[];
  matchCount: number;
  weightedMatchCount: number;
  leagueHomeGoals: number;
  leagueAwayGoals: number;
  priorWeight: number;
  halfLifeDays?: number;
  teams: Map<string, SoccerTeamRates>;
}

export interface FitSoccerPoissonOptions {
  source?: string[];
  priorWeight?: number;
  halfLifeDays?: number;
}

export interface SoccerScorePredictionOptions {
  homeTeam: string;
  awayTeam: string;
  neutral?: boolean;
  maxScore?: number;
  simulations?: number;
  seed?: string | number;
  totalLines?: number[];
  scoreQueries?: string[];
  topN?: number;
}

export interface SoccerScorePrediction {
  model: {
    kind: "soccer-poisson";
    source: string[];
    matchCount: number;
    weightedMatchCount: number;
    priorWeight: number;
    halfLifeDays?: number;
    leagueHomeGoals: number;
    leagueAwayGoals: number;
  };
  fixture: {
    homeTeam: string;
    awayTeam: string;
    neutral: boolean;
  };
  expectedGoals: {
    home: number;
    away: number;
    total: number;
  };
  teamRates: {
    home: SoccerTeamRates;
    away: SoccerTeamRates;
  };
  exact: {
    distribution: ScoreDistribution;
    summary: ScoreSummary;
  };
  monteCarlo?: {
    distribution: ScoreDistribution;
    summary: ScoreSummary;
  };
  warnings: string[];
}

interface TeamAccumulator {
  team: string;
  homeWeight: number;
  awayWeight: number;
  homeFor: number;
  homeAgainst: number;
  awayFor: number;
  awayAgainst: number;
}

const DEFAULT_PRIOR_WEIGHT = 8;
const DEFAULT_LEAGUE_HOME_GOALS = 1.35;
const DEFAULT_LEAGUE_AWAY_GOALS = 1.1;

function normalizeName(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .toLowerCase();
}

function parseCsvRows(csv: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let index = 0; index < csv.length; index += 1) {
    const char = csv[index];
    const next = csv[index + 1];

    if (char === "\"") {
      if (inQuotes && next === "\"") {
        field += "\"";
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (!inQuotes && char === ",") {
      row.push(field);
      field = "";
      continue;
    }

    if (!inQuotes && (char === "\n" || char === "\r")) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(field);
      if (row.some((value) => value.trim().length > 0)) rows.push(row);
      row = [];
      field = "";
      continue;
    }

    field += char;
  }

  row.push(field);
  if (row.some((value) => value.trim().length > 0)) rows.push(row);
  return rows;
}

function normalizeHeader(value: string): string {
  return value.replace(/^\uFEFF/, "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

function field(
  row: string[],
  headers: Map<string, number>,
  candidates: string[]
): string | undefined {
  for (const candidate of candidates) {
    const index = headers.get(normalizeHeader(candidate));
    const value = index === undefined ? undefined : row[index]?.trim();
    if (value) return value;
  }
  return undefined;
}

function numberField(
  row: string[],
  headers: Map<string, number>,
  candidates: string[]
): number | undefined {
  const value = field(row, headers, candidates);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function booleanField(
  row: string[],
  headers: Map<string, number>,
  candidates: string[]
): boolean | undefined {
  const value = field(row, headers, candidates);
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  if (["true", "t", "yes", "y", "1"].includes(normalized)) return true;
  if (["false", "f", "no", "n", "0"].includes(normalized)) return false;
  return undefined;
}

export function parseSoccerMatchesCsv(csv: string): SoccerMatchResult[] {
  const rows = parseCsvRows(csv);
  if (rows.length === 0) return [];
  const headers = new Map(rows[0].map((header, index) => [normalizeHeader(header), index]));
  const matches: SoccerMatchResult[] = [];

  for (const row of rows.slice(1)) {
    const homeTeam = field(row, headers, ["home_team", "HomeTeam", "home"]);
    const awayTeam = field(row, headers, ["away_team", "AwayTeam", "away"]);
    const homeScore = numberField(row, headers, ["home_score", "FTHG", "HG", "home_goals"]);
    const awayScore = numberField(row, headers, ["away_score", "FTAG", "AG", "away_goals"]);
    if (!homeTeam || !awayTeam || homeScore === undefined || awayScore === undefined) continue;

    matches.push({
      date: field(row, headers, ["date", "Date"]),
      competition: field(row, headers, ["competition", "tournament", "Div", "league"]),
      season: field(row, headers, ["season", "Season"]),
      homeTeam,
      awayTeam,
      homeScore,
      awayScore,
      neutral: booleanField(row, headers, ["neutral"])
    });
  }

  return matches;
}

export async function loadSoccerMatchesFromCsvFiles(paths: string[]): Promise<SoccerMatchResult[]> {
  const loaded = await Promise.all(
    paths.map(async (path) => parseSoccerMatchesCsv(await readFile(path, "utf8")))
  );
  return loaded.flat();
}

function parseDateMillis(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  const slash = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(trimmed);
  if (slash) {
    const day = Number(slash[1]);
    const month = Number(slash[2]);
    const year = Number(slash[3].length === 2 ? `20${slash[3]}` : slash[3]);
    return Date.UTC(year, month - 1, day);
  }
  const parsed = Date.parse(trimmed);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function matchWeight(
  match: SoccerMatchResult,
  maxDateMillis: number | undefined,
  halfLifeDays: number | undefined
): number {
  if (!halfLifeDays || halfLifeDays <= 0 || maxDateMillis === undefined) return 1;
  const dateMillis = parseDateMillis(match.date);
  if (dateMillis === undefined) return 1;
  const ageDays = Math.max(0, (maxDateMillis - dateMillis) / 86_400_000);
  return 0.5 ** (ageDays / halfLifeDays);
}

function accumulatorFor(team: string, teams: Map<string, TeamAccumulator>): TeamAccumulator {
  const key = normalizeName(team);
  const current = teams.get(key);
  if (current) return current;
  const created = {
    team,
    homeWeight: 0,
    awayWeight: 0,
    homeFor: 0,
    homeAgainst: 0,
    awayFor: 0,
    awayAgainst: 0
  };
  teams.set(key, created);
  return created;
}

function blendedAverage(sum: number, weight: number, priorAverage: number, priorWeight: number): number {
  return (sum + priorAverage * priorWeight) / (weight + priorWeight);
}

function teamRatesFromAccumulator(
  accumulator: TeamAccumulator,
  leagueHomeGoals: number,
  leagueAwayGoals: number,
  priorWeight: number
): SoccerTeamRates {
  const blendedHomeGoalsFor = blendedAverage(
    accumulator.homeFor,
    accumulator.homeWeight,
    leagueHomeGoals,
    priorWeight
  );
  const blendedHomeGoalsAgainst = blendedAverage(
    accumulator.homeAgainst,
    accumulator.homeWeight,
    leagueAwayGoals,
    priorWeight
  );
  const blendedAwayGoalsFor = blendedAverage(
    accumulator.awayFor,
    accumulator.awayWeight,
    leagueAwayGoals,
    priorWeight
  );
  const blendedAwayGoalsAgainst = blendedAverage(
    accumulator.awayAgainst,
    accumulator.awayWeight,
    leagueHomeGoals,
    priorWeight
  );

  return {
    team: accumulator.team,
    homeWeight: accumulator.homeWeight,
    awayWeight: accumulator.awayWeight,
    homeAttack: blendedHomeGoalsFor / leagueHomeGoals,
    homeDefense: blendedHomeGoalsAgainst / leagueAwayGoals,
    awayAttack: blendedAwayGoalsFor / leagueAwayGoals,
    awayDefense: blendedAwayGoalsAgainst / leagueHomeGoals,
    blendedHomeGoalsFor,
    blendedHomeGoalsAgainst,
    blendedAwayGoalsFor,
    blendedAwayGoalsAgainst
  };
}

function defaultRates(team: string): SoccerTeamRates {
  return {
    team,
    homeWeight: 0,
    awayWeight: 0,
    homeAttack: 1,
    homeDefense: 1,
    awayAttack: 1,
    awayDefense: 1,
    blendedHomeGoalsFor: DEFAULT_LEAGUE_HOME_GOALS,
    blendedHomeGoalsAgainst: DEFAULT_LEAGUE_AWAY_GOALS,
    blendedAwayGoalsFor: DEFAULT_LEAGUE_AWAY_GOALS,
    blendedAwayGoalsAgainst: DEFAULT_LEAGUE_HOME_GOALS
  };
}

export function fitSoccerPoissonModel(
  matches: SoccerMatchResult[],
  options: FitSoccerPoissonOptions = {}
): SoccerPoissonModel {
  if (matches.length === 0) throw new Error("Cannot fit soccer score model without match results.");
  const priorWeight = options.priorWeight ?? DEFAULT_PRIOR_WEIGHT;
  if (priorWeight < 0) throw new Error("priorWeight must be non-negative.");

  const datedMatches = matches
    .map((match) => parseDateMillis(match.date))
    .filter((value): value is number => value !== undefined);
  const maxDateMillis = datedMatches.length > 0 ? Math.max(...datedMatches) : undefined;
  const teams = new Map<string, TeamAccumulator>();
  let homeGoalSum = 0;
  let awayGoalSum = 0;
  let matchWeightSum = 0;

  for (const match of matches) {
    const weight = matchWeight(match, maxDateMillis, options.halfLifeDays);
    homeGoalSum += match.homeScore * weight;
    awayGoalSum += match.awayScore * weight;
    matchWeightSum += weight;

    const home = accumulatorFor(match.homeTeam, teams);
    home.homeWeight += weight;
    home.homeFor += match.homeScore * weight;
    home.homeAgainst += match.awayScore * weight;

    const away = accumulatorFor(match.awayTeam, teams);
    away.awayWeight += weight;
    away.awayFor += match.awayScore * weight;
    away.awayAgainst += match.homeScore * weight;
  }

  const leagueHomeGoals = matchWeightSum > 0
    ? homeGoalSum / matchWeightSum
    : DEFAULT_LEAGUE_HOME_GOALS;
  const leagueAwayGoals = matchWeightSum > 0
    ? awayGoalSum / matchWeightSum
    : DEFAULT_LEAGUE_AWAY_GOALS;
  const rates = new Map<string, SoccerTeamRates>();

  for (const accumulator of teams.values()) {
    rates.set(
      normalizeName(accumulator.team),
      teamRatesFromAccumulator(accumulator, leagueHomeGoals, leagueAwayGoals, priorWeight)
    );
  }

  return {
    sport: "soccer",
    source: options.source ?? [],
    matchCount: matches.length,
    weightedMatchCount: matchWeightSum,
    leagueHomeGoals,
    leagueAwayGoals,
    priorWeight,
    halfLifeDays: options.halfLifeDays,
    teams: rates
  };
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function clampExpectedGoals(value: number): number {
  return Math.min(6, Math.max(0.05, value));
}

export function predictSoccerScore(
  model: SoccerPoissonModel,
  options: SoccerScorePredictionOptions
): SoccerScorePrediction {
  const homeRates = model.teams.get(normalizeName(options.homeTeam)) ?? defaultRates(options.homeTeam);
  const awayRates = model.teams.get(normalizeName(options.awayTeam)) ?? defaultRates(options.awayTeam);
  const neutral = options.neutral === true;
  const baseNeutralGoals = (model.leagueHomeGoals + model.leagueAwayGoals) / 2;
  const homeExpectedGoals = neutral
    ? baseNeutralGoals * mean([homeRates.homeAttack, homeRates.awayAttack]) *
      mean([awayRates.homeDefense, awayRates.awayDefense])
    : model.leagueHomeGoals * homeRates.homeAttack * awayRates.awayDefense;
  const awayExpectedGoals = neutral
    ? baseNeutralGoals * mean([awayRates.homeAttack, awayRates.awayAttack]) *
      mean([homeRates.homeDefense, homeRates.awayDefense])
    : model.leagueAwayGoals * awayRates.awayAttack * homeRates.homeDefense;
  const exactDistribution = buildIndependentPoissonScoreDistribution({
    sport: "soccer",
    homeTeam: options.homeTeam,
    awayTeam: options.awayTeam,
    homeMean: clampExpectedGoals(homeExpectedGoals),
    awayMean: clampExpectedGoals(awayExpectedGoals),
    maxScore: options.maxScore
  });
  const summaryOptions = {
    topN: options.topN,
    totalLines: options.totalLines,
    scoreQueries: options.scoreQueries
  };
  const warnings = [];
  if (!model.teams.has(normalizeName(options.homeTeam))) {
    warnings.push(`No historical rows found for ${options.homeTeam}; using league-average team rates.`);
  }
  if (!model.teams.has(normalizeName(options.awayTeam))) {
    warnings.push(`No historical rows found for ${options.awayTeam}; using league-average team rates.`);
  }

  return {
    model: {
      kind: "soccer-poisson",
      source: model.source,
      matchCount: model.matchCount,
      weightedMatchCount: model.weightedMatchCount,
      priorWeight: model.priorWeight,
      halfLifeDays: model.halfLifeDays,
      leagueHomeGoals: model.leagueHomeGoals,
      leagueAwayGoals: model.leagueAwayGoals
    },
    fixture: {
      homeTeam: options.homeTeam,
      awayTeam: options.awayTeam,
      neutral
    },
    expectedGoals: {
      home: exactDistribution.parameters.homeMean,
      away: exactDistribution.parameters.awayMean,
      total: exactDistribution.parameters.homeMean + exactDistribution.parameters.awayMean
    },
    teamRates: {
      home: homeRates,
      away: awayRates
    },
    exact: {
      distribution: exactDistribution,
      summary: summarizeScoreDistribution(exactDistribution, summaryOptions)
    },
    monteCarlo: options.simulations
      ? (() => {
        const distribution = buildMonteCarloScoreDistribution({
          sport: "soccer",
          homeTeam: options.homeTeam,
          awayTeam: options.awayTeam,
          homeMean: exactDistribution.parameters.homeMean,
          awayMean: exactDistribution.parameters.awayMean,
          maxScore: options.maxScore,
          simulations: options.simulations,
          seed: options.seed
        });
        return {
          distribution,
          summary: summarizeScoreDistribution(distribution, summaryOptions)
        };
      })()
      : undefined,
    warnings
  };
}
