import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  binaryKellyFraction,
  sizeBinaryKellyBet,
  sizeBinaryKellyPortfolio
} from "../src/kelly.js";

function assertNear(actual: number | undefined, expected: number) {
  assert.notEqual(actual, undefined);
  assert.ok(Math.abs((actual as number) - expected) < 1e-9, `${actual} should be near ${expected}`);
}

describe("Kelly sizing", () => {
  it("returns zero when a binary contract has no positive edge", () => {
    assert.equal(binaryKellyFraction({ probability: 0.49, price: 0.5 }), 0);
    assert.equal(binaryKellyFraction({ probability: 0.5, price: 0.5 }), 0);
  });

  it("sizes a binary contract with fractional Kelly and a per-trade cap", () => {
    const sizing = sizeBinaryKellyBet(
      { probability: 0.6, price: 0.5 },
      { bankrollUsd: 100, kellyMultiplier: 0.25, maxStakeUsd: 3 }
    );

    assertNear(sizing.fullKellyFraction, 0.2);
    assertNear(sizing.kellyFraction, 0.05);
    assert.equal(sizing.stakeUsd, 3);
  });

  it("scales a portfolio when Kelly stakes exceed the portfolio cap", () => {
    const sizes = sizeBinaryKellyPortfolio(
      [
        { id: "a", probability: 0.8, price: 0.5 },
        { id: "b", probability: 0.8, price: 0.5 }
      ],
      {
        bankrollUsd: 100,
        kellyMultiplier: 1,
        maxKellyFraction: 1,
        maxPortfolioFraction: 0.5
      }
    );

    assert.equal(sizes.length, 2);
    assertNear(sizes[0].rawStakeUsd, 60);
    assertNear(sizes[1].rawStakeUsd, 60);
    assertNear(sizes[0].stakeUsd, 25);
    assertNear(sizes[1].stakeUsd, 25);
  });
});
