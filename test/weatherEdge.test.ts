import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  fahrenheitToCelsius,
  looksLikeHongKongLocation,
  normalizeNoaaDailySummaries,
  normalizeOpenMeteoDaily,
  normalizeOpenMeteoHourly,
  parseWeatherSourceIds,
  selectBestNoaaStation
} from "../src/weatherEdge.js";

describe("weather edge source helpers", () => {
  it("parses weather source lists", () => {
    assert.deepEqual(parseWeatherSourceIds([]), [
      "openmeteo_gfs",
      "openmeteo_ecmwf",
      "openmeteo_ukmo",
      "nws",
      "hko",
      "noaa_ncei"
    ]);
    assert.deepEqual(parseWeatherSourceIds(["openmeteo_gfs", "nws"]), ["openmeteo_gfs", "nws"]);
    assert.throws(() => parseWeatherSourceIds(["bogus"]), /Unknown weather source/);
  });

  it("normalizes Open-Meteo daily and hourly arrays", () => {
    const raw = {
      daily: {
        time: ["2026-07-03", "2026-07-04"],
        temperature_2m_max: [23.4, 25.1],
        temperature_2m_min: [13.2, 14.7],
        precipitation_sum: [0, 1.4]
      },
      hourly: {
        time: ["2026-07-03T00:00", "2026-07-03T01:00"],
        temperature_2m: [17.1, 16.8],
        precipitation: [0, 0.1],
        precipitation_probability: [10, 20]
      }
    };

    assert.deepEqual(normalizeOpenMeteoDaily(raw), [
      {
        date: "2026-07-03",
        minTempC: 13.2,
        maxTempC: 23.4,
        precipitationMm: 0
      },
      {
        date: "2026-07-04",
        minTempC: 14.7,
        maxTempC: 25.1,
        precipitationMm: 1.4
      }
    ]);
    assert.deepEqual(normalizeOpenMeteoHourly(raw), [
      {
        time: "2026-07-03T00:00",
        tempC: 17.1,
        precipitationMm: 0,
        precipitationProbabilityPct: 10
      },
      {
        time: "2026-07-03T01:00",
        tempC: 16.8,
        precipitationMm: 0.1,
        precipitationProbabilityPct: 20
      }
    ]);
  });

  it("handles temperature conversion and Hong Kong targeting", () => {
    assert.equal(fahrenheitToCelsius(68), 20);
    assert.equal(looksLikeHongKongLocation({
      name: "Hong Kong",
      latitude: 22.3193,
      longitude: 114.1694
    }), true);
    assert.equal(looksLikeHongKongLocation({
      name: "Vancouver",
      countryCode: "CA",
      latitude: 49.2827,
      longitude: -123.1207
    }), false);
  });

  it("selects a nearby NOAA station with useful date coverage", () => {
    const location = {
      name: "Vancouver",
      latitude: 49.24966,
      longitude: -123.11934
    };
    const station = selectBestNoaaStation([
      {
        id: "STALE_NEARBY",
        latitude: 49.25,
        longitude: -123.12,
        maxdate: "2020-01-01"
      },
      {
        id: "FRESH_CLOSE",
        latitude: 49.3,
        longitude: -123.1,
        maxdate: "2026-06-30"
      },
      {
        id: "FRESH_FAR",
        latitude: 48.8,
        longitude: -122.5,
        maxdate: "2026-06-30"
      }
    ], location, "2026-07-03");

    assert.equal(station?.id, "FRESH_CLOSE");
    assert.ok((station?.distanceKm ?? 0) > 0);
  });

  it("normalizes NOAA CDO daily summaries", () => {
    assert.deepEqual(normalizeNoaaDailySummaries([
      {
        date: "2026-06-11T00:00:00",
        datatype: "TMAX",
        station: "GHCND:TEST",
        value: 19.6
      },
      {
        date: "2026-06-11T00:00:00",
        datatype: "TMIN",
        station: "GHCND:TEST",
        value: 11.8
      },
      {
        date: "2026-06-11T00:00:00",
        datatype: "PRCP",
        station: "GHCND:TEST",
        value: 0
      }
    ]), [
      {
        date: "2026-06-11",
        stationId: "GHCND:TEST",
        maxTempC: 19.6,
        minTempC: 11.8,
        precipitationMm: 0,
        raw: [
          {
            date: "2026-06-11T00:00:00",
            datatype: "TMAX",
            station: "GHCND:TEST",
            value: 19.6
          },
          {
            date: "2026-06-11T00:00:00",
            datatype: "TMIN",
            station: "GHCND:TEST",
            value: 11.8
          },
          {
            date: "2026-06-11T00:00:00",
            datatype: "PRCP",
            station: "GHCND:TEST",
            value: 0
          }
        ]
      }
    ]);
  });
});
