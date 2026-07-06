import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { deployableWeatherCash } from "../src/weatherReinvest.js";

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
