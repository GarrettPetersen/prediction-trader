import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseResolutionSource } from "../src/weatherStations.js";

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
});
