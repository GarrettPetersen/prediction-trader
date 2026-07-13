export interface WeatherMarketAnchorPricingInput {
  coefficient: number;
  originalFair: number;
  originalReferencePrice: number;
  originalExecutionPrice: number;
  oppositeExecutionPrice: number;
}

export interface WeatherMarketAnchorPricingResult {
  inverse: boolean;
  disagreement: number;
  anchoredOriginalProbability: number;
  selectedFair: number;
  selectedPrice: number;
  edge: number;
}

export type WeatherHybridStrategyLane =
  | "normal_agreement"
  | "inverse_disagreement"
  | "abstain";

export interface WeatherHybridRoutingInput {
  originalSide: "YES" | "NO";
  originalFair: number;
  originalEdge?: number;
  originalReferencePrice?: number;
  originalExecutionPrice?: number;
  oppositeReferencePrice?: number;
  oppositeExecutionPrice?: number;
  measure: string;
  outcomeKind: string;
  minOriginalEdge: number;
  normalMinMarketProbability: number;
  coefficient: number;
  minOppositeMarketProbability: number;
  minExecutableEdge: number;
}

export interface WeatherHybridRoutingResult {
  lane: WeatherHybridStrategyLane;
  selectedSide?: "YES" | "NO";
  selectedFair?: number;
  selectedPrice?: number;
  edge?: number;
  anchoredOriginalProbability?: number;
  reason: string;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function priceWeatherMarketAnchor(
  input: WeatherMarketAnchorPricingInput
): WeatherMarketAnchorPricingResult {
  if (!Number.isFinite(input.coefficient)) {
    throw new Error("Weather market-anchor coefficient must be finite.");
  }
  const disagreement = input.originalFair - input.originalReferencePrice;
  if (!(disagreement > 0)) {
    throw new Error(`Expected positive forecast/market disagreement; got ${disagreement}.`);
  }
  const anchoredOriginalProbability = clamp(
    input.originalReferencePrice + input.coefficient * disagreement,
    0.001,
    0.999
  );
  const inverse = input.coefficient < 0;
  const selectedFair = inverse ? 1 - anchoredOriginalProbability : anchoredOriginalProbability;
  const selectedPrice = inverse ? input.oppositeExecutionPrice : input.originalExecutionPrice;
  return {
    inverse,
    disagreement,
    anchoredOriginalProbability,
    selectedFair,
    selectedPrice,
    edge: selectedFair - selectedPrice
  };
}

function validateProbability(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${label} must be between 0 and 1.`);
  }
}

function abstain(reason: string): WeatherHybridRoutingResult {
  return { lane: "abstain", reason };
}

export function isWeatherHybridNormalLane(input: Pick<
  WeatherHybridRoutingInput,
  "measure" | "outcomeKind" | "originalSide"
>): boolean {
  return input.measure === "temperature_high" &&
    input.outcomeKind === "range" &&
    input.originalSide === "NO";
}

export function routeWeatherHybridStrategy(
  input: WeatherHybridRoutingInput
): WeatherHybridRoutingResult {
  validateProbability(input.minOriginalEdge, "Hybrid minimum original edge");
  validateProbability(input.normalMinMarketProbability, "Hybrid normal-lane market probability");
  validateProbability(input.minOppositeMarketProbability, "Hybrid minimum opposite-market probability");
  validateProbability(input.minExecutableEdge, "Hybrid minimum executable edge");

  if (!Number.isFinite(input.coefficient) || input.coefficient >= 0) {
    throw new Error("Hybrid market-anchor coefficient must be a finite negative number.");
  }
  if (input.originalEdge === undefined || input.originalEdge < input.minOriginalEdge) {
    return abstain(
      `Original forecast edge ${(input.originalEdge ?? 0).toFixed(3)} is below required ${input.minOriginalEdge.toFixed(3)}.`
    );
  }
  if (
    input.originalReferencePrice === undefined ||
    input.oppositeReferencePrice === undefined
  ) {
    return abstain("Hybrid routing requires explicit original-side and opposite-side market probabilities.");
  }
  if (
    input.originalExecutionPrice === undefined ||
    input.oppositeExecutionPrice === undefined
  ) {
    return abstain("Hybrid routing requires executable prices for both sides.");
  }

  if (
    isWeatherHybridNormalLane(input) &&
    input.originalReferencePrice >= input.normalMinMarketProbability
  ) {
    return {
      lane: "normal_agreement",
      selectedSide: input.originalSide,
      selectedFair: input.originalFair,
      selectedPrice: input.originalExecutionPrice,
      edge: input.originalEdge,
      reason: `Normal agreement lane: high-temperature range NO is market-favoured at ${input.originalReferencePrice.toFixed(3)}.`
    };
  }

  if (input.oppositeReferencePrice >= input.minOppositeMarketProbability) {
    const anchored = priceWeatherMarketAnchor({
      coefficient: input.coefficient,
      originalFair: input.originalFair,
      originalReferencePrice: input.originalReferencePrice,
      originalExecutionPrice: input.originalExecutionPrice,
      oppositeExecutionPrice: input.oppositeExecutionPrice
    });
    if (anchored.edge < input.minExecutableEdge) {
      return abstain(
        `Inverse edge ${anchored.edge.toFixed(3)} is below executable minimum ${input.minExecutableEdge.toFixed(3)}.`
      );
    }
    return {
      lane: "inverse_disagreement",
      selectedSide: input.originalSide === "YES" ? "NO" : "YES",
      selectedFair: anchored.selectedFair,
      selectedPrice: anchored.selectedPrice,
      edge: anchored.edge,
      anchoredOriginalProbability: anchored.anchoredOriginalProbability,
      reason: `Inverse disagreement lane: opposite market side is favoured at ${input.oppositeReferencePrice.toFixed(3)}.`
    };
  }

  const shape = `${input.measure}:${input.outcomeKind}:${input.originalSide}`;
  return abstain(
    `No hybrid lane accepted ${shape}: normal lane requires high-temperature range NO at ` +
    `${input.normalMinMarketProbability.toFixed(3)}+, and opposite market probability ` +
    `${input.oppositeReferencePrice.toFixed(3)} is below ${input.minOppositeMarketProbability.toFixed(3)}.`
  );
}
