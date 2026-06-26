export interface ScorelineProbability {
  homeScore: number;
  awayScore: number;
  probability: number;
}

export interface ScoreDistribution {
  sport: string;
  homeTeam: string;
  awayTeam: string;
  method: "exact-poisson-grid" | "monte-carlo";
  maxScore: number;
  coveredMass: number;
  scorelines: ScorelineProbability[];
  parameters: {
    homeMean: number;
    awayMean: number;
    simulations?: number;
    seed?: string | number;
  };
}

export interface ScoreSummaryOptions {
  topN?: number;
  totalLines?: number[];
  scoreQueries?: string[];
}

export interface ScoreSummary {
  expectedHomeScore: number;
  expectedAwayScore: number;
  expectedTotalScore: number;
  homeWin: number;
  draw: number;
  awayWin: number;
  bothTeamsToScore: {
    yes: number;
    no: number;
  };
  totals: Array<{
    line: number;
    over: number;
    underOrEqual: number;
  }>;
  queriedScores: Array<{
    score: string;
    probability: number;
  }>;
  topScores: ScorelineProbability[];
}

export interface IndependentPoissonScoreOptions {
  sport: string;
  homeTeam: string;
  awayTeam: string;
  homeMean: number;
  awayMean: number;
  maxScore?: number;
}

export interface MonteCarloScoreOptions extends IndependentPoissonScoreOptions {
  simulations?: number;
  seed?: string | number;
}

export interface ThreeWayProbabilities {
  homeWin: number;
  draw: number;
  awayWin: number;
}

export interface InferredPoissonMeans {
  homeMean: number;
  awayMean: number;
  expectedTotalScore: number;
  fittedProbabilities: ThreeWayProbabilities;
  loss: number;
}

const DEFAULT_MAX_SCORE = 10;
const DEFAULT_TOTAL_LINES = [0.5, 1.5, 2.5, 3.5, 4.5];
const DEFAULT_SIMULATIONS = 50_000;

function assertFiniteNonNegative(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${name} must be a finite non-negative number.`);
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function poissonPmf(lambda: number, maxScore: number): number[] {
  assertFiniteNonNegative(lambda, "lambda");
  const values = new Array<number>(maxScore + 1);
  values[0] = Math.exp(-lambda);
  for (let score = 1; score <= maxScore; score += 1) {
    values[score] = values[score - 1] * lambda / score;
  }
  return values;
}

function scoreKey(homeScore: number, awayScore: number): string {
  return `${homeScore}-${awayScore}`;
}

function normalizeScorelines(
  scorelines: ScorelineProbability[],
  coveredMass: number
): ScorelineProbability[] {
  if (coveredMass <= 0) return scorelines;
  return scorelines.map((scoreline) => ({
    ...scoreline,
    probability: scoreline.probability / coveredMass
  }));
}

export function buildIndependentPoissonScoreDistribution(
  options: IndependentPoissonScoreOptions
): ScoreDistribution {
  const maxScore = Math.trunc(options.maxScore ?? DEFAULT_MAX_SCORE);
  if (maxScore < 1) throw new Error("maxScore must be at least 1.");
  assertFiniteNonNegative(options.homeMean, "homeMean");
  assertFiniteNonNegative(options.awayMean, "awayMean");

  const homePmf = poissonPmf(options.homeMean, maxScore);
  const awayPmf = poissonPmf(options.awayMean, maxScore);
  const scorelines: ScorelineProbability[] = [];
  let coveredMass = 0;

  for (let homeScore = 0; homeScore <= maxScore; homeScore += 1) {
    for (let awayScore = 0; awayScore <= maxScore; awayScore += 1) {
      const probability = homePmf[homeScore] * awayPmf[awayScore];
      coveredMass += probability;
      scorelines.push({ homeScore, awayScore, probability });
    }
  }

  return {
    sport: options.sport,
    homeTeam: options.homeTeam,
    awayTeam: options.awayTeam,
    method: "exact-poisson-grid",
    maxScore,
    coveredMass,
    scorelines: normalizeScorelines(scorelines, coveredMass),
    parameters: {
      homeMean: options.homeMean,
      awayMean: options.awayMean
    }
  };
}

function hashSeed(seed: string | number): number {
  const text = String(seed);
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function seededRandom(seed: string | number): () => number {
  let state = hashSeed(seed);
  return () => {
    state += 0x6D2B79F5;
    let value = state;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}

function samplePoisson(lambda: number, random: () => number): number {
  if (lambda <= 0) return 0;
  const threshold = Math.exp(-lambda);
  let product = 1;
  let value = 0;

  do {
    value += 1;
    product *= random();
  } while (product > threshold);

  return value - 1;
}

export function buildMonteCarloScoreDistribution(options: MonteCarloScoreOptions): ScoreDistribution {
  const maxScore = Math.trunc(options.maxScore ?? DEFAULT_MAX_SCORE);
  const simulations = Math.trunc(options.simulations ?? DEFAULT_SIMULATIONS);
  if (maxScore < 1) throw new Error("maxScore must be at least 1.");
  if (simulations < 1) throw new Error("simulations must be at least 1.");
  assertFiniteNonNegative(options.homeMean, "homeMean");
  assertFiniteNonNegative(options.awayMean, "awayMean");

  const random = seededRandom(options.seed ?? `${options.homeTeam}|${options.awayTeam}|${simulations}`);
  const counts = new Map<string, ScorelineProbability>();
  let included = 0;

  for (let index = 0; index < simulations; index += 1) {
    const homeScore = samplePoisson(options.homeMean, random);
    const awayScore = samplePoisson(options.awayMean, random);
    if (homeScore > maxScore || awayScore > maxScore) continue;
    const key = scoreKey(homeScore, awayScore);
    const current = counts.get(key) ?? { homeScore, awayScore, probability: 0 };
    current.probability += 1;
    included += 1;
    counts.set(key, current);
  }
  const coveredMass = included / simulations;

  return {
    sport: options.sport,
    homeTeam: options.homeTeam,
    awayTeam: options.awayTeam,
    method: "monte-carlo",
    maxScore,
    coveredMass,
    scorelines: normalizeScorelines(Array.from(counts.values()), included),
    parameters: {
      homeMean: options.homeMean,
      awayMean: options.awayMean,
      simulations,
      seed: options.seed
    }
  };
}

function parseScoreQuery(score: string): { homeScore: number; awayScore: number } {
  const match = /^\s*(\d+)\s*[-:]\s*(\d+)\s*$/.exec(score);
  if (!match) throw new Error(`Invalid score query "${score}". Use a form like 1-1.`);
  return {
    homeScore: Number(match[1]),
    awayScore: Number(match[2])
  };
}

export function summarizeScoreDistribution(
  distribution: ScoreDistribution,
  options: ScoreSummaryOptions = {}
): ScoreSummary {
  const topN = Math.trunc(options.topN ?? 10);
  const totalLines = options.totalLines ?? DEFAULT_TOTAL_LINES;
  const scoreProbabilityByKey = new Map<string, number>();
  let expectedHomeScore = 0;
  let expectedAwayScore = 0;
  let homeWin = 0;
  let draw = 0;
  let awayWin = 0;
  let bothTeamsToScoreYes = 0;

  for (const scoreline of distribution.scorelines) {
    expectedHomeScore += scoreline.homeScore * scoreline.probability;
    expectedAwayScore += scoreline.awayScore * scoreline.probability;
    scoreProbabilityByKey.set(
      scoreKey(scoreline.homeScore, scoreline.awayScore),
      scoreline.probability
    );

    if (scoreline.homeScore > scoreline.awayScore) homeWin += scoreline.probability;
    if (scoreline.homeScore === scoreline.awayScore) draw += scoreline.probability;
    if (scoreline.homeScore < scoreline.awayScore) awayWin += scoreline.probability;
    if (scoreline.homeScore > 0 && scoreline.awayScore > 0) {
      bothTeamsToScoreYes += scoreline.probability;
    }
  }

  const totals = totalLines.map((line) => {
    const over = distribution.scorelines.reduce(
      (sum, scoreline) =>
        scoreline.homeScore + scoreline.awayScore > line
          ? sum + scoreline.probability
          : sum,
      0
    );
    return {
      line,
      over,
      underOrEqual: 1 - over
    };
  });

  const queriedScores = (options.scoreQueries ?? []).map((query) => {
    const parsed = parseScoreQuery(query);
    return {
      score: scoreKey(parsed.homeScore, parsed.awayScore),
      probability: scoreProbabilityByKey.get(scoreKey(parsed.homeScore, parsed.awayScore)) ?? 0
    };
  });

  return {
    expectedHomeScore,
    expectedAwayScore,
    expectedTotalScore: expectedHomeScore + expectedAwayScore,
    homeWin,
    draw,
    awayWin,
    bothTeamsToScore: {
      yes: bothTeamsToScoreYes,
      no: 1 - bothTeamsToScoreYes
    },
    totals,
    queriedScores,
    topScores: [...distribution.scorelines]
      .sort((a, b) => b.probability - a.probability)
      .slice(0, topN)
  };
}

export function inferPoissonMeansFromThreeWayProbabilities(
  probabilities: ThreeWayProbabilities,
  expectedTotalScore: number,
  options: {
    maxScore?: number;
    steps?: number;
    minMean?: number;
  } = {}
): InferredPoissonMeans {
  const maxScore = options.maxScore ?? DEFAULT_MAX_SCORE;
  const steps = Math.trunc(options.steps ?? 500);
  const minMean = options.minMean ?? 0.05;
  if (expectedTotalScore <= minMean * 2) {
    throw new Error("expectedTotalScore is too low for the requested minMean.");
  }

  let best: InferredPoissonMeans | undefined;
  for (let step = 0; step <= steps; step += 1) {
    const share = step / steps;
    const homeMean = minMean + share * (expectedTotalScore - 2 * minMean);
    const awayMean = expectedTotalScore - homeMean;
    const distribution = buildIndependentPoissonScoreDistribution({
      sport: "soccer",
      homeTeam: "home",
      awayTeam: "away",
      homeMean,
      awayMean,
      maxScore
    });
    const summary = summarizeScoreDistribution(distribution, { topN: 1, totalLines: [] });
    const loss =
      (summary.homeWin - probabilities.homeWin) ** 2 +
      (summary.draw - probabilities.draw) ** 2 +
      (summary.awayWin - probabilities.awayWin) ** 2;
    const candidate = {
      homeMean,
      awayMean,
      expectedTotalScore,
      fittedProbabilities: {
        homeWin: summary.homeWin,
        draw: summary.draw,
        awayWin: summary.awayWin
      },
      loss
    };
    if (!best || candidate.loss < best.loss) best = candidate;
  }

  if (!best) {
    throw new Error("Could not infer Poisson means.");
  }

  return {
    ...best,
    homeMean: clamp(best.homeMean, minMean, expectedTotalScore - minMean),
    awayMean: clamp(best.awayMean, minMean, expectedTotalScore - minMean)
  };
}
