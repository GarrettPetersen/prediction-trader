import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  calculateBaseSigma,
  probabilityInRange
} from "../src/weatherPricing.js";

describe("weather pricing math", () => {
  it("uses larger sigma as forecast horizon grows", () => {
    assert.equal(calculateBaseSigma(4), 0.8);
    assert.equal(calculateBaseSigma(24), 1.3);
    assert.equal(calculateBaseSigma(240), 4.5);
    assert.equal(calculateBaseSigma(300), 5.5);
  });

  it("prices exact and tail ranges with a normal CDF", () => {
    const exact = probabilityInRange(20, 1, 19.5, 20.5);
    const below = probabilityInRange(20, 1, undefined, 20.5);
    const above = probabilityInRange(20, 1, 19.5, undefined);

    assert.ok(exact > 0.38);
    assert.ok(exact < 0.39);
    assert.ok(below > 0.69);
    assert.ok(above > 0.69);
  });
});
