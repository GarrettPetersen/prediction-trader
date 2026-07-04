import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  calculateBaseSigma,
  probabilityInRange,
  resolvePricingForecastTarget
} from "../src/weatherPricing.js";
import type { AppConfig } from "../src/config.js";
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
});
