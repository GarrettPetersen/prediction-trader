import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  calculateBaseSigma,
  priceWeatherMarketGroup,
  probabilityInRange,
  resolvePricingForecastTarget
} from "../src/weatherPricing.js";
import { loadConfig, type AppConfig } from "../src/config.js";
import type { WeatherMarketGroup } from "../src/weatherMarkets.js";

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

  it("uses HKO as the forecast target only when the market explicitly resolves there", async () => {
    const group: WeatherMarketGroup = {
      eventSlug: "highest-temperature-in-hong-kong-on-july-5-2026",
      eventTitle: "Highest temperature in Hong Kong according to the Hong Kong Observatory",
      eventEndDate: "2026-07-05T16:00:00Z",
      city: "Hong Kong",
      date: "2026-07-05",
      measure: "temperature_high",
      markets: [{
        eventSlug: "highest-temperature-in-hong-kong-on-july-5-2026",
        eventTitle: "Highest temperature in Hong Kong according to the Hong Kong Observatory",
        eventEndDate: "2026-07-05T16:00:00Z",
        marketSlug: "highest-temperature-in-hong-kong-on-july-5-2026-34c",
        question: "Will the highest temperature in Hong Kong be 34°C according to the Hong Kong Observatory?",
        resolutionSource: "https://www.hko.gov.hk/en/wxinfo/ts/index.htm",
        active: true,
        closed: false,
        outcomes: [],
        parsed: {
          city: "Hong Kong",
          date: "2026-07-05",
          measure: "temperature_high",
          outcome: {
            kind: "exact",
            label: "34C",
            unit: "C",
            lowerTempC: 33.5,
            upperTempC: 34.5,
            exactTempC: 34,
            rawValue: 34
          }
        }
      }],
      unparsed: []
    };

    const target = await resolvePricingForecastTarget({} as AppConfig, group, {});

    assert.equal(target.strictError, undefined);
    assert.equal(target.location.name, "Hong Kong Observatory");
    assert.equal(target.resolutionTarget.matched, true);
    assert.equal(target.resolutionTarget.station?.id, "HKO");
    assert.equal(target.resolutionTarget.forecastLocation.countryCode, "HK");
  });

  it("uses HKO when Gamma exposes the source only in the description", async () => {
    const group: WeatherMarketGroup = {
      eventSlug: "highest-temperature-in-hong-kong-on-july-7-2026",
      eventTitle: "Highest temperature in Hong Kong on July 7?",
      eventEndDate: "2026-07-07T12:00:00Z",
      city: "Hong Kong",
      date: "2026-07-07",
      measure: "temperature_high",
      markets: [{
        eventSlug: "highest-temperature-in-hong-kong-on-july-7-2026",
        eventTitle: "Highest temperature in Hong Kong on July 7?",
        eventEndDate: "2026-07-07T12:00:00Z",
        marketSlug: "highest-temperature-in-hong-kong-on-july-7-2026-31c",
        question: "Will the highest temperature in Hong Kong be 31°C on July 7?",
        description: "The resolution source for this market will be information from the Hong Kong Observatory, specifically the \"Absolute Daily Max (deg. C)\" once information is finalized in the relevant \"Daily Extract\", available here: https://www.weather.gov.hk/en/cis/climat.htm",
        active: true,
        closed: false,
        outcomes: [],
        parsed: {
          city: "Hong Kong",
          date: "2026-07-07",
          measure: "temperature_high",
          outcome: {
            kind: "exact",
            label: "31C",
            unit: "C",
            lowerTempC: 30.5,
            upperTempC: 31.5,
            exactTempC: 31,
            rawValue: 31
          }
        }
      }],
      unparsed: []
    };

    const target = await resolvePricingForecastTarget({} as AppConfig, group, {});

    assert.equal(target.strictError, undefined);
    assert.equal(target.resolutionTarget.matched, true);
    assert.equal(target.resolutionTarget.station?.id, "HKO");
    assert.equal(target.resolutionTarget.resolutionSource, "https://www.weather.gov.hk/en/cis/climat.htm");
  });

  it("uses calibrated previous-run residuals in live day-ahead pricing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "weather-pricing-"));
    const observationsPath = join(dir, "observations.jsonl");
    const previousRunsPath = join(dir, "previous-runs.jsonl");
    const resolutionActualsPath = join(dir, "resolution-actuals.jsonl");
    await writeFile(observationsPath, "", "utf8");
    await writeFile(previousRunsPath, [
      "openmeteo_gfs",
      "openmeteo_ecmwf",
      "openmeteo_ukmo"
    ].map((source) => JSON.stringify({
      id: `previous:${source}`,
      source,
      provider: source,
      model: source,
      collectedAt: "2026-07-07T00:00:00.000Z",
      targetKey: "station:HKO",
      targetKind: "resolution_station",
      resolutionStationId: "HKO",
      city: "Hong Kong",
      countryCode: "HK",
      date: "2026-07-06",
      measure: "temperature_high",
      leadDays: 1,
      ok: true,
      valueC: 20,
      hourlyCount: 24
    })).join("\n") + "\n", "utf8");
    await writeFile(resolutionActualsPath, `${JSON.stringify({
      id: "actual:hko:2026-07-06",
      source: "weather_resolution_actual",
      fetchedAt: "2026-07-07T00:00:00.000Z",
      marketSnapshotCapturedAt: "2026-07-07T00:00:00.000Z",
      eventSlug: "highest-temperature-in-hong-kong-on-july-6-2026",
      eventTitle: "Highest temperature in Hong Kong on July 6",
      city: "Hong Kong",
      date: "2026-07-06",
      measure: "temperature_high",
      resolutionStationId: "HKO",
      extremeC: { resolution: 22 },
      outcomes: [],
      warnings: [],
      errors: []
    })}\n`, "utf8");

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
      const model = url.searchParams.get("models");
      const maxTemp = model === "gfs_seamless" ? 30 : model === "ecmwf_ifs025" ? 31 : 32;
      return new Response(JSON.stringify({
        daily: {
          time: ["2026-07-08"],
          temperature_2m_max: [maxTemp],
          temperature_2m_min: [25],
          precipitation_sum: [0]
        },
        hourly: {
          time: [],
          temperature_2m: [],
          precipitation: []
        },
        current: {}
      }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }) as typeof fetch;

    try {
      const config = loadConfig({
        WEATHER_OBSERVATIONS_PATH: observationsPath,
        WEATHER_PREVIOUS_RUN_FORECASTS_PATH: previousRunsPath,
        WEATHER_RESOLUTION_ACTUALS_PATH: resolutionActualsPath
      });
      const group: WeatherMarketGroup = {
        eventSlug: "highest-temperature-in-hong-kong-on-july-8-2026",
        eventTitle: "Highest temperature in Hong Kong according to the Hong Kong Observatory",
        eventEndDate: "2026-07-08T16:00:00Z",
        city: "Hong Kong",
        date: "2026-07-08",
        measure: "temperature_high",
        markets: [{
          eventSlug: "highest-temperature-in-hong-kong-on-july-8-2026",
          eventTitle: "Highest temperature in Hong Kong according to the Hong Kong Observatory",
          eventEndDate: "2026-07-08T16:00:00Z",
          marketSlug: "highest-temperature-in-hong-kong-on-july-8-2026-33c",
          question: "Will the highest temperature in Hong Kong be 33°C according to the Hong Kong Observatory?",
          resolutionSource: "https://www.hko.gov.hk/en/wxinfo/ts/index.htm",
          active: true,
          closed: false,
          bestAsk: 0.2,
          outcomes: [{ outcome: "Yes", price: 0.2 }, { outcome: "No", price: 0.8 }],
          parsed: {
            city: "Hong Kong",
            date: "2026-07-08",
            measure: "temperature_high",
            outcome: {
              kind: "exact",
              label: "33C",
              unit: "C",
              lowerTempC: 32.5,
              upperTempC: 33.5,
              exactTempC: 33,
              rawValue: 33
            }
          }
        }],
        unparsed: []
      };

      const report = await priceWeatherMarketGroup(config, group, { minEdge: 0.05 });

      assert.equal(report.consensus?.calibration?.mode, "historical_residuals");
      assert.equal(report.consensus.calibration.targetKey, "station:HKO");
      assert.ok(report.consensus.calibration.measureSamples > 0);
      assert.ok(report.consensus.meanC > 32);
      assert.equal(report.climatology, undefined);
      assert.equal(report.outcomes[0].signal, "BUY_YES");
      assert.ok(report.outcomes[0].fairYes > 0.5);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
