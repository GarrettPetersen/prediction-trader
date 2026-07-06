import { inspect } from "node:util";
import { loadConfig } from "./config.js";
import { assertCanExecute, assertLiveMutation } from "./safety.js";
import {
  appendExecutionLedgerRecord,
  filterLedgerRecords,
  readLedgerRecords,
  summarizeLedger,
  type LedgerRecord
} from "./ledger.js";
import {
  backfillLedger,
  type LedgerBackfillVenue
} from "./ledgerBackfill.js";
import { updateLedger } from "./ledgerUpdate.js";
import {
  executePolymarketOrder,
  executePolymarketRedeem,
  previewPolymarketRedeem,
  previewPolymarketOrder
} from "./marketplaces/polymarket.js";
import {
  getPolymarketEvent,
  getPolymarketPositions
} from "./marketplaces/polymarketData.js";
import {
  executeVistadexTrade,
  getVistadexEvent,
  getVistadexPositions,
  getVistadexPublicActivity,
  previewVistadexTrade,
  quoteVistadexTrade
} from "./marketplaces/vistadex.js";
import {
  estimateMatchProbabilities,
  loadFootballEloDataset,
  lookupFootballTeam,
  parseFootballFixtureTitle,
  pricePolymarketFootballEvent
} from "./models/footballElo.js";
import {
  fitSoccerPoissonModel,
  loadSoccerMatchesFromCsvFiles,
  predictSoccerScore,
  type SoccerScorePrediction
} from "./models/soccerPoisson.js";
import {
  buildIndependentPoissonScoreDistribution,
  buildMonteCarloScoreDistribution,
  inferPoissonMeansFromThreeWayProbabilities,
  summarizeScoreDistribution,
  type ScoreSummary
} from "./models/scoreDistribution.js";
import {
  buildUnlockTickets,
  createPortfolioUnlockPlan,
  type PortfolioUnlockVenueArg
} from "./portfolioUnlock.js";
import {
  fetchWeatherEdgeSources,
  fetchNoaaClimatology,
  parseWeatherSourceIds,
  resolveWeatherLocation,
  type WeatherDailyPoint,
  type WeatherHourlyPoint,
  type WeatherLocation,
  type WeatherSourceResult
} from "./weatherEdge.js";
import {
  fetchPolymarketWeatherEventBySlug,
  fetchPolymarketWeatherMarkets,
  type WeatherMarketGroup
} from "./weatherMarkets.js";
import {
  computeVistadexMiddayWeatherReport,
  formatFahrenheit,
  type MiddayWeatherGroupReport,
  type MiddayWeatherOutcomePricing,
  type MiddayWeatherReport
} from "./weatherMidday.js";
import {
  priceWeatherMarketGroup,
  rankWeatherSignals,
  type WeatherOutcomePricing,
  type WeatherPricingReport
} from "./weatherPricing.js";
import {
  computeWeatherEdgeReport,
  type WeatherEdgeReport,
  type WeatherEdgeRow
} from "./weatherEdges.js";
import {
  runWeatherMarketBacktest,
  type WeatherBacktestTrade
} from "./weatherBacktest.js";
import {
  auditWeatherResolutionSources,
  type WeatherResolutionAuditRow
} from "./weatherResolutionAudit.js";
import {
  runWeatherReinvestment,
  writeWeatherReinvestReport,
  type WeatherReinvestConfidence
} from "./weatherReinvest.js";
import {
  collectWeatherBacktestRunDataset,
  collectWeatherForecastSnapshotsDataset,
  collectWeatherMarketSnapshotsDataset,
  collectWeatherObservationsDataset,
  collectWeatherPreviousRunForecastsDataset,
  collectWeatherResolutionActualsDataset,
  summarizeWeatherDatasets,
  weatherDatasetPaths,
  type OpenMeteoPreviousRunSourceId,
  type WeatherForecastSnapshotRecord,
  type WeatherMarketSnapshotRecord,
  type WeatherObservationRecord,
  type WeatherPreviousRunForecastRecord,
  type WeatherResolutionActualRecord
} from "./weatherDatasets.js";
import type {
  PolymarketOrderTicket,
  PolymarketRedeemTicket,
  TradeSide,
  VistadexTradeTicket
} from "./types.js";

type Args = Record<string, string | boolean>;
const POLYMARKET_ORDER_TYPES = new Set(["GTC", "GTD", "FOK", "FAK"]);

function parseArgs(argv: string[]): { command: string; args: Args } {
  const [command = "help", ...rest] = argv;
  const args: Args = {};

  for (let i = 0; i < rest.length; i += 1) {
    const item = rest[i];
    if (!item.startsWith("--")) continue;

    const key = item.slice(2);
    const next = rest[i + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }

  return { command, args };
}

function stringArg(args: Args, key: string, required = true): string | undefined {
  const value = args[key];
  if (typeof value === "string" && value.length > 0) return value;
  if (required) throw new Error(`Missing --${key}.`);
  return undefined;
}

function requiredStringArg(args: Args, key: string): string {
  return stringArg(args, key, true) as string;
}

function numberArg(args: Args, key: string, required = true): number | undefined {
  const raw = stringArg(args, key, required);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`--${key} must be a number.`);
  return value;
}

function requiredNumberArg(args: Args, key: string): number {
  return numberArg(args, key, true) as number;
}

function listArg(args: Args, key: string, required = false): string[] {
  const raw = stringArg(args, key, required);
  if (raw === undefined) return [];
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function localTimeMinutesArg(args: Args, key: string): number | undefined {
  const raw = stringArg(args, key, false);
  if (raw === undefined) return undefined;
  const match = raw.match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  if (!match) throw new Error(`--${key} must be in HH:MM 24-hour local time format.`);
  return Number(match[1]) * 60 + Number(match[2]);
}

function numberListArg(args: Args, key: string): number[] | undefined {
  const values = listArg(args, key, false);
  if (values.length === 0) return undefined;
  return values.map((value) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) throw new Error(`--${key} must be a comma-separated list of numbers.`);
    return parsed;
  });
}

function optionalNumberListArg(args: Args, key: string): number[] {
  return numberListArg(args, key) ?? [];
}

function sideArg(args: Args): TradeSide {
  const side = requiredStringArg(args, "side");
  if (side !== "buy" && side !== "sell") {
    throw new Error("--side must be buy or sell.");
  }
  return side;
}

function polymarketOrderTypeArg(args: Args): PolymarketOrderTicket["orderType"] {
  const orderType = (stringArg(args, "order-type", false) ?? "FOK").toUpperCase();
  if (!POLYMARKET_ORDER_TYPES.has(orderType)) {
    throw new Error("--order-type must be one of GTC, GTD, FOK, FAK.");
  }
  return orderType as PolymarketOrderTicket["orderType"];
}

function portfolioUnlockVenueArg(args: Args): PortfolioUnlockVenueArg {
  const venue = stringArg(args, "venue", false) ?? "all";
  if (venue !== "all" && venue !== "polymarket" && venue !== "vistadex") {
    throw new Error("--venue must be all, polymarket, or vistadex.");
  }
  return venue;
}

function ledgerBackfillVenueArg(args: Args): LedgerBackfillVenue {
  return portfolioUnlockVenueArg(args);
}

function validatePolymarketTicket(ticket: PolymarketOrderTicket): void {
  const isMarketType = ticket.orderType === "FOK" || ticket.orderType === "FAK";
  if (ticket.amountUsd !== undefined && ticket.shares !== undefined) {
    throw new Error("Pass only one of --amount-usd or --shares.");
  }
  if (isMarketType && ticket.side === "buy" && ticket.amountUsd === undefined) {
    throw new Error("Polymarket market buys require --amount-usd.");
  }
  if (isMarketType && ticket.side === "sell" && ticket.shares === undefined) {
    throw new Error("Polymarket market sells require --shares.");
  }
  if (!isMarketType && ticket.shares === undefined) {
    throw new Error("Polymarket limit orders require --shares.");
  }
}

function validatePolymarketRedeemTicket(ticket: PolymarketRedeemTicket): void {
  const targets = [ticket.conditionId, ticket.marketId, ticket.positionId].filter(Boolean);
  if (targets.length !== 1) {
    throw new Error("Pass exactly one of --condition-id, --market-id, or --position-id.");
  }
}

function validateVistadexTicket(ticket: VistadexTradeTicket): void {
  if (ticket.side === "buy" && ticket.amountUsd === undefined) {
    throw new Error("Vistadex buys require --amount-usd.");
  }
  if (ticket.side === "sell" && ticket.shares === undefined) {
    throw new Error("Vistadex sells require --shares.");
  }
}

function print(value: unknown): void {
  console.log(inspect(value, { depth: null, colors: true }));
}

function compactScoreSummary(summary: ScoreSummary) {
  return {
    expectedGoals: {
      home: summary.expectedHomeScore,
      away: summary.expectedAwayScore,
      total: summary.expectedTotalScore
    },
    threeWay: {
      homeWin: summary.homeWin,
      draw: summary.draw,
      awayWin: summary.awayWin
    },
    bothTeamsToScore: summary.bothTeamsToScore,
    totals: summary.totals,
    queriedScores: summary.queriedScores,
    topScores: summary.topScores.map((score) => ({
      score: `${score.homeScore}-${score.awayScore}`,
      probability: score.probability
    }))
  };
}

function compactLedgerRecord(record: LedgerRecord) {
  return {
    id: record.id,
    dedupeKey: record.dedupeKey,
    source: record.source,
    venue: record.venue,
    action: record.action,
    occurredAt: record.occurredAt,
    recordedAt: record.recordedAt,
    status: record.status,
    side: record.side,
    price: record.price,
    shares: record.shares,
    notionalUsd: record.notionalUsd,
    summary: record.summary,
    market: record.market,
    ids: record.ids,
    notes: record.notes
  };
}

function compactHistoricalWeather(value: unknown) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  const record = value as { date?: unknown; records?: unknown };
  const records = Array.isArray(record.records) ? record.records : undefined;
  const station = typeof (record as { station?: unknown }).station === "object" &&
    (record as { station?: unknown }).station !== null
    ? (record as { station: Record<string, unknown> }).station
    : undefined;
  const daily = Array.isArray((record as { daily?: unknown }).daily)
    ? (record as { daily: Record<string, unknown>[] }).daily.map((point) => {
      const { raw: _raw, ...compact } = point;
      return compact;
    })
    : undefined;
  return {
    ...record,
    station: station
      ? {
        id: station.id,
        name: station.name,
        latitude: station.latitude,
        longitude: station.longitude,
        mindate: station.mindate,
        maxdate: station.maxdate,
        distanceKm: station.distanceKm
      }
      : undefined,
    daily,
    recordCount: records?.length,
    records: records?.slice(0, 10)
  };
}

function compactWeatherLocation(location: WeatherLocation) {
  return {
    name: location.name,
    latitude: location.latitude,
    longitude: location.longitude,
    timezone: location.timezone,
    countryCode: location.countryCode,
    country: location.country,
    admin1: location.admin1
  };
}

function compactWeatherDailyPoint(point: WeatherDailyPoint) {
  const { raw: _raw, ...compact } = point;
  return compact;
}

function compactWeatherHourlyPoint(point: WeatherHourlyPoint | undefined) {
  if (!point) return undefined;
  const { raw: _raw, ...compact } = point;
  return compact;
}

function compactWeatherSourceResult(result: WeatherSourceResult) {
  return {
    source: result.source,
    provider: result.provider,
    ok: result.ok,
    skipped: result.skipped,
    model: result.model,
    note: result.note,
    error: result.error,
    url: result.url,
    daily: result.daily?.slice(0, 5).map(compactWeatherDailyPoint),
    hourly: result.hourly
      ? {
        count: result.hourly.length,
        first: compactWeatherHourlyPoint(result.hourly[0]),
        last: compactWeatherHourlyPoint(result.hourly.at(-1))
      }
      : undefined,
    current: result.current,
    historical: result.historical ? compactHistoricalWeather(result.historical) : undefined
  };
}

function compactWeatherMarketGroup(group: WeatherMarketGroup) {
  return {
    event: {
      slug: group.eventSlug,
      title: group.eventTitle,
      endDate: group.eventEndDate
    },
    parsed: {
      city: group.city,
      date: group.date,
      measure: group.measure
    },
    marketCount: group.markets.length,
    markets: group.markets.slice(0, 4).map((market) => ({
      slug: market.marketSlug,
      question: market.question,
      active: market.active,
      closed: market.closed,
      acceptingOrders: market.acceptingOrders,
      bestBid: market.bestBid,
      bestAsk: market.bestAsk,
      liquidity: market.liquidity,
      resolutionSource: market.resolutionSource,
      parsedOutcome: market.parsed.outcome,
      outcomes: market.outcomes
    })),
    omittedMarkets: Math.max(0, group.markets.length - 4),
    unparsed: group.unparsed.slice(0, 10),
    omittedUnparsed: Math.max(0, group.unparsed.length - 10)
  };
}

function compactWeatherSignal(signal: WeatherOutcomePricing) {
  return {
    signal: signal.signal,
    marketSlug: signal.marketSlug,
    outcomeLabel: signal.outcomeLabel,
    fairYes: signal.fairYes,
    fairNo: signal.fairNo,
    yesAsk: signal.yesAsk,
    noAsk: signal.noAsk,
    yesEdge: signal.yesEdge,
    noEdge: signal.noEdge,
    edge: signal.edge,
    confidence: signal.confidence,
    kellyFraction: signal.kellyFraction,
    suggestedSizeUsd: signal.suggestedSizeUsd,
    tokenId: signal.tokenId,
    price: signal.price,
    reason: signal.reason
  };
}

function round(value: number | undefined, decimals = 4): number | undefined {
  if (value === undefined) return undefined;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function compactWeatherEdgeRow(row: WeatherEdgeRow) {
  return {
    signal: row.signal,
    bestSide: row.bestSide,
    bestEdge: round(row.bestEdge),
    eventSlug: row.eventSlug,
    marketSlug: row.marketSlug,
    question: row.question,
    fairYes: round(row.fairYes),
    yesAsk: round(row.yesAsk),
    yesEdge: round(row.yesEdge),
    fairNo: round(row.fairNo),
    noAsk: round(row.noAsk),
    noEdge: round(row.noEdge),
    confidence: row.confidence,
    suggestedSizeUsd: round(row.suggestedSizeUsd, 2),
    kellyFraction: round(row.kellyFraction),
    liquidity: round(row.liquidity, 2),
    volume: round(row.volume, 2),
    resolution: {
      matched: row.forecastTargetMatched,
      stationId: row.forecastStationId,
      stationName: row.forecastStationName,
      cityDistanceKm: round(row.forecastCityDistanceKm, 1),
      source: row.resolutionSource
    },
    consensus: {
      meanC: round(row.consensusMeanC, 2),
      sigmaC: round(row.consensusSigmaC, 2),
      agreement: row.agreement
    },
    tradingWindow: row.tradingWindow
      ? {
        safeToTrade: row.tradingWindow.safeToTrade,
        status: row.tradingWindow.status,
        timezone: row.tradingWindow.timezone,
        localDate: row.tradingWindow.localDate,
        localTime: row.tradingWindow.localTime,
        minutesAfterLocalMidnight: row.tradingWindow.minutesAfterLocalMidnight,
        graceMinutes: row.tradingWindow.graceMinutes,
        reason: row.tradingWindow.reason
      }
      : undefined,
    tokenId: row.tokenId,
    price: round(row.price)
  };
}

function compactWeatherEdgeReport(report: WeatherEdgeReport, args: Args) {
  const sourceRows = args["signals-only"] === true ? report.signals : report.rows;
  const top = args.all === true
    ? sourceRows.length
    : Math.max(1, Math.trunc(numberArg(args, "top", false) ?? 50));
  const rows = sourceRows.slice(0, top);
  return {
    targetDate: report.targetDate,
    scannedGroups: report.scannedGroups,
    targetGroups: report.targetGroups,
    pricedGroups: report.pricedGroups,
    timeSkippedGroups: report.timeSkippedGroups,
    erroredGroups: report.erroredGroups,
    marketCount: report.marketCount,
    rowCount: report.rowCount,
    signalCount: report.signalCount,
    displayedRows: rows.length,
    omittedRows: Math.max(0, sourceRows.length - rows.length),
    rows: rows.map(compactWeatherEdgeRow),
    errors: report.errors,
    reports: args.reports === true
      ? report.groups.map(compactWeatherPricingReport)
      : undefined
  };
}

function compactWeatherObservationRecord(record: WeatherObservationRecord) {
  const { rawRecords: _rawRecords, ...compact } = record;
  return {
    ...compact,
    rawRecordCount: record.rawRecords.length
  };
}

function compactWeatherMarketSnapshotRecord(record: WeatherMarketSnapshotRecord) {
  return {
    id: record.id,
    capturedAt: record.capturedAt,
    eventSlug: record.eventSlug,
    city: record.city,
    date: record.date,
    measure: record.measure,
    marketSlug: record.marketSlug,
    question: record.question,
    resolutionSource: record.resolutionSource,
    bestBid: record.bestBid,
    bestAsk: record.bestAsk,
    liquidity: record.liquidity,
    volume: record.volume,
    outcome: record.outcome,
    tokens: record.tokens
  };
}

function compactWeatherForecastSnapshotRecord(record: WeatherForecastSnapshotRecord) {
  return {
    id: record.id,
    forecastCapturedAt: record.forecastCapturedAt,
    marketSnapshotCapturedAt: record.marketSnapshotCapturedAt,
    city: record.city,
    countryCode: record.countryCode,
    date: record.date,
    measure: record.measure,
    source: record.source,
    provider: record.provider,
    model: record.model,
    ok: record.ok,
    skipped: record.skipped,
    valueC: round(record.valueC, 2),
    dailyPoint: record.dailyPoint
      ? {
        date: record.dailyPoint.date,
        minTempC: round(record.dailyPoint.minTempC, 2),
        maxTempC: round(record.dailyPoint.maxTempC, 2),
        precipitationMm: round(record.dailyPoint.precipitationMm, 2)
      }
      : undefined,
    hourlyCount: record.hourlyPoints?.length,
    note: record.note,
    error: record.error
  };
}

function compactWeatherPreviousRunForecastRecord(record: WeatherPreviousRunForecastRecord) {
  return {
    id: record.id,
    collectedAt: record.collectedAt,
    targetKey: record.targetKey,
    targetKind: record.targetKind,
    resolutionStationId: record.resolutionStationId,
    resolutionStationName: record.resolutionStationName,
    cityDistanceKm: round(record.cityDistanceKm, 1),
    city: record.city,
    countryCode: record.countryCode,
    date: record.date,
    measure: record.measure,
    leadDays: record.leadDays,
    source: record.source,
    provider: record.provider,
    model: record.model,
    ok: record.ok,
    valueC: round(record.valueC, 2),
    hourlyCount: record.hourlyCount,
    note: record.note,
    error: record.error
  };
}

function compactWeatherResolutionActualRecord(record: WeatherResolutionActualRecord) {
  return {
    id: record.id,
    fetchedAt: record.fetchedAt,
    marketSnapshotCapturedAt: record.marketSnapshotCapturedAt,
    eventSlug: record.eventSlug,
    city: record.city,
    date: record.date,
    measure: record.measure,
    stationId: record.resolutionStationId,
    stationName: record.resolutionStationName,
    timezone: record.timezone,
    resolution: record.resolution
      ? {
        provider: record.resolution.provider,
        ok: record.resolution.ok,
        highF: formatFahrenheit(record.resolution.maxTempC),
        lowF: formatFahrenheit(record.resolution.minTempC),
        rawUnit: record.resolution.rawUnit,
        url: record.resolution.url,
        note: record.resolution.note,
        error: record.resolution.error
      }
      : undefined,
    wunderground: record.wunderground
      ? {
        ok: record.wunderground.ok,
        highF: formatFahrenheit(record.wunderground.maxTempC),
        lowF: formatFahrenheit(record.wunderground.minTempC),
        rawUnit: record.wunderground.rawUnit,
        note: record.wunderground.note,
        error: record.wunderground.error
      }
      : undefined,
    metar: record.metar
      ? {
        observationCount: record.metar.observationCount,
        latestObservedAt: record.metar.latestObservedAt,
        latestTempF: formatFahrenheit(record.metar.latestTempC),
        highSoFarF: formatFahrenheit(record.metar.highSoFarC),
        lowSoFarF: formatFahrenheit(record.metar.lowSoFarC)
      }
      : undefined,
    extremeF: {
      resolution: formatFahrenheit(record.extremeC?.resolution),
      wunderground: formatFahrenheit(record.extremeC?.wunderground),
      metar: formatFahrenheit(record.extremeC?.metar),
      deltaMetarMinusResolution: formatFahrenheitDelta(record.extremeC?.deltaMetarMinusResolution),
      deltaMetarMinusWunderground: formatFahrenheitDelta(record.extremeC?.deltaMetarMinusWunderground)
    },
    outcomes: record.outcomes.map((outcome) => ({
      marketSlug: outcome.marketSlug,
      outcomeLabel: outcome.outcomeLabel,
      resolutionYes: outcome.resolutionYes,
      wundergroundYes: outcome.wundergroundYes,
      metarYes: outcome.metarYes
    })),
    warnings: record.warnings,
    errors: record.errors
  };
}

function compactWeatherBacktestTrade(trade: WeatherBacktestTrade) {
  return {
    side: trade.side,
    won: trade.won,
    pnlUsd: round(trade.pnlUsd, 2),
    stakeUsd: round(trade.stakeUsd, 2),
    payoutUsd: round(trade.payoutUsd, 2),
    edge: round(trade.edge),
    fair: round(trade.fair),
    price: round(trade.price),
    fullKellyFraction: round(trade.fullKellyFraction),
    kellyFraction: round(trade.kellyFraction),
    rawStakeUsd: round(trade.rawStakeUsd, 2),
    city: trade.city,
    forecastTargetKey: trade.forecastTargetKey,
    resolutionStationId: trade.resolutionStationId,
    measure: trade.measure,
    outcomeLabel: trade.outcomeLabel,
    actualC: round(trade.actualC, 2),
    resolvedYes: trade.resolvedYes,
    proxyActualYes: trade.proxyActualYes,
    forecastMeanC: round(trade.forecastMeanC, 2),
    calibratedMeanC: round(trade.calibratedMeanC, 2),
    sigmaC: round(trade.sigmaC, 2),
    marketSlug: trade.marketSlug,
    question: trade.question,
    decisionTime: trade.decisionTime,
    priceTime: trade.priceTime,
    priceAgeHours: round(trade.priceAgeHours, 2)
  };
}

function compactWeatherResolutionAuditRow(row: WeatherResolutionAuditRow) {
  return {
    status: row.status,
    city: row.city,
    date: row.date,
    measure: row.measure,
    marketCount: row.marketCount,
    stationId: row.resolution.stationId,
    stationName: row.station?.site,
    resolutionLocation: row.resolution.locationPath,
    forecastLocation: row.forecastLocation?.name,
    distanceKm: round(row.distanceKm, 1),
    resolutionSource: row.resolutionSource,
    recommendation: row.recommendation,
    eventSlug: row.eventSlug
  };
}

function compactWeatherPricingReport(report: WeatherPricingReport) {
  return {
    group: report.group,
    location: compactWeatherLocation(report.location),
    resolutionTarget: report.resolutionTarget
      ? {
        matched: report.resolutionTarget.matched,
        stationId: report.resolutionTarget.station?.id,
        stationName: report.resolutionTarget.station?.site,
        cityDistanceKm: round(report.resolutionTarget.cityDistanceKm, 1),
        resolutionSource: report.resolutionTarget.resolutionSource,
        note: report.resolutionTarget.note,
        forecastLocation: report.resolutionTarget.forecastLocation
      }
      : undefined,
    sources: report.sources,
    tradingWindow: report.tradingWindow,
    climatology: report.climatology
      ? {
        ok: report.climatology.ok,
        skipped: report.climatology.skipped,
        note: report.climatology.note,
        error: report.climatology.error,
        station: report.climatology.station
          ? {
            id: report.climatology.station.id,
            name: report.climatology.station.name,
            distanceKm: report.climatology.station.distanceKm,
            maxdate: report.climatology.station.maxdate
          }
          : undefined,
        years: report.climatology.years,
        dates: report.climatology.dates,
        maxTempC: report.climatology.maxTempC,
        minTempC: report.climatology.minTempC,
        precipitationMm: report.climatology.precipitationMm,
        sampleCount: report.climatology.daily.length
      }
      : undefined,
    consensus: report.consensus,
    errors: report.errors,
    outcomes: report.outcomes.map(compactWeatherSignal)
  };
}

function compactMiddayWeatherOutcome(row: MiddayWeatherOutcomePricing) {
  return {
    signal: row.signal,
    bestSide: row.bestSide,
    bestEdge: round(row.edge),
    eventSlug: row.eventSlug,
    marketSlug: row.marketSlug,
    question: row.question,
    fairYes: round(row.fairYes),
    yesBid: round(row.yesBid),
    yesAsk: round(row.yesAsk),
    yesEdge: round(row.yesEdge),
    fairNo: round(row.fairNo),
    noBid: round(row.noBid),
    noAsk: round(row.noAsk),
    noEdge: round(row.noEdge),
    lockedByObservation: row.lockedByObservation,
    confidence: row.confidence,
    suggestedSizeUsd: round(row.suggestedSizeUsd, 2),
    kellyFraction: round(row.kellyFraction),
    price: round(row.price),
    held: row.held
      ? {
        outcome: row.held.outcome,
        balance: round(row.held.balance, 4),
        midpoint: round(row.held.midpoint),
        bestBid: round(row.held.bestBid),
        bestAsk: round(row.held.bestAsk)
      }
      : undefined,
    reason: row.reason
  };
}

function formatFahrenheitDelta(valueC: number | undefined): number | undefined {
  return valueC === undefined ? undefined : round(valueC * 9 / 5, 2);
}

function compactMiddayWeatherGroup(report: MiddayWeatherGroupReport) {
  return {
    group: report.group,
    station: report.station
      ? {
        id: report.station.id,
        name: report.station.site,
        state: report.station.state,
        country: report.station.country
      }
      : undefined,
    resolutionSource: report.resolutionSource,
    observation: report.observation
      ? {
        timezone: report.observation.timezone,
        observationCount: report.observation.observationCount,
        latestObservedAt: report.observation.latestObservedAt,
        latestTempF: formatFahrenheit(report.observation.latestTempC),
        highSoFarF: formatFahrenheit(report.observation.highSoFarC),
        lowSoFarF: formatFahrenheit(report.observation.lowSoFarC)
      }
      : undefined,
    consensus: report.consensus
      ? {
        measure: report.consensus.measure,
        observedExtremeF: formatFahrenheit(report.consensus.observedExtremeC),
        forecastExtremeMeanF: formatFahrenheit(report.consensus.forecastExtremeMeanC),
        finalMeanF: formatFahrenheit(report.consensus.finalMeanC),
        sigmaF: round(report.consensus.sigmaC * 9 / 5, 2),
        modelStdDevF: round(report.consensus.modelStdDevC * 9 / 5, 2),
        remainingHourCount: report.consensus.remainingHourCount,
        forecastPoints: report.consensus.forecastPoints.map((point) => ({
          source: point.source,
          valueF: formatFahrenheit(point.valueC),
          hourlyCount: point.hourlyCount
        }))
      }
      : undefined,
    resolutionCheck: report.resolutionCheck
      ? {
        provider: report.resolutionCheck.provider,
        stationId: report.resolutionCheck.stationId,
        stationName: report.resolutionCheck.stationName,
        forecastLocationDistanceKm: round(report.resolutionCheck.forecastLocationDistanceKm, 3),
        observationStationId: report.resolutionCheck.observationStationId,
        observationCount: report.resolutionCheck.observationCount,
        exactActual: report.resolutionCheck.exactActual
          ? {
            ok: report.resolutionCheck.exactActual.ok,
            url: report.resolutionCheck.exactActual.url,
            highF: formatFahrenheit(report.resolutionCheck.exactActual.maxTempC),
            lowF: formatFahrenheit(report.resolutionCheck.exactActual.minTempC),
            rawUnit: report.resolutionCheck.exactActual.rawUnit,
            note: report.resolutionCheck.exactActual.note,
            error: report.resolutionCheck.exactActual.error
          }
          : undefined,
        observedExtremeDeltaF: formatFahrenheitDelta(report.resolutionCheck.observedExtremeDeltaC),
        forecastMeanDeltaF: formatFahrenheitDelta(report.resolutionCheck.forecastMeanDeltaC),
        finalMeanDeltaF: formatFahrenheitDelta(report.resolutionCheck.finalMeanDeltaC),
        sourceComparisons: report.resolutionCheck.sourceComparisons.map((comparison) => ({
          source: comparison.source,
          ok: comparison.ok,
          skipped: comparison.skipped,
          forecastLocationDistanceKm: round(comparison.forecastLocationDistanceKm, 3),
          forecastExtremeF: formatFahrenheit(comparison.forecastExtremeC),
          deltaToResolutionF: formatFahrenheitDelta(comparison.deltaToResolutionC),
          note: comparison.note,
          error: comparison.error
        })),
        warnings: report.resolutionCheck.warnings
      }
      : undefined,
    sourceSummary: report.sourceSummary,
    errors: report.errors,
    outcomes: report.outcomes.map(compactMiddayWeatherOutcome)
  };
}

function compactMiddayWeatherReport(report: MiddayWeatherReport, args: Args) {
  const sourceRows = args["signals-only"] === true ? report.signals : report.rows;
  const top = args.all === true
    ? sourceRows.length
    : Math.max(1, Math.trunc(numberArg(args, "top", false) ?? 50));
  const rows = sourceRows.slice(0, top);
  return {
    targetDate: report.targetDate,
    scannedEvents: report.scannedEvents,
    groupCount: report.groupCount,
    rowCount: report.rowCount,
    signalCount: report.signalCount,
    displayedRows: rows.length,
    omittedRows: Math.max(0, sourceRows.length - rows.length),
    rows: rows.map(compactMiddayWeatherOutcome),
    errors: report.errors,
    groups: args.reports === true
      ? report.groups.map(compactMiddayWeatherGroup)
      : undefined
  };
}

function compactTeamRates(teamRates: SoccerScorePrediction["teamRates"]) {
  return {
    home: {
      team: teamRates.home.team,
      homeWeight: teamRates.home.homeWeight,
      awayWeight: teamRates.home.awayWeight,
      homeAttack: teamRates.home.homeAttack,
      awayAttack: teamRates.home.awayAttack,
      homeDefense: teamRates.home.homeDefense,
      awayDefense: teamRates.home.awayDefense
    },
    away: {
      team: teamRates.away.team,
      homeWeight: teamRates.away.homeWeight,
      awayWeight: teamRates.away.awayWeight,
      homeAttack: teamRates.away.homeAttack,
      awayAttack: teamRates.away.awayAttack,
      homeDefense: teamRates.away.homeDefense,
      awayDefense: teamRates.away.awayDefense
    }
  };
}

function compactSoccerPrediction(prediction: SoccerScorePrediction) {
  return {
    model: prediction.model,
    fixture: prediction.fixture,
    expectedGoals: prediction.expectedGoals,
    warnings: prediction.warnings,
    teamRates: compactTeamRates(prediction.teamRates),
    exact: {
      method: prediction.exact.distribution.method,
      maxScore: prediction.exact.distribution.maxScore,
      coveredMass: prediction.exact.distribution.coveredMass,
      summary: compactScoreSummary(prediction.exact.summary)
    },
    monteCarlo: prediction.monteCarlo
      ? {
        method: prediction.monteCarlo.distribution.method,
        simulations: prediction.monteCarlo.distribution.parameters.simulations,
        seed: prediction.monteCarlo.distribution.parameters.seed,
        coveredMass: prediction.monteCarlo.distribution.coveredMass,
        summary: compactScoreSummary(prediction.monteCarlo.summary)
      }
      : undefined
  };
}

async function historicalSoccerScoreReport(args: Args, fixture: { home: string; away: string }) {
  const historyPaths = listArg(args, "history", true);
  const matches = await loadSoccerMatchesFromCsvFiles(historyPaths);
  const model = fitSoccerPoissonModel(matches, {
    source: historyPaths,
    priorWeight: numberArg(args, "prior-weight", false),
    halfLifeDays: numberArg(args, "half-life-days", false)
  });
  return compactSoccerPrediction(predictSoccerScore(model, {
    homeTeam: fixture.home,
    awayTeam: fixture.away,
    neutral: args.neutral === true,
    maxScore: numberArg(args, "max-score", false),
    simulations: numberArg(args, "simulations", false),
    seed: stringArg(args, "seed", false),
    totalLines: numberListArg(args, "total-lines"),
    scoreQueries: listArg(args, "scores", false),
    topN: numberArg(args, "top", false)
  }));
}

function weatherPricingOptions(args: Args) {
  const noaaYears = numberArg(args, "noaa-years", false);
  return {
    bankrollUsd: numberArg(args, "bankroll", false),
    maxPerTradeUsd: numberArg(args, "max-per-trade", false) ?? numberArg(args, "max-usd", false),
    kellyMultiplier: numberArg(args, "kelly-multiplier", false),
    maxKellyFraction: numberArg(args, "max-kelly-fraction", false),
    maxGroupFraction: numberArg(args, "max-group-fraction", false),
    portfolioStepUsd: numberArg(args, "portfolio-step-usd", false),
    minEdge: numberArg(args, "min-edge", false),
    noaaYears: noaaYears === 0 ? undefined : noaaYears,
    skipClimatology: args["no-climatology"] === true || noaaYears === 0,
    noaaStationId: stringArg(args, "ncei-station", false),
    noaaLocationId: stringArg(args, "ncei-location", false),
    countryCode: stringArg(args, "country", false),
    allowCityForecast: args["allow-city-forecast"] === true,
    sizingStrategy: weatherSizingStrategyArg(args)
  };
}

function weatherSizingStrategyArg(args: Args): "independent_kelly" | "city_portfolio" | undefined {
  const value = stringArg(args, "sizing", false);
  if (value === undefined) return undefined;
  if (value === "independent-kelly" || value === "independent_kelly") return "independent_kelly";
  if (value === "city-portfolio" || value === "city_portfolio") return "city_portfolio";
  throw new Error("--sizing must be independent-kelly or city-portfolio.");
}

function weatherReinvestConfidenceArg(args: Args): WeatherReinvestConfidence | undefined {
  const value = stringArg(args, "min-confidence", false);
  if (value === undefined) return undefined;
  const normalized = value.toUpperCase();
  if (normalized === "LOW" || normalized === "MEDIUM" || normalized === "HIGH") {
    return normalized;
  }
  throw new Error("--min-confidence must be low, medium, or high.");
}

function previousRunSourcesArg(args: Args): OpenMeteoPreviousRunSourceId[] | undefined {
  const values = listArg(args, "sources", false);
  if (values.length === 0) return undefined;
  const allowed = new Set(["openmeteo_gfs", "openmeteo_ecmwf", "openmeteo_ukmo"]);
  return values.map((value) => {
    if (allowed.has(value)) return value as OpenMeteoPreviousRunSourceId;
    throw new Error("--sources for weather:dataset:previous-runs must use openmeteo_gfs, openmeteo_ecmwf, and/or openmeteo_ukmo.");
  });
}

async function priceWeatherGroups(config: ReturnType<typeof loadConfig>, groups: WeatherMarketGroup[], args: Args) {
  const maxEvents = Math.max(1, Math.trunc(numberArg(args, "max-events", false) ?? groups.length));
  const selected = groups.filter((group) => group.markets.length > 0).slice(0, maxEvents);
  const reports: WeatherPricingReport[] = [];
  for (const group of selected) {
    reports.push(await priceWeatherMarketGroup(config, group, weatherPricingOptions(args)));
  }
  return reports;
}

function backtestWeatherClimatologySamples(values: number[], threshold?: number) {
  const rows = values.map((actual, index) => {
    const train = values.filter((_value, trainIndex) => trainIndex !== index);
    if (train.length === 0) {
      return { actual, predictedMean: undefined, predictedStdDev: undefined };
    }
    const predictedMean = train.reduce((sum, value) => sum + value, 0) / train.length;
    const predictedStdDev = Math.sqrt(
      train.reduce((sum, value) => sum + (value - predictedMean) ** 2, 0) / train.length
    );
    return {
      actual,
      predictedMean,
      predictedStdDev,
      absoluteError: Math.abs(actual - predictedMean),
      thresholdActual: threshold === undefined ? undefined : actual >= threshold,
      thresholdPrediction: threshold === undefined ? undefined : predictedMean >= threshold
    };
  });

  const errors = rows.flatMap((row) => row.absoluteError === undefined ? [] : [row.absoluteError]);
  const thresholdRows = rows.filter((row) => row.thresholdActual !== undefined);
  return {
    sampleCount: values.length,
    meanAbsoluteError: errors.length > 0
      ? errors.reduce((sum, value) => sum + value, 0) / errors.length
      : undefined,
    threshold,
    thresholdAccuracy: thresholdRows.length > 0
      ? thresholdRows.filter((row) => row.thresholdActual === row.thresholdPrediction).length / thresholdRows.length
      : undefined,
    rows
  };
}

function usage(): void {
  console.log(`Prediction Trader

Commands:
  polymarket:positions [--redeemable] [--include-zero] [--limit N]
  polymarket:event --slug SLUG [--orderbook]
  polymarket:order --side buy|sell --token-id ID --price N (--amount-usd N | --shares N) [--order-type FOK|FAK|GTC|GTD] [--execute]
  polymarket:redeem (--condition-id HEX | --market-id ID | --position-id ID) [--execute]
  vistadex:event --slug SLUG
  vistadex:positions [--include-zero] [--limit N]
  vistadex:activity [--username USERNAME | --wallet ADDRESS] [--limit N] [--max-pages N]
  vistadex:quote --side buy|sell --condition-id HEX --outcome-index 0|1 (--amount-usd N | --shares N) [--limit-price N]
  vistadex:trade --side buy|sell --condition-id HEX --outcome-index 0|1 (--amount-usd N | --shares N) [--limit-price N] [--execute]
  portfolio:unlock [--venue all|polymarket|vistadex] [--min-unlock-usd N] [--max-pairs N] [--execute]
  ledger:list [--ledger PATH] [--venue polymarket|vistadex] [--source execution|backfill] [--action ACTION] [--limit N]
  ledger:summary [--ledger PATH]
  ledger:update [--ledger PATH] [--venue all|polymarket|vistadex] [--limit N] [--max-pages N] [--no-positions] [--no-fills] [--no-cash]
  ledger:backfill [--ledger PATH] [--venue all|polymarket|vistadex] [--no-positions] [--no-fills] [--polymarket-first-page]
  weather:sources (--city CITY [--country CODE] | --latitude N --longitude N) [--days N] [--sources all|openmeteo_gfs,openmeteo_ecmwf,openmeteo_ukmo,nws,hko,noaa_ncei] [--ncei-location ID | --ncei-station ID] [--history-date YYYY-MM-DD] [--raw]
  weather:scan [--limit N] [--max-pages N] [--include-expired] [--include-unparsed]
  weather:price --slug EVENT_SLUG [--bankroll N] [--max-per-trade N] [--kelly-multiplier N] [--max-kelly-fraction N] [--min-edge N] [--country CODE] [--noaa-years N] [--allow-city-forecast]
  weather:signals [--limit N] [--max-pages N] [--max-events N] [--bankroll N] [--max-per-trade N] [--kelly-multiplier N] [--max-kelly-fraction N] [--min-edge N] [--allow-city-forecast]
  weather:edges [--date YYYY-MM-DD | --days-ahead N] [--top N | --all] [--signals-only] [--bankroll N] [--max-per-trade N] [--kelly-multiplier N] [--max-kelly-fraction N] [--sizing independent-kelly|city-portfolio] [--max-group-fraction N] [--portfolio-step-usd N] [--no-climatology] [--concurrency N] [--allow-city-forecast] [--allow-started-day] [--high-grace-minutes N] [--low-grace-minutes N]
  weather:tomorrow [--top N | --all] [--signals-only] [--bankroll N] [--max-per-trade N] [--kelly-multiplier N] [--max-kelly-fraction N] [--sizing independent-kelly|city-portfolio] [--max-group-fraction N] [--portfolio-step-usd N] [--no-climatology] [--concurrency N] [--allow-started-day]
  weather:midday (--held-vistadex | --slug SLUG | --slugs SLUG[,SLUG...]) [--date YYYY-MM-DD] [--sources openmeteo_gfs,openmeteo_ecmwf,openmeteo_ukmo,nws,hko] [--metar-hours N] [--top N | --all] [--signals-only] [--reports] [--resolution-actuals] [--bankroll N] [--max-per-trade N] [--kelly-multiplier N] [--max-kelly-fraction N] [--min-edge N]
  weather:backtest --city CITY [--country CODE] --date YYYY-MM-DD [--measure temperature_high|temperature_low] [--years N] [--threshold N]
  weather:backtest:markets --date YYYY-MM-DD [--lead-days N] [--bankroll N] [--min-edge N] [--min-trade-price N] [--sizing independent-kelly|city-portfolio] [--kelly-multiplier N] [--max-kelly-fraction N] [--max-per-trade N] [--max-portfolio-fraction N] [--max-group-fraction N] [--portfolio-step-usd N] [--sources openmeteo_gfs,openmeteo_ecmwf,openmeteo_ukmo] [--max-staleness-hours N] [--calibration-half-life-days N] [--city-bias-prior-weight N]
  weather:resolution-audit [--date YYYY-MM-DD | --days-ahead N] [--status active|closed] [--distance-ok-km N] [--distance-warn-km N] [--top N]
  weather:reinvest [--execute] [--date YYYY-MM-DD | --days-ahead N] [--bankroll N] [--max-per-trade N] [--max-buys N] [--max-group-fraction N] [--min-cash-to-reinvest N] [--min-confidence low|medium|high] [--entry-start-local-time HH:MM] [--entry-end-local-time HH:MM] [--report-path PATH]
  weather:run [--cycles N] [--interval-sec N] [--paper] [--limit N] [--max-events N] [--bankroll N] [--max-per-trade N] [--kelly-multiplier N] [--max-kelly-fraction N]
  weather:dataset:observations (--city CITY [--country CODE] | --latitude N --longitude N) --start-date YYYY-MM-DD --end-date YYYY-MM-DD [--ncei-station ID | --ncei-location ID] [--path PATH]
  weather:dataset:markets [--date YYYY-MM-DD | --days-ahead N] [--limit N] [--max-pages N] [--include-expired] [--path PATH]
  weather:dataset:forecasts [--market-captured-at ISO] [--sources openmeteo_gfs,openmeteo_ecmwf,openmeteo_ukmo,nws,hko] [--max-cities N] [--path PATH]
  weather:dataset:previous-runs --start-date YYYY-MM-DD --end-date YYYY-MM-DD [--market-captured-at ISO] [--cities CITY[,CITY...]] [--sources openmeteo_gfs,openmeteo_ecmwf,openmeteo_ukmo] [--lead-days 1,2,3] [--max-cities N] [--path PATH]
  weather:dataset:resolution-actuals [--market-captured-at ISO] [--date YYYY-MM-DD] [--metar-hours N] [--max-groups N] [--no-wunderground] [--path PATH]
  weather:dataset:run [--date YYYY-MM-DD | --days-ahead N] [--limit N] [--max-pages N] [--max-events N] [--bankroll N] [--max-per-trade N] [--kelly-multiplier N] [--max-kelly-fraction N] [--no-climatology] [--path PATH]
  weather:dataset:summary
  football:ratings [--refresh] [--team TEAM] [--limit N]
  football:price --slug SLUG [--refresh] [--home TEAM --away TEAM] [--edge-threshold N]
  football:screen --slugs SLUG[,SLUG...] [--refresh] [--edge-threshold N]
  football:score (--slug SLUG | --home TEAM --away TEAM) [--history CSV[,CSV...]] [--simulations N] [--scores 0-0,1-1] [--total-lines 1.5,2.5,3.5]
  score:predict --sport soccer --home TEAM --away TEAM --history CSV[,CSV...] [--simulations N] [--scores 0-0,1-1] [--total-lines 1.5,2.5,3.5]

Live trading requires --execute and PREDICTION_TRADER_LIVE=1.
`);
}

async function run(): Promise<void> {
  const { command, args } = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const execute = args.execute === true;
  const maxUsd = numberArg(args, "max-usd", false);
  const safety = {
    ...config.safety,
    maxUsd: maxUsd ?? config.safety.maxUsd
  };
  const ledgerPath = stringArg(args, "ledger", false) ?? config.ledger.path;

  if (command === "help" || command === "--help" || command === "-h") {
    usage();
    return;
  }

  if (command === "ledger:list") {
    const records = filterLedgerRecords(await readLedgerRecords(ledgerPath), {
      venue: stringArg(args, "venue", false),
      source: stringArg(args, "source", false),
      action: stringArg(args, "action", false),
      limit: numberArg(args, "limit", false)
    });
    print({
      path: ledgerPath,
      count: records.length,
      records: args.raw === true ? records : records.map(compactLedgerRecord)
    });
    return;
  }

  if (command === "ledger:summary") {
    print(summarizeLedger(await readLedgerRecords(ledgerPath), ledgerPath));
    return;
  }

  if (command === "ledger:update") {
    const result = await updateLedger(config, ledgerPath, {
      venue: ledgerBackfillVenueArg(args),
      includePositions: args["no-positions"] !== true,
      includeFills: args["no-fills"] !== true,
      includeCash: args["no-cash"] !== true,
      polymarketOnlyFirstPage: args["polymarket-first-page"] === true,
      positionLimit: numberArg(args, "limit", false),
      cashSnapshotId: stringArg(args, "snapshot-id", false),
      polymarketTradeParams: {
        market: stringArg(args, "market", false),
        assetId: stringArg(args, "asset-id", false),
        after: stringArg(args, "after", false),
        before: stringArg(args, "before", false)
      },
      vistadexActivityParams: {
        username: stringArg(args, "username", false),
        walletAddress: stringArg(args, "wallet", false),
        limit: numberArg(args, "activity-limit", false) ?? numberArg(args, "limit", false),
        maxPages: numberArg(args, "max-pages", false)
      }
    });
    print({
      path: result.path,
      attempted: result.attempted,
      appended: result.appended,
      skipped: result.skipped,
      generated: result.generated,
      cashSnapshots: result.cashSnapshots,
      errors: result.errors,
      beforeSummary: result.beforeSummary,
      afterSummary: result.afterSummary,
      appendedSummary: result.appendedSummary,
      records: result.records.slice(0, 20).map(compactLedgerRecord),
      omittedRecords: Math.max(0, result.records.length - 20)
    });
    return;
  }

  if (command === "weather:sources") {
    const report = await fetchWeatherEdgeSources(config, {
      city: stringArg(args, "city", false),
      countryCode: stringArg(args, "country", false),
      latitude: numberArg(args, "latitude", false),
      longitude: numberArg(args, "longitude", false),
      days: numberArg(args, "days", false),
      sources: parseWeatherSourceIds(listArg(args, "sources", false)),
      noaaLocationId: stringArg(args, "ncei-location", false),
      noaaStationId: stringArg(args, "ncei-station", false),
      historyDate: stringArg(args, "history-date", false)
    });
    print(args.raw === true
      ? report
      : {
        location: compactWeatherLocation(report.location),
        requestedDays: report.requestedDays,
        sources: report.sources,
        summary: report.summary,
        results: report.results.map(compactWeatherSourceResult)
    });
    return;
  }

  if (command === "weather:scan") {
    const groups = await fetchPolymarketWeatherMarkets(config, {
      limit: numberArg(args, "limit", false),
      maxPages: numberArg(args, "max-pages", false),
      includeExpired: args["include-expired"] === true,
      includeUnparsed: args["include-unparsed"] === true
    });
    print({
      count: groups.length,
      groups: args.raw === true ? groups : groups.map(compactWeatherMarketGroup)
    });
    return;
  }

  if (command === "weather:price") {
    const groups = await fetchPolymarketWeatherEventBySlug(config, requiredStringArg(args, "slug"), {
      includeUnparsed: args["include-unparsed"] === true
    });
    const reports = await priceWeatherGroups(config, groups, {
      ...args,
      "max-events": stringArg(args, "max-events", false) ?? String(groups.length)
    });
    print({
      eventSlug: requiredStringArg(args, "slug"),
      groupCount: groups.length,
      reports: args.raw === true ? reports : reports.map(compactWeatherPricingReport),
      signals: rankWeatherSignals(reports).map(compactWeatherSignal)
    });
    return;
  }

  if (command === "weather:signals") {
    const groups = await fetchPolymarketWeatherMarkets(config, {
      limit: numberArg(args, "limit", false),
      maxPages: numberArg(args, "max-pages", false),
      includeExpired: args["include-expired"] === true
    });
    const reports = await priceWeatherGroups(config, groups, args);
    const signals = rankWeatherSignals(reports);
    print({
      scannedGroups: groups.length,
      pricedGroups: reports.length,
      signalCount: signals.length,
      signals: args.raw === true ? signals : signals.map(compactWeatherSignal),
      reports: args.reports === true
        ? reports.map(compactWeatherPricingReport)
        : undefined
    });
    return;
  }

  if (command === "weather:edges" || command === "weather:tomorrow") {
    const report = await computeWeatherEdgeReport(config, {
      ...weatherPricingOptions(args),
      date: stringArg(args, "date", false),
      daysAhead: command === "weather:tomorrow"
        ? 1
        : numberArg(args, "days-ahead", false) ?? 1,
      limit: numberArg(args, "limit", false),
      maxPages: numberArg(args, "max-pages", false),
      maxEvents: numberArg(args, "max-events", false),
      concurrency: numberArg(args, "concurrency", false),
      minLiquidity: numberArg(args, "min-liquidity", false),
      includeExpired: args["include-expired"] === true,
      allowStartedDay: args["allow-started-day"] === true,
      highGraceMinutes: numberArg(args, "high-grace-minutes", false),
      lowGraceMinutes: numberArg(args, "low-grace-minutes", false)
    });
    print(args.raw === true ? report : compactWeatherEdgeReport(report, args));
    return;
  }

  if (command === "weather:midday") {
    const slugs = [
      ...listArg(args, "slugs", false),
      ...listArg(args, "slug", false)
    ];
    const sourceArgs = listArg(args, "sources", false);
    if (slugs.length === 0 && args["held-vistadex"] !== true) {
      throw new Error("Pass --held-vistadex, --slug, or --slugs.");
    }
    const report = await computeVistadexMiddayWeatherReport(config, {
      date: stringArg(args, "date", false),
      slugs,
      heldVistadex: args["held-vistadex"] === true,
      sources: sourceArgs.length > 0 ? parseWeatherSourceIds(sourceArgs) : undefined,
      metarHours: numberArg(args, "metar-hours", false),
      bankrollUsd: numberArg(args, "bankroll", false),
      maxPerTradeUsd: numberArg(args, "max-per-trade", false) ?? numberArg(args, "max-usd", false),
      kellyMultiplier: numberArg(args, "kelly-multiplier", false),
      maxKellyFraction: numberArg(args, "max-kelly-fraction", false),
      minEdge: numberArg(args, "min-edge", false),
      fetchResolutionActuals: args["resolution-actuals"] === true
    });
    print(args.raw === true ? report : compactMiddayWeatherReport(report, args));
    return;
  }

  if (command === "weather:backtest") {
    const measure = stringArg(args, "measure", false) ?? "temperature_high";
    if (measure !== "temperature_high" && measure !== "temperature_low") {
      throw new Error("--measure must be temperature_high or temperature_low.");
    }
    const location = await resolveWeatherLocation(config, {
      city: requiredStringArg(args, "city"),
      countryCode: stringArg(args, "country", false)
    });
    const climatology = await fetchNoaaClimatology(config, location, {
      targetDate: requiredStringArg(args, "date"),
      years: numberArg(args, "years", false),
      noaaStationId: stringArg(args, "ncei-station", false),
      noaaLocationId: stringArg(args, "ncei-location", false)
    });
    const samples = measure === "temperature_high"
      ? climatology.daily.flatMap((point) => point.maxTempC === undefined ? [] : [point.maxTempC])
      : climatology.daily.flatMap((point) => point.minTempC === undefined ? [] : [point.minTempC]);
    print({
      location: compactWeatherLocation(location),
      measure,
      climatology: {
        ok: climatology.ok,
        skipped: climatology.skipped,
        note: climatology.note,
        error: climatology.error,
        station: climatology.station
          ? {
            id: climatology.station.id,
            name: climatology.station.name,
            distanceKm: climatology.station.distanceKm
          }
          : undefined,
        years: climatology.years,
        dates: climatology.dates,
        summary: measure === "temperature_high" ? climatology.maxTempC : climatology.minTempC
      },
      backtest: backtestWeatherClimatologySamples(samples, numberArg(args, "threshold", false))
    });
    return;
  }

  if (command === "weather:backtest:markets") {
    const report = await runWeatherMarketBacktest(config, {
      date: requiredStringArg(args, "date"),
      leadDays: numberArg(args, "lead-days", false),
      bankrollUsd: numberArg(args, "bankroll", false),
      minEdge: numberArg(args, "min-edge", false),
      sources: listArg(args, "sources", false),
      limit: numberArg(args, "limit", false),
      maxPages: numberArg(args, "max-pages", false),
      maxStalenessHours: numberArg(args, "max-staleness-hours", false),
      calibrationHalfLifeDays: numberArg(args, "calibration-half-life-days", false),
      cityBiasPriorWeight: numberArg(args, "city-bias-prior-weight", false),
      minTradePrice: numberArg(args, "min-trade-price", false),
      kellyMultiplier: numberArg(args, "kelly-multiplier", false),
      maxKellyFraction: numberArg(args, "max-kelly-fraction", false),
      maxPerTradeUsd: numberArg(args, "max-per-trade", false) ?? numberArg(args, "max-usd", false),
      maxPortfolioFraction: numberArg(args, "max-portfolio-fraction", false),
      maxGroupFraction: numberArg(args, "max-group-fraction", false),
      portfolioStepUsd: numberArg(args, "portfolio-step-usd", false),
      sizingStrategy: weatherSizingStrategyArg(args)
    });
    const top = Math.max(1, Math.trunc(numberArg(args, "top", false) ?? 25));
    print(args.raw === true
      ? report
      : {
        date: report.date,
        leadDays: report.leadDays,
        bankrollUsd: report.bankrollUsd,
        minEdge: report.minEdge,
        strategy: report.strategy,
        sizing: report.sizing,
        calibration: report.calibration.map((item) => ({
          measure: item.measure,
          samples: item.samples,
          biasC: round(item.biasC, 3),
          sigmaC: round(item.sigmaC, 3),
          meanAbsoluteErrorC: round(item.meanAbsoluteErrorC, 3),
          halfLifeDays: item.halfLifeDays,
          cityBiases: item.cityBiases,
          sourceWeights: Object.fromEntries(Object.entries(item.sourceWeights).map(([source, value]) => [source, round(value, 4)])),
          sourceBiasC: Object.fromEntries(Object.entries(item.sourceBiasC).map(([source, value]) => [source, round(value, 3)]))
        })),
        summary: {
          ...report.summary,
          stakeUsd: round(report.summary.stakeUsd, 2),
          payoutUsd: round(report.summary.payoutUsd, 2),
          pnlUsd: round(report.summary.pnlUsd, 2),
          roi: round(report.summary.roi, 4),
          brierScore: report.summary.brierScore === undefined ? undefined : round(report.summary.brierScore, 4),
          candidateBrierScore: report.summary.candidateBrierScore === undefined ? undefined : round(report.summary.candidateBrierScore, 4)
        },
        displayedTrades: Math.min(top, report.trades.length),
        omittedTrades: Math.max(0, report.trades.length - top),
        trades: report.trades.slice(0, top).map(compactWeatherBacktestTrade)
      });
    return;
  }

  if (command === "weather:resolution-audit") {
    const status = stringArg(args, "status", false) ?? "active";
    if (status !== "active" && status !== "closed") {
      throw new Error("--status must be active or closed.");
    }
    const report = await auditWeatherResolutionSources(config, {
      date: stringArg(args, "date", false),
      daysAhead: numberArg(args, "days-ahead", false),
      status,
      limit: numberArg(args, "limit", false),
      maxPages: numberArg(args, "max-pages", false),
      distanceOkKm: numberArg(args, "distance-ok-km", false),
      distanceWarnKm: numberArg(args, "distance-warn-km", false)
    });
    const top = Math.max(1, Math.trunc(numberArg(args, "top", false) ?? 100));
    print(args.raw === true
      ? report
      : {
        targetDate: report.targetDate,
        status: report.status,
        scannedGroups: report.scannedGroups,
        auditedGroups: report.auditedGroups,
        summary: report.summary,
        displayedRows: Math.min(top, report.rows.length),
        omittedRows: Math.max(0, report.rows.length - top),
        rows: report.rows.slice(0, top).map(compactWeatherResolutionAuditRow)
    });
    return;
  }

  if (command === "weather:reinvest") {
    const report = await runWeatherReinvestment(config, {
      execute,
      ledgerPath,
      date: stringArg(args, "date", false),
      daysAhead: numberArg(args, "days-ahead", false),
      limit: numberArg(args, "limit", false),
      maxPages: numberArg(args, "max-pages", false),
      maxEvents: numberArg(args, "max-events", false),
      concurrency: numberArg(args, "concurrency", false),
      minLiquidity: numberArg(args, "min-liquidity", false),
      highGraceMinutes: numberArg(args, "high-grace-minutes", false),
      lowGraceMinutes: numberArg(args, "low-grace-minutes", false),
      bankrollUsd: numberArg(args, "bankroll", false),
      maxPerTradeUsd: numberArg(args, "max-per-trade", false) ?? numberArg(args, "max-usd", false),
      kellyMultiplier: numberArg(args, "kelly-multiplier", false),
      maxKellyFraction: numberArg(args, "max-kelly-fraction", false),
      maxGroupFraction: numberArg(args, "max-group-fraction", false),
      portfolioStepUsd: numberArg(args, "portfolio-step-usd", false),
      minEdge: numberArg(args, "min-edge", false),
      skipClimatology: args["no-climatology"] === true ? true : undefined,
      sellBidThreshold: numberArg(args, "sell-bid-threshold", false),
      sellMinPrice: numberArg(args, "sell-min-price", false),
      minSellShares: numberArg(args, "min-sell-shares", false),
      minTradeUsd: numberArg(args, "min-trade", false),
      minCashToReinvestUsd: numberArg(args, "min-cash-to-reinvest", false),
      maxBuys: numberArg(args, "max-buys", false),
      minConfidence: weatherReinvestConfidenceArg(args),
      buyMinExecutableEdge: numberArg(args, "buy-min-executable-edge", false),
      buyQuoteDriftUsd: numberArg(args, "buy-quote-drift", false),
      entryStartLocalMinutes: localTimeMinutesArg(args, "entry-start-local-time"),
      entryEndLocalMinutes: localTimeMinutesArg(args, "entry-end-local-time")
    });
    const reportPath = stringArg(args, "report-path", false);
    if (reportPath) await writeWeatherReinvestReport(reportPath, report);
    print(report);
    return;
  }

  if (command === "weather:run") {
    if (execute) {
      throw new Error("weather:run live execution is intentionally not enabled yet. Use weather:signals and explicit order commands after review.");
    }
    const cycles = Math.max(1, Math.trunc(numberArg(args, "cycles", false) ?? 1));
    const intervalSec = Math.max(0, Math.trunc(numberArg(args, "interval-sec", false) ?? 0));
    const outputs = [];
    for (let cycle = 0; cycle < cycles; cycle += 1) {
      const groups = await fetchPolymarketWeatherMarkets(config, {
        limit: numberArg(args, "limit", false),
        maxPages: numberArg(args, "max-pages", false),
        includeExpired: args["include-expired"] === true
      });
      const reports = await priceWeatherGroups(config, groups, args);
      const signals = rankWeatherSignals(reports);
      outputs.push({
        cycle: cycle + 1,
        at: new Date().toISOString(),
        paper: args.paper === true,
        scannedGroups: groups.length,
        pricedGroups: reports.length,
        signalCount: signals.length,
        signals: signals.map(compactWeatherSignal)
      });
      if (cycle < cycles - 1 && intervalSec > 0) {
        await new Promise((resolve) => setTimeout(resolve, intervalSec * 1000));
      }
    }
    print({ cycles: outputs });
    return;
  }

  if (command === "weather:dataset:observations") {
    const result = await collectWeatherObservationsDataset(config, {
      city: stringArg(args, "city", false),
      countryCode: stringArg(args, "country", false),
      latitude: numberArg(args, "latitude", false),
      longitude: numberArg(args, "longitude", false),
      startDate: requiredStringArg(args, "start-date"),
      endDate: requiredStringArg(args, "end-date"),
      noaaStationId: stringArg(args, "ncei-station", false),
      noaaLocationId: stringArg(args, "ncei-location", false),
      path: stringArg(args, "path", false)
    });
    print(args.raw === true
      ? result
      : {
        path: result.path,
        ok: result.ok,
        skipped: result.skipped,
        note: result.note,
        error: result.error,
        location: compactWeatherLocation(result.location),
        station: result.station,
        write: {
          attempted: result.write.attempted,
          appended: result.write.appended,
          skipped: result.write.skipped
        },
        records: result.write.records.slice(0, 10).map(compactWeatherObservationRecord),
        omittedRecords: Math.max(0, result.write.records.length - 10)
      });
    return;
  }

  if (command === "weather:dataset:markets") {
    const result = await collectWeatherMarketSnapshotsDataset(config, {
      date: stringArg(args, "date", false),
      daysAhead: numberArg(args, "days-ahead", false),
      limit: numberArg(args, "limit", false),
      maxPages: numberArg(args, "max-pages", false),
      includeExpired: args["include-expired"] === true,
      path: stringArg(args, "path", false)
    });
    print(args.raw === true
      ? result
      : {
        path: result.path,
        capturedAt: result.capturedAt,
        targetDate: result.targetDate,
        scannedGroups: result.scannedGroups,
        capturedGroups: result.capturedGroups,
        write: {
          attempted: result.write.attempted,
          appended: result.write.appended,
          skipped: result.write.skipped
        },
        records: result.write.records.slice(0, 10).map(compactWeatherMarketSnapshotRecord),
        omittedRecords: Math.max(0, result.write.records.length - 10)
      });
    return;
  }

  if (command === "weather:dataset:forecasts") {
    const result = await collectWeatherForecastSnapshotsDataset(config, {
      marketSnapshotCapturedAt: stringArg(args, "market-captured-at", false),
      sources: listArg(args, "sources", false).length > 0
        ? parseWeatherSourceIds(listArg(args, "sources", false))
        : undefined,
      maxCities: numberArg(args, "max-cities", false),
      path: stringArg(args, "path", false)
    });
    print(args.raw === true
      ? result
      : {
        path: result.path,
        forecastCapturedAt: result.forecastCapturedAt,
        marketSnapshotCapturedAt: result.marketSnapshotCapturedAt,
        scannedMarketRecords: result.scannedMarketRecords,
        targetGroups: result.targetGroups,
        cityCount: result.cityCount,
        sourceIds: result.sourceIds,
        write: {
          attempted: result.write.attempted,
          appended: result.write.appended,
          skipped: result.write.skipped
        },
        records: result.write.records.slice(0, 10).map(compactWeatherForecastSnapshotRecord),
        omittedRecords: Math.max(0, result.write.records.length - 10),
        errors: result.errors
      });
    return;
  }

  if (command === "weather:dataset:previous-runs") {
    const result = await collectWeatherPreviousRunForecastsDataset(config, {
      marketSnapshotCapturedAt: stringArg(args, "market-captured-at", false),
      startDate: requiredStringArg(args, "start-date"),
      endDate: requiredStringArg(args, "end-date"),
      cities: listArg(args, "cities", false),
      sources: previousRunSourcesArg(args),
      leadDays: optionalNumberListArg(args, "lead-days").length > 0
        ? optionalNumberListArg(args, "lead-days")
        : undefined,
      maxCities: numberArg(args, "max-cities", false),
      path: stringArg(args, "path", false)
    });
    print(args.raw === true
      ? result
      : {
        path: result.path,
        collectedAt: result.collectedAt,
        startDate: result.startDate,
        endDate: result.endDate,
        cityCount: result.cityCount,
        targetCount: result.targetCount,
        sourceIds: result.sourceIds,
        leadDays: result.leadDays,
        write: {
          attempted: result.write.attempted,
          appended: result.write.appended,
          skipped: result.write.skipped
        },
        records: result.write.records.slice(0, 10).map(compactWeatherPreviousRunForecastRecord),
        omittedRecords: Math.max(0, result.write.records.length - 10),
        errors: result.errors
      });
    return;
  }

  if (command === "weather:dataset:resolution-actuals") {
    const result = await collectWeatherResolutionActualsDataset(config, {
      marketSnapshotCapturedAt: stringArg(args, "market-captured-at", false),
      date: stringArg(args, "date", false),
      metarHours: numberArg(args, "metar-hours", false),
      maxGroups: numberArg(args, "max-groups", false),
      includeWunderground: args["no-wunderground"] !== true,
      path: stringArg(args, "path", false)
    });
    print(args.raw === true
      ? result
      : {
        path: result.path,
        fetchedAt: result.fetchedAt,
        marketSnapshotCapturedAt: result.marketSnapshotCapturedAt,
        scannedMarketRecords: result.scannedMarketRecords,
        targetGroups: result.targetGroups,
        write: {
          attempted: result.write.attempted,
          appended: result.write.appended,
          skipped: result.write.skipped
        },
        records: result.write.records.slice(0, 10).map(compactWeatherResolutionActualRecord),
        omittedRecords: Math.max(0, result.write.records.length - 10),
        warnings: result.warnings,
        errors: result.errors
      });
    return;
  }

  if (command === "weather:dataset:run") {
    const result = await collectWeatherBacktestRunDataset(config, {
      ...weatherPricingOptions(args),
      date: stringArg(args, "date", false),
      daysAhead: numberArg(args, "days-ahead", false) ?? 1,
      limit: numberArg(args, "limit", false),
      maxPages: numberArg(args, "max-pages", false),
      maxEvents: numberArg(args, "max-events", false),
      concurrency: numberArg(args, "concurrency", false),
      minLiquidity: numberArg(args, "min-liquidity", false),
      includeExpired: args["include-expired"] === true,
      path: stringArg(args, "path", false)
    });
    print(args.raw === true
      ? result
      : {
        path: result.path,
        runAt: result.runAt,
        write: {
          attempted: result.write.attempted,
          appended: result.write.appended,
          skipped: result.write.skipped
        },
        summary: result.record.summary,
        topRows: result.record.rows.slice(0, Math.max(1, Math.trunc(numberArg(args, "top", false) ?? 20)))
          .map(compactWeatherEdgeRow),
        errors: result.record.errors
      });
    return;
  }

  if (command === "weather:dataset:summary") {
    print(await summarizeWeatherDatasets(weatherDatasetPaths(config)));
    return;
  }

  if (command === "ledger:backfill") {
    const result = await backfillLedger(config, ledgerPath, {
      venue: ledgerBackfillVenueArg(args),
      includePositions: args["no-positions"] !== true,
      includeFills: args["no-fills"] !== true,
      polymarketOnlyFirstPage: args["polymarket-first-page"] === true,
      positionLimit: numberArg(args, "limit", false),
      polymarketTradeParams: {
        market: stringArg(args, "market", false),
        assetId: stringArg(args, "asset-id", false),
        after: stringArg(args, "after", false),
        before: stringArg(args, "before", false)
      }
    });
    print({
      ...result,
      records: result.records.slice(0, 20).map(compactLedgerRecord),
      omittedRecords: Math.max(0, result.records.length - 20)
    });
    return;
  }

  if (command === "polymarket:positions") {
    print(await getPolymarketPositions(config, {
      includeZero: args["include-zero"] === true,
      limit: numberArg(args, "limit", false),
      redeemableOnly: args.redeemable === true
    }));
    return;
  }

  if (command === "polymarket:event") {
    print(await getPolymarketEvent(config, requiredStringArg(args, "slug"), {
      includeOrderbook: args.orderbook === true
    }));
    return;
  }

  if (command === "polymarket:order") {
    const ticket: PolymarketOrderTicket = {
      venue: "polymarket",
      side: sideArg(args),
      tokenId: requiredStringArg(args, "token-id"),
      price: requiredNumberArg(args, "price"),
      orderType: polymarketOrderTypeArg(args),
      amountUsd: numberArg(args, "amount-usd", false),
      shares: numberArg(args, "shares", false),
      tickSize: stringArg(args, "tick-size", false),
      negRisk: args["neg-risk"] === true ? true : undefined,
      postOnly: args["post-only"] === true
    };
    validatePolymarketTicket(ticket);

    const preview = previewPolymarketOrder(ticket);
    print({ execute, preview, safety });
    if (!execute) return;

    assertCanExecute(ticket, safety, execute);
    const executionResult = await executePolymarketOrder(config, ticket);
    const ledger = await appendExecutionLedgerRecord(ledgerPath, {
      command,
      ticket,
      preview,
      execution: executionResult,
      action: "order"
    });
    print({ execution: executionResult, ledger });
    return;
  }

  if (command === "polymarket:redeem") {
    const ticket: PolymarketRedeemTicket = {
      venue: "polymarket",
      conditionId: stringArg(args, "condition-id", false),
      marketId: stringArg(args, "market-id", false),
      positionId: stringArg(args, "position-id", false)
    };
    validatePolymarketRedeemTicket(ticket);

    print({ execute, preview: previewPolymarketRedeem(ticket), safety });
    if (!execute) return;

    assertLiveMutation(safety, execute);
    const preview = previewPolymarketRedeem(ticket);
    const executionResult = await executePolymarketRedeem(config, ticket);
    const ledger = await appendExecutionLedgerRecord(ledgerPath, {
      command,
      ticket,
      preview,
      execution: executionResult,
      action: "redeem"
    });
    print({ execution: executionResult, ledger });
    return;
  }

  if (command === "portfolio:unlock") {
    const plan = await createPortfolioUnlockPlan(config, {
      venue: portfolioUnlockVenueArg(args),
      limit: numberArg(args, "limit", false),
      maxPairs: numberArg(args, "max-pairs", false),
      minShares: numberArg(args, "min-shares", false),
      minUnlockUsd: numberArg(args, "min-unlock-usd", false)
    });
    const ticketsByPair = plan.pairs.map((pair) => ({
      venue: pair.venue,
      conditionId: pair.conditionId,
      slug: pair.slug,
      question: pair.question ?? pair.title,
      estimatedUnlockUsd: pair.estimatedUnlockUsd,
      estimatedCostUsd: pair.estimatedCostUsd,
      tickets: buildUnlockTickets(pair)
    }));

    print({ execute, safety, plan, ticketsByPair });
    if (!execute) return;

    const tickets = ticketsByPair.flatMap((pair) => pair.tickets);
    for (const ticket of tickets) {
      assertCanExecute(ticket, safety, execute);
    }

    const executions = [];
    for (const pair of plan.pairs) {
      const pairResult = {
        venue: pair.venue,
        conditionId: pair.conditionId,
        question: pair.question ?? pair.title,
        executions: [] as unknown[]
      };
      for (const ticket of buildUnlockTickets(pair)) {
        const preview = ticket.venue === "polymarket"
          ? previewPolymarketOrder(ticket)
          : previewVistadexTrade(ticket);
        const result = ticket.venue === "polymarket"
          ? await executePolymarketOrder(config, ticket)
          : await executeVistadexTrade(config, ticket);
        const ledger = await appendExecutionLedgerRecord(ledgerPath, {
          command,
          ticket,
          preview,
          execution: result,
          action: "order"
        });
        pairResult.executions.push({ ticket, result, ledger });
        if (result.status === "failed") break;
      }
      executions.push(pairResult);
    }
    print({ executions });
    return;
  }

  if (command === "football:ratings") {
    const dataset = await loadFootballEloDataset({ refresh: args.refresh === true });
    const team = stringArg(args, "team", false);
    if (team) {
      print({
        source: dataset.sourceUrls,
        cache: dataset.cachePaths,
        team: lookupFootballTeam(dataset, team)
      });
      return;
    }

    print({
      source: dataset.sourceUrls,
      cache: dataset.cachePaths,
      count: dataset.ratings.length,
      ratings: dataset.ratings.slice(0, Math.trunc(numberArg(args, "limit", false) ?? 25))
    });
    return;
  }

  if (command === "football:price") {
    print(await pricePolymarketFootballEvent(config, requiredStringArg(args, "slug"), {
      refresh: args.refresh === true,
      home: stringArg(args, "home", false),
      away: stringArg(args, "away", false),
      edgeThreshold: numberArg(args, "edge-threshold", false),
      homeAdvantage: numberArg(args, "home-advantage", false),
      drawBase: numberArg(args, "draw-base", false),
      drawMin: numberArg(args, "draw-min", false),
      drawScale: numberArg(args, "draw-scale", false),
      eloScale: numberArg(args, "elo-scale", false)
    }));
    return;
  }

  if (command === "football:screen") {
    const slugs = requiredStringArg(args, "slugs")
      .split(",")
      .map((slug) => slug.trim())
      .filter(Boolean);
    const reports = await Promise.all(
      slugs.map(async (slug) => {
        try {
          return {
            ok: true as const,
            report: await pricePolymarketFootballEvent(config, slug, {
              refresh: args.refresh === true,
              edgeThreshold: numberArg(args, "edge-threshold", false),
              homeAdvantage: numberArg(args, "home-advantage", false),
              drawBase: numberArg(args, "draw-base", false),
              drawMin: numberArg(args, "draw-min", false),
              drawScale: numberArg(args, "draw-scale", false),
              eloScale: numberArg(args, "elo-scale", false)
            })
          };
        } catch (error) {
          return {
            ok: false as const,
            slug,
            error: error instanceof Error ? error.message : String(error)
          };
        }
      })
    );
    print(reports.map((result) => {
      if (!result.ok) {
        return {
          event: { slug: result.slug },
          error: result.error
        };
      }

      const { report } = result;
      return {
        event: report.event,
        teams: {
          home: `${report.teams.home.name} (${report.teams.home.rating})`,
          away: `${report.teams.away.name} (${report.teams.away.rating})`
        },
        probabilities: {
          homeWin: report.probabilities.homeWin,
          draw: report.probabilities.draw,
          awayWin: report.probabilities.awayWin,
          eloDiff: report.probabilities.eloDiff
        },
        buySignals: report.markets
          .filter((market) => market.buyYesSignal === "buy")
          .sort((a, b) => (b.buyYesEdge ?? -Infinity) - (a.buyYesEdge ?? -Infinity))
      };
    }));
    return;
  }

  if (command === "football:score") {
    const slug = stringArg(args, "slug", false);
    const event = slug
      ? await getPolymarketEvent(config, slug, { includeOrderbook: false })
      : undefined;
    const parsedFixture = event
      ? parseFootballFixtureTitle((event as { title?: unknown }).title)
      : undefined;
    const fixture = {
      home: stringArg(args, "home", false) ?? parsedFixture?.home,
      away: stringArg(args, "away", false) ?? parsedFixture?.away
    };
    if (!fixture.home || !fixture.away) {
      throw new Error("Pass --slug or both --home and --away.");
    }

    if (listArg(args, "history", false).length > 0) {
      print({
        event: event
          ? {
            slug,
            title: (event as { title?: unknown }).title,
            live: (event as { live?: unknown }).live,
            score: (event as { score?: unknown }).score,
            elapsed: (event as { elapsed?: unknown }).elapsed,
            period: (event as { period?: unknown }).period
          }
          : undefined,
        report: await historicalSoccerScoreReport(args, {
          home: fixture.home,
          away: fixture.away
        })
      });
      return;
    }

    const dataset = await loadFootballEloDataset({ refresh: args.refresh === true });
    const home = lookupFootballTeam(dataset, fixture.home);
    const away = lookupFootballTeam(dataset, fixture.away);
    const probabilities = estimateMatchProbabilities(home, away, {
      homeAdvantage: numberArg(args, "home-advantage", false),
      drawBase: numberArg(args, "draw-base", false),
      drawMin: numberArg(args, "draw-min", false),
      drawScale: numberArg(args, "draw-scale", false),
      eloScale: numberArg(args, "elo-scale", false)
    });
    const maxScore = numberArg(args, "max-score", false);
    const inferred = inferPoissonMeansFromThreeWayProbabilities(
      {
        homeWin: probabilities.homeWin,
        draw: probabilities.draw,
        awayWin: probabilities.awayWin
      },
      numberArg(args, "expected-total-goals", false) ?? 2.6,
      { maxScore }
    );
    const exactDistribution = buildIndependentPoissonScoreDistribution({
      sport: "soccer",
      homeTeam: home.name,
      awayTeam: away.name,
      homeMean: inferred.homeMean,
      awayMean: inferred.awayMean,
      maxScore
    });
    const summaryOptions = {
      topN: numberArg(args, "top", false),
      totalLines: numberListArg(args, "total-lines"),
      scoreQueries: listArg(args, "scores", false)
    };
    const exactSummary = summarizeScoreDistribution(exactDistribution, summaryOptions);
    const simulations = numberArg(args, "simulations", false);
    const seed = stringArg(args, "seed", false);
    const monteCarloDistribution = simulations
      ? buildMonteCarloScoreDistribution({
        sport: "soccer",
        homeTeam: home.name,
        awayTeam: away.name,
        homeMean: inferred.homeMean,
        awayMean: inferred.awayMean,
        maxScore,
        simulations,
        seed
      })
      : undefined;

    print({
      source: {
        type: "football-elo-score-model",
        ratingsUrl: dataset.sourceUrls.ratings,
        teamsUrl: dataset.sourceUrls.teams,
        ratingsCachePath: dataset.cachePaths.ratings,
        teamsCachePath: dataset.cachePaths.teams,
        note: "Elo gives the 1X2 prior; Poisson means are fitted to that prior at the requested expected total goals."
      },
      warning: event && (event as { live?: unknown }).live === true
        ? "This score model is pre-match only; it does not use the live score or in-game stats."
        : undefined,
      event: event
        ? {
          slug,
          title: (event as { title?: unknown }).title,
          live: (event as { live?: unknown }).live,
          score: (event as { score?: unknown }).score,
          elapsed: (event as { elapsed?: unknown }).elapsed,
          period: (event as { period?: unknown }).period
        }
        : undefined,
      fixture: {
        home: home.name,
        away: away.name
      },
      teams: { home, away },
      eloThreeWay: probabilities,
      inferredPoisson: inferred,
      exact: {
        method: exactDistribution.method,
        maxScore: exactDistribution.maxScore,
        coveredMass: exactDistribution.coveredMass,
        summary: compactScoreSummary(exactSummary)
      },
      monteCarlo: monteCarloDistribution
        ? {
          method: monteCarloDistribution.method,
          simulations: monteCarloDistribution.parameters.simulations,
          seed: monteCarloDistribution.parameters.seed,
          coveredMass: monteCarloDistribution.coveredMass,
          summary: compactScoreSummary(summarizeScoreDistribution(monteCarloDistribution, summaryOptions))
        }
        : undefined
    });
    return;
  }

  if (command === "score:predict") {
    const sport = requiredStringArg(args, "sport");
    if (sport !== "soccer") {
      throw new Error("Only --sport soccer is implemented so far.");
    }
    print(await historicalSoccerScoreReport(args, {
      home: requiredStringArg(args, "home"),
      away: requiredStringArg(args, "away")
    }));
    return;
  }

  if (command === "vistadex:event") {
    print(await getVistadexEvent(config, requiredStringArg(args, "slug")));
    return;
  }

  if (command === "vistadex:activity") {
    print(await getVistadexPublicActivity(config, {
      username: stringArg(args, "username", false),
      walletAddress: stringArg(args, "wallet", false),
      limit: numberArg(args, "limit", false),
      maxPages: numberArg(args, "max-pages", false)
    }));
    return;
  }

  if (command === "vistadex:positions") {
    print(await getVistadexPositions(config, {
      includeZero: args["include-zero"] === true,
      limit: numberArg(args, "limit", false)
    }));
    return;
  }

  if (command === "vistadex:quote" || command === "vistadex:trade") {
    const outcomeIndex = requiredNumberArg(args, "outcome-index");
    if (outcomeIndex !== 0 && outcomeIndex !== 1) {
      throw new Error("--outcome-index must be 0 or 1.");
    }

    const ticket: VistadexTradeTicket = {
      venue: "vistadex",
      side: sideArg(args),
      conditionId: requiredStringArg(args, "condition-id"),
      outcomeIndex,
      collateralMint: stringArg(args, "collateral-mint", false),
      amountUsd: numberArg(args, "amount-usd", false),
      shares: numberArg(args, "shares", false),
      limitPrice: numberArg(args, "limit-price", false)
    };
    validateVistadexTicket(ticket);

    const preview = previewVistadexTrade(ticket);
    print({ execute, preview, safety });
    if (command === "vistadex:quote") {
      print(await quoteVistadexTrade(config, ticket));
      return;
    }
    if (!execute) return;

    assertCanExecute(ticket, safety, execute);
    const executionResult = await executeVistadexTrade(config, ticket);
    const ledger = await appendExecutionLedgerRecord(ledgerPath, {
      command,
      ticket,
      preview,
      execution: executionResult,
      action: "order"
    });
    print({ execution: executionResult, ledger });
    return;
  }

  usage();
  throw new Error(`Unknown command: ${command}`);
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
