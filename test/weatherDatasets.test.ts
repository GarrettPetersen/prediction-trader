import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendJsonlRecordsUnique,
  buildWeatherForecastSnapshotRecords,
  buildWeatherMarketSnapshotRecords,
  buildWeatherObservationRecords,
  buildWeatherPreviousRunForecastRecords,
  readJsonlRecords,
  summarizeWeatherDatasets,
  type WeatherBacktestRunRecord,
  type WeatherResolutionActualRecord
} from "../src/weatherDatasets.js";
import type { WeatherMarketCandidate } from "../src/weatherMarkets.js";

describe("weather dataset stores", () => {
  it("builds durable NOAA observation records and dedupes appends", async () => {
    const dir = await mkdtemp(join(tmpdir(), "weather-datasets-"));
    const path = join(dir, "observations.jsonl");
    const records = buildWeatherObservationRecords({
      provider: "NOAA NCEI Climate Data Online",
      ok: true,
      location: {
        name: "Vancouver",
        countryCode: "CA",
        latitude: 49.2827,
        longitude: -123.1207
      },
      station: {
        id: "GHCND:CA001108446",
        name: "VANCOUVER INTL A",
        latitude: 49.18,
        longitude: -123.18,
        distanceKm: 12
      },
      daily: [{
        date: "2026-06-11",
        stationId: "GHCND:CA001108446",
        maxTempC: 19.6,
        minTempC: 11.8,
        precipitationMm: 0,
        raw: [{ datatype: "TMAX", value: 19.6 }]
      }]
    }, "2026-07-03T12:00:00.000Z");

    assert.equal(records[0].id, "noaa_ncei:GHCND:CA001108446:2026-06-11");

    const first = await appendJsonlRecordsUnique(path, records);
    const second = await appendJsonlRecordsUnique(path, records);
    const stored = await readJsonlRecords(path);

    assert.equal(first.appended, 1);
    assert.equal(second.appended, 0);
    assert.equal(second.skipped, 1);
    assert.equal(stored.length, 1);
  });

  it("builds market snapshots and summarizes weather dataset files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "weather-datasets-"));
    const observationsPath = join(dir, "observations.jsonl");
    const marketSnapshotsPath = join(dir, "markets.jsonl");
    const forecastSnapshotsPath = join(dir, "forecasts.jsonl");
    const previousRunForecastsPath = join(dir, "previous-runs.jsonl");
    const backtestRunsPath = join(dir, "runs.jsonl");
    const resolutionActualsPath = join(dir, "resolution-actuals.jsonl");
    const market: WeatherMarketCandidate = {
      eventSlug: "highest-temperature-in-london-on-july-4-2026",
      eventTitle: "Highest temperature in London on July 4?",
      eventEndDate: "2026-07-04T12:00:00Z",
      marketSlug: "london-20c",
      question: "Will the highest temperature in London be 20°C?",
      conditionId: "0xabc",
      active: true,
      closed: false,
      acceptingOrders: true,
      bestBid: 0.4,
      bestAsk: 0.45,
      liquidity: 100,
      volume: 50,
      outcomes: [
        { outcome: "Yes", tokenId: "yes-token", price: 0.44 },
        { outcome: "No", tokenId: "no-token", price: 0.56 }
      ],
      parsed: {
        city: "London",
        date: "2026-07-04",
        measure: "temperature_high",
        outcome: {
          kind: "exact",
          label: "20C",
          unit: "C",
          lowerTempC: 19.5,
          upperTempC: 20.5,
          exactTempC: 20,
          rawValue: 20
        }
      }
    };
    const snapshots = buildWeatherMarketSnapshotRecords([market], "2026-07-03T12:00:00.000Z");
    const forecasts = buildWeatherForecastSnapshotRecords({
      marketSnapshotCapturedAt: "2026-07-03T12:00:00.000Z",
      forecastCapturedAt: "2026-07-03T12:01:00.000Z",
      city: "London",
      countryCode: "GB",
      targets: [{ date: "2026-07-04", measure: "temperature_high" }],
      location: {
        name: "London",
        latitude: 51.5,
        longitude: -0.1,
        countryCode: "GB"
      },
      results: [{
        source: "openmeteo_gfs",
        provider: "Open-Meteo / NOAA NCEP GFS",
        ok: true,
        model: "gfs_seamless",
        daily: [{
          date: "2026-07-04",
          minTempC: 15,
          maxTempC: 22,
          precipitationMm: 0
        }]
      }, {
        source: "nws",
        provider: "U.S. National Weather Service",
        ok: false,
        skipped: true,
        note: "U.S.-only"
      }]
    });
    const previousRuns = buildWeatherPreviousRunForecastRecords({
      collectedAt: "2026-07-03T12:02:00.000Z",
      city: "London",
      countryCode: "GB",
      location: {
        name: "London",
        latitude: 51.5,
        longitude: -0.1,
        countryCode: "GB"
      },
      source: "openmeteo_gfs",
      provider: "Open-Meteo Previous Runs / NOAA NCEP GFS",
      model: "gfs_seamless",
      startDate: "2026-07-04",
      endDate: "2026-07-04",
      leadDays: [1],
      hourly: {
        time: ["2026-07-04T00:00", "2026-07-04T12:00", "2026-07-04T23:00"],
        temperature_2m_previous_day1: [15, 22, 17]
      }
    });
    const run: WeatherBacktestRunRecord = {
      id: "weatheredge:test",
      source: "weatheredge",
      runAt: "2026-07-03T12:05:00.000Z",
      targetDate: "2026-07-04",
      options: { date: "2026-07-04" },
      summary: {
        scannedGroups: 1,
        targetGroups: 1,
        pricedGroups: 1,
        erroredGroups: 0,
        marketCount: 1,
        rowCount: 1,
        signalCount: 0
      },
      rows: [],
      signals: [],
      errors: []
    };
    const resolutionActual: WeatherResolutionActualRecord = {
      id: "weather_resolution_actual:test",
      source: "weather_resolution_actual",
      fetchedAt: "2026-07-05T00:00:00.000Z",
      marketSnapshotCapturedAt: "2026-07-03T12:00:00.000Z",
      eventSlug: "highest-temperature-in-london-on-july-4-2026",
      eventTitle: "Highest temperature in London on July 4?",
      city: "London",
      date: "2026-07-04",
      measure: "temperature_high",
      resolutionStationId: "EGLL",
      timezone: "Europe/London",
      extremeC: {
        wunderground: 22,
        metar: 21.8,
        deltaMetarMinusWunderground: -0.2
      },
      outcomes: [{
        marketSlug: "london-20c",
        question: "Will the highest temperature in London be 20°C?",
        outcomeLabel: "20C",
        lowerTempC: 19.5,
        upperTempC: 20.5,
        wundergroundYes: false,
        metarYes: false
      }],
      warnings: [],
      errors: []
    };

    await appendJsonlRecordsUnique(observationsPath, [{
      id: "noaa_ncei:GHCND:TEST:2026-07-04",
      source: "noaa_ncei",
      provider: "NOAA NCEI Climate Data Online",
      fetchedAt: "2026-07-05T00:00:00.000Z",
      latitude: 51.5,
      longitude: -0.1,
      stationId: "GHCND:TEST",
      date: "2026-07-04",
      rawRecords: []
    }]);
    await appendJsonlRecordsUnique(marketSnapshotsPath, snapshots);
    await appendJsonlRecordsUnique(forecastSnapshotsPath, forecasts);
    await appendJsonlRecordsUnique(previousRunForecastsPath, previousRuns);
    await appendJsonlRecordsUnique(backtestRunsPath, [run]);
    await appendJsonlRecordsUnique(resolutionActualsPath, [resolutionActual]);

    const summary = await summarizeWeatherDatasets({
      observationsPath,
      marketSnapshotsPath,
      forecastSnapshotsPath,
      previousRunForecastsPath,
      backtestRunsPath,
      resolutionActualsPath
    });

    assert.equal(snapshots[0].tokens[0].tokenId, "yes-token");
    assert.equal(forecasts[0].valueC, 22);
    assert.equal(forecasts[1].skipped, true);
    assert.equal(previousRuns.length, 2);
    assert.equal(previousRuns.find((record) => record.measure === "temperature_high")?.valueC, 22);
    assert.equal(previousRuns.find((record) => record.measure === "temperature_low")?.valueC, 15);
    assert.equal(summary.observations.count, 1);
    assert.equal(summary.observations.firstDate, "2026-07-04");
    assert.equal(summary.marketSnapshots.distinctMarkets, 1);
    assert.deepEqual(summary.marketSnapshots.targetDates, ["2026-07-04"]);
    assert.equal(summary.forecastSnapshots.count, 2);
    assert.equal(summary.forecastSnapshots.distinctForecastKeys, 2);
    assert.deepEqual(summary.forecastSnapshots.sourceIds, ["nws", "openmeteo_gfs"]);
    assert.equal(summary.previousRunForecasts.count, 2);
    assert.deepEqual(summary.previousRunForecasts.leadDays, [1]);
    assert.equal(summary.backtestRuns.count, 1);
    assert.deepEqual(summary.backtestRuns.targetDates, ["2026-07-04"]);
    assert.equal(summary.resolutionActuals.count, 1);
    assert.equal(summary.resolutionActuals.distinctMarkets, 1);
    assert.deepEqual(summary.resolutionActuals.targetDates, ["2026-07-04"]);
  });
});
