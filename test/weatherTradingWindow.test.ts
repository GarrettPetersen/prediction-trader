import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  assessWeatherEntryWindow,
  assessWeatherTradingWindow,
  inferWeatherTimeZone
} from "../src/weatherTradingWindow.js";

describe("weather trading window", () => {
  it("infers US weather station timezones from longitude when needed", () => {
    assert.equal(inferWeatherTimeZone({ countryCode: "US", longitude: -95.34 }), "America/Chicago");
    assert.equal(inferWeatherTimeZone({ countryCode: "US", longitude: -104.67 }), "America/Denver");
    assert.equal(inferWeatherTimeZone({ countryCode: "US", longitude: -122.38 }), "America/Los_Angeles");
  });

  it("infers major Asia market timezones from country codes", () => {
    assert.equal(inferWeatherTimeZone({ countryCode: "CN" }), "Asia/Shanghai");
    assert.equal(inferWeatherTimeZone({ countryCode: "HK" }), "Asia/Hong_Kong");
    assert.equal(inferWeatherTimeZone({ countryCode: "KR" }), "Asia/Seoul");
  });

  it("allows markets before the target day in the market-local timezone", () => {
    const assessment = assessWeatherTradingWindow({
      targetDate: "2026-07-04",
      measure: "temperature_high",
      countryCode: "US",
      longitude: -73.87,
      now: new Date("2026-07-04T00:04:00Z")
    });

    assert.equal(assessment.safeToTrade, true);
    assert.equal(assessment.status, "before_market_day");
    assert.equal(assessment.localDate, "2026-07-03");
    assert.equal(assessment.timezone, "America/New_York");
  });

  it("uses a wider post-midnight grace window for highs than lows", () => {
    const now = new Date("2026-07-04T00:45:00Z");
    const base = {
      targetDate: "2026-07-04",
      countryCode: "GB",
      now
    };

    assert.equal(assessWeatherTradingWindow({
      ...base,
      measure: "temperature_high"
    }).safeToTrade, true);

    const low = assessWeatherTradingWindow({
      ...base,
      measure: "temperature_low"
    });
    assert.equal(low.safeToTrade, false);
    assert.equal(low.status, "local_day_started");
  });

  it("rejects markets once the local day is well underway", () => {
    const assessment = assessWeatherTradingWindow({
      targetDate: "2026-07-04",
      measure: "temperature_high",
      countryCode: "JP",
      now: new Date("2026-07-04T00:04:00Z")
    });

    assert.equal(assessment.safeToTrade, false);
    assert.equal(assessment.status, "local_day_started");
    assert.equal(assessment.localDate, "2026-07-04");
  });

  it("rejects markets when timezone cannot be inferred", () => {
    const assessment = assessWeatherTradingWindow({
      targetDate: "2026-07-04",
      measure: "temperature_high",
      now: new Date("2026-07-04T00:04:00Z")
    });

    assert.equal(assessment.safeToTrade, false);
    assert.equal(assessment.status, "timezone_unknown");
  });

  it("allows day-ahead entries in the station-local evening window", () => {
    const assessment = assessWeatherEntryWindow({
      targetDate: "2026-07-08",
      countryCode: "JP",
      now: new Date("2026-07-07T11:17:00Z")
    });

    assert.equal(assessment.shouldEnter, true);
    assert.equal(assessment.status, "inside_entry_window");
    assert.equal(assessment.timezone, "Asia/Tokyo");
    assert.equal(assessment.localDate, "2026-07-07");
    assert.equal(assessment.localTime, "20:17");
  });

  it("holds cash before the station-local evening entry window", () => {
    const assessment = assessWeatherEntryWindow({
      targetDate: "2026-07-08",
      countryCode: "GB",
      now: new Date("2026-07-07T12:17:00Z")
    });

    assert.equal(assessment.shouldEnter, false);
    assert.equal(assessment.status, "before_entry_window");
    assert.equal(assessment.localDate, "2026-07-07");
    assert.equal(assessment.localTime, "13:17");
  });

  it("rejects entries once the station-local target day has started", () => {
    const assessment = assessWeatherEntryWindow({
      targetDate: "2026-07-08",
      countryCode: "HK",
      now: new Date("2026-07-07T17:30:00Z")
    });

    assert.equal(assessment.shouldEnter, false);
    assert.equal(assessment.status, "market_day_started");
    assert.equal(assessment.localDate, "2026-07-08");
  });
});
