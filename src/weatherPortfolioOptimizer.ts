export type WeatherPortfolioSide = "YES" | "NO";

export interface WeatherPortfolioCandidate {
  id: string;
  side: WeatherPortfolioSide;
  price: number;
  fair: number;
  edge: number;
  lowerTempC?: number;
  upperTempC?: number;
}

export interface WeatherTemperatureDistribution {
  meanC: number;
  sigmaC: number;
}

export interface WeatherPortfolioOptimizerOptions {
  bankrollUsd?: number;
  kellyMultiplier?: number;
  maxKellyFraction?: number;
  maxStakeUsd?: number;
  maxPortfolioFraction?: number;
  stepUsd?: number;
  minMarginalLogGrowth?: number;
}

export interface WeatherPortfolioOptimizedSize {
  id: string;
  fullKellyFraction: number;
  kellyFraction: number;
  rawStakeUsd: number;
  stakeUsd?: number;
  expectedLogGrowth: number;
}

interface TemperatureScenario {
  tempC: number;
  probability: number;
}

const DEFAULT_BANKROLL_USD = 0;
const DEFAULT_KELLY_MULTIPLIER = 0.25;
const DEFAULT_MAX_KELLY_FRACTION = 0.15;
const DEFAULT_MAX_PORTFOLIO_FRACTION = 1;
const DEFAULT_TAIL_SIGMAS = 5;
const DEFAULT_STEP_C = 0.25;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function finiteOrDefault(value: number | undefined, defaultValue: number): number {
  return value === undefined || !Number.isFinite(value) ? defaultValue : value;
}

function normalCdf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const abs = Math.abs(x) / Math.sqrt(2);
  const t = 1 / (1 + 0.3275911 * abs);
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const erf = sign * (1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-abs * abs));
  return 0.5 * (1 + erf);
}

function probabilityBelow(tempC: number, distribution: WeatherTemperatureDistribution): number {
  const sigmaC = Math.max(0.1, distribution.sigmaC);
  return normalCdf((tempC - distribution.meanC) / sigmaC);
}

function buildTemperatureScenarios(distribution: WeatherTemperatureDistribution): TemperatureScenario[] {
  const sigmaC = Math.max(0.1, distribution.sigmaC);
  const start = distribution.meanC - DEFAULT_TAIL_SIGMAS * sigmaC;
  const end = distribution.meanC + DEFAULT_TAIL_SIGMAS * sigmaC;
  const scenarios: TemperatureScenario[] = [];

  const lowTailProbability = probabilityBelow(start, distribution);
  if (lowTailProbability > 0) {
    scenarios.push({
      tempC: start - sigmaC,
      probability: lowTailProbability
    });
  }

  for (let lower = start; lower < end; lower += DEFAULT_STEP_C) {
    const upper = Math.min(end, lower + DEFAULT_STEP_C);
    const probability = probabilityBelow(upper, distribution) - probabilityBelow(lower, distribution);
    if (probability <= 0) continue;
    scenarios.push({
      tempC: (lower + upper) / 2,
      probability
    });
  }

  const highTailProbability = 1 - probabilityBelow(end, distribution);
  if (highTailProbability > 0) {
    scenarios.push({
      tempC: end + sigmaC,
      probability: highTailProbability
    });
  }

  const total = scenarios.reduce((sum, scenario) => sum + scenario.probability, 0);
  return total > 0
    ? scenarios.map((scenario) => ({
      ...scenario,
      probability: scenario.probability / total
    }))
    : [];
}

function resolvesYes(candidate: WeatherPortfolioCandidate, tempC: number): boolean {
  return (
    (candidate.lowerTempC === undefined || tempC >= candidate.lowerTempC) &&
    (candidate.upperTempC === undefined || tempC < candidate.upperTempC)
  );
}

function candidateWins(candidate: WeatherPortfolioCandidate, tempC: number): boolean {
  const yes = resolvesYes(candidate, tempC);
  return candidate.side === "YES" ? yes : !yes;
}

function expectedLogGrowth(
  candidates: WeatherPortfolioCandidate[],
  scenarios: TemperatureScenario[],
  stakes: number[],
  bankrollUsd: number
): number {
  if (bankrollUsd <= 0) return 0;
  const totalStake = stakes.reduce((sum, stake) => sum + stake, 0);
  let expected = 0;

  for (const scenario of scenarios) {
    let wealth = bankrollUsd - totalStake;
    for (let index = 0; index < candidates.length; index += 1) {
      const stake = stakes[index] ?? 0;
      if (stake <= 0) continue;
      if (candidateWins(candidates[index], scenario.tempC)) {
        wealth += stake / candidates[index].price;
      }
    }
    if (wealth <= 0) return -Infinity;
    expected += scenario.probability * Math.log(wealth / bankrollUsd);
  }

  return expected;
}

function defaultStepUsd(bankrollUsd: number): number {
  if (bankrollUsd <= 0) return 0.1;
  return clamp(bankrollUsd * 0.005, 0.1, 1);
}

export function optimizeWeatherPortfolio(
  rawCandidates: WeatherPortfolioCandidate[],
  distribution: WeatherTemperatureDistribution,
  options: WeatherPortfolioOptimizerOptions = {}
): WeatherPortfolioOptimizedSize[] {
  const bankrollUsd = Math.max(0, finiteOrDefault(options.bankrollUsd, DEFAULT_BANKROLL_USD));
  const kellyMultiplier = clamp(
    finiteOrDefault(options.kellyMultiplier, DEFAULT_KELLY_MULTIPLIER),
    0,
    1
  );
  const maxKellyFraction = clamp(
    finiteOrDefault(options.maxKellyFraction, DEFAULT_MAX_KELLY_FRACTION),
    0,
    1
  );
  const maxPortfolioFraction = clamp(
    finiteOrDefault(options.maxPortfolioFraction, DEFAULT_MAX_PORTFOLIO_FRACTION),
    0,
    1
  );
  const finalMaxStakeUsd = Math.max(0, finiteOrDefault(options.maxStakeUsd, Infinity));
  const finalMaxPerCandidateUsd = Math.min(finalMaxStakeUsd, bankrollUsd * maxKellyFraction);
  const finalMaxPortfolioUsd = bankrollUsd * maxPortfolioFraction;
  const stepUsd = Math.max(0.01, finiteOrDefault(options.stepUsd, defaultStepUsd(bankrollUsd)));
  const minMarginalLogGrowth = finiteOrDefault(options.minMarginalLogGrowth, 0);
  const candidates = rawCandidates.map((candidate) => ({
    ...candidate,
    price: clamp(candidate.price, 0, 1),
    fair: clamp(candidate.fair, 0, 1)
  }));
  const scenarios = buildTemperatureScenarios(distribution);
  const stakes = candidates.map(() => 0);

  if (
    bankrollUsd <= 0 ||
    kellyMultiplier <= 0 ||
    finalMaxPerCandidateUsd <= 0 ||
    finalMaxPortfolioUsd <= 0 ||
    scenarios.length === 0
  ) {
    return candidates.map((candidate) => ({
      id: candidate.id,
      fullKellyFraction: 0,
      kellyFraction: 0,
      rawStakeUsd: 0,
      expectedLogGrowth: 0
    }));
  }

  const rawScale = 1 / kellyMultiplier;
  const maxRawPerCandidateUsd = finalMaxPerCandidateUsd * rawScale;
  const maxRawPortfolioUsd = Math.min(bankrollUsd, finalMaxPortfolioUsd * rawScale);
  let currentLogGrowth = expectedLogGrowth(candidates, scenarios, stakes, bankrollUsd);

  while (stakes.reduce((sum, stake) => sum + stake, 0) < maxRawPortfolioUsd - 1e-9) {
    const rawStakeTotal = stakes.reduce((sum, stake) => sum + stake, 0);
    let bestIndex = -1;
    let bestIncrement = 0;
    let bestGain = minMarginalLogGrowth;
    let bestLogGrowth = currentLogGrowth;

    for (let index = 0; index < candidates.length; index += 1) {
      const candidate = candidates[index];
      if (
        candidate.edge <= 0 ||
        candidate.price <= 0 ||
        candidate.price >= 1 ||
        stakes[index] >= maxRawPerCandidateUsd - 1e-9
      ) {
        continue;
      }

      const increment = Math.min(
        stepUsd * rawScale,
        maxRawPerCandidateUsd - stakes[index],
        maxRawPortfolioUsd - rawStakeTotal
      );
      if (increment <= 1e-9) continue;

      stakes[index] += increment;
      const nextLogGrowth = expectedLogGrowth(candidates, scenarios, stakes, bankrollUsd);
      stakes[index] -= increment;
      const gain = nextLogGrowth - currentLogGrowth;
      if (gain > bestGain) {
        bestIndex = index;
        bestIncrement = increment;
        bestGain = gain;
        bestLogGrowth = nextLogGrowth;
      }
    }

    if (bestIndex < 0 || bestIncrement <= 0) break;
    stakes[bestIndex] += bestIncrement;
    currentLogGrowth = bestLogGrowth;
  }

  return candidates.map((candidate, index) => {
    const rawStakeUsd = stakes[index] ?? 0;
    const stakeUsd = Math.min(rawStakeUsd * kellyMultiplier, finalMaxPerCandidateUsd);
    return {
      id: candidate.id,
      fullKellyFraction: bankrollUsd > 0 ? rawStakeUsd / bankrollUsd : 0,
      kellyFraction: bankrollUsd > 0 ? stakeUsd / bankrollUsd : 0,
      rawStakeUsd,
      stakeUsd: stakeUsd > 0 ? stakeUsd : undefined,
      expectedLogGrowth: currentLogGrowth
    };
  });
}
