import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  assertReinvestCalibrationEnabled,
  deployableWeatherCash,
  requireReinvestMinEdge
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
