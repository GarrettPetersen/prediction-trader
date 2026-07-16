import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildWeatherEdgeRows,
  filterWeatherGroupsForDate,
  localIsoDateDaysFrom
} from "../src/weatherEdges.js";
import type { WeatherMarketGroup } from "../src/weatherMarkets.js";
import type { WeatherPricingReport } from "../src/weatherPricing.js";

function parsedLondonOutcome(rawValue: number) {
  return {
    city: "London",
    date: "2026-07-04",
    measure: "temperature_high" as const,
    outcome: {
      kind: "exact" as const,
      label: `${rawValue}C`,
      unit: "C" as const,
      lowerTempC: rawValue - 0.5,
      upperTempC: rawValue + 0.5,
      exactTempC: rawValue,
      rawValue
    }
  };
}

function group(date: string, city: string): WeatherMarketGroup {
  return {
    eventSlug: `highest-temperature-in-${city.toLowerCase()}-on-${date}`,
    eventTitle: `Highest temperature in ${city}?`,
    eventEndDate: `${date}T12:00:00Z`,
    city,
    date,
    measure: "temperature_high",
    markets: [{
      eventSlug: `highest-temperature-in-${city.toLowerCase()}-on-${date}`,
      eventTitle: `Highest temperature in ${city}?`,
      eventEndDate: `${date}T12:00:00Z`,
      marketSlug: `${city.toLowerCase()}-20c`,
      question: `Will the highest temperature in ${city} be 20°C?`,
      active: true,
      closed: false,
      liquidity: 100,
      volume: 50,
      outcomes: [],
      parsed: {
        city,
        date,
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
    }],
    unparsed: []
  };
}

describe("weather edge reports", () => {
  it("formats local dates by day offset", () => {
    assert.equal(localIsoDateDaysFrom(new Date(2026, 6, 3, 13), 1), "2026-07-04");
  });

  it("filters weather groups to the target date", () => {
    const groups = [
      group("2026-07-05", "Paris"),
      group("2026-07-04", "London"),
      group("2026-07-04", "Amsterdam")
    ];

    assert.deepEqual(
      filterWeatherGroupsForDate(groups, "2026-07-04").map((item) => item.city),
      ["Amsterdam", "London"]
    );
  });

  it("builds ranked edge rows with market metadata", () => {
    const report: WeatherPricingReport = {
      group: {
        eventSlug: "highest-temperature-in-london-on-july-4-2026",
        eventTitle: "Highest temperature in London on July 4?",
        eventEndDate: "2026-07-04T12:00:00Z",
        city: "London",
        date: "2026-07-04",
        measure: "temperature_high",
        marketCount: 2
      },
      markets: [
        { marketSlug: "london-20c", liquidity: 200, volume: 30, parsed: parsedLondonOutcome(20) },
        { marketSlug: "london-21c", liquidity: 100, volume: 20, parsed: parsedLondonOutcome(21) }
      ],
      location: {
        name: "London",
        latitude: 51.5,
        longitude: -0.1,
        timezone: "Europe/London"
      },
      sources: [],
      outcomes: [
        {
          marketSlug: "london-20c",
          question: "Will the highest temperature in London be 20°C?",
          outcomeLabel: "20C",
          fairYes: 0.6,
          fairNo: 0.4,
          yesAsk: 0.55,
          noAsk: 0.5,
          yesEdge: 0.05,
          noEdge: -0.1,
          signal: "BUY_YES",
          strategy: "forecast_edge",
          edge: 0.05,
          confidence: "HIGH",
          kellyFraction: 0.02,
          reason: "test"
        },
        {
          marketSlug: "london-21c",
          question: "Will the highest temperature in London be 21°C?",
          outcomeLabel: "21C",
          fairYes: 0.1,
          fairNo: 0.9,
          yesAsk: 0.3,
          noAsk: 0.7,
          yesEdge: -0.2,
          noEdge: 0.2,
          signal: "BUY_NO",
          strategy: "forecast_edge",
          edge: 0.2,
          confidence: "MEDIUM",
          kellyFraction: 0.03,
          reason: "test"
        }
      ],
      errors: []
    };

    const rows = buildWeatherEdgeRows([report]);

    assert.equal(rows[0].marketSlug, "london-21c");
    assert.equal(rows[0].bestSide, "NO");
    assert.equal(rows[0].liquidity, 100);
    assert.equal(rows[1].bestSide, "YES");
  });

  it("suppresses day-ahead signals when the local market day has started", () => {
    const report: WeatherPricingReport = {
      group: {
        eventSlug: "highest-temperature-in-london-on-july-4-2026",
        eventTitle: "Highest temperature in London on July 4?",
        eventEndDate: "2026-07-04T12:00:00Z",
        city: "London",
        date: "2026-07-04",
        measure: "temperature_high",
        marketCount: 1
      },
      markets: [{ marketSlug: "london-20c", liquidity: 200, volume: 30, parsed: parsedLondonOutcome(20) }],
      location: {
        name: "London",
        latitude: 51.5,
        longitude: -0.1,
        timezone: "Europe/London"
      },
      sources: [],
      tradingWindow: {
        safeToTrade: false,
        status: "local_day_started",
        timezone: "Europe/London",
        localDate: "2026-07-04",
        localTime: "13:00",
        minutesAfterLocalMidnight: 780,
        graceMinutes: 120,
        reason: "Target date has started locally."
      },
      outcomes: [{
        marketSlug: "london-20c",
        question: "Will the highest temperature in London be 20°C?",
        outcomeLabel: "20C",
        fairYes: 0.6,
        fairNo: 0.4,
        yesAsk: 0.55,
        yesEdge: 0.05,
            signal: "BUY_YES",
            strategy: "forecast_edge",
        edge: 0.05,
        confidence: "HIGH",
        kellyFraction: 0.02,
        suggestedSizeUsd: 5,
        price: 0.55,
        reason: "test"
      }],
      errors: []
    };

    const [row] = buildWeatherEdgeRows([report]);

    assert.equal(row.signal, "SKIP");
    assert.equal(row.kellyFraction, 0);
    assert.equal(row.suggestedSizeUsd, undefined);
    assert.match(row.reason, /weather:midday/);
  });
});
