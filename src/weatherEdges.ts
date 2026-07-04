import type { AppConfig } from "./config.js";
import {
  fetchPolymarketWeatherMarkets,
  type WeatherMarketGroup,
  type WeatherMeasure
} from "./weatherMarkets.js";
import {
  priceWeatherMarketGroup,
  rankWeatherSignals,
  type WeatherOutcomePricing,
  type WeatherPricingOptions,
  type WeatherPricingReport
} from "./weatherPricing.js";
import {
  assessWeatherTradingWindow,
  type WeatherTradingWindowAssessment
} from "./weatherTradingWindow.js";

export interface WeatherEdgeReportOptions extends WeatherPricingOptions {
  date?: string;
  daysAhead?: number;
  limit?: number;
  maxPages?: number;
  maxEvents?: number;
  concurrency?: number;
  minLiquidity?: number;
  includeExpired?: boolean;
  allowStartedDay?: boolean;
  now?: Date;
  highGraceMinutes?: number;
  lowGraceMinutes?: number;
  sizingStrategy?: WeatherPricingOptions["sizingStrategy"];
  maxGroupFraction?: number;
  portfolioStepUsd?: number;
}

export interface WeatherEdgeRow {
  eventSlug: string;
  eventTitle: string;
  eventEndDate?: string;
  city: string;
  date: string;
  measure: WeatherMeasure;
  marketSlug: string;
  question: string;
  outcomeLabel: string;
  bestSide: "YES" | "NO";
  signal: WeatherOutcomePricing["signal"];
  fairYes: number;
  fairNo: number;
  yesBid?: number;
  yesAsk?: number;
  noBid?: number;
  noAsk?: number;
  yesEdge?: number;
  noEdge?: number;
  bestEdge?: number;
  confidence: WeatherOutcomePricing["confidence"];
  kellyFraction: number;
  suggestedSizeUsd?: number;
  tokenId?: string;
  price?: number;
  liquidity?: number;
  volume?: number;
  resolutionSource?: string;
  forecastTargetMatched?: boolean;
  forecastStationId?: string;
  forecastStationName?: string;
  forecastCityDistanceKm?: number;
  consensusMeanC?: number;
  consensusSigmaC?: number;
  modelStdDevC?: number;
  agreement?: string;
  tradingWindow?: WeatherTradingWindowAssessment;
  reason: string;
}

export interface WeatherEdgeReport {
  targetDate: string;
  scannedGroups: number;
  targetGroups: number;
  pricedGroups: number;
  timeSkippedGroups: number;
  erroredGroups: number;
  marketCount: number;
  rowCount: number;
  signalCount: number;
  groups: WeatherPricingReport[];
  rows: WeatherEdgeRow[];
  signals: WeatherEdgeRow[];
  errors: Array<{ eventSlug: string; city: string; date: string; error: string }>;
}

function formatLocalIsoDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function localIsoDateDaysFrom(baseDate = new Date(), daysAhead = 1): string {
  const date = new Date(baseDate);
  date.setDate(date.getDate() + daysAhead);
  return formatLocalIsoDate(date);
}

export function filterWeatherGroupsForDate(groups: WeatherMarketGroup[], targetDate: string): WeatherMarketGroup[] {
  return groups
    .filter((group) => group.date === targetDate && group.markets.length > 0)
    .sort((a, b) => {
      const endDate = (a.eventEndDate ?? "").localeCompare(b.eventEndDate ?? "");
      if (endDate !== 0) return endDate;
      const city = a.city.localeCompare(b.city);
      if (city !== 0) return city;
      return a.measure.localeCompare(b.measure);
    });
}

function bestSide(outcome: WeatherOutcomePricing): "YES" | "NO" {
  return (outcome.yesEdge ?? -Infinity) >= (outcome.noEdge ?? -Infinity) ? "YES" : "NO";
}

export function buildWeatherEdgeRows(reports: WeatherPricingReport[]): WeatherEdgeRow[] {
  return reports
    .flatMap((report) => {
      const markets = new Map(report.markets.map((market) => [market.marketSlug, market]));
      return report.outcomes.map((outcome) => {
        const side = bestSide(outcome);
        const market = markets.get(outcome.marketSlug);
        return {
          eventSlug: report.group.eventSlug,
          eventTitle: report.group.eventTitle,
          eventEndDate: report.group.eventEndDate,
          city: report.group.city,
          date: report.group.date,
          measure: report.group.measure,
          marketSlug: outcome.marketSlug,
          question: outcome.question,
          outcomeLabel: outcome.outcomeLabel,
          bestSide: side,
          signal: outcome.signal,
          fairYes: outcome.fairYes,
          fairNo: outcome.fairNo,
          yesBid: outcome.yesBid,
          yesAsk: outcome.yesAsk,
          noBid: outcome.noBid,
          noAsk: outcome.noAsk,
          yesEdge: outcome.yesEdge,
          noEdge: outcome.noEdge,
          bestEdge: side === "YES" ? outcome.yesEdge : outcome.noEdge,
          confidence: outcome.confidence,
          kellyFraction: outcome.kellyFraction,
          suggestedSizeUsd: outcome.suggestedSizeUsd,
          tokenId: outcome.tokenId,
          price: outcome.price,
          liquidity: market?.liquidity,
          volume: market?.volume,
          resolutionSource: report.resolutionTarget?.resolutionSource,
          forecastTargetMatched: report.resolutionTarget?.matched,
          forecastStationId: report.resolutionTarget?.station?.id,
          forecastStationName: report.resolutionTarget?.station?.site,
          forecastCityDistanceKm: report.resolutionTarget?.cityDistanceKm,
          consensusMeanC: report.consensus?.meanC,
          consensusSigmaC: report.consensus?.sigmaC,
          modelStdDevC: report.consensus?.modelStdDevC,
          agreement: report.consensus?.agreement,
          tradingWindow: report.tradingWindow,
          reason: outcome.reason
        };
      });
    })
    .sort((a, b) => (b.bestEdge ?? -Infinity) - (a.bestEdge ?? -Infinity));
}

async function mapWithConcurrency<T, U>(
  items: T[],
  concurrency: number,
  task: (item: T) => Promise<U>
): Promise<U[]> {
  const results = new Array<U>(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, Math.trunc(concurrency)), items.length || 1);

  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await task(items[index]);
    }
  }));

  return results;
}

function pricingOptions(options: WeatherEdgeReportOptions): WeatherPricingOptions {
  return {
    bankrollUsd: options.bankrollUsd,
    maxPerTradeUsd: options.maxPerTradeUsd,
    kellyMultiplier: options.kellyMultiplier,
    maxKellyFraction: options.maxKellyFraction,
    minEdge: options.minEdge,
    noaaYears: options.noaaYears,
    skipClimatology: options.skipClimatology,
    noaaStationId: options.noaaStationId,
    noaaLocationId: options.noaaLocationId,
    countryCode: options.countryCode,
    allowCityForecast: options.allowCityForecast,
    sizingStrategy: options.sizingStrategy,
    maxGroupFraction: options.maxGroupFraction,
    portfolioStepUsd: options.portfolioStepUsd
  };
}

function assessReportTradingWindow(
  report: WeatherPricingReport,
  options: Pick<WeatherEdgeReportOptions, "now" | "highGraceMinutes" | "lowGraceMinutes">
): WeatherTradingWindowAssessment {
  const forecastLocation = report.resolutionTarget?.forecastLocation ?? report.location;
  const station = report.resolutionTarget?.station;
  return assessWeatherTradingWindow({
    targetDate: report.group.date,
    measure: report.group.measure,
    timezone: report.location.timezone,
    countryCode: forecastLocation.countryCode ?? station?.country,
    country: forecastLocation.country ?? station?.country,
    admin1: forecastLocation.admin1 ?? station?.state,
    state: station?.state,
    longitude: forecastLocation.longitude ?? station?.longitude,
    now: options.now,
    highGraceMinutes: options.highGraceMinutes,
    lowGraceMinutes: options.lowGraceMinutes
  });
}

export async function computeWeatherEdgeReport(
  config: AppConfig,
  options: WeatherEdgeReportOptions = {}
): Promise<WeatherEdgeReport> {
  const targetDate = options.date ?? localIsoDateDaysFrom(new Date(), options.daysAhead ?? 1);
  const groups = await fetchPolymarketWeatherMarkets(config, {
    limit: options.limit ?? 100,
    maxPages: options.maxPages ?? 20,
    includeExpired: options.includeExpired
  });
  const targetGroups = filterWeatherGroupsForDate(groups, targetDate);
  const maxEvents = options.maxEvents === undefined
    ? targetGroups.length
    : Math.max(0, Math.trunc(options.maxEvents));
  const selectedGroups = targetGroups.slice(0, maxEvents);
  const errors: WeatherEdgeReport["errors"] = [];
  const pricedReports = (await mapWithConcurrency(
    selectedGroups,
    options.concurrency ?? 2,
    async (group) => {
      try {
        return await priceWeatherMarketGroup(config, group, pricingOptions(options));
      } catch (error) {
        errors.push({
          eventSlug: group.eventSlug,
          city: group.city,
          date: group.date,
          error: error instanceof Error ? error.message : String(error)
        });
        return undefined;
      }
    }
  )).filter((report): report is WeatherPricingReport => report !== undefined);
  const reportsWithTiming = pricedReports.map((report) => ({
    ...report,
    tradingWindow: assessReportTradingWindow(report, options)
  }));
  const reports = options.allowStartedDay
    ? reportsWithTiming
    : reportsWithTiming.filter((report) => report.tradingWindow?.safeToTrade);

  const rows = buildWeatherEdgeRows(reports)
    .filter((row) => options.minLiquidity === undefined || (row.liquidity ?? 0) >= options.minLiquidity);
  const signalSlugs = new Set(rankWeatherSignals(reports).map((signal) => signal.marketSlug));
  const signals = rows.filter((row) => row.signal !== "SKIP" && signalSlugs.has(row.marketSlug));

  return {
    targetDate,
    scannedGroups: groups.length,
    targetGroups: targetGroups.length,
    pricedGroups: reports.length,
    timeSkippedGroups: reportsWithTiming.length - reports.length,
    erroredGroups: errors.length,
    marketCount: reports.reduce((sum, report) => sum + report.group.marketCount, 0),
    rowCount: rows.length,
    signalCount: signals.length,
    groups: reports,
    rows,
    signals,
    errors
  };
}
