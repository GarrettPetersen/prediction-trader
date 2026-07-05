import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseWundergroundDailyActualFromHtml,
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
});
