import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  hkoAnnualDailyExtractUrl,
  hkoMonthlyDailyExtractUrl,
  noaaTimeseriesSynopticUrl,
  parseHkoDailyActualFromJson,
  parseNoaaTimeseriesDailyActualFromAviationMetars,
  parseNoaaTimeseriesDailyActualFromSynoptic,
  parseWeatherComHistoricalDailyActualFromJson,
  parseWundergroundDailyActualFromHtml,
  weatherComHistoricalObservationsUrl,
  wundergroundDailyHistoryUrl
} from "../src/weatherResolutionData.js";

describe("weather resolution actual helpers", () => {
  it("builds dated Wunderground history URLs from resolution sources", () => {
    assert.equal(
      wundergroundDailyHistoryUrl({
        raw: "https://www.wunderground.com/history/daily/us/ca/los-angeles/KLAX",
        provider: "wunderground",
        stationId: "KLAX",
        locationPath: "us/ca/los-angeles"
      }, "2026-07-04"),
      "https://www.wunderground.com/history/daily/us/ca/los-angeles/KLAX/date/2026-7-4"
    );
  });

  it("builds Weather.com historical observations URLs for Wunderground stations", () => {
    assert.equal(
      weatherComHistoricalObservationsUrl({
        raw: "https://www.wunderground.com/history/daily/us/ga/atlanta/KATL",
        provider: "wunderground",
        stationId: "katl",
        locationPath: "us/ga/atlanta"
      }, "2026-07-04"),
      "https://api.weather.com/v1/location/KATL:9:US/observations/historical.json?apiKey=e1f10a1e78da46f5b10a1e78da96f525&units=e&startDate=20260704&endDate=20260704"
    );

    assert.equal(
      weatherComHistoricalObservationsUrl({
        raw: "https://www.wunderground.com/history/daily/gb/london/EGLL",
        provider: "wunderground",
        stationId: "EGLL",
        locationPath: "gb/london"
      }, "2026-07-04"),
      "https://api.weather.com/v1/location/EGLL:9:GB/observations/historical.json?apiKey=e1f10a1e78da46f5b10a1e78da96f525&units=e&startDate=20260704&endDate=20260704"
    );
  });

  it("parses daily high and low from Weather.com historical observations", () => {
    const actual = parseWeatherComHistoricalDailyActualFromJson(JSON.stringify({
      observations: [
        { key: "KATL", valid_time_gmt: 1783123200, temp: 76, max_temp: 95, min_temp: 76 },
        { key: "KATL", valid_time_gmt: 1783166400, temp: 93 }
      ]
    }), {
      stationId: "KATL",
      date: "2026-07-04",
      url: "https://api.weather.com/v1/location/KATL:9:US/observations/historical.json",
      fetchedAt: "2026-07-05T00:00:00.000Z"
    });

    assert.equal(actual.ok, true);
    assert.equal(actual.provider, "wunderground");
    assert.equal(actual.rawUnit, "F");
    assert.ok(actual.maxTempC !== undefined && actual.maxTempC > 34.9 && actual.maxTempC < 35.1);
    assert.ok(actual.minTempC !== undefined && actual.minTempC > 24.3 && actual.minTempC < 24.5);
  });

  it("parses daily high and low from Wunderground-like JSON payloads", () => {
    const html = `
      <html>
        <script type="application/json">
          {
            "props": {
              "pageProps": {
                "history": {
                  "dailySummary": {
                    "imperial": {
                      "temperatureHigh": 75,
                      "temperatureLow": 62
                    }
                  }
                }
              }
            }
          }
        </script>
      </html>
    `;

    const actual = parseWundergroundDailyActualFromHtml(html, {
      stationId: "KLAX",
      date: "2026-07-04",
      url: "https://example.test",
      fetchedAt: "2026-07-05T00:00:00.000Z"
    });

    assert.equal(actual.ok, true);
    assert.equal(actual.rawUnit, "F");
    assert.ok(actual.maxTempC !== undefined && actual.maxTempC > 23.8 && actual.maxTempC < 24);
    assert.ok(actual.minTempC !== undefined && actual.minTempC > 16.6 && actual.minTempC < 16.8);
  });

  it("builds HKO daily extract URLs and parses exact HKO daily extract rows", () => {
    assert.equal(
      hkoMonthlyDailyExtractUrl("2026-07-05"),
      "https://www.weather.gov.hk/cis/dailyExtract/dailyExtract_202607.xml"
    );
    assert.equal(
      hkoAnnualDailyExtractUrl("2026-07-05"),
      "https://www.weather.gov.hk/cis/dailyExtract/dailyExtract_2026.xml"
    );

    const actual = parseHkoDailyActualFromJson(JSON.stringify({
      stn: {
        data: [{
          month: 7,
          dayData: [
            ["04", "1009.4", "32.6", "28.8", "27.2", "25.7", "84", "91", "12.8"],
            ["05", "1008.8", "33.0", "30.0", "27.7", "25.9", "79", "84", "4.5"]
          ]
        }]
      }
    }), {
      date: "2026-07-05",
      url: hkoMonthlyDailyExtractUrl("2026-07-05"),
      fetchedAt: "2026-07-06T00:00:00.000Z"
    });

    assert.equal(actual.ok, true);
    assert.equal(actual.provider, "hko");
    assert.equal(actual.maxTempC, 33);
    assert.equal(actual.minTempC, 27.7);
    assert.equal(actual.rawUnit, "C");
  });

  it("builds Weather.gov/Synoptic timeseries URLs and parses same-day station observations", () => {
    assert.equal(
      noaaTimeseriesSynopticUrl("ltfm", "2026-07-05"),
      "https://api.synopticdata.com/v2/stations/timeseries?STID=LTFM&showemptystations=1&start=202607050000&end=202607052359&complete=1&token=7c76618b66c74aee913bdbae4b448bdd&obtimezone=local"
    );

    const actual = parseNoaaTimeseriesDailyActualFromSynoptic(JSON.stringify({
      SUMMARY: { RESPONSE_MESSAGE: "OK" },
      STATION: [{
        STID: "LTFM",
        TIMEZONE: "Europe/Istanbul",
        OBSERVATIONS: {
          date_time: [
            "2026-07-04T23:50:00+0300",
            "2026-07-05T00:20:00+0300",
            "2026-07-05T13:20:00+0300",
            "2026-07-06T00:20:00+0300"
          ],
          air_temp_set_1: [20, 22, 31, 21]
        }
      }]
    }), {
      stationId: "LTFM",
      date: "2026-07-05",
      url: noaaTimeseriesSynopticUrl("LTFM", "2026-07-05"),
      fetchedAt: "2026-07-06T00:00:00.000Z"
    });

    assert.equal(actual.ok, true);
    assert.equal(actual.provider, "noaa_timeseries");
    assert.equal(actual.maxTempC, 31);
    assert.equal(actual.minTempC, 22);
  });

  it("parses AviationWeather METAR fallback observations by local station day", () => {
    const actual = parseNoaaTimeseriesDailyActualFromAviationMetars(JSON.stringify([
      { icaoId: "LTFM", reportTime: "2026-07-04T21:50:00.000Z", temp: 22 },
      { icaoId: "LTFM", reportTime: "2026-07-05T10:50:00.000Z", temp: 32 },
      { icaoId: "LTFM", reportTime: "2026-07-05T21:50:00.000Z", temp: 20 }
    ]), {
      stationId: "LTFM",
      date: "2026-07-05",
      url: "https://aviationweather.gov/api/data/metar?ids=LTFM&format=json&hours=72",
      fetchedAt: "2026-07-06T00:00:00.000Z",
      timezone: "Europe/Istanbul"
    });

    assert.equal(actual.ok, true);
    assert.equal(actual.maxTempC, 32);
    assert.equal(actual.minTempC, 22);
  });
});
