import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseWeatherMarketQuestion } from "../src/weatherMarkets.js";

describe("weather market parsing", () => {
  it("parses exact city high-temperature bins", () => {
    const parsed = parseWeatherMarketQuestion(
      "Will the highest temperature in Istanbul be 31°C on July 3?",
      "2026-07-03T12:00:00Z"
    );

    assert.equal(parsed?.city, "Istanbul");
    assert.equal(parsed?.date, "2026-07-03");
    assert.equal(parsed?.measure, "temperature_high");
    assert.equal(parsed?.outcome.kind, "exact");
    assert.equal(parsed?.outcome.lowerTempC, 30.5);
    assert.equal(parsed?.outcome.upperTempC, 31.5);
  });

  it("parses or-below and fahrenheit outcomes", () => {
    const parsed = parseWeatherMarketQuestion(
      "Will the highest temperature in New York be 80°F or below on July 4?",
      "2026-07-04T12:00:00Z"
    );

    assert.equal(parsed?.city, "New York");
    assert.equal(parsed?.outcome.kind, "or_below");
    assert.equal(parsed?.outcome.unit, "F");
    assert.ok((parsed?.outcome.upperTempC ?? 0) > 26);
    assert.ok((parsed?.outcome.upperTempC ?? 0) < 27.1);
  });

  it("parses hyphenated fahrenheit ranges", () => {
    const parsed = parseWeatherMarketQuestion(
      "Will the lowest temperature in Miami be between 78-79°F on July 4?",
      "2026-07-04T12:00:00Z"
    );

    assert.equal(parsed?.city, "Miami");
    assert.equal(parsed?.measure, "temperature_low");
    assert.equal(parsed?.outcome.kind, "range");
    assert.equal(parsed?.outcome.unit, "F");
    assert.ok((parsed?.outcome.lowerTempC ?? 0) > 25.2);
    assert.ok((parsed?.outcome.upperTempC ?? 0) < 27);
  });

  it("parses or-higher tail outcomes", () => {
    const parsed = parseWeatherMarketQuestion(
      "Will the highest temperature in Jeddah be 39°C or higher on July 5?",
      "2026-07-05T12:00:00Z"
    );

    assert.equal(parsed?.city, "Jeddah");
    assert.equal(parsed?.outcome.kind, "or_above");
    assert.equal(parsed?.outcome.lowerTempC, 38.5);
  });

  it("skips unsupported non-city weather markets", () => {
    assert.equal(parseWeatherMarketQuestion(
      "Will global temperature increase by between 1.10ºC and 1.14ºC in June 2026?",
      "2026-06-30T00:00:00Z"
    ), undefined);
  });
});
