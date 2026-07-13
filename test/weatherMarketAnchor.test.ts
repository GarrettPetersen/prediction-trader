import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  routeWeatherHybridStrategy,
  type WeatherHybridRoutingInput
} from "../src/weatherMarketAnchor.js";

const BASE: WeatherHybridRoutingInput = {
  originalSide: "NO",
  originalFair: 0.9,
  originalEdge: 0.3,
  originalReferencePrice: 0.62,
  originalExecutionPrice: 0.6,
  oppositeReferencePrice: 0.38,
  oppositeExecutionPrice: 0.4,
  measure: "temperature_high",
  outcomeKind: "range",
  minOriginalEdge: 0.3,
  normalMinMarketProbability: 0.5,
  coefficient: -0.25,
  minOppositeMarketProbability: 0.5,
  minExecutableEdge: 0.03
};

describe("WeatherEdge hybrid strategy router", () => {
  it("keeps market-agreeing high-temperature range NO signals in the normal lane", () => {
    const result = routeWeatherHybridStrategy(BASE);

    assert.equal(result.lane, "normal_agreement");
    assert.equal(result.selectedSide, "NO");
    assert.equal(result.selectedFair, 0.9);
    assert.equal(result.edge, 0.3);
  });

  it("routes a large model-market disagreement to the market-favoured opposite side", () => {
    const result = routeWeatherHybridStrategy({
      ...BASE,
      originalReferencePrice: 0.35,
      originalExecutionPrice: 0.37,
      oppositeReferencePrice: 0.65,
      oppositeExecutionPrice: 0.66
    });

    assert.equal(result.lane, "inverse_disagreement");
    assert.equal(result.selectedSide, "YES");
    assert.ok((result.edge ?? 0) > 0.1);
  });

  it("abstains from exact-temperature NO even when the market agrees", () => {
    const result = routeWeatherHybridStrategy({
      ...BASE,
      outcomeKind: "exact"
    });

    assert.equal(result.lane, "abstain");
    assert.match(result.reason, /No hybrid lane accepted/);
  });

  it("abstains when the apparent forecast edge misses the explicit gate", () => {
    const result = routeWeatherHybridStrategy({
      ...BASE,
      originalEdge: 0.29
    });

    assert.equal(result.lane, "abstain");
    assert.match(result.reason, /below required/);
  });

  it("fails loudly on invalid hybrid configuration", () => {
    assert.throws(
      () => routeWeatherHybridStrategy({ ...BASE, coefficient: 0.25 }),
      /finite negative/
    );
  });
});
