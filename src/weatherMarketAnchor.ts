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
