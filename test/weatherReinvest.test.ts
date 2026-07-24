import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  assertCompleteWeatherEdgeReport,
  buildWeatherVenueRoutes,
  isRetryableVistadexTransientError,
  requireReinvestEntryWindows,
  requireReinvestPricingStrategy,
  requireVistadexEventMarkets,
  selectBestWeatherVenueQuote,
  weatherHybridLaneBudgets,
  weatherReinvestEntryWindow,
  weatherReinvestExecutionFailures
} from "../src/weatherReinvest.js";
import {
  isRetryableNetworkError,
  retryDelayMs,
  retryTransient
} from "../src/retry.js";
import type { WeatherEdgeRow } from "../src/weatherEdges.js";

function venueRow(overrides: Partial<WeatherEdgeRow> = {}): WeatherEdgeRow {
  return {
    referencePlatform: "polymarket",
    eventSlug: "highest-temperature-in-new-york-on-july-17-2026",
    eventTitle: "Highest temperature in New York",
    city: "New York",
    date: "2026-07-17",
    measure: "temperature_high",
    marketSlug: "new-york-89-90f",
    question: "Will the highest temperature in New York be between 89-90F?",
    outcomeLabel: "89-90F",
    outcomeKind: "range",
    outcomeUnit: "F",
    lowerTempC: 31.3888888889,
    upperTempC: 32.5,
    bestSide: "YES",
    signal: "BUY_YES",
    fairYes: 0.6,
    fairNo: 0.4,
    bestEdge: 0.15,
    confidence: "HIGH",
    kellyFraction: 0.05,
    suggestedSizeUsd: 5,
    strategy: "forecast_edge",
    forecastTargetMatched: true,
    forecastStationId: "KNYC",
    modelMode: "historical_residuals",
    reason: "test",
    ...overrides
  };
}

describe("WeatherEdge Vistadex execution retry helpers", () => {
  it("treats an event shell without markets as an explicit transient state", () => {
    assert.throws(
      () => requireVistadexEventMarkets({ event: { slug: "kxhighny-26jul17" }, markets: [] }, "kxhighny-26jul17"),
      /still being created: no markets are available yet/
    );
    assert.equal(
      isRetryableVistadexTransientError(
        new Error('Vistadex event "kxhighny-26jul17" is still being created: no markets are available yet.')
      ),
      true
    );
    assert.deepEqual(requireVistadexEventMarkets({ markets: [{ market: {} }] }, "kxhighny-26jul17"), [{ market: {} }]);
  });

  it("refuses to trade from a partial venue pricing scan", () => {
    assert.doesNotThrow(() => assertCompleteWeatherEdgeReport({ erroredGroups: 0, errors: [] }));
    assert.throws(
      () => assertCompleteWeatherEdgeReport({
        erroredGroups: 1,
        errors: [{
          eventSlug: "kxhighny-26jul17",
          city: "New York",
          date: "2026-07-17",
          error: "Kalshi market source did not match the configured station."
        }]
      }),
      /refusing to route against an incomplete Polymarket\/Kalshi comparison/
    );
  });

  it("groups equivalent Kalshi and Polymarket contracts into one quote route", () => {
    const polymarket = venueRow();
    const kalshi = venueRow({
      referencePlatform: "kalshi",
      eventSlug: "kxhighny-26jul17",
      marketSlug: "kxhighny-26jul17-b89.5"
    });

    const routes = buildWeatherVenueRoutes([polymarket, kalshi]);

    assert.equal(routes.length, 1);
    assert.deepEqual(routes[0].candidates.map((row) => row.referencePlatform).sort(), ["kalshi", "polymarket"]);
  });

  it("suppresses a weaker venue signal that would bet the opposite side", () => {
    const routes = buildWeatherVenueRoutes([
      venueRow({ bestEdge: 0.2 }),
      venueRow({
        referencePlatform: "kalshi",
        eventSlug: "kxhighny-26jul17",
        marketSlug: "kxhighny-26jul17-b89.5",
        bestSide: "NO",
        signal: "BUY_NO",
        bestEdge: 0.1
      })
    ]);

    assert.equal(routes[0].candidates.length, 2);
    assert.equal(routes[0].candidates[0].referencePlatform, "polymarket");
    assert.deepEqual(routes[0].candidates.map((row) => row.bestSide), ["YES", "YES"]);
    assert.equal(routes[0].suppressed[0].referencePlatform, "kalshi");
  });

  it("quotes an equivalent venue even when its snapshot did not emit a signal", () => {
    const routes = buildWeatherVenueRoutes([
      venueRow(),
      venueRow({
        referencePlatform: "kalshi",
        eventSlug: "kxhighny-26jul17",
        marketSlug: "kxhighny-26jul17-b89.5",
        bestSide: "NO",
        signal: "SKIP",
        suggestedSizeUsd: undefined,
        kellyFraction: 0,
        fairYes: 0.55,
        fairNo: 0.45
      })
    ]);

    assert.equal(routes.length, 1);
    assert.equal(routes[0].candidates.length, 2);
    assert.equal(routes[0].candidates[1].referencePlatform, "kalshi");
    assert.equal(routes[0].candidates[1].bestSide, "YES");
    assert.equal(routes[0].candidates[1].fairYes, 0.6);
    assert.equal(routes[0].candidates[1].suggestedSizeUsd, 5);
  });

  it("selects the venue with the strongest executable edge", () => {
    const polymarket = venueRow();
    const kalshi = venueRow({ referencePlatform: "kalshi", eventSlug: "kxhighny-26jul17" });
    const selected = selectBestWeatherVenueQuote([
      { row: polymarket, fairPrice: 0.6, pricePerShare: 0.52, value: "polymarket" },
      { row: kalshi, fairPrice: 0.6, pricePerShare: 0.47, value: "kalshi" }
    ]);

    assert.equal(selected?.value, "kalshi");
  });

  it("rejects signals that lack strict venue comparison metadata", () => {
    assert.throws(
      () => buildWeatherVenueRoutes([venueRow({ forecastStationId: undefined })]),
      /missing strict venue-routing metadata/
    );
  });

  it("requires an explicit live pricing strategy", () => {
    assert.throws(
      () => requireReinvestPricingStrategy({}),
      /requires --strategy/
    );
  });

  it("requires explicit parameters for market-informed inversion", () => {
    assert.throws(
      () => requireReinvestPricingStrategy({ strategy: "market_informed_inverse" }),
      /market-anchor-coefficient/
    );
    assert.deepEqual(requireReinvestPricingStrategy({
      strategy: "market_informed_inverse",
      marketAnchorCoefficient: -0.25,
      marketAnchorMinOppositeMarketProbability: 0.5
    }), {
      strategy: "market_informed_inverse",
      marketAnchor: {
        coefficient: -0.25,
        minOppositeMarketProbability: 0.5,
        minExecutableEdge: 0.03
      }
    });
  });

  it("requires explicit routing parameters for the market-informed hybrid", () => {
    assert.throws(
      () => requireReinvestPricingStrategy({
        strategy: "market_informed_hybrid",
        marketAnchorCoefficient: -0.25,
        marketAnchorMinOppositeMarketProbability: 0.5
      }),
      /hybrid-normal-min-market-probability/
    );
    assert.throws(
      () => requireReinvestPricingStrategy({
        strategy: "market_informed_hybrid",
        marketAnchorCoefficient: -0.25,
        marketAnchorMinOppositeMarketProbability: 0.5,
        hybridNormalMinMarketProbability: 0.5
      }),
      /hybrid-normal-buy-budget-fraction/
    );
    assert.deepEqual(requireReinvestPricingStrategy({
      strategy: "market_informed_hybrid",
      marketAnchorCoefficient: -0.25,
      marketAnchorMinOppositeMarketProbability: 0.5,
      hybridNormalMinMarketProbability: 0.5,
      hybridNormalBuyBudgetFraction: 1 / 3
    }), {
      strategy: "market_informed_hybrid",
      marketAnchor: {
        coefficient: -0.25,
        minOppositeMarketProbability: 0.5,
        minExecutableEdge: 0.03
      },
      hybrid: {
        normalMinMarketProbability: 0.5
      },
      hybridNormalBuyBudgetFraction: 1 / 3
    });
  });

  it("reserves independent normal and inverse lane budgets", () => {
    assert.deepEqual(weatherHybridLaneBudgets(30, 1 / 3), {
      normalAgreement: 10,
      inverseDisagreement: 20
    });
    assert.throws(() => weatherHybridLaneBudgets(30, 1.1), /between 0 and 1/);
  });

  it("requires a separate inverse-low window for market-informed strategies", () => {
    assert.throws(
      () => requireReinvestEntryWindows({}, "market_informed_hybrid"),
      /explicit inverse-low entry start and end times/
    );
    assert.deepEqual(requireReinvestEntryWindows({
      inverseLowEntryStartLocalMinutes: 20 * 60,
      inverseLowEntryEndLocalMinutes: 23 * 60 + 30
    }, "market_informed_hybrid"), {
      high: { startLocalMinutes: 20 * 60, endLocalMinutes: 23 * 60 + 30 },
      low: { startLocalMinutes: 11 * 60, endLocalMinutes: 14 * 60 + 30 },
      inverseLow: { startLocalMinutes: 20 * 60, endLocalMinutes: 23 * 60 + 30 }
    });
  });

  it("routes inverse lows to late evening while normal lows stay midday", () => {
    const entryWindows = requireReinvestEntryWindows({
      inverseLowEntryStartLocalMinutes: 20 * 60,
      inverseLowEntryEndLocalMinutes: 23 * 60 + 30
    }, "market_informed_hybrid");
    const inverseLate = weatherReinvestEntryWindow({
      date: "2026-07-14",
      measure: "temperature_low",
      strategy: "market_informed_hybrid",
      strategyLane: "inverse_disagreement",
      timezone: "Europe/London",
      now: new Date("2026-07-13T21:15:00.000Z"),
      entryWindows
    });
    const normalLate = weatherReinvestEntryWindow({
      date: "2026-07-14",
      measure: "temperature_low",
      strategy: "forecast_edge",
      timezone: "Europe/London",
      now: new Date("2026-07-13T21:15:00.000Z"),
      entryWindows
    });
    const normalMidday = weatherReinvestEntryWindow({
      date: "2026-07-14",
      measure: "temperature_low",
      strategy: "forecast_edge",
      timezone: "Europe/London",
      now: new Date("2026-07-13T11:15:00.000Z"),
      entryWindows
    });

    assert.equal(inverseLate.policy, "inverse_low_late");
    assert.equal(inverseLate.shouldEnter, true);
    assert.equal(normalLate.policy, "low_midday");
    assert.equal(normalLate.status, "after_entry_window");
    assert.equal(normalMidday.shouldEnter, true);
  });

  it("still blocks inverse lows once the target day starts", () => {
    const entryWindows = requireReinvestEntryWindows({
      inverseLowEntryStartLocalMinutes: 20 * 60,
      inverseLowEntryEndLocalMinutes: 23 * 60 + 30
    }, "market_informed_hybrid");
    const assessment = weatherReinvestEntryWindow({
      date: "2026-07-14",
      measure: "temperature_low",
      strategy: "market_informed_hybrid",
      strategyLane: "inverse_disagreement",
      timezone: "Europe/London",
      now: new Date("2026-07-14T00:15:00.000Z"),
      entryWindows
    });

    assert.equal(assessment.policy, "inverse_low_late");
    assert.equal(assessment.shouldEnter, false);
    assert.equal(assessment.status, "market_day_started");
  });

  it("retries transient Vistadex filler and transport failures", () => {
    assert.equal(isRetryableVistadexTransientError(new Error("Timed out waiting for filler action")), true);
    assert.equal(isRetryableVistadexTransientError(new Error("WebSocket closed while waiting for filler action")), true);
    assert.equal(isRetryableVistadexTransientError(new Error("fetch failed")), true);
    assert.equal(isRetryableVistadexTransientError(new Error('Event "highest-temperature-in-lucknow-on-july-16-2026" is still being created')), true);
  });

  it("recognizes transient source failures without treating validation as retryable", () => {
    assert.equal(isRetryableNetworkError(new Error("fetch failed")), true);
    assert.equal(isRetryableNetworkError(new Error("Request failed 503 Service Unavailable")), true);
    assert.equal(isRetryableNetworkError(new Error("Polymarket Gamma request failed with HTTP 503")), true);
    assert.equal(
      isRetryableNetworkError(new Error("Weather pricing failed", { cause: new Error("ECONNRESET") })),
      true
    );
    assert.equal(isRetryableNetworkError(new Error("Resolution station mismatch")), false);
  });

  it("does not retry deterministic trade validation failures", () => {
    assert.equal(isRetryableVistadexTransientError(new Error("Retry buy quote 0.9000 above max acceptable 0.8000.")), false);
    assert.equal(isRetryableVistadexTransientError(new Error("Vistadex buy requires amountUsd.")), false);
  });

  it("uses exponential retry backoff", () => {
    assert.equal(retryDelayMs(10_000, 1), 10_000);
    assert.equal(retryDelayMs(10_000, 2), 20_000);
    assert.equal(retryDelayMs(10_000, 3), 40_000);
  });

  it("retries a transient Vistadex operation once and returns its result", async () => {
    let calls = 0;
    const notices: string[] = [];
    const result = await retryTransient(async () => {
      calls += 1;
      if (calls === 1) throw new Error('Event "lucknow" is still being created');
      return "ready";
    }, {
      label: "Lucknow event lookup",
      maxAttempts: 2,
      retryBackoffMs: 0,
      isRetryable: isRetryableVistadexTransientError,
      onRetry: (notice) => notices.push(`${notice.label}:${notice.attempt}`)
    });

    assert.equal(result, "ready");
    assert.equal(calls, 2);
    assert.deepEqual(notices, ["Lucknow event lookup:1"]);
  });

  it("reports an exhausted transient Vistadex operation with context", async () => {
    let calls = 0;
    await assert.rejects(
      retryTransient(async () => {
        calls += 1;
        throw new Error('Event "lucknow" is still being created');
      }, {
        label: "Lucknow event lookup",
        maxAttempts: 2,
        retryBackoffMs: 0,
        isRetryable: isRetryableVistadexTransientError
      }),
      /Lucknow event lookup failed after 2 attempts: Event "lucknow" is still being created/
    );
    assert.equal(calls, 2);
  });

  it("does not retry a non-transient Vistadex operation failure", async () => {
    let calls = 0;
    await assert.rejects(
      retryTransient(async () => {
        calls += 1;
        throw new Error("Vistadex authentication failed");
      }, {
        label: "event lookup",
        maxAttempts: 2,
        retryBackoffMs: 0,
        isRetryable: isRetryableVistadexTransientError
      }),
      /Vistadex authentication failed/
    );
    assert.equal(calls, 1);
  });

  it("surfaces failed live execution attempts", () => {
    const failures = weatherReinvestExecutionFailures({
      sold: [],
      bought: [],
      skipped: [
        {
          action: "buy_edge",
          status: "failed",
          attempts: [{
            attempt: 1,
            maxAttempts: 1,
            startedAt: "2026-07-10T00:00:00.000Z",
            finishedAt: "2026-07-10T00:02:00.000Z",
            status: "failed",
            error: "Timed out waiting for filler action",
            retryable: true
          }]
        },
        {
          action: "buy_edge",
          status: "skipped",
          reason: "Outside station-local day-ahead entry window."
        }
      ]
    } as any);

    assert.equal(failures.length, 1);
    assert.equal(failures[0].status, "failed");
  });

  it("does not fail a healthy no-op run", () => {
    const failures = weatherReinvestExecutionFailures({
      sold: [],
      bought: [],
      skipped: [{
        action: "buy_edge",
        status: "skipped",
        reason: "No edge."
      }]
    } as any);

    assert.deepEqual(failures, []);
  });
});
