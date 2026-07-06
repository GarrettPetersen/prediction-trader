import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseResolutionSource,
  resolutionSourceFromText
} from "../src/weatherStations.js";

describe("weather resolution audit helpers", () => {
  it("parses Wunderground station resolution sources", () => {
    assert.deepEqual(
      parseResolutionSource("https://www.wunderground.com/history/daily/us/ca/los-angeles/KLAX"),
      {
        raw: "https://www.wunderground.com/history/daily/us/ca/los-angeles/KLAX",
        provider: "wunderground",
        stationId: "KLAX",
        locationPath: "us/ca/los-angeles"
      }
    );
  });

  it("marks missing and unsupported resolution sources", () => {
    assert.deepEqual(parseResolutionSource(undefined), { provider: "missing" });
    assert.equal(parseResolutionSource("https://example.com/rules").provider, "unknown");
  });

  it("parses NOAA timeseries station resolution sources", () => {
    assert.deepEqual(
      parseResolutionSource("https://www.weather.gov/wrh/timeseries?site=ltfm"),
      {
        raw: "https://www.weather.gov/wrh/timeseries?site=ltfm",
        provider: "noaa_timeseries",
        stationId: "LTFM"
      }
    );
  });

  it("derives source URLs from market rule text", () => {
    assert.equal(
      resolutionSourceFromText(
        "The resolution source is available here: https://www.weather.gov/wrh/timeseries?site=uuww"
      ),
      "https://www.weather.gov/wrh/timeseries?site=UUWW"
    );
    assert.equal(
      resolutionSourceFromText("Daily Extract: https://www.weather.gov.hk/en/cis/climat.htm"),
      "https://www.weather.gov.hk/en/cis/climat.htm"
    );
  });
});
