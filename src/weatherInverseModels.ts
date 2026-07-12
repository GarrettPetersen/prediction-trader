import type { WeatherBacktestTrade } from "./weatherBacktest.js";
import { priceWeatherMarketAnchor } from "./weatherMarketAnchor.js";

export interface WeatherMarketAnchorModel {
  id: string;
  coefficient: number;
  minOriginalEdge: number;
  minOppositeMarketProbability: number;
}

export interface WeatherInverseModelOptions {
  bankrollUsd: number;
  kellyMultiplier: number;
  maxKellyFraction: number;
  maxPerTradeUsd: number;
  maxPortfolioFraction: number;
  maxGroupFraction: number;
  minExecutableEdge: number;
  minTradePrice: number;
}

export interface WeatherInverseModelDayInput {
  date: string;
  trades: WeatherBacktestTrade[];
}

export interface WeatherInverseModelDayResult {
  date: string;
  candidateCount: number;
  tradeCount: number;
  wins: number;
  losses: number;
  stakeUsd: number;
  payoutUsd: number;
  pnlUsd: number;
}

export interface WeatherInverseModelSummary {
  model: WeatherMarketAnchorModel;
  days: number;
  candidateCount: number;
  tradeCount: number;
  wins: number;
  losses: number;
  winningDays: number;
  losingDays: number;
  stakeUsd: number;
  payoutUsd: number;
  pnlUsd: number;
  roiOnStake: number;
  daily: WeatherInverseModelDayResult[];
}

export interface WeatherInverseGridResult {
  train: WeatherInverseModelSummary[];
  holdout: WeatherInverseModelSummary[];
  selectedModel: WeatherMarketAnchorModel;
  selectedTrain: WeatherInverseModelSummary;
  selectedHoldout: WeatherInverseModelSummary;
}

interface SizedInverseCandidate {
  groupKey: string;
  won: boolean;
  price: number;
  stakeUsd: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function scaledCandidates(
  candidates: SizedInverseCandidate[],
  bankrollUsd: number,
  maxGroupFraction: number,
  maxPortfolioFraction: number
): SizedInverseCandidate[] {
  const byGroup = new Map<string, SizedInverseCandidate[]>();
  for (const candidate of candidates) {
    const group = byGroup.get(candidate.groupKey) ?? [];
    group.push(candidate);
    byGroup.set(candidate.groupKey, group);
  }

  const groupScaled: SizedInverseCandidate[] = [];
  const maxGroupStakeUsd = bankrollUsd * maxGroupFraction;
  for (const group of byGroup.values()) {
    const stakeUsd = group.reduce((sum, candidate) => sum + candidate.stakeUsd, 0);
    const scale = stakeUsd > maxGroupStakeUsd && stakeUsd > 0 ? maxGroupStakeUsd / stakeUsd : 1;
    groupScaled.push(...group.map((candidate) => ({
      ...candidate,
      stakeUsd: candidate.stakeUsd * scale
    })));
  }

  const totalStakeUsd = groupScaled.reduce((sum, candidate) => sum + candidate.stakeUsd, 0);
  const maxPortfolioStakeUsd = bankrollUsd * maxPortfolioFraction;
  const portfolioScale = totalStakeUsd > maxPortfolioStakeUsd && totalStakeUsd > 0
    ? maxPortfolioStakeUsd / totalStakeUsd
    : 1;
  return groupScaled.map((candidate) => ({
    ...candidate,
    stakeUsd: candidate.stakeUsd * portfolioScale
  }));
}

export function defaultWeatherMarketAnchorModels(): WeatherMarketAnchorModel[] {
  const models: WeatherMarketAnchorModel[] = [{
    id: "forecast-edge",
    coefficient: 1,
    minOriginalEdge: 0.2,
    minOppositeMarketProbability: 0
  }];
  for (const coefficient of [-0.25, -0.5, -1, -1.5, -2]) {
    for (const minOriginalEdge of [0.2, 0.3, 0.4]) {
      for (const minOppositeMarketProbability of [0, 0.5, 0.6]) {
        const confidence = minOppositeMarketProbability === 0
          ? "all"
          : `market-${Math.round(minOppositeMarketProbability * 100)}`;
        models.push({
          id: `inverse-${Math.abs(coefficient)}-edge-${Math.round(minOriginalEdge * 100)}-${confidence}`,
          coefficient,
          minOriginalEdge,
          minOppositeMarketProbability
        });
      }
    }
  }
  return models;
}

export function evaluateWeatherMarketAnchorModelDay(
  input: WeatherInverseModelDayInput,
  model: WeatherMarketAnchorModel,
  options: WeatherInverseModelOptions
): WeatherInverseModelDayResult {
  const candidates: SizedInverseCandidate[] = [];
  for (const trade of input.trades) {
    if (trade.edge < model.minOriginalEdge) continue;
    const inverse = model.coefficient < 0;
    const oppositeMarketProbability = 1 - trade.referencePrice;
    if (inverse && oppositeMarketProbability < model.minOppositeMarketProbability) continue;

    const anchored = priceWeatherMarketAnchor({
      coefficient: model.coefficient,
      originalFair: trade.fair,
      originalReferencePrice: trade.referencePrice,
      originalExecutionPrice: trade.price,
      oppositeExecutionPrice: trade.oppositePrice
    });
    const fair = anchored.selectedFair;
    const price = anchored.selectedPrice;
    const edge = anchored.edge;
    if (price < options.minTradePrice || edge < options.minExecutableEdge) continue;

    const fullKellyFraction = clamp(edge / (1 - price), 0, 1);
    const kellyFraction = Math.min(
      fullKellyFraction * options.kellyMultiplier,
      options.maxKellyFraction
    );
    const stakeUsd = Math.min(
      options.bankrollUsd * kellyFraction,
      options.maxPerTradeUsd
    );
    if (!(stakeUsd > 0)) continue;

    candidates.push({
      groupKey: `${trade.forecastTargetKey}|${trade.date}|${trade.measure}`,
      won: inverse ? trade.oppositeWon : trade.won,
      price,
      stakeUsd
    });
  }

  const sized = scaledCandidates(
    candidates,
    options.bankrollUsd,
    options.maxGroupFraction,
    options.maxPortfolioFraction
  );
  const stakeUsd = sized.reduce((sum, candidate) => sum + candidate.stakeUsd, 0);
  const payoutUsd = sized.reduce(
    (sum, candidate) => sum + (candidate.won ? candidate.stakeUsd / candidate.price : 0),
    0
  );
  return {
    date: input.date,
    candidateCount: input.trades.length,
    tradeCount: sized.length,
    wins: sized.filter((candidate) => candidate.won).length,
    losses: sized.filter((candidate) => !candidate.won).length,
    stakeUsd,
    payoutUsd,
    pnlUsd: payoutUsd - stakeUsd
  };
}

export function summarizeWeatherMarketAnchorModel(
  inputs: WeatherInverseModelDayInput[],
  model: WeatherMarketAnchorModel,
  options: WeatherInverseModelOptions
): WeatherInverseModelSummary {
  const daily = inputs.map((input) => evaluateWeatherMarketAnchorModelDay(input, model, options));
  const stakeUsd = daily.reduce((sum, day) => sum + day.stakeUsd, 0);
  const payoutUsd = daily.reduce((sum, day) => sum + day.payoutUsd, 0);
  const pnlUsd = payoutUsd - stakeUsd;
  return {
    model,
    days: daily.length,
    candidateCount: daily.reduce((sum, day) => sum + day.candidateCount, 0),
    tradeCount: daily.reduce((sum, day) => sum + day.tradeCount, 0),
    wins: daily.reduce((sum, day) => sum + day.wins, 0),
    losses: daily.reduce((sum, day) => sum + day.losses, 0),
    winningDays: daily.filter((day) => day.pnlUsd > 0).length,
    losingDays: daily.filter((day) => day.pnlUsd < 0).length,
    stakeUsd,
    payoutUsd,
    pnlUsd,
    roiOnStake: stakeUsd > 0 ? pnlUsd / stakeUsd : 0,
    daily
  };
}

function compareSummaries(a: WeatherInverseModelSummary, b: WeatherInverseModelSummary): number {
  if (a.pnlUsd !== b.pnlUsd) return b.pnlUsd - a.pnlUsd;
  if (a.winningDays !== b.winningDays) return b.winningDays - a.winningDays;
  if (a.tradeCount !== b.tradeCount) return b.tradeCount - a.tradeCount;
  return a.model.id.localeCompare(b.model.id);
}

export function evaluateWeatherInverseGrid(input: {
  train: WeatherInverseModelDayInput[];
  holdout: WeatherInverseModelDayInput[];
  models?: WeatherMarketAnchorModel[];
  minTrainingTrades?: number;
  options: WeatherInverseModelOptions;
}): WeatherInverseGridResult {
  if (input.train.length === 0) throw new Error("Inverse-model grid requires at least one training day.");
  if (input.holdout.length === 0) throw new Error("Inverse-model grid requires at least one holdout day.");
  const models = input.models ?? defaultWeatherMarketAnchorModels();
  if (models.length === 0) throw new Error("Inverse-model grid requires at least one model.");

  const train = models
    .map((model) => summarizeWeatherMarketAnchorModel(input.train, model, input.options))
    .sort(compareSummaries);
  const minTrainingTrades = Math.max(1, Math.trunc(input.minTrainingTrades ?? 10));
  const eligibleTrain = train.filter((summary) => summary.tradeCount >= minTrainingTrades);
  if (eligibleTrain.length === 0) {
    throw new Error(`No inverse model made the required ${minTrainingTrades} training trades.`);
  }
  const holdoutById = new Map(models.map((model) => [
    model.id,
    summarizeWeatherMarketAnchorModel(input.holdout, model, input.options)
  ]));
  const selectedTrain = eligibleTrain[0];
  const selectedHoldout = holdoutById.get(selectedTrain.model.id);
  if (!selectedHoldout) throw new Error(`Missing holdout result for selected model ${selectedTrain.model.id}.`);

  return {
    train,
    holdout: [...holdoutById.values()].sort(compareSummaries),
    selectedModel: selectedTrain.model,
    selectedTrain,
    selectedHoldout
  };
}
