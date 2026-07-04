export interface BinaryKellyInput {
  probability: number;
  price: number;
}

export interface KellySizingOptions {
  bankrollUsd?: number;
  kellyMultiplier?: number;
  maxKellyFraction?: number;
  maxStakeUsd?: number;
}

export interface BinaryKellySizing {
  fullKellyFraction: number;
  kellyFraction: number;
  stakeUsd?: number;
}

export interface BinaryKellyPortfolioInput extends BinaryKellyInput {
  id: string;
}

export interface BinaryKellyPortfolioSize extends BinaryKellyPortfolioInput, BinaryKellySizing {
  rawStakeUsd: number;
}

export interface KellyPortfolioSizingOptions extends KellySizingOptions {
  maxPortfolioFraction?: number;
}

export const DEFAULT_KELLY_MULTIPLIER = 0.25;
export const DEFAULT_MAX_KELLY_FRACTION = 0.15;
export const DEFAULT_MAX_PORTFOLIO_FRACTION = 1;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function finiteOrDefault(value: number | undefined, fallback: number): number {
  return value === undefined || !Number.isFinite(value) ? fallback : value;
}

export function binaryKellyFraction(input: BinaryKellyInput): number {
  if (
    !Number.isFinite(input.probability) ||
    !Number.isFinite(input.price) ||
    input.price <= 0 ||
    input.price >= 1
  ) {
    return 0;
  }

  const probability = clamp(input.probability, 0, 1);
  return clamp((probability - input.price) / (1 - input.price), 0, 1);
}

export function sizeBinaryKellyBet(
  input: BinaryKellyInput,
  options: KellySizingOptions = {}
): BinaryKellySizing {
  const fullKellyFraction = binaryKellyFraction(input);
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
  const kellyFraction = clamp(fullKellyFraction * kellyMultiplier, 0, maxKellyFraction);
  const bankrollUsd = Math.max(0, finiteOrDefault(options.bankrollUsd, 0));
  const maxStakeUsd = Math.max(0, finiteOrDefault(options.maxStakeUsd, Infinity));
  const stakeUsd = kellyFraction > 0 && bankrollUsd > 0
    ? Math.min(bankrollUsd * kellyFraction, maxStakeUsd)
    : undefined;

  return {
    fullKellyFraction,
    kellyFraction,
    stakeUsd
  };
}

export function sizeBinaryKellyPortfolio(
  inputs: BinaryKellyPortfolioInput[],
  options: KellyPortfolioSizingOptions = {}
): BinaryKellyPortfolioSize[] {
  const bankrollUsd = Math.max(0, finiteOrDefault(options.bankrollUsd, 0));
  const maxPortfolioFraction = clamp(
    finiteOrDefault(options.maxPortfolioFraction, DEFAULT_MAX_PORTFOLIO_FRACTION),
    0,
    1
  );
  const maxPortfolioStakeUsd = bankrollUsd * maxPortfolioFraction;
  const raw = inputs.map((input) => {
    const sizing = sizeBinaryKellyBet(input, options);
    return {
      ...input,
      ...sizing,
      rawStakeUsd: sizing.stakeUsd ?? 0
    };
  });
  const rawStakeTotal = raw.reduce((sum, item) => sum + item.rawStakeUsd, 0);
  const scale = rawStakeTotal > 0 && rawStakeTotal > maxPortfolioStakeUsd
    ? maxPortfolioStakeUsd / rawStakeTotal
    : 1;

  return raw.map((item) => ({
    ...item,
    stakeUsd: item.rawStakeUsd > 0 ? item.rawStakeUsd * scale : undefined
  }));
}
