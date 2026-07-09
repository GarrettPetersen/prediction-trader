import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  assessOpenMeteoForecastFreshness,
  type OpenMeteoModelFreshness
} from "../src/weatherForecastFreshness.js";

function source(
  name: OpenMeteoModelFreshness["source"],
  init: string,
  usableAfter = "2026-07-08T19:10:00Z"
): OpenMeteoModelFreshness {
  return {
    source: name,
    label: name,
    metadataModel: name,
    metadataUrl: `https://api.open-meteo.com/data/${name}/static/meta.json`,
    lastRunInitialisationTime: init,
    lastRunAvailabilityTime: "2026-07-08T19:00:00Z",
    usableAfter,
    nextExpectedInitialisationTime: "2026-07-09T00:00:00Z",
    updateIntervalSeconds: 21_600,
    temporalResolutionSeconds: 3_600
  };
}

describe("weather forecast freshness", () => {
  it("allows a common usable recent Open-Meteo cycle", () => {
    const report = assessOpenMeteoForecastFreshness({
      now: new Date("2026-07-08T23:00:00Z"),
      maxRunAgeHours: 12,
      sources: [
        source("openmeteo_gfs", "2026-07-08T18:00:00Z"),
        source("openmeteo_ecmwf", "2026-07-08T18:00:00Z"),
        source("openmeteo_ukmo", "2026-07-08T18:00:00Z")
      ]
    });

    assert.equal(report.ok, true);
    assert.equal(report.status, "fresh");
    assert.equal(report.commonInitialisationTime, "2026-07-08T18:00:00Z");
    assert.equal(report.allSourcesUsableAfter, "2026-07-08T19:10:00Z");
  });

  it("blocks buys while sources are on different initialization cycles", () => {
    const report = assessOpenMeteoForecastFreshness({
      now: new Date("2026-07-08T23:00:00Z"),
      maxRunAgeHours: 12,
      sources: [
        source("openmeteo_gfs", "2026-07-08T18:00:00Z"),
        source("openmeteo_ecmwf", "2026-07-08T18:00:00Z"),
        source("openmeteo_ukmo", "2026-07-08T12:00:00Z")
      ]
    });

    assert.equal(report.ok, false);
    assert.equal(report.status, "sources_out_of_sync");
    assert.match(report.reason, /different initialization cycles/);
  });

  it("blocks buys before the common cycle is usable on all API servers", () => {
    const report = assessOpenMeteoForecastFreshness({
      now: new Date("2026-07-08T19:05:00Z"),
      maxRunAgeHours: 12,
      sources: [
        source("openmeteo_gfs", "2026-07-08T18:00:00Z", "2026-07-08T19:10:00Z"),
        source("openmeteo_ecmwf", "2026-07-08T18:00:00Z", "2026-07-08T19:30:00Z"),
        source("openmeteo_ukmo", "2026-07-08T18:00:00Z", "2026-07-08T20:00:00Z")
      ]
    });

    assert.equal(report.ok, false);
    assert.equal(report.status, "not_available_yet");
    assert.equal(report.allSourcesUsableAfter, "2026-07-08T20:00:00Z");
  });

  it("blocks buys when the common cycle is stale", () => {
    const report = assessOpenMeteoForecastFreshness({
      now: new Date("2026-07-09T07:00:00Z"),
      maxRunAgeHours: 12,
      sources: [
        source("openmeteo_gfs", "2026-07-08T18:00:00Z"),
        source("openmeteo_ecmwf", "2026-07-08T18:00:00Z"),
        source("openmeteo_ukmo", "2026-07-08T18:00:00Z")
      ]
    });

    assert.equal(report.ok, false);
    assert.equal(report.status, "too_old");
    assert.equal(report.runAgeHours, 13);
  });
});
