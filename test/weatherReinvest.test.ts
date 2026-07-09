import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  assertReinvestCalibrationEnabled,
  deployableWeatherCash,
  evaluateReinvestAuditGate,
  requirePositiveModelRunAgeHours,
  requireReinvestMinEdge,
  weatherBuyCashBudget
} from "../src/weatherReinvest.js";

describe("weather reinvestment cash reserve", () => {
  it("keeps the target reserve out of deployable cash", () => {
    assert.equal(deployableWeatherCash(50, 20), 30);
    assert.equal(deployableWeatherCash(20, 20), 0);
    assert.equal(deployableWeatherCash(12.34, 20), 0);
  });

  it("treats negative reserve inputs as zero", () => {
    assert.equal(deployableWeatherCash(12.34, -5), 12.34);
  });
});

describe("weather reinvestment buy budget", () => {
  it("caps deployable cash by absolute and fractional buy limits", () => {
    assert.equal(weatherBuyCashBudget({
      deployableCashUsd: 50,
      bankrollUsd: 100,
      maxBuySpendUsd: 8,
      maxBuySpendFraction: 0.05
    }), 5);
  });

  it("uses deployable cash when buy limits are higher than cash", () => {
    assert.equal(weatherBuyCashBudget({
      deployableCashUsd: 3,
      bankrollUsd: 100,
      maxBuySpendUsd: 8,
      maxBuySpendFraction: 0.05
    }), 3);
  });

  it("rejects invalid buy spend fractions", () => {
    assert.throws(
      () => weatherBuyCashBudget({
        deployableCashUsd: 50,
        bankrollUsd: 100,
        maxBuySpendFraction: 1.1
      }),
      /between 0 and 1/
    );
  });
});

describe("weather reinvestment forecast freshness age", () => {
  it("defaults to a 12 hour max model run age", () => {
    assert.equal(requirePositiveModelRunAgeHours(undefined), 12);
  });

  it("rejects invalid max model run ages", () => {
    assert.throws(
      () => requirePositiveModelRunAgeHours(0),
      /positive number/
    );
  });
});

describe("weather reinvestment edge threshold", () => {
  it("requires an explicit live reinvestment threshold", () => {
    assert.throws(
      () => requireReinvestMinEdge(),
      /requires --min-edge/
    );
  });

  it("uses the explicit threshold", () => {
    assert.equal(requireReinvestMinEdge(0.20), 0.20);
  });
});

describe("weather reinvestment calibration gate", () => {
  it("rejects diagnostics-only no-calibration mode", () => {
    assert.throws(
      () => assertReinvestCalibrationEnabled(true),
      /requires calibrated historical residuals/
    );
  });

  it("allows calibrated mode", () => {
    assert.doesNotThrow(() => assertReinvestCalibrationEnabled(undefined));
    assert.doesNotThrow(() => assertReinvestCalibrationEnabled(false));
  });
});

describe("weather reinvestment recent audit gate", () => {
  it("blocks fresh buys when the market-informed opposite side is outperforming", () => {
    const gate = evaluateReinvestAuditGate({
      since: "2026-07-06T00:00:00.000Z",
      lookbackHours: 72,
      minPositions: 3,
      report: {
        positionCount: 5,
        actual: { selectedPnlUsd: -20 },
        opposite: { selectedPnlUsd: 12 },
        oppositeAdvantageUsd: 32
      }
    });

    assert.equal(gate.passed, false);
    assert.match(gate.reason, /negative/);
  });

  it("passes only when actual performance is positive and beats the inverse", () => {
    const gate = evaluateReinvestAuditGate({
      since: "2026-07-06T00:00:00.000Z",
      lookbackHours: 72,
      minPositions: 3,
      report: {
        positionCount: 5,
        actual: { selectedPnlUsd: 4 },
        opposite: { selectedPnlUsd: -2 },
        oppositeAdvantageUsd: -6
      }
    });

    assert.equal(gate.passed, true);
  });

  it("blocks when the sample is too small to trust", () => {
    const gate = evaluateReinvestAuditGate({
      since: "2026-07-06T00:00:00.000Z",
      lookbackHours: 72,
      minPositions: 3,
      report: {
        positionCount: 2,
        actual: { selectedPnlUsd: 4 },
        opposite: { selectedPnlUsd: -2 },
        oppositeAdvantageUsd: -6
      }
    });

    assert.equal(gate.passed, false);
    assert.match(gate.reason, /need at least 3/);
  });
});
