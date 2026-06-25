import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { AppConfig } from "../config.js";
import { getPolymarketEvent } from "../marketplaces/polymarketData.js";

export const WORLD_ELO_RATINGS_URL = "https://www.eloratings.net/World.tsv";
export const WORLD_ELO_TEAMS_URL = "https://www.eloratings.net/en.teams.tsv";
export const DEFAULT_RATINGS_CACHE_PATH = "data/football/elo-world.tsv";
export const DEFAULT_TEAMS_CACHE_PATH = "data/football/elo-teams.tsv";

const DEFAULT_DRAW_BASE = 0.27;
const DEFAULT_DRAW_MIN = 0.08;
const DEFAULT_DRAW_SCALE = 450;
const DEFAULT_ELO_SCALE = 400;
const DEFAULT_EDGE_THRESHOLD = 0.03;

const EXTRA_TEAM_ALIASES: Record<string, string[]> = {
  CD: ["Congo DR", "Democratic Republic of the Congo"],
  CI: ["Cote d'Ivoire", "Côte d'Ivoire", "Cote d Ivoire", "Côte d Ivoire"],
  CV: ["Cabo Verde"],
  IR: ["IR Iran"],
  TR: ["Turkiye", "Türkiye"]
};

export interface FootballEloRating {
  rank: number;
  code: string;
  name: string;
  aliases: string[];
  rating: number;
  rankChange?: number;
  ratingChange?: number;
}

export interface FootballEloDataset {
  ratings: FootballEloRating[];
  ratingsByCode: Map<string, FootballEloRating>;
  ratingsByAlias: Map<string, FootballEloRating>;
  sourceUrls: {
    ratings: string;
    teams: string;
  };
  cachePaths: {
    ratings: string;
    teams: string;
  };
}

export interface FootballModelOptions {
  drawBase?: number;
  drawMin?: number;
  drawScale?: number;
  eloScale?: number;
  homeAdvantage?: number;
}

export interface MatchProbabilities {
  homeWin: number;
  draw: number;
  awayWin: number;
  expectedHomeScore: number;
  eloDiff: number;
  params: Required<FootballModelOptions>;
}

interface LoadFootballEloOptions {
  refresh?: boolean;
  ratingsUrl?: string;
  teamsUrl?: string;
  ratingsCachePath?: string;
  teamsCachePath?: string;
}

interface FootballMarketProjection {
  market: string | undefined;
  conditionId: string | undefined;
  outcome: "home" | "draw" | "away" | "unknown";
  modelProbability: number | undefined;
  yesPrice: number | undefined;
  yesBestAsk: number | undefined;
  yesBestBid: number | undefined;
  buyYesEdge: number | undefined;
  buyYesSignal: "buy" | "pass" | "unknown";
}

function normalizeAlias(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .toLowerCase();
}

function numberValue(value: string | undefined): number | undefined {
  if (value === undefined || value.length === 0) return undefined;
  const normalized = value.replace("\u2212", "-").replace("−", "-");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

async function readOrFetchText(url: string, cachePath: string, refresh = false): Promise<string> {
  const absoluteCachePath = resolve(cachePath);
  if (!refresh) {
    try {
      return await readFile(absoluteCachePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Football Elo request failed with HTTP ${response.status}: ${await response.text()}`);
  }
  const text = await response.text();
  await mkdir(dirname(absoluteCachePath), { recursive: true });
  await writeFile(absoluteCachePath, text);
  return text;
}

export function parseTeamAliases(teamsTsv: string): Map<string, { name: string; aliases: string[] }> {
  const result = new Map<string, { name: string; aliases: string[] }>();
  for (const line of teamsTsv.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [code, name, ...aliases] = line.split("\t");
    if (!code || !name) continue;
    result.set(code, {
      name,
      aliases: [name, ...aliases].filter(Boolean)
    });
  }
  return result;
}

export function parseWorldEloRatings(
  ratingsTsv: string,
  teamAliases: Map<string, { name: string; aliases: string[] }>
): FootballEloRating[] {
  return ratingsTsv
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line): FootballEloRating | undefined => {
      const fields = line.split("\t");
      const code = fields[2];
      const rating = numberValue(fields[3]);
      const rank = numberValue(fields[0]);
      if (!code || rating === undefined || rank === undefined) return undefined;
      const team = teamAliases.get(code) ?? { name: code, aliases: [code] };
      const aliases = Array.from(new Set([...team.aliases, ...(EXTRA_TEAM_ALIASES[code] ?? [])]));
      const result: FootballEloRating = {
        rank,
        code,
        name: team.name,
        aliases,
        rating
      };
      const rankChange = numberValue(fields[10]);
      const ratingChange = numberValue(fields[11]);
      if (rankChange !== undefined) result.rankChange = rankChange;
      if (ratingChange !== undefined) result.ratingChange = ratingChange;
      return result;
    })
    .filter((rating): rating is FootballEloRating => Boolean(rating));
}

export async function loadFootballEloDataset(
  options: LoadFootballEloOptions = {}
): Promise<FootballEloDataset> {
  const ratingsUrl = options.ratingsUrl ?? WORLD_ELO_RATINGS_URL;
  const teamsUrl = options.teamsUrl ?? WORLD_ELO_TEAMS_URL;
  const ratingsCachePath = options.ratingsCachePath ?? DEFAULT_RATINGS_CACHE_PATH;
  const teamsCachePath = options.teamsCachePath ?? DEFAULT_TEAMS_CACHE_PATH;
  const [ratingsText, teamsText] = await Promise.all([
    readOrFetchText(ratingsUrl, ratingsCachePath, options.refresh),
    readOrFetchText(teamsUrl, teamsCachePath, options.refresh)
  ]);
  const teamAliases = parseTeamAliases(teamsText);
  const ratings = parseWorldEloRatings(ratingsText, teamAliases);
  const ratingsByCode = new Map(ratings.map((rating) => [rating.code, rating]));
  const ratingsByAlias = new Map<string, FootballEloRating>();

  for (const rating of ratings) {
    for (const alias of [rating.code, rating.name, ...rating.aliases]) {
      ratingsByAlias.set(normalizeAlias(alias), rating);
    }
  }

  return {
    ratings,
    ratingsByCode,
    ratingsByAlias,
    sourceUrls: { ratings: ratingsUrl, teams: teamsUrl },
    cachePaths: { ratings: ratingsCachePath, teams: teamsCachePath }
  };
}

export function lookupFootballTeam(dataset: FootballEloDataset, team: string): FootballEloRating {
  const normalized = normalizeAlias(team);
  const rating = dataset.ratingsByAlias.get(normalized);
  if (!rating) {
    throw new Error(`No Football Elo rating found for "${team}". Add an alias or pass the Elo team name/code.`);
  }
  return rating;
}

export function estimateMatchProbabilities(
  home: FootballEloRating,
  away: FootballEloRating,
  options: FootballModelOptions = {}
): MatchProbabilities {
  const params = {
    drawBase: options.drawBase ?? DEFAULT_DRAW_BASE,
    drawMin: options.drawMin ?? DEFAULT_DRAW_MIN,
    drawScale: options.drawScale ?? DEFAULT_DRAW_SCALE,
    eloScale: options.eloScale ?? DEFAULT_ELO_SCALE,
    homeAdvantage: options.homeAdvantage ?? 0
  };
  const eloDiff = home.rating - away.rating + params.homeAdvantage;
  const expectedHomeScore = 1 / (1 + 10 ** (-eloDiff / params.eloScale));
  const rawDraw =
    params.drawMin +
    (params.drawBase - params.drawMin) * Math.exp(-Math.abs(eloDiff) / params.drawScale);
  const maxDraw = Math.max(0, 2 * Math.min(expectedHomeScore, 1 - expectedHomeScore) - 0.001);
  const draw = clamp(rawDraw, params.drawMin, maxDraw);
  const homeWin = clamp(expectedHomeScore - draw / 2, 0, 1);
  const awayWin = clamp(1 - expectedHomeScore - draw / 2, 0, 1);
  const total = homeWin + draw + awayWin;

  return {
    homeWin: homeWin / total,
    draw: draw / total,
    awayWin: awayWin / total,
    expectedHomeScore,
    eloDiff,
    params
  };
}

function parseFixtureTitle(title: unknown): { home: string; away: string } | undefined {
  if (typeof title !== "string") return undefined;
  const match = /^(.+?)\s+vs\.\s+(.+)$/.exec(title);
  if (!match) return undefined;
  return { home: match[1], away: match[2] };
}

function yesOutcome(market: { outcomes?: unknown }): {
  price?: number;
  bestBid?: number;
  bestAsk?: number;
} {
  const outcomes = Array.isArray(market.outcomes) ? market.outcomes : [];
  const yes = outcomes.find((outcome): outcome is Record<string, any> =>
    Boolean(outcome && typeof outcome === "object" && outcome.outcome === "Yes")
  );
  return {
    price: typeof yes?.price === "number" ? yes.price : undefined,
    bestBid: typeof yes?.orderbook?.bestBid?.price === "number" ? yes.orderbook.bestBid.price : undefined,
    bestAsk: typeof yes?.orderbook?.bestAsk?.price === "number" ? yes.orderbook.bestAsk.price : undefined
  };
}

function projectionForQuestion(
  question: unknown,
  home: FootballEloRating,
  away: FootballEloRating,
  probabilities: MatchProbabilities
): { outcome: FootballMarketProjection["outcome"]; modelProbability: number | undefined } {
  if (typeof question !== "string") return { outcome: "unknown", modelProbability: undefined };
  const normalized = normalizeAlias(question);

  if (normalized.includes(" end in a draw")) {
    return { outcome: "draw", modelProbability: probabilities.draw };
  }

  if (normalized.includes(`${normalizeAlias(home.name)} win`)) {
    return { outcome: "home", modelProbability: probabilities.homeWin };
  }
  if (normalized.includes(`${normalizeAlias(away.name)} win`)) {
    return { outcome: "away", modelProbability: probabilities.awayWin };
  }

  return { outcome: "unknown", modelProbability: undefined };
}

export async function pricePolymarketFootballEvent(
  config: AppConfig,
  slug: string,
  options: LoadFootballEloOptions & FootballModelOptions & {
    home?: string;
    away?: string;
    includeOrderbook?: boolean;
    edgeThreshold?: number;
  } = {}
) {
  const [event, dataset] = await Promise.all([
    getPolymarketEvent(config, slug, { includeOrderbook: options.includeOrderbook ?? true }),
    loadFootballEloDataset(options)
  ]);
  const parsedFixture = parseFixtureTitle((event as { title?: unknown }).title);
  const fixture = {
    home: options.home ?? parsedFixture?.home,
    away: options.away ?? parsedFixture?.away
  };
  if (!fixture.home || !fixture.away) {
    throw new Error("Could not infer teams from event title. Pass --home and --away.");
  }

  const home = lookupFootballTeam(dataset, fixture.home);
  const away = lookupFootballTeam(dataset, fixture.away);
  const probabilities = estimateMatchProbabilities(home, away, options);
  const edgeThreshold = options.edgeThreshold ?? DEFAULT_EDGE_THRESHOLD;
  const markets = Array.isArray((event as { markets?: unknown }).markets)
    ? ((event as { markets: any[] }).markets)
    : [];

  const projections: FootballMarketProjection[] = markets.map((market) => {
    const quote = yesOutcome(market);
    const { outcome, modelProbability } = projectionForQuestion(market.question, home, away, probabilities);
    const executablePrice = quote.bestAsk ?? quote.price;
    const buyYesEdge =
      modelProbability !== undefined && executablePrice !== undefined
        ? modelProbability - executablePrice
        : undefined;
    return {
      market: typeof market.question === "string" ? market.question : undefined,
      conditionId: typeof market.conditionId === "string" ? market.conditionId : undefined,
      outcome,
      modelProbability,
      yesPrice: quote.price,
      yesBestAsk: quote.bestAsk,
      yesBestBid: quote.bestBid,
      buyYesEdge,
      buyYesSignal:
        buyYesEdge === undefined
          ? "unknown"
          : buyYesEdge >= edgeThreshold
            ? "buy"
            : "pass"
    };
  });

  return {
    source: {
      ratingsUrl: dataset.sourceUrls.ratings,
      teamsUrl: dataset.sourceUrls.teams,
      ratingsCachePath: dataset.cachePaths.ratings,
      teamsCachePath: dataset.cachePaths.teams
    },
    warning: (event as { live?: unknown }).live === true
      ? "This is a pre-match Elo model; it does not account for live score, cards, injuries, or in-game stats."
      : undefined,
    event: {
      slug,
      title: (event as { title?: unknown }).title,
      startTime: (event as { startTime?: unknown }).startTime,
      endDate: (event as { endDate?: unknown }).endDate,
      live: (event as { live?: unknown }).live,
      score: (event as { score?: unknown }).score,
      elapsed: (event as { elapsed?: unknown }).elapsed,
      period: (event as { period?: unknown }).period
    },
    teams: { home, away },
    probabilities,
    markets: projections
  };
}
