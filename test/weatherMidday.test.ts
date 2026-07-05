import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildMiddayConsensus,
  calculateMiddaySigmaC,
  parseAviationMetars,
  partialDayProbabilityInRange,
  summarizeStationObservations,
  vistadexEventToWeatherGroups,
  type MiddayWeatherConsensus
} from "../src/weatherMidday.js";

function highConsensus(observedExtremeC: number, forecastExtremeMeanC: number, sigmaC = 1): MiddayWeatherConsensus {
  return {
    measure: "temperature_high",
    targetDate: "2026-07-04",
    stationId: "KXYZ",
    timezone: "America/New_York",
    observedExtremeC,
    forecastExtremeMeanC,
    finalMeanC: Math.max(observedExtremeC, forecastExtremeMeanC),
    sigmaC,
    modelStdDevC: 0,
    remainingHourCount: 4,
    forecastPoints: [],
    observation: {
      stationId: "KXYZ",
      timezone: "America/New_York",
      targetDate: "2026-07-04",
      observationCount: 1,
      highSoFarC: observedExtremeC,
      lowSoFarC: observedExtremeC,
      observations: []
    }
  };
}

function lowConsensus(observedExtremeC: number, forecastExtremeMeanC: number, sigmaC = 1): MiddayWeatherConsensus {
  return {
    ...highConsensus(observedExtremeC, forecastExtremeMeanC, sigmaC),
    measure: "temperature_low",
    finalMeanC: Math.min(observedExtremeC, forecastExtremeMeanC)
  };
}

function completeDay(consensus: MiddayWeatherConsensus): MiddayWeatherConsensus {
  return {
    ...consensus,
    remainingHourCount: 0
  };
}

describe("weather midday conditional probabilities", () => {
  it("marks a high-temperature range impossible after the observed high crosses the upper edge", () => {
    const probability = partialDayProbabilityInRange(highConsensus(36, 35, 0.5), 34, 35);

    assert.equal(probability, 0);
  });

  it("keeps a high-temperature range alive while the observed high is inside the bin", () => {
    const probability = partialDayProbabilityInRange(highConsensus(34.5, 34.8, 0.4), 34, 35);

    assert.ok(probability > 0.68);
    assert.ok(probability < 0.7);
  });

  it("uses the remaining forecast distribution when the high has not reached the bin", () => {
    const probability = partialDayProbabilityInRange(highConsensus(32, 34.5, 0.5), 34, 35);

    assert.ok(probability > 0.68);
    assert.ok(probability < 0.69);
  });

  it("marks a low-temperature range impossible after the observed low crosses below it", () => {
    const probability = partialDayProbabilityInRange(lowConsensus(14, 15, 0.5), 15, 16);

    assert.equal(probability, 0);
  });

  it("keeps a low-temperature range alive while the observed low is inside the bin", () => {
    const probability = partialDayProbabilityInRange(lowConsensus(15.5, 15.3, 0.4), 15, 16);

    assert.ok(probability > 0.77);
    assert.ok(probability < 0.78);
  });

  it("locks a complete high-temperature day from the observed high", () => {
    assert.equal(partialDayProbabilityInRange(completeDay(highConsensus(34.5, 40, 0.4)), 34, 35), 1);
    assert.equal(partialDayProbabilityInRange(completeDay(highConsensus(33.5, 40, 0.4)), 34, 35), 0);
  });

  it("locks a complete low-temperature day from the observed low", () => {
    assert.equal(partialDayProbabilityInRange(completeDay(lowConsensus(15.5, 10, 0.4)), 15, 16), 1);
    assert.equal(partialDayProbabilityInRange(completeDay(lowConsensus(16.5, 10, 0.4)), 15, 16), 0);
  });
});

describe("weather midday observations", () => {
  it("parses AviationWeather METAR JSON and summarizes a station day", () => {
    const observations = parseAviationMetars([
      { icaoId: "KXYZ", reportTime: "2026-07-04T16:00:00.000Z", temp: 30 },
      { icaoId: "KXYZ", reportTime: "2026-07-04T17:00:00.000Z", temp: 32 },
      { icaoId: "KXYZ", reportTime: "2026-07-05T05:00:00.000Z", temp: 20 }
    ]);
    const summary = summarizeStationObservations("KXYZ", "UTC", "2026-07-04", observations);

    assert.equal(summary.observationCount, 2);
    assert.equal(summary.highSoFarC, 32);
    assert.equal(summary.lowSoFarC, 30);
    assert.equal(summary.latestObservedAt, "2026-07-04T17:00:00.000Z");
  });

  it("builds a same-day consensus from remaining hourly forecasts", () => {
    const observation = summarizeStationObservations("KXYZ", "UTC", "2026-07-04", parseAviationMetars([
      { icaoId: "KXYZ", reportTime: "2026-07-04T15:00:00.000Z", temp: 31 }
    ]));
    const consensus = buildMiddayConsensus({
      measure: "temperature_high",
      targetDate: "2026-07-04",
      stationId: "KXYZ",
      timezone: "UTC",
      observation,
      now: new Date("2026-07-04T16:30:00.000Z"),
      sourceResults: [
        {
          source: "openmeteo_gfs",
          provider: "GFS",
          ok: true,
          hourly: [
            { time: "2026-07-04T15:00", tempC: 31 },
            { time: "2026-07-04T17:00", tempC: 33 },
            { time: "2026-07-04T18:00", tempC: 34 }
          ]
        },
        {
          source: "openmeteo_ecmwf",
          provider: "ECMWF",
          ok: true,
          hourly: [
            { time: "2026-07-04T17:00", tempC: 35 }
          ]
        }
      ]
    });

    assert.equal(consensus.observedExtremeC, 31);
    assert.ok(consensus.forecastExtremeMeanC > 34);
    assert.equal(consensus.remainingHourCount, 2);
    assert.equal(consensus.forecastPoints.length, 2);
  });

  it("uses daily-only HKO forecasts when hourly points are unavailable", () => {
    const observation = summarizeStationObservations("HKO", "Asia/Hong_Kong", "2026-07-05", [
      { stationId: "HKO", observedAt: "2026-07-05T03:00:00.000Z", tempC: 30 }
    ]);
    const consensus = buildMiddayConsensus({
      measure: "temperature_high",
      targetDate: "2026-07-05",
      stationId: "HKO",
      timezone: "Asia/Hong_Kong",
      observation,
      now: new Date("2026-07-05T04:00:00.000Z"),
      sourceResults: [
        {
          source: "hko",
          provider: "Hong Kong Observatory",
          ok: true,
          daily: [
            { date: "2026-07-05", minTempC: 28, maxTempC: 34 }
          ]
        }
      ]
    });

    assert.equal(consensus.forecastPoints.length, 1);
    assert.equal(consensus.forecastPoints[0].source, "hko");
    assert.equal(consensus.forecastExtremeMeanC, 34);
    assert.equal(consensus.finalMeanC, 34);
    assert.equal(consensus.remainingHourCount, 12);
  });

  it("shrinks sigma when no hours remain", () => {
    assert.equal(calculateMiddaySigmaC(0, 3, 0), 0.2);
  });
});

describe("weather midday Vistadex parsing", () => {
  it("turns a Vistadex event payload into a weather group", () => {
    const groups = vistadexEventToWeatherGroups({
      event: {
        slug: "highest-temperature-in-houston-on-july-4-2026",
        title: "Highest temperature in Houston on July 4?",
        end_date: "2026-07-04T12:00:00+00:00"
      },
      markets: [
        {
          metadata: {
            question: "Will the highest temperature in Houston be between 94-95°F on July 4?",
            slug: "highest-temperature-in-houston-on-july-4-2026-94-95f",
            condition_id: "0xabc",
            resolution_source: "https://www.wunderground.com/history/daily/us/tx/houston/KHOU",
            outcomes: ["Yes", "No"],
            active: true,
            closed: false,
            accepting_orders: true,
            end_date: "2026-07-04T12:00:00+00:00"
          },
          stats: {
            outcome_prices: [0.2, 0.8],
            best_bid: 0.18,
            best_ask: 0.22,
            liquidity: 100
          }
        }
      ]
    });

    assert.equal(groups.length, 1);
    assert.equal(groups[0].eventSlug, "highest-temperature-in-houston-on-july-4-2026");
    assert.equal(groups[0].markets[0].conditionId, "0xabc");
    assert.equal(groups[0].markets[0].parsed.outcome.label, "94-95F");
  });
});
