import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { AppConfig } from "./config.js";
import {
  fetchWeatherEdgeSources,
  fetchNoaaObservations,
  resolveWeatherLocation,
  type NoaaNceiDailySummary,
  type NoaaNceiStation,
  type WeatherDailyPoint,
  type WeatherHourlyPoint,
  type WeatherLocation,
  type WeatherSourceId,
  type WeatherSourceResult
} from "./weatherEdge.js";
import {
  computeWeatherEdgeReport,
  filterWeatherGroupsForDate,
  localIsoDateDaysFrom,
  type WeatherEdgeReportOptions,
  type WeatherEdgeRow
} from "./weatherEdges.js";
import {
  fetchPolymarketWeatherMarkets,
  type WeatherMarketCandidate,
  type WeatherMeasure,
  type WeatherOutcomeKind
} from "./weatherMarkets.js";

export interface WeatherDatasetPaths {
  observationsPath: string;
  marketSnapshotsPath: string;
  forecastSnapshotsPath: string;
  previousRunForecastsPath: string;
  backtestRunsPath: string;
}

export interface JsonlWriteResult<T> {
  path: string;
  attempted: number;
  appended: number;
  skipped: number;
  records: T[];
}

export interface WeatherObservationRecord {
  id: string;
  source: "noaa_ncei";
  provider: "NOAA NCEI Climate Data Online";
  fetchedAt: string;
  city?: string;
  countryCode?: string;
  latitude: number;
  longitude: number;
  station?: Pick<NoaaNceiStation, "id" | "name" | "latitude" | "longitude" | "distanceKm" | "mindate" | "maxdate">;
  stationId?: string;
  date: string;
  maxTempC?: number;
  minTempC?: number;
  precipitationMm?: number;
  rawRecords: unknown[];
}

export interface WeatherMarketSnapshotRecord {
  id: string;
  source: "polymarket_gamma";
  capturedAt: string;
  eventSlug: string;
  eventTitle: string;
  eventEndDate?: string;
  city: string;
  date: string;
  measure: WeatherMeasure;
  marketSlug: string;
  question: string;
  resolutionSource?: string;
  conditionId?: string;
  active: boolean;
  closed: boolean;
  acceptingOrders?: boolean;
  negRisk?: boolean;
  bestBid?: number;
  bestAsk?: number;
  liquidity?: number;
  volume?: number;
  outcome: {
    kind: WeatherOutcomeKind;
    label: string;
    unit: "C" | "F";
    lowerTempC?: number;
    upperTempC?: number;
    exactTempC?: number;
    rawValue: number;
    rawUpperValue?: number;
  };
  tokens: Array<{ outcome: string; tokenId?: string; price?: number }>;
}

export interface WeatherForecastSnapshotRecord {
  id: string;
  source: WeatherSourceId;
  provider: string;
  model?: string;
  forecastCapturedAt: string;
  marketSnapshotCapturedAt: string;
  city: string;
  countryCode?: string;
  date: string;
  measure: WeatherMeasure;
  location?: Pick<WeatherLocation, "name" | "latitude" | "longitude" | "timezone" | "countryCode" | "country" | "admin1">;
  ok: boolean;
  skipped?: boolean;
  note?: string;
  error?: string;
  valueC?: number;
  dailyPoint?: WeatherDailyPoint;
  hourlyPoints?: WeatherHourlyPoint[];
}

export type OpenMeteoPreviousRunSourceId = Extract<
  WeatherSourceId,
  "openmeteo_gfs" | "openmeteo_ecmwf" | "openmeteo_ukmo"
>;

export interface WeatherPreviousRunForecastRecord {
  id: string;
  source: OpenMeteoPreviousRunSourceId;
  provider: string;
  model: string;
  collectedAt: string;
  city: string;
  countryCode?: string;
  date: string;
  measure: WeatherMeasure;
  leadDays: number;
  location?: Pick<WeatherLocation, "name" | "latitude" | "longitude" | "timezone" | "countryCode" | "country" | "admin1">;
  ok: boolean;
  valueC?: number;
  hourlyCount: number;
  note?: string;
  error?: string;
}

export interface WeatherBacktestRunRecord {
  id: string;
  source: "weatheredge";
  runAt: string;
  targetDate: string;
  options: WeatherEdgeReportOptions;
  summary: {
    scannedGroups: number;
    targetGroups: number;
    pricedGroups: number;
    erroredGroups: number;
    marketCount: number;
    rowCount: number;
    signalCount: number;
  };
  rows: WeatherEdgeRow[];
  signals: WeatherEdgeRow[];
  errors: Array<{ eventSlug: string; city: string; date: string; error: string }>;
}

export interface CollectWeatherObservationsOptions {
  city?: string;
  countryCode?: string;
  latitude?: number;
  longitude?: number;
  startDate: string;
  endDate: string;
  noaaStationId?: string;
  noaaLocationId?: string;
  path?: string;
  fetchedAt?: string;
}

export interface CollectWeatherMarketSnapshotsOptions {
  date?: string;
  daysAhead?: number;
  limit?: number;
  maxPages?: number;
  includeExpired?: boolean;
  path?: string;
  capturedAt?: string;
}

export interface CollectWeatherForecastSnapshotsOptions {
  marketSnapshotCapturedAt?: string;
  forecastCapturedAt?: string;
  path?: string;
  sources?: WeatherSourceId[];
  maxCities?: number;
  countryCodes?: Record<string, string | undefined>;
}

export interface CollectWeatherPreviousRunForecastsOptions {
  startDate: string;
  endDate: string;
  cities?: string[];
  countryCodes?: Record<string, string | undefined>;
  sources?: OpenMeteoPreviousRunSourceId[];
  leadDays?: number[];
  maxCities?: number;
  path?: string;
  collectedAt?: string;
}

export interface CollectWeatherBacktestRunOptions extends WeatherEdgeReportOptions {
  path?: string;
  runAt?: string;
}

export interface WeatherDatasetSummary {
  path: string;
  count: number;
  firstDate?: string;
  lastDate?: string;
  firstCapturedAt?: string;
  lastCapturedAt?: string;
  firstRunAt?: string;
  lastRunAt?: string;
  distinctMarkets?: number;
  distinctForecastKeys?: number;
  targetDates?: string[];
  sourceIds?: string[];
  leadDays?: number[];
}

const OPEN_METEO_PREVIOUS_RUN_MODELS: Record<
  OpenMeteoPreviousRunSourceId,
  { provider: string; model: string }
> = {
  openmeteo_gfs: {
    provider: "Open-Meteo Previous Runs / NOAA NCEP GFS",
    model: "gfs_seamless"
  },
  openmeteo_ecmwf: {
    provider: "Open-Meteo Previous Runs / ECMWF IFS",
    model: "ecmwf_ifs025"
  },
  openmeteo_ukmo: {
    provider: "Open-Meteo Previous Runs / UK Met Office",
    model: "ukmo_seamless"
  }
};

export const DEFAULT_WEATHER_MARKET_COUNTRY_CODES: Record<string, string> = {
  Amsterdam: "NL",
  Ankara: "TR",
  Atlanta: "US",
  Austin: "US",
  Beijing: "CN",
  "Buenos Aires": "AR",
  Busan: "KR",
  "Cape Town": "ZA",
  Chengdu: "CN",
  Chicago: "US",
  Chongqing: "CN",
  Dallas: "US",
  Denver: "US",
  Guangzhou: "CN",
  Helsinki: "FI",
  "Hong Kong": "HK",
  Houston: "US",
  Istanbul: "TR",
  Jeddah: "SA",
  Karachi: "PK",
  "Kuala Lumpur": "MY",
  London: "GB",
  "Los Angeles": "US",
  Lucknow: "IN",
  Madrid: "ES",
  Manila: "PH",
  "Mexico City": "MX",
  Miami: "US",
  Milan: "IT",
  Moscow: "RU",
  Munich: "DE",
  "New York City": "US",
  "Panama City": "PA",
  Paris: "FR",
  Qingdao: "CN",
  "San Francisco": "US",
  "Sao Paulo": "BR",
  Seattle: "US",
  Seoul: "KR",
  Shanghai: "CN",
  Shenzhen: "CN",
  Singapore: "SG",
  Taipei: "TW",
  "Tel Aviv": "IL",
  Tokyo: "JP",
  Toronto: "CA",
  Warsaw: "PL",
  Wellington: "NZ",
  Wuhan: "CN"
};

export function weatherDatasetPaths(config: AppConfig): WeatherDatasetPaths {
  return config.weather.datasets;
}

export async function readJsonlRecords<T>(path: string): Promise<T[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return [];
    throw error;
  }

  return raw
    .split(/\r?\n/)
    .flatMap((line, index) => {
      const trimmed = line.trim();
      if (!trimmed) return [];
      try {
        return [JSON.parse(trimmed) as T];
      } catch (error) {
        throw new Error(`Invalid JSONL at ${path}:${index + 1}: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
}

export async function appendJsonlRecordsUnique<T extends { id: string }>(
  path: string,
  records: T[]
): Promise<JsonlWriteResult<T>> {
  const existing = await readJsonlRecords<{ id?: unknown }>(path);
  const seen = new Set(existing.flatMap((record) => typeof record.id === "string" ? [record.id] : []));
  const appendable = records.filter((record) => {
    if (seen.has(record.id)) return false;
    seen.add(record.id);
    return true;
  });

  if (appendable.length > 0) {
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, appendable.map((record) => JSON.stringify(record)).join("\n") + "\n", "utf8");
  }

  return {
    path,
    attempted: records.length,
    appended: appendable.length,
    skipped: records.length - appendable.length,
    records: appendable
  };
}

export function buildWeatherObservationRecords(
  report: {
    provider: "NOAA NCEI Climate Data Online";
    ok: boolean;
    location: WeatherLocation;
    station?: NoaaNceiStation;
    daily: NoaaNceiDailySummary[];
  },
  fetchedAt: string
): WeatherObservationRecord[] {
  if (!report.ok) return [];

  return report.daily.map((point) => {
    const stationId = point.stationId ?? report.station?.id;
    return {
      id: [
        "noaa_ncei",
        stationId ?? `${report.location.latitude.toFixed(4)},${report.location.longitude.toFixed(4)}`,
        point.date
      ].join(":"),
      source: "noaa_ncei",
      provider: report.provider,
      fetchedAt,
      city: report.location.name,
      countryCode: report.location.countryCode,
      latitude: report.location.latitude,
      longitude: report.location.longitude,
      station: report.station
        ? {
          id: report.station.id,
          name: report.station.name,
          latitude: report.station.latitude,
          longitude: report.station.longitude,
          distanceKm: report.station.distanceKm,
          mindate: report.station.mindate,
          maxdate: report.station.maxdate
        }
        : undefined,
      stationId,
      date: point.date,
      maxTempC: point.maxTempC,
      minTempC: point.minTempC,
      precipitationMm: point.precipitationMm,
      rawRecords: point.raw
    };
  });
}

export function buildWeatherMarketSnapshotRecords(
  markets: WeatherMarketCandidate[],
  capturedAt: string
): WeatherMarketSnapshotRecord[] {
  return markets.map((market) => ({
    id: ["polymarket_gamma", capturedAt, market.marketSlug].join(":"),
    source: "polymarket_gamma",
    capturedAt,
    eventSlug: market.eventSlug,
    eventTitle: market.eventTitle,
    eventEndDate: market.eventEndDate,
    city: market.parsed.city,
    date: market.parsed.date,
    measure: market.parsed.measure,
    marketSlug: market.marketSlug,
    question: market.question,
    resolutionSource: market.resolutionSource,
    conditionId: market.conditionId,
    active: market.active,
    closed: market.closed,
    acceptingOrders: market.acceptingOrders,
    negRisk: market.negRisk,
    bestBid: market.bestBid,
    bestAsk: market.bestAsk,
    liquidity: market.liquidity,
    volume: market.volume,
    outcome: {
      kind: market.parsed.outcome.kind,
      label: market.parsed.outcome.label,
      unit: market.parsed.outcome.unit,
      lowerTempC: market.parsed.outcome.lowerTempC,
      upperTempC: market.parsed.outcome.upperTempC,
      exactTempC: market.parsed.outcome.exactTempC,
      rawValue: market.parsed.outcome.rawValue,
      rawUpperValue: market.parsed.outcome.rawUpperValue
    },
    tokens: market.outcomes
  }));
}

export function buildWeatherForecastSnapshotRecords(options: {
  marketSnapshotCapturedAt: string;
  forecastCapturedAt: string;
  city: string;
  countryCode?: string;
  targets: Array<{ date: string; measure: WeatherMeasure }>;
  location?: WeatherLocation;
  results: WeatherSourceResult[];
}): WeatherForecastSnapshotRecord[] {
  return options.results.flatMap((result) => {
    const sourceLocation = result.location ?? options.location;
    return options.targets.map((target) => {
      const dailyPoint = result.daily?.find((point) => point.date === target.date);
      const hourlyPoints = (result.hourly ?? []).filter((point) => point.time.slice(0, 10) === target.date);
      return {
        id: [
          "weather_forecast",
          options.marketSnapshotCapturedAt,
          options.forecastCapturedAt,
          options.city,
          target.date,
          target.measure,
          result.source
        ].join(":"),
        source: result.source,
        provider: result.provider,
        model: result.model,
        forecastCapturedAt: options.forecastCapturedAt,
        marketSnapshotCapturedAt: options.marketSnapshotCapturedAt,
        city: options.city,
        countryCode: options.countryCode,
        date: target.date,
        measure: target.measure,
        location: sourceLocation
          ? {
            name: sourceLocation.name,
            latitude: sourceLocation.latitude,
            longitude: sourceLocation.longitude,
            timezone: sourceLocation.timezone,
            countryCode: sourceLocation.countryCode,
            country: sourceLocation.country,
            admin1: sourceLocation.admin1
          }
          : undefined,
        ok: result.ok,
        skipped: result.skipped,
        note: result.note,
        error: result.error,
        valueC: forecastValueForMeasure(target.measure, dailyPoint, hourlyPoints),
        dailyPoint,
        hourlyPoints: hourlyPoints.length > 0 ? hourlyPoints : undefined
      };
    });
  });
}

export function buildWeatherPreviousRunForecastRecords(options: {
  collectedAt: string;
  city: string;
  countryCode?: string;
  location: WeatherLocation;
  source: OpenMeteoPreviousRunSourceId;
  provider: string;
  model: string;
  startDate: string;
  endDate: string;
  leadDays: number[];
  hourly: Record<string, unknown>;
  error?: string;
}): WeatherPreviousRunForecastRecord[] {
  const times = stringArray(options.hourly.time);
  const records: WeatherPreviousRunForecastRecord[] = [];

  for (const leadDays of options.leadDays) {
    const values = numberArray(options.hourly[`temperature_2m_previous_day${leadDays}`]);
    const valuesByDate = new Map<string, number[]>();

    times.forEach((time, index) => {
      const date = time.slice(0, 10);
      if (date < options.startDate || date > options.endDate) return;
      const value = values[index];
      if (value === undefined) return;
      const existing = valuesByDate.get(date) ?? [];
      existing.push(value);
      valuesByDate.set(date, existing);
    });

    for (const date of isoDatesBetween(options.startDate, options.endDate)) {
      const hourlyValues = valuesByDate.get(date) ?? [];
      for (const measure of ["temperature_high", "temperature_low"] as const) {
        const valueC = hourlyValues.length === 0
          ? undefined
          : measure === "temperature_high"
            ? Math.max(...hourlyValues)
            : Math.min(...hourlyValues);
        records.push({
          id: [
            "weather_previous_run",
            options.city,
            date,
            measure,
            options.source,
            `lead${leadDays}`
          ].join(":"),
          source: options.source,
          provider: options.provider,
          model: options.model,
          collectedAt: options.collectedAt,
          city: options.city,
          countryCode: options.countryCode,
          date,
          measure,
          leadDays,
          location: {
            name: options.location.name,
            latitude: options.location.latitude,
            longitude: options.location.longitude,
            timezone: options.location.timezone,
            countryCode: options.location.countryCode,
            country: options.location.country,
            admin1: options.location.admin1
          },
          ok: valueC !== undefined && !options.error,
          valueC,
          hourlyCount: hourlyValues.length,
          note: valueC === undefined ? "No previous-run temperature values returned for this date/lead." : undefined,
          error: options.error
        });
      }
    }
  }

  return records;
}

export async function collectWeatherObservationsDataset(
  config: AppConfig,
  options: CollectWeatherObservationsOptions
): Promise<{
  path: string;
  location: WeatherLocation;
  station?: WeatherObservationRecord["station"];
  ok: boolean;
  skipped?: boolean;
  note?: string;
  error?: string;
  write: JsonlWriteResult<WeatherObservationRecord>;
}> {
  if (options.startDate > options.endDate) throw new Error("--start-date must be before or equal to --end-date.");
  const location = await resolveWeatherLocation(config, {
    city: options.city,
    countryCode: options.countryCode,
    latitude: options.latitude,
    longitude: options.longitude
  });
  const report = await fetchNoaaObservations(config, location, {
    startDate: options.startDate,
    endDate: options.endDate,
    noaaStationId: options.noaaStationId,
    noaaLocationId: options.noaaLocationId
  });
  const records = buildWeatherObservationRecords(report, options.fetchedAt ?? new Date().toISOString());
  const write = await appendJsonlRecordsUnique(
    options.path ?? config.weather.datasets.observationsPath,
    records
  );

  return {
    path: write.path,
    location,
    station: records[0]?.station,
    ok: report.ok,
    skipped: report.skipped,
    note: report.note,
    error: report.error,
    write
  };
}

export async function collectWeatherMarketSnapshotsDataset(
  config: AppConfig,
  options: CollectWeatherMarketSnapshotsOptions = {}
): Promise<{
  path: string;
  capturedAt: string;
  targetDate?: string;
  scannedGroups: number;
  capturedGroups: number;
  write: JsonlWriteResult<WeatherMarketSnapshotRecord>;
}> {
  const capturedAt = options.capturedAt ?? new Date().toISOString();
  const targetDate = options.date ?? (
    options.daysAhead === undefined ? undefined : localIsoDateDaysFrom(new Date(), options.daysAhead)
  );
  const groups = await fetchPolymarketWeatherMarkets(config, {
    limit: options.limit,
    maxPages: options.maxPages,
    includeExpired: options.includeExpired
  });
  const selectedGroups = targetDate ? filterWeatherGroupsForDate(groups, targetDate) : groups;
  const records = buildWeatherMarketSnapshotRecords(
    selectedGroups.flatMap((group) => group.markets),
    capturedAt
  );
  const write = await appendJsonlRecordsUnique(
    options.path ?? config.weather.datasets.marketSnapshotsPath,
    records
  );

  return {
    path: write.path,
    capturedAt,
    targetDate,
    scannedGroups: groups.length,
    capturedGroups: selectedGroups.length,
    write
  };
}

export async function collectWeatherPreviousRunForecastsDataset(
  config: AppConfig,
  options: CollectWeatherPreviousRunForecastsOptions
): Promise<{
  path: string;
  collectedAt: string;
  startDate: string;
  endDate: string;
  cityCount: number;
  sourceIds: OpenMeteoPreviousRunSourceId[];
  leadDays: number[];
  write: JsonlWriteResult<WeatherPreviousRunForecastRecord>;
  errors: Array<{ city: string; source?: string; error: string }>;
}> {
  if (options.startDate > options.endDate) throw new Error("--start-date must be before or equal to --end-date.");
  const cities = (options.cities && options.cities.length > 0
    ? options.cities
    : await latestMarketSnapshotCities(config)
  ).slice(0, options.maxCities);
  const sourceIds = options.sources ?? ["openmeteo_gfs", "openmeteo_ecmwf", "openmeteo_ukmo"];
  const leadDays = (options.leadDays ?? [1]).map((value) => Math.max(1, Math.min(7, Math.trunc(value))));
  const collectedAt = options.collectedAt ?? new Date().toISOString();
  const records: WeatherPreviousRunForecastRecord[] = [];
  const errors: Array<{ city: string; source?: string; error: string }> = [];

  for (const city of cities) {
    const countryCode = options.countryCodes?.[city] ?? DEFAULT_WEATHER_MARKET_COUNTRY_CODES[city];
    let location: WeatherLocation;
    try {
      location = await resolveWeatherLocation(config, { city, countryCode });
    } catch (error) {
      errors.push({ city, error: error instanceof Error ? error.message : String(error) });
      continue;
    }

    for (const source of sourceIds) {
      const model = OPEN_METEO_PREVIOUS_RUN_MODELS[source];
      try {
        const raw = await fetchOpenMeteoPreviousRuns(config, location, {
          startDate: options.startDate,
          endDate: options.endDate,
          model: model.model,
          leadDays
        });
        records.push(...buildWeatherPreviousRunForecastRecords({
          collectedAt,
          city,
          countryCode,
          location,
          source,
          provider: model.provider,
          model: model.model,
          startDate: options.startDate,
          endDate: options.endDate,
          leadDays,
          hourly: raw
        }));
      } catch (error) {
        errors.push({
          city,
          source,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
  }

  const write = await appendJsonlRecordsUnique(
    options.path ?? config.weather.datasets.previousRunForecastsPath,
    records
  );

  return {
    path: write.path,
    collectedAt,
    startDate: options.startDate,
    endDate: options.endDate,
    cityCount: cities.length,
    sourceIds,
    leadDays,
    write,
    errors
  };
}

export async function collectWeatherForecastSnapshotsDataset(
  config: AppConfig,
  options: CollectWeatherForecastSnapshotsOptions = {}
): Promise<{
  path: string;
  forecastCapturedAt: string;
  marketSnapshotCapturedAt: string;
  scannedMarketRecords: number;
  targetGroups: number;
  cityCount: number;
  sourceIds: WeatherSourceId[];
  write: JsonlWriteResult<WeatherForecastSnapshotRecord>;
  errors: Array<{ city: string; error: string }>;
}> {
  const marketRecords = await readJsonlRecords<WeatherMarketSnapshotRecord>(config.weather.datasets.marketSnapshotsPath);
  if (marketRecords.length === 0) {
    throw new Error(`No market snapshot records found at ${config.weather.datasets.marketSnapshotsPath}. Run weather:dataset:markets first.`);
  }

  const marketSnapshotCapturedAt = options.marketSnapshotCapturedAt ?? maxString(
    marketRecords.map((record) => record.capturedAt)
  );
  if (!marketSnapshotCapturedAt) throw new Error("Could not determine latest market snapshot timestamp.");

  const selected = marketRecords.filter((record) => record.capturedAt === marketSnapshotCapturedAt);
  if (selected.length === 0) {
    throw new Error(`No market snapshot records found for capturedAt ${marketSnapshotCapturedAt}.`);
  }

  const targetsByCity = new Map<string, Array<{ date: string; measure: WeatherMeasure }>>();
  for (const record of selected) {
    const targets = targetsByCity.get(record.city) ?? [];
    if (!targets.some((target) => target.date === record.date && target.measure === record.measure)) {
      targets.push({ date: record.date, measure: record.measure });
    }
    targetsByCity.set(record.city, targets);
  }

  const cities = [...targetsByCity.keys()].sort().slice(0, options.maxCities);
  const forecastCapturedAt = options.forecastCapturedAt ?? new Date().toISOString();
  const sourceIds = options.sources ?? ["openmeteo_gfs", "openmeteo_ecmwf", "openmeteo_ukmo", "nws", "hko"];
  const records: WeatherForecastSnapshotRecord[] = [];
  const errors: Array<{ city: string; error: string }> = [];

  for (const city of cities) {
    const targets = targetsByCity.get(city) ?? [];
    try {
      const countryCode = options.countryCodes?.[city] ?? DEFAULT_WEATHER_MARKET_COUNTRY_CODES[city];
      const report = await fetchWeatherEdgeSources(config, {
        city,
        countryCode,
        days: forecastDaysForTargets(targets.map((target) => target.date)),
        sources: sourceIds
      });
      records.push(...buildWeatherForecastSnapshotRecords({
        marketSnapshotCapturedAt,
        forecastCapturedAt,
        city,
        countryCode,
        targets,
        location: report.location,
        results: report.results
      }));
    } catch (error) {
      errors.push({
        city,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  const write = await appendJsonlRecordsUnique(
    options.path ?? config.weather.datasets.forecastSnapshotsPath,
    records
  );

  return {
    path: write.path,
    forecastCapturedAt,
    marketSnapshotCapturedAt,
    scannedMarketRecords: selected.length,
    targetGroups: [...targetsByCity.values()].reduce((sum, targets) => sum + targets.length, 0),
    cityCount: cities.length,
    sourceIds,
    write,
    errors
  };
}

export async function collectWeatherBacktestRunDataset(
  config: AppConfig,
  options: CollectWeatherBacktestRunOptions = {}
): Promise<{
  path: string;
  runAt: string;
  write: JsonlWriteResult<WeatherBacktestRunRecord>;
  record: WeatherBacktestRunRecord;
}> {
  const { path, runAt: explicitRunAt, ...reportOptions } = options;
  const report = await computeWeatherEdgeReport(config, reportOptions);
  const runAt = explicitRunAt ?? new Date().toISOString();
  const record: WeatherBacktestRunRecord = {
    id: stableId("weatheredge", { runAt, targetDate: report.targetDate, options: reportOptions }),
    source: "weatheredge",
    runAt,
    targetDate: report.targetDate,
    options: reportOptions,
    summary: {
      scannedGroups: report.scannedGroups,
      targetGroups: report.targetGroups,
      pricedGroups: report.pricedGroups,
      erroredGroups: report.erroredGroups,
      marketCount: report.marketCount,
      rowCount: report.rowCount,
      signalCount: report.signalCount
    },
    rows: report.rows,
    signals: report.signals,
    errors: report.errors
  };
  const write = await appendJsonlRecordsUnique(
    path ?? config.weather.datasets.backtestRunsPath,
    [record]
  );

  return {
    path: write.path,
    runAt,
    write,
    record
  };
}

export async function summarizeWeatherDatasets(paths: WeatherDatasetPaths): Promise<{
  observations: WeatherDatasetSummary;
  marketSnapshots: WeatherDatasetSummary;
  forecastSnapshots: WeatherDatasetSummary;
  previousRunForecasts: WeatherDatasetSummary;
  backtestRuns: WeatherDatasetSummary;
}> {
  const [observations, marketSnapshots, forecastSnapshots, previousRunForecasts, backtestRuns] = await Promise.all([
    summarizeObservationDataset(paths.observationsPath),
    summarizeMarketSnapshotDataset(paths.marketSnapshotsPath),
    summarizeForecastSnapshotDataset(paths.forecastSnapshotsPath),
    summarizePreviousRunForecastDataset(paths.previousRunForecastsPath),
    summarizeBacktestRunDataset(paths.backtestRunsPath)
  ]);

  return { observations, marketSnapshots, forecastSnapshots, previousRunForecasts, backtestRuns };
}

async function summarizeObservationDataset(path: string): Promise<WeatherDatasetSummary> {
  const records = await readJsonlRecords<Partial<WeatherObservationRecord>>(path);
  const dates = records.flatMap((record) => typeof record.date === "string" ? [record.date] : []);
  return {
    path,
    count: records.length,
    firstDate: minString(dates),
    lastDate: maxString(dates)
  };
}

async function summarizeMarketSnapshotDataset(path: string): Promise<WeatherDatasetSummary> {
  const records = await readJsonlRecords<Partial<WeatherMarketSnapshotRecord>>(path);
  const capturedAt = records.flatMap((record) => typeof record.capturedAt === "string" ? [record.capturedAt] : []);
  const markets = new Set(records.flatMap((record) => typeof record.marketSlug === "string" ? [record.marketSlug] : []));
  const targetDates = uniqueSorted(records.flatMap((record) => typeof record.date === "string" ? [record.date] : []));
  return {
    path,
    count: records.length,
    firstCapturedAt: minString(capturedAt),
    lastCapturedAt: maxString(capturedAt),
    distinctMarkets: markets.size,
    targetDates
  };
}

async function summarizeForecastSnapshotDataset(path: string): Promise<WeatherDatasetSummary> {
  const records = await readJsonlRecords<Partial<WeatherForecastSnapshotRecord>>(path);
  const capturedAt = records.flatMap((record) => typeof record.forecastCapturedAt === "string" ? [record.forecastCapturedAt] : []);
  const targetDates = uniqueSorted(records.flatMap((record) => typeof record.date === "string" ? [record.date] : []));
  const sources = uniqueSorted(records.flatMap((record) => typeof record.source === "string" ? [record.source] : []));
  const keys = new Set(records.flatMap((record) => {
    if (
      typeof record.city !== "string" ||
      typeof record.date !== "string" ||
      typeof record.measure !== "string" ||
      typeof record.source !== "string"
    ) {
      return [];
    }
    return [`${record.city}|${record.date}|${record.measure}|${record.source}`];
  }));
  return {
    path,
    count: records.length,
    firstCapturedAt: minString(capturedAt),
    lastCapturedAt: maxString(capturedAt),
    distinctForecastKeys: keys.size,
    targetDates,
    sourceIds: sources
  };
}

async function summarizePreviousRunForecastDataset(path: string): Promise<WeatherDatasetSummary> {
  const records = await readJsonlRecords<Partial<WeatherPreviousRunForecastRecord>>(path);
  const dates = records.flatMap((record) => typeof record.date === "string" ? [record.date] : []);
  const collectedAt = records.flatMap((record) => typeof record.collectedAt === "string" ? [record.collectedAt] : []);
  const sources = uniqueSorted(records.flatMap((record) => typeof record.source === "string" ? [record.source] : []));
  const leadDays = uniqueNumbers(records.flatMap((record) => typeof record.leadDays === "number" ? [record.leadDays] : []));
  const keys = new Set(records.flatMap((record) => {
    if (
      typeof record.city !== "string" ||
      typeof record.date !== "string" ||
      typeof record.measure !== "string" ||
      typeof record.source !== "string" ||
      typeof record.leadDays !== "number"
    ) {
      return [];
    }
    return [`${record.city}|${record.date}|${record.measure}|${record.source}|${record.leadDays}`];
  }));
  return {
    path,
    count: records.length,
    firstDate: minString(dates),
    lastDate: maxString(dates),
    firstCapturedAt: minString(collectedAt),
    lastCapturedAt: maxString(collectedAt),
    distinctForecastKeys: keys.size,
    sourceIds: sources,
    leadDays
  };
}

async function summarizeBacktestRunDataset(path: string): Promise<WeatherDatasetSummary> {
  const records = await readJsonlRecords<Partial<WeatherBacktestRunRecord>>(path);
  const runTimes = records.flatMap((record) => typeof record.runAt === "string" ? [record.runAt] : []);
  const targetDates = uniqueSorted(records.flatMap((record) => typeof record.targetDate === "string" ? [record.targetDate] : []));
  return {
    path,
    count: records.length,
    firstRunAt: minString(runTimes),
    lastRunAt: maxString(runTimes),
    targetDates
  };
}

function forecastValueForMeasure(
  measure: WeatherMeasure,
  dailyPoint: WeatherDailyPoint | undefined,
  hourlyPoints: WeatherHourlyPoint[]
): number | undefined {
  if (dailyPoint) {
    return measure === "temperature_high" ? dailyPoint.maxTempC : dailyPoint.minTempC;
  }

  const values = hourlyPoints.flatMap((point) => point.tempC === undefined ? [] : [point.tempC]);
  if (values.length === 0) return undefined;
  return measure === "temperature_high" ? Math.max(...values) : Math.min(...values);
}

function forecastDaysForTargets(dates: string[]): number {
  const latestTarget = maxString(dates);
  if (!latestTarget) return 7;
  const targetEnd = Date.parse(`${latestTarget}T23:59:00Z`);
  if (!Number.isFinite(targetEnd)) return 7;
  return Math.max(1, Math.min(16, Math.ceil((targetEnd - Date.now()) / 86_400_000) + 1));
}

function stableId(prefix: string, value: unknown): string {
  return `${prefix}:${createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 24)}`;
}

function minString(values: string[]): string | undefined {
  return values.length > 0 ? [...values].sort()[0] : undefined;
}

function maxString(values: string[]): string | undefined {
  return values.length > 0 ? [...values].sort().at(-1) : undefined;
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort();
}

function uniqueNumbers(values: number[]): number[] {
  return [...new Set(values)].sort((a, b) => a - b);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function numberArray(value: unknown): Array<number | undefined> {
  return Array.isArray(value)
    ? value.map((item) => typeof item === "number" && Number.isFinite(item) ? item : undefined)
    : [];
}

function isoDatesBetween(startDate: string, endDate: string): string[] {
  const dates: string[] = [];
  let current = startDate;
  while (current <= endDate) {
    dates.push(current);
    current = addDaysIso(current, 1);
  }
  return dates;
}

function addDaysIso(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

async function latestMarketSnapshotCities(config: AppConfig): Promise<string[]> {
  const records = await readJsonlRecords<WeatherMarketSnapshotRecord>(config.weather.datasets.marketSnapshotsPath);
  const latest = maxString(records.map((record) => record.capturedAt));
  if (!latest) throw new Error(`No market snapshots found at ${config.weather.datasets.marketSnapshotsPath}.`);
  return uniqueSorted(records.filter((record) => record.capturedAt === latest).map((record) => record.city));
}

async function fetchOpenMeteoPreviousRuns(
  config: AppConfig,
  location: WeatherLocation,
  options: {
    startDate: string;
    endDate: string;
    model: string;
    leadDays: number[];
  }
): Promise<Record<string, unknown>> {
  const url = new URL(config.weather.openMeteoPreviousRunsUrl);
  url.searchParams.set("latitude", String(location.latitude));
  url.searchParams.set("longitude", String(location.longitude));
  url.searchParams.set("timezone", location.timezone ?? "auto");
  url.searchParams.set("temperature_unit", "celsius");
  url.searchParams.set("start_date", options.startDate);
  url.searchParams.set("end_date", options.endDate);
  url.searchParams.set("models", options.model);
  url.searchParams.set(
    "hourly",
    options.leadDays.map((leadDays) => `temperature_2m_previous_day${leadDays}`).join(",")
  );

  const response = await fetch(url);
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`${response.status} ${response.statusText}: ${body.replace(/\s+/g, " ").slice(0, 240)}`);
  }
  const raw = await response.json() as Record<string, unknown>;
  const hourly = raw.hourly;
  if (typeof hourly !== "object" || hourly === null || Array.isArray(hourly)) {
    throw new Error("Previous Runs response did not include an hourly object.");
  }
  return hourly as Record<string, unknown>;
}
