import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeKalshiWeatherMarket,
  parseKalshiWeatherSeries,
  parseWeatherMarketQuestion
} from "../src/weatherMarkets.js";
import {
  parseResolutionSource,
  resolutionSourceFromText,
  resolutionSourcesMatch
} from "../src/weatherStations.js";

describe("weather market parsing", () => {
  it("parses exact city high-temperature bins", () => {
    const parsed = parseWeatherMarketQuestion(
      "Will the highest temperature in Istanbul be 31°C on July 3?",
      "2026-07-03T12:00:00Z"
    );

    assert.equal(parsed?.city, "Istanbul");
    assert.equal(parsed?.date, "2026-07-03");
    assert.equal(parsed?.measure, "temperature_high");
    assert.equal(parsed?.outcome.kind, "exact");
    assert.equal(parsed?.outcome.lowerTempC, 30.5);
    assert.equal(parsed?.outcome.upperTempC, 31.5);
  });

  it("parses or-below and fahrenheit outcomes", () => {
    const parsed = parseWeatherMarketQuestion(
      "Will the highest temperature in New York be 80°F or below on July 4?",
      "2026-07-04T12:00:00Z"
    );

    assert.equal(parsed?.city, "New York");
    assert.equal(parsed?.outcome.kind, "or_below");
    assert.equal(parsed?.outcome.unit, "F");
    assert.ok((parsed?.outcome.upperTempC ?? 0) > 26);
    assert.ok((parsed?.outcome.upperTempC ?? 0) < 27.1);
  });

  it("parses hyphenated fahrenheit ranges", () => {
    const parsed = parseWeatherMarketQuestion(
      "Will the lowest temperature in Miami be between 78-79°F on July 4?",
      "2026-07-04T12:00:00Z"
    );

    assert.equal(parsed?.city, "Miami");
    assert.equal(parsed?.measure, "temperature_low");
    assert.equal(parsed?.outcome.kind, "range");
    assert.equal(parsed?.outcome.unit, "F");
    assert.ok((parsed?.outcome.lowerTempC ?? 0) > 25.2);
    assert.ok((parsed?.outcome.upperTempC ?? 0) < 27);
  });

  it("parses or-higher tail outcomes", () => {
    const parsed = parseWeatherMarketQuestion(
      "Will the highest temperature in Jeddah be 39°C or higher on July 5?",
      "2026-07-05T12:00:00Z"
    );

    assert.equal(parsed?.city, "Jeddah");
    assert.equal(parsed?.outcome.kind, "or_above");
    assert.equal(parsed?.outcome.lowerTempC, 38.5);
  });

  it("skips unsupported non-city weather markets", () => {
    assert.equal(parseWeatherMarketQuestion(
      "Will global temperature increase by between 1.10ºC and 1.14ºC in June 2026?",
      "2026-06-30T00:00:00Z"
    ), undefined);
  });

  it("identifies Kalshi daily high and low city series", () => {
    assert.deepEqual(parseKalshiWeatherSeries({
      ticker: "KXHIGHNY",
      title: "Highest temperature in NYC"
    }), {
      city: "New York City",
      measure: "temperature_high"
    });
    assert.deepEqual(parseKalshiWeatherSeries({
      ticker: "KXLOWMIA",
      title: "Miami Low Temperature Daily"
    }), {
      city: "Miami",
      measure: "temperature_low"
    });
  });

  it("normalizes Kalshi ranges, books, and exact NWS settlement sources", () => {
    const source = "https://forecast.weather.gov/product.php?site=OKX&product=CLI&issuedby=NYC";
    const market = normalizeKalshiWeatherMarket({
      ticker: "KXHIGHNY",
      title: "Highest temperature in NYC",
      settlement_sources: [{ name: "NWS", url: source }]
    }, {
      ticker: "KXHIGHNY-26JUL17-B89.5",
      event_ticker: "KXHIGHNY-26JUL17",
      title: "Will the high temp in Central Park be 89-90 degrees on Jul 17, 2026?",
      rules_primary: "The highest temperature observed in Central Park for Jul 17, 2026 will be between 89 and 90 degrees Fahrenheit.",
      status: "open",
      close_time: "2026-07-18T03:59:00Z",
      yes_bid_dollars: "0.4100",
      yes_ask_dollars: "0.4300",
      no_bid_dollars: "0.5700",
      no_ask_dollars: "0.5900",
      last_price_dollars: "0.3900",
      liquidity_dollars: "123.45",
      volume_fp: "88.00"
    });

    assert.equal(market?.referencePlatform, "kalshi");
    assert.equal(market?.eventSlug, "kxhighny-26jul17");
    assert.equal(market?.parsed.date, "2026-07-17");
    assert.equal(market?.parsed.outcome.kind, "range");
    assert.ok(Math.abs((market?.parsed.outcome.lowerTempC ?? 0) - 31.3888889) < 1e-6);
    assert.ok(Math.abs((market?.parsed.outcome.upperTempC ?? 0) - 32.5) < 1e-6);
    assert.equal(market?.resolutionSource, source);
    assert.equal(market?.outcomes[0].price, 0.42);
    assert.equal(market?.outcomes[1].bestAsk, 0.59);
  });

  it("treats Kalshi zero book fields as absent quotes", () => {
    const market = normalizeKalshiWeatherMarket({
      ticker: "KXHIGHNY",
      title: "Highest temperature in NYC",
      settlement_sources: [{
        url: "https://forecast.weather.gov/product.php?site=OKX&product=CLI&issuedby=NYC"
      }]
    }, {
      ticker: "KXHIGHNY-26JUL17-T98",
      event_ticker: "KXHIGHNY-26JUL17",
      title: "Will the high temp be above 98 on Jul 17, 2026?",
      rules_primary: "The highest temperature for Jul 17, 2026 will be greater than 98 degrees Fahrenheit.",
      status: "open",
      yes_bid_dollars: "0.0000",
      yes_ask_dollars: "0.0000",
      no_bid_dollars: "0.9700",
      no_ask_dollars: "0.9900"
    });

    assert.equal(market?.outcomes[0].bestBid, undefined);
    assert.equal(market?.outcomes[0].bestAsk, undefined);
    assert.equal(market?.parsed.outcome.kind, "or_above");
    assert.equal(market?.parsed.outcome.rawValue, 99);
  });

  it("fails loudly when a Kalshi weather series lacks its supported settlement feed", () => {
    assert.throws(() => normalizeKalshiWeatherMarket({
      ticker: "KXHIGHNY",
      title: "Highest temperature in NYC",
      settlement_sources: [{ url: "https://example.com/weather" }]
    }, {
      ticker: "KXHIGHNY-26JUL17-T98",
      event_ticker: "KXHIGHNY-26JUL17",
      title: "Will the high temp be above 98 on Jul 17, 2026?",
      rules_primary: "The highest temperature for Jul 17, 2026 will be greater than 98 degrees Fahrenheit.",
      status: "open"
    }), /does not expose a supported NWS CLI settlement source/);
  });

  it("parses and compares NWS CLI source identities", () => {
    const source = "https://forecast.weather.gov/product.php?site=OKX&product=CLI&issuedby=nyc";
    const extracted = resolutionSourceFromText(`Resolution source: ${source}`);

    assert.equal(parseResolutionSource(extracted).provider, "nws_cli");
    assert.equal(parseResolutionSource(extracted).stationId, "KNYC");
    assert.equal(resolutionSourcesMatch(source, "https://forecast.weather.gov/product.php?product=CLI&issuedby=NYC"), true);
    assert.equal(resolutionSourcesMatch(source, "https://forecast.weather.gov/product.php?product=CLI&issuedby=LAX"), false);
  });

  it("ignores sentence punctuation after a resolution URL", () => {
    const source = "https://www.wunderground.com/history/daily/us/ca/los-angeles/KLAX";

    assert.equal(resolutionSourceFromText(`Resolution source: ${source}.`), source);
    assert.equal(resolutionSourcesMatch(source, `${source}.`), true);
  });
});
