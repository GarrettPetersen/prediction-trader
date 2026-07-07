import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AppConfig } from "./config.js";

export const WEATHER_SOURCE_IDS = [
  "openmeteo_gfs",
  "openmeteo_ecmwf",
  "openmeteo_ukmo",
  "nws",
  "hko",
  "noaa_ncei"
] as const;

export type WeatherSourceId = typeof WEATHER_SOURCE_IDS[number];

export interface WeatherLocation {
  name?: string;
  latitude: number;
  longitude: number;
  timezone?: string;
  countryCode?: string;
  country?: string;
  admin1?: string;
  raw?: unknown;
}

export interface WeatherDailyPoint {
  date: string;
  minTempC?: number;
  maxTempC?: number;
  precipitationMm?: number;
  raw?: unknown;
}

export interface WeatherHourlyPoint {
  time: string;
  tempC?: number;
  precipitationMm?: number;
  precipitationProbabilityPct?: number;
  raw?: unknown;
}

export interface NoaaNceiStation {
  id: string;
  name?: string;
  latitude: number;
  longitude: number;
  mindate?: string;
  maxdate?: string;
  datacoverage?: number;
  distanceKm?: number;
  raw?: unknown;
}

export interface NoaaNceiDailySummary {
  date: string;
  stationId?: string;
  minTempC?: number;
  maxTempC?: number;
  precipitationMm?: number;
  raw: unknown[];
}

export interface WeatherClimatologyReport {
  provider: "NOAA NCEI Climate Data Online";
  ok: boolean;
  skipped?: boolean;
  note?: string;
  location: WeatherLocation;
  station?: NoaaNceiStation;
  targetDate: string;
  years: number;
  dates: string[];
  daily: NoaaNceiDailySummary[];
  maxTempC?: WeatherSampleSummary;
  minTempC?: WeatherSampleSummary;
  precipitationMm?: WeatherSampleSummary;
  error?: string;
}

export interface WeatherObservationReport {
  provider: "NOAA NCEI Climate Data Online";
  ok: boolean;
  skipped?: boolean;
  note?: string;
  location: WeatherLocation;
  station?: NoaaNceiStation;
  startDate: string;
  endDate: string;
  daily: NoaaNceiDailySummary[];
  error?: string;
}

export interface WeatherSampleSummary {
  count: number;
  mean: number;
  stdDev: number;
  min: number;
  max: number;
  values: number[];
}

export interface WeatherSourceResult {
  source: WeatherSourceId;
  provider: string;
  ok: boolean;
  skipped?: boolean;
  model?: string;
  url?: string;
  note?: string;
  location?: WeatherLocation;
  daily?: WeatherDailyPoint[];
  hourly?: WeatherHourlyPoint[];
  current?: unknown;
  historical?: unknown;
  raw?: unknown;
  error?: string;
}

export interface FetchWeatherEdgeSourcesOptions {
  city?: string;
  countryCode?: string;
  latitude?: number;
  longitude?: number;
  days?: number;
  sources?: WeatherSourceId[];
  noaaLocationId?: string;
  noaaStationId?: string;
  historyDate?: string;
}

export interface WeatherEdgeSourcesReport {
  location: WeatherLocation;
  requestedDays: number;
  sources: WeatherSourceId[];
  results: WeatherSourceResult[];
  summary: {
    ok: number;
    skipped: number;
    failed: number;
  };
}

const OPEN_METEO_MODELS: Record<
  Extract<WeatherSourceId, "openmeteo_gfs" | "openmeteo_ecmwf" | "openmeteo_ukmo">,
  { provider: string; model: string; maxDays: number }
> = {
  openmeteo_gfs: {
    provider: "Open-Meteo / NOAA NCEP GFS",
    model: "gfs_seamless",
    maxDays: 16
  },
  openmeteo_ecmwf: {
    provider: "Open-Meteo / ECMWF IFS",
    model: "ecmwf_ifs025",
    maxDays: 15
  },
  openmeteo_ukmo: {
    provider: "Open-Meteo / UK Met Office",
    model: "ukmo_seamless",
    maxDays: 7
  }
};
const NOAA_STATION_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const NOAA_RECENT_DATA_CACHE_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const NOAA_RECENT_DATA_WINDOW_DAYS = 14;
const memoryWeatherCache = new Map<string, unknown>();
const inflightWeatherCache = new Map<string, Promise<unknown>>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function unknownArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function arrayNumberAt(value: unknown, index: number): number | undefined {
  if (!Array.isArray(value)) return undefined;
  return numberValue(value[index]);
}

function arrayStringAt(value: unknown, index: number): string | undefined {
  if (!Array.isArray(value)) return undefined;
  return stringValue(value[index]);
}

function positiveInteger(value: number | undefined, defaultValue: number): number {
  if (value === undefined || !Number.isFinite(value)) return defaultValue;
  return Math.max(1, Math.trunc(value));
}

function endpointUrl(baseUrl: string, path = ""): URL {
  if (!path) return new URL(baseUrl);
  const cleanBase = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL(path, cleanBase);
}

async function fetchJson(url: URL, init?: RequestInit): Promise<unknown> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const response = await fetch(url, init);
    if (response.ok) return response.json() as Promise<unknown>;
    const body = await response.text();
    const trimmed = body.replace(/\s+/g, " ").slice(0, 240);
    if (response.status === 429 && attempt < 3) {
      await new Promise((resolve) => setTimeout(resolve, 1100));
      continue;
    }
    throw new Error(`${response.status} ${response.statusText}${trimmed ? `: ${trimmed}` : ""}`);
  }

  throw new Error("Request failed after retries.");
}

interface CacheEnvelope {
  cachedAt: string;
  value: unknown;
}

function weatherCachePath(config: AppConfig, namespace: string, key: string): string {
  const digest = createHash("sha256").update(key).digest("hex");
  return join(config.weather.cacheDir, namespace, `${digest}.json`);
}

function cacheIsFresh(envelope: CacheEnvelope, maxAgeMs?: number): boolean {
  if (maxAgeMs === undefined) return true;
  const cachedAt = Date.parse(envelope.cachedAt);
  if (!Number.isFinite(cachedAt)) return false;
  return Date.now() - cachedAt <= maxAgeMs;
}

async function readWeatherCache(
  config: AppConfig,
  namespace: string,
  key: string,
  maxAgeMs?: number
): Promise<unknown | undefined> {
  const memoryKey = `${namespace}:${key}`;
  if (memoryWeatherCache.has(memoryKey)) return memoryWeatherCache.get(memoryKey);

  try {
    const raw = await readFile(weatherCachePath(config, namespace, key), "utf8");
    const envelope = JSON.parse(raw) as CacheEnvelope;
    if (!cacheIsFresh(envelope, maxAgeMs)) return undefined;
    memoryWeatherCache.set(memoryKey, envelope.value);
    return envelope.value;
  } catch {
    return undefined;
  }
}

async function writeWeatherCache(
  config: AppConfig,
  namespace: string,
  key: string,
  value: unknown
): Promise<void> {
  try {
    const path = weatherCachePath(config, namespace, key);
    await mkdir(join(config.weather.cacheDir, namespace), { recursive: true });
    await writeFile(path, `${JSON.stringify({
      cachedAt: new Date().toISOString(),
      value
    })}\n`, "utf8");
  } catch {
    // Cache failures should never block a market scan.
  }
}

async function fetchCachedJson(
  config: AppConfig,
  namespace: string,
  url: URL,
  init?: RequestInit,
  options: { maxAgeMs?: number } = {}
): Promise<unknown> {
  const key = url.toString();
  const memoryKey = `${namespace}:${key}`;
  const cached = await readWeatherCache(config, namespace, key, options.maxAgeMs);
  if (cached !== undefined) return cached;

  const existing = inflightWeatherCache.get(memoryKey);
  if (existing) return existing;

  const request = (async () => {
    const value = await fetchJson(url, init);
    memoryWeatherCache.set(memoryKey, value);
    await writeWeatherCache(config, namespace, key, value);
    return value;
  })();

  inflightWeatherCache.set(memoryKey, request);
  try {
    return await request;
  } finally {
    inflightWeatherCache.delete(memoryKey);
  }
}

function isoDateValue(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(`${value.slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function daysBetween(later: string, earlier: string): number {
  const laterValue = isoDateValue(later);
  const earlierValue = isoDateValue(earlier);
  if (laterValue === undefined || earlierValue === undefined) return 0;
  return Math.max(0, (laterValue - earlierValue) / 86_400_000);
}

export function distanceKm(
  first: Pick<WeatherLocation, "latitude" | "longitude">,
  second: Pick<WeatherLocation, "latitude" | "longitude">
): number {
  const radiusKm = 6371;
  const toRad = (value: number) => value * Math.PI / 180;
  const dLat = toRad(second.latitude - first.latitude);
  const dLon = toRad(second.longitude - first.longitude);
  const lat1 = toRad(first.latitude);
  const lat2 = toRad(second.latitude);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * radiusKm * Math.asin(Math.sqrt(a));
}

export function parseWeatherSourceIds(values: string[]): WeatherSourceId[] {
  if (values.length === 0 || values.includes("all")) return [...WEATHER_SOURCE_IDS];

  return values.map((value) => {
    if ((WEATHER_SOURCE_IDS as readonly string[]).includes(value)) {
      return value as WeatherSourceId;
    }
    throw new Error(`Unknown weather source "${value}". Use all or one of: ${WEATHER_SOURCE_IDS.join(", ")}.`);
  });
}

export function fahrenheitToCelsius(value: number): number {
  return (value - 32) * 5 / 9;
}

function tempToCelsius(value: number | undefined, unit: unknown): number | undefined {
  if (value === undefined) return undefined;
  const normalizedUnit = typeof unit === "string" ? unit.toUpperCase() : "C";
  return normalizedUnit === "F" ? fahrenheitToCelsius(value) : value;
}

export function normalizeOpenMeteoDaily(raw: unknown): WeatherDailyPoint[] {
  const daily = asRecord(asRecord(raw).daily);
  const times = stringArray(daily.time);

  return times.map((date, index) => ({
    date,
    minTempC: arrayNumberAt(daily.temperature_2m_min, index),
    maxTempC: arrayNumberAt(daily.temperature_2m_max, index),
    precipitationMm: arrayNumberAt(daily.precipitation_sum, index)
  }));
}

export function normalizeOpenMeteoHourly(raw: unknown): WeatherHourlyPoint[] {
  const hourly = asRecord(asRecord(raw).hourly);
  const times = stringArray(hourly.time);

  return times.map((time, index) => ({
    time,
    tempC: arrayNumberAt(hourly.temperature_2m, index),
    precipitationMm: arrayNumberAt(hourly.precipitation, index),
    precipitationProbabilityPct: arrayNumberAt(hourly.precipitation_probability, index)
  }));
}

export function looksLikeHongKongLocation(location: WeatherLocation): boolean {
  if (location.countryCode?.toUpperCase() === "HK") return true;
  if (/hong kong/i.test(location.name ?? "")) return true;
  return location.latitude >= 22 &&
    location.latitude <= 23 &&
    location.longitude >= 113 &&
    location.longitude <= 115;
}

function shouldAttemptNws(location: WeatherLocation): boolean {
  if (location.countryCode) return location.countryCode.toUpperCase() === "US";
  return location.latitude >= 18 &&
    location.latitude <= 72 &&
    location.longitude >= -170 &&
    location.longitude <= -50;
}

export async function geocodeWeatherLocation(
  config: AppConfig,
  city: string,
  countryCode?: string
): Promise<WeatherLocation> {
  const url = endpointUrl(config.weather.openMeteoGeocodingUrl, "search");
  url.searchParams.set("name", city);
  url.searchParams.set("count", "1");
  url.searchParams.set("language", "en");
  url.searchParams.set("format", "json");
  if (countryCode) url.searchParams.set("countryCode", countryCode.toUpperCase());

  const raw = await fetchJson(url);
  const first = unknownArray(asRecord(raw).results)[0];
  const result = asRecord(first);
  const latitude = numberValue(result.latitude);
  const longitude = numberValue(result.longitude);
  if (latitude === undefined || longitude === undefined) {
    throw new Error(`Could not geocode weather location "${city}".`);
  }

  return {
    name: stringValue(result.name) ?? city,
    latitude,
    longitude,
    timezone: stringValue(result.timezone),
    countryCode: stringValue(result.country_code)?.toUpperCase() ?? countryCode?.toUpperCase(),
    country: stringValue(result.country),
    admin1: stringValue(result.admin1),
    raw: result
  };
}

export async function resolveWeatherLocation(
  config: AppConfig,
  options: FetchWeatherEdgeSourcesOptions
): Promise<WeatherLocation> {
  const countryCode = options.countryCode?.toUpperCase();
  if (options.latitude !== undefined || options.longitude !== undefined) {
    if (options.latitude === undefined || options.longitude === undefined) {
      throw new Error("Pass both --latitude and --longitude, or pass neither and use --city.");
    }
    return {
      name: options.city,
      latitude: options.latitude,
      longitude: options.longitude,
      countryCode
    };
  }

  if (!options.city) throw new Error("Pass --city or both --latitude and --longitude.");
  return geocodeWeatherLocation(config, options.city, countryCode);
}

async function fetchOpenMeteoModel(
  config: AppConfig,
  source: Extract<WeatherSourceId, "openmeteo_gfs" | "openmeteo_ecmwf" | "openmeteo_ukmo">,
  location: WeatherLocation,
  requestedDays: number
): Promise<WeatherSourceResult> {
  const model = OPEN_METEO_MODELS[source];
  const forecastDays = Math.min(requestedDays, model.maxDays);
  const url = endpointUrl(config.weather.openMeteoForecastUrl);
  url.searchParams.set("latitude", String(location.latitude));
  url.searchParams.set("longitude", String(location.longitude));
  url.searchParams.set("timezone", location.timezone ?? "auto");
  url.searchParams.set("temperature_unit", "celsius");
  url.searchParams.set("precipitation_unit", "mm");
  url.searchParams.set("forecast_days", String(forecastDays));
  url.searchParams.set("models", model.model);
  url.searchParams.set("current", "temperature_2m,precipitation,weather_code");
  url.searchParams.set("daily", "temperature_2m_max,temperature_2m_min,precipitation_sum");
  url.searchParams.set("hourly", "temperature_2m,precipitation");

  const raw = await fetchJson(url);
  return {
    source,
    provider: model.provider,
    ok: true,
    model: model.model,
    url: url.toString(),
    location,
    daily: normalizeOpenMeteoDaily(raw),
    hourly: normalizeOpenMeteoHourly(raw),
    current: asRecord(raw).current,
    note: forecastDays < requestedDays
      ? `Capped at ${forecastDays} days because this model family has a shorter horizon.`
      : undefined,
    raw
  };
}

function normalizeNwsHourly(raw: unknown): WeatherHourlyPoint[] {
  const periods = unknownArray(asRecord(asRecord(raw).properties).periods);
  return periods.flatMap((period) => {
    const record = asRecord(period);
    const time = stringValue(record.startTime);
    if (!time) return [];

    const precip = asRecord(record.probabilityOfPrecipitation);
    return [{
      time,
      tempC: tempToCelsius(numberValue(record.temperature), record.temperatureUnit),
      precipitationProbabilityPct: numberValue(precip.value),
      raw: record
    }];
  });
}

async function fetchNwsForecast(
  config: AppConfig,
  location: WeatherLocation,
  requestedDays: number
): Promise<WeatherSourceResult> {
  const source: WeatherSourceId = "nws";
  if (!shouldAttemptNws(location)) {
    return {
      source,
      provider: "U.S. National Weather Service",
      ok: false,
      skipped: true,
      location,
      note: "NWS api.weather.gov forecasts are U.S.-only; pass a U.S. location to fetch this source."
    };
  }

  const headers = {
    "User-Agent": config.weather.nwsUserAgent,
    Accept: "application/geo+json"
  };
  const pointsUrl = endpointUrl(config.weather.nwsApiUrl, `points/${location.latitude},${location.longitude}`);
  const points = await fetchJson(pointsUrl, { headers });
  const hourlyUrlRaw = stringValue(asRecord(asRecord(points).properties).forecastHourly);
  if (!hourlyUrlRaw) throw new Error("NWS /points response did not include forecastHourly.");

  const hourlyUrl = new URL(hourlyUrlRaw);
  const raw = await fetchJson(hourlyUrl, { headers });
  return {
    source,
    provider: "U.S. National Weather Service",
    ok: true,
    url: hourlyUrl.toString(),
    location,
    hourly: normalizeNwsHourly(raw).slice(0, requestedDays * 24),
    raw
  };
}

function parseHkoDate(value: unknown): string | undefined {
  const raw = stringValue(value);
  if (!raw) return undefined;
  const compact = raw.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}`;
  return raw;
}

function normalizeHkoForecast(raw: unknown): WeatherDailyPoint[] {
  return unknownArray(asRecord(raw).weatherForecast).flatMap((item) => {
    const record = asRecord(item);
    const date = parseHkoDate(record.forecastDate);
    if (!date) return [];
    const max = asRecord(record.forecastMaxtemp);
    const min = asRecord(record.forecastMintemp);
    return [{
      date,
      minTempC: tempToCelsius(numberValue(min.value), min.unit),
      maxTempC: tempToCelsius(numberValue(max.value), max.unit),
      raw: record
    }];
  });
}

function normalizeHkoCurrent(raw: unknown): unknown {
  const temperatures = unknownArray(asRecord(asRecord(raw).temperature).data);
  const firstHko = temperatures.find((item) => /observatory/i.test(stringValue(asRecord(item).place) ?? ""));
  const chosen = asRecord(firstHko ?? temperatures[0]);
  const value = tempToCelsius(numberValue(chosen.value), chosen.unit);
  if (value === undefined) return asRecord(raw).temperature;

  return {
    tempC: value,
    place: stringValue(chosen.place),
    recordTime: stringValue(asRecord(asRecord(raw).temperature).recordTime)
  };
}

async function fetchHkoForecast(
  config: AppConfig,
  location: WeatherLocation,
  requestedDays: number
): Promise<WeatherSourceResult> {
  const source: WeatherSourceId = "hko";
  if (!looksLikeHongKongLocation(location)) {
    return {
      source,
      provider: "Hong Kong Observatory",
      ok: false,
      skipped: true,
      location,
      note: "HKO is Hong Kong-specific; pass --city \"Hong Kong\" --country HK to fetch it."
    };
  }

  const forecastUrl = endpointUrl(config.weather.hkoApiUrl);
  forecastUrl.searchParams.set("dataType", "fnd");
  forecastUrl.searchParams.set("lang", "en");

  const currentUrl = endpointUrl(config.weather.hkoApiUrl);
  currentUrl.searchParams.set("dataType", "rhrread");
  currentUrl.searchParams.set("lang", "en");

  const [forecastRaw, currentRaw] = await Promise.all([
    fetchJson(forecastUrl),
    fetchJson(currentUrl)
  ]);

  return {
    source,
    provider: "Hong Kong Observatory",
    ok: true,
    url: forecastUrl.toString(),
    location,
    daily: normalizeHkoForecast(forecastRaw).slice(0, requestedDays),
    current: normalizeHkoCurrent(currentRaw),
    raw: {
      forecast: forecastRaw,
      current: currentRaw
    }
  };
}

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function noaaExtent(location: WeatherLocation, radiusKm: number): string {
  const latDelta = radiusKm / 111;
  const lonDelta = radiusKm / (111 * Math.max(0.2, Math.cos(location.latitude * Math.PI / 180)));
  const south = location.latitude - latDelta;
  const north = location.latitude + latDelta;
  const west = location.longitude - lonDelta;
  const east = location.longitude + lonDelta;
  return [south, west, north, east].map((value) => value.toFixed(4)).join(",");
}

export function normalizeNoaaStations(raw: unknown, location: WeatherLocation): NoaaNceiStation[] {
  return unknownArray(asRecord(raw).results).flatMap((item) => {
    const record = asRecord(item);
    const id = stringValue(record.id);
    const latitude = numberValue(record.latitude);
    const longitude = numberValue(record.longitude);
    if (!id || latitude === undefined || longitude === undefined) return [];

    const station = {
      id,
      name: stringValue(record.name),
      latitude,
      longitude,
      mindate: stringValue(record.mindate),
      maxdate: stringValue(record.maxdate),
      datacoverage: numberValue(record.datacoverage),
      raw: record
    };
    return [{
      ...station,
      distanceKm: distanceKm(location, station)
    }];
  });
}

function stationCoversDate(station: NoaaNceiStation, date: string): boolean {
  const target = isoDateValue(date);
  const min = isoDateValue(station.mindate);
  const max = isoDateValue(station.maxdate);
  if (target === undefined) return true;
  return (min === undefined || min <= target) && (max === undefined || max >= target);
}

export function selectBestNoaaStation(
  stations: NoaaNceiStation[],
  location: WeatherLocation,
  targetDate = todayIsoDate()
): NoaaNceiStation | undefined {
  const scored = stations.map((station) => {
    const stationDistanceKm = station.distanceKm ?? distanceKm(location, station);
    const ageDays = station.maxdate ? daysBetween(targetDate, station.maxdate) : 3650;
    const outsideDatePenalty = stationCoversDate(station, targetDate) ? 0 : 10_000;
    const coveragePenalty = station.datacoverage === undefined ? 0 : (1 - station.datacoverage) * 25;
    return {
      station: {
        ...station,
        distanceKm: stationDistanceKm
      },
      score: stationDistanceKm + ageDays + outsideDatePenalty + coveragePenalty
    };
  });

  return scored.sort((a, b) => a.score - b.score)[0]?.station;
}

async function discoverNoaaStation(
  config: AppConfig,
  location: WeatherLocation,
  token: string,
  targetDate: string
): Promise<NoaaNceiStation | undefined> {
  for (const radiusKm of [100, 250, 500]) {
    const url = endpointUrl(config.weather.noaaCdoApiUrl, "stations");
    url.searchParams.set("datasetid", "GHCND");
    url.searchParams.set("datatypeid", "TMAX");
    url.searchParams.set("extent", noaaExtent(location, radiusKm));
    url.searchParams.set("limit", "1000");

    const raw = await fetchCachedJson(
      config,
      "noaa-stations",
      url,
      { headers: { token } },
      { maxAgeMs: NOAA_STATION_CACHE_MAX_AGE_MS }
    );
    const stations = normalizeNoaaStations(raw, location);
    const best = selectBestNoaaStation(stations, location, targetDate);
    if (best) return best;
  }

  return undefined;
}

export function normalizeNoaaDailySummaries(records: unknown[]): NoaaNceiDailySummary[] {
  const byDate = new Map<string, NoaaNceiDailySummary>();
  for (const item of records) {
    const record = asRecord(item);
    const date = stringValue(record.date)?.slice(0, 10);
    const datatype = stringValue(record.datatype);
    const value = numberValue(record.value);
    if (!date || !datatype || value === undefined) continue;

    const existing = byDate.get(date) ?? {
      date,
      stationId: stringValue(record.station),
      raw: []
    };
    existing.raw.push(record);
    if (datatype === "TMAX") existing.maxTempC = value;
    if (datatype === "TMIN") existing.minTempC = value;
    if (datatype === "PRCP") existing.precipitationMm = value;
    byDate.set(date, existing);
  }

  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function calendarDateForYear(targetDate: string, year: number): string {
  const monthDay = targetDate.slice(5, 10);
  if (monthDay === "02-29") return `${year}-02-${isLeapYear(year) ? "29" : "28"}`;
  return `${year}-${monthDay}`;
}

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function summarizeWeatherSamples(values: number[]): WeatherSampleSummary | undefined {
  if (values.length === 0) return undefined;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return {
    count: values.length,
    mean,
    stdDev: Math.sqrt(variance),
    min: Math.min(...values),
    max: Math.max(...values),
    values
  };
}

function noaaDataCacheMaxAge(endDate: string): number | undefined {
  const end = isoDateValue(endDate);
  if (end === undefined) return NOAA_RECENT_DATA_CACHE_MAX_AGE_MS;
  const ageDays = (Date.now() - end) / 86_400_000;
  return ageDays <= NOAA_RECENT_DATA_WINDOW_DAYS
    ? NOAA_RECENT_DATA_CACHE_MAX_AGE_MS
    : undefined;
}

async function fetchNoaaDataRecords(
  config: AppConfig,
  token: string,
  options: {
    startDate: string;
    endDate: string;
    stationId?: string;
    locationId?: string;
  }
): Promise<unknown[]> {
  const records: unknown[] = [];
  const limit = 1000;

  for (let page = 0; page < 100; page += 1) {
    const url = buildNoaaDataUrl(config, {
      ...options,
      limit,
      offset: page === 0 ? undefined : records.length + 1
    });
    const raw = await fetchCachedJson(
      config,
      "noaa-data",
      url,
      { headers: { token } },
      { maxAgeMs: noaaDataCacheMaxAge(options.endDate) }
    );
    const pageRecords = unknownArray(asRecord(raw).results);
    records.push(...pageRecords);
    if (pageRecords.length < limit) break;
    await new Promise((resolve) => setTimeout(resolve, 220));
  }

  return records;
}

function buildNoaaDataUrl(
  config: AppConfig,
  options: {
    startDate: string;
    endDate: string;
    stationId?: string;
    locationId?: string;
    limit?: number;
    offset?: number;
  }
): URL {
  const url = endpointUrl(config.weather.noaaCdoApiUrl, "data");
  url.searchParams.set("datasetid", "GHCND");
  url.searchParams.set("datatypeid", "TMAX,TMIN,PRCP");
  url.searchParams.set("units", "metric");
  url.searchParams.set("startdate", options.startDate);
  url.searchParams.set("enddate", options.endDate);
  url.searchParams.set("limit", String(options.limit ?? 1000));
  url.searchParams.set("includemetadata", "false");
  if (options.offset !== undefined) url.searchParams.set("offset", String(options.offset));
  if (options.locationId) url.searchParams.set("locationid", options.locationId);
  if (options.stationId) url.searchParams.set("stationid", options.stationId);
  return url;
}

async function fetchNoaaDailyForDate(
  config: AppConfig,
  token: string,
  date: string,
  stationId?: string,
  locationId?: string
): Promise<NoaaNceiDailySummary[]> {
  const records = await fetchNoaaDataRecords(config, token, {
    startDate: date,
    endDate: date,
    stationId,
    locationId
  });
  return normalizeNoaaDailySummaries(records);
}

async function fetchNoaaDailyRange(
  config: AppConfig,
  token: string,
  startDate: string,
  endDate: string,
  stationId?: string,
  locationId?: string
): Promise<NoaaNceiDailySummary[]> {
  const records: unknown[] = [];
  let segmentStart = startDate;

  while (segmentStart <= endDate) {
    const segmentEnd = minIsoDate(addDaysIso(segmentStart, 364), endDate);
    records.push(...await fetchNoaaDataRecords(config, token, {
      startDate: segmentStart,
      endDate: segmentEnd,
      stationId,
      locationId
    }));
    segmentStart = addDaysIso(segmentEnd, 1);
    if (segmentStart <= endDate) {
      await new Promise((resolve) => setTimeout(resolve, 220));
    }
  }

  return normalizeNoaaDailySummaries(records);
}

function addDaysIso(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function minIsoDate(first: string, second: string): string {
  return first <= second ? first : second;
}

export async function fetchNoaaObservations(
  config: AppConfig,
  location: WeatherLocation,
  options: {
    startDate: string;
    endDate: string;
    noaaStationId?: string;
    noaaLocationId?: string;
  }
): Promise<WeatherObservationReport> {
  const token = config.weather.noaaCdoToken;
  if (!token) {
    return {
      provider: "NOAA NCEI Climate Data Online",
      ok: false,
      skipped: true,
      location,
      startDate: options.startDate,
      endDate: options.endDate,
      daily: [],
      note: "NOAA CDO requires NOAA_CDO_TOKEN."
    };
  }

  try {
    const station = options.noaaStationId || options.noaaLocationId
      ? undefined
      : await discoverNoaaStation(config, location, token, options.endDate);
    const stationId = options.noaaStationId ?? station?.id;

    if (!stationId && !options.noaaLocationId) {
      return {
        provider: "NOAA NCEI Climate Data Online",
        ok: false,
        skipped: true,
        location,
        startDate: options.startDate,
        endDate: options.endDate,
        daily: [],
        note: "NOAA CDO could not find a nearby GHCND station with TMAX coverage."
      };
    }

    const daily = await fetchNoaaDailyRange(
      config,
      token,
      options.startDate,
      options.endDate,
      stationId,
      options.noaaLocationId
    );

    return {
      provider: "NOAA NCEI Climate Data Online",
      ok: true,
      location,
      station,
      startDate: options.startDate,
      endDate: options.endDate,
      daily,
      note: station
        ? `Auto-selected station ${station.id}${station.name ? ` (${station.name})` : ""}${station.distanceKm === undefined ? "" : ` ${station.distanceKm.toFixed(1)} km away`}.`
        : undefined
    };
  } catch (error) {
    return {
      provider: "NOAA NCEI Climate Data Online",
      ok: false,
      location,
      startDate: options.startDate,
      endDate: options.endDate,
      daily: [],
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

export async function fetchNoaaClimatology(
  config: AppConfig,
  location: WeatherLocation,
  options: {
    targetDate: string;
    years?: number;
    noaaStationId?: string;
    noaaLocationId?: string;
  }
): Promise<WeatherClimatologyReport> {
  const token = config.weather.noaaCdoToken;
  if (!token) {
    return {
      provider: "NOAA NCEI Climate Data Online",
      ok: false,
      skipped: true,
      location,
      targetDate: options.targetDate,
      years: options.years ?? 10,
      dates: [],
      daily: [],
      note: "NOAA CDO requires NOAA_CDO_TOKEN."
    };
  }

  try {
    const years = Math.max(1, Math.min(30, Math.trunc(options.years ?? 10)));
    const targetYear = Number(options.targetDate.slice(0, 4));
    const dates = Array.from({ length: years }, (_, index) => calendarDateForYear(options.targetDate, targetYear - index - 1));
    const station = options.noaaStationId || options.noaaLocationId
      ? undefined
      : await discoverNoaaStation(config, location, token, todayIsoDate());
    const stationId = options.noaaStationId ?? station?.id;

    if (!stationId && !options.noaaLocationId) {
      return {
        provider: "NOAA NCEI Climate Data Online",
        ok: false,
        skipped: true,
        location,
        targetDate: options.targetDate,
        years,
        dates,
        daily: [],
        note: "NOAA CDO could not find a nearby GHCND station with TMAX coverage."
      };
    }

    const daily: NoaaNceiDailySummary[] = [];
    for (let index = 0; index < dates.length; index += 1) {
      const date = dates[index];
      daily.push(...await fetchNoaaDailyForDate(
        config,
        token,
        date,
        stationId,
        options.noaaLocationId
      ));
      if (index < dates.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 220));
      }
    }

    const maxValues = daily.flatMap((point) => point.maxTempC === undefined ? [] : [point.maxTempC]);
    const minValues = daily.flatMap((point) => point.minTempC === undefined ? [] : [point.minTempC]);
    const precipValues = daily.flatMap((point) => point.precipitationMm === undefined ? [] : [point.precipitationMm]);

    return {
      provider: "NOAA NCEI Climate Data Online",
      ok: true,
      location,
      station,
      targetDate: options.targetDate,
      years,
      dates,
      daily,
      maxTempC: summarizeWeatherSamples(maxValues),
      minTempC: summarizeWeatherSamples(minValues),
      precipitationMm: summarizeWeatherSamples(precipValues),
      note: station
        ? `Auto-selected station ${station.id}${station.name ? ` (${station.name})` : ""}${station.distanceKm === undefined ? "" : ` ${station.distanceKm.toFixed(1)} km away`}.`
        : undefined
    };
  } catch (error) {
    return {
      provider: "NOAA NCEI Climate Data Online",
      ok: false,
      location,
      targetDate: options.targetDate,
      years: options.years ?? 10,
      dates: [],
      daily: [],
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function fetchNoaaNceiHistory(
  config: AppConfig,
  location: WeatherLocation,
  options: FetchWeatherEdgeSourcesOptions
): Promise<WeatherSourceResult> {
  const source: WeatherSourceId = "noaa_ncei";
  if (!config.weather.noaaCdoToken) {
    return {
      source,
      provider: "NOAA NCEI Climate Data Online",
      ok: false,
      skipped: true,
      location,
      note: "NOAA CDO requires NOAA_CDO_TOKEN. Request one from NCEI, add it to .env, then rerun."
    };
  }

  const token = config.weather.noaaCdoToken;
  const locationId = options.noaaLocationId;
  let stationId = options.noaaStationId;
  let station: NoaaNceiStation | undefined;
  const targetDate = options.historyDate ?? todayIsoDate();
  if (!locationId && !stationId) {
    station = await discoverNoaaStation(config, location, token, targetDate);
    stationId = station?.id;
  }

  if (!locationId && !stationId) {
    return {
      source,
      provider: "NOAA NCEI Climate Data Online",
      ok: false,
      skipped: true,
      location,
      note: "NOAA CDO could not find a nearby GHCND station with TMAX coverage. Pass --ncei-location or --ncei-station to force one."
    };
  }

  const date = options.historyDate ?? station?.maxdate ?? targetDate;
  const dataParams = {
    startDate: date,
    endDate: date,
    stationId,
    locationId
  };
  const records = await fetchNoaaDataRecords(config, token, dataParams);
  const daily = normalizeNoaaDailySummaries(records);
  return {
    source,
    provider: "NOAA NCEI Climate Data Online",
    ok: true,
    url: buildNoaaDataUrl(config, dataParams).toString(),
    location,
    note: station
      ? `Auto-selected station ${station.id}${station.name ? ` (${station.name})` : ""}${station.distanceKm === undefined ? "" : ` ${station.distanceKm.toFixed(1)} km away`}; using ${date}.`
      : undefined,
    historical: {
      date,
      station,
      records,
      daily
    }
  };
}

async function fetchWeatherSource(
  config: AppConfig,
  source: WeatherSourceId,
  location: WeatherLocation,
  requestedDays: number,
  options: FetchWeatherEdgeSourcesOptions
): Promise<WeatherSourceResult> {
  try {
    if (source === "openmeteo_gfs" || source === "openmeteo_ecmwf" || source === "openmeteo_ukmo") {
      return await fetchOpenMeteoModel(config, source, location, requestedDays);
    }
    if (source === "nws") return await fetchNwsForecast(config, location, requestedDays);
    if (source === "hko") return await fetchHkoForecast(config, location, requestedDays);
    return await fetchNoaaNceiHistory(config, location, options);
  } catch (error) {
    return {
      source,
      provider: providerName(source),
      ok: false,
      location,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function providerName(source: WeatherSourceId): string {
  if (source === "openmeteo_gfs" || source === "openmeteo_ecmwf" || source === "openmeteo_ukmo") {
    return OPEN_METEO_MODELS[source].provider;
  }
  if (source === "nws") return "U.S. National Weather Service";
  if (source === "hko") return "Hong Kong Observatory";
  return "NOAA NCEI Climate Data Online";
}

export async function fetchWeatherEdgeSources(
  config: AppConfig,
  options: FetchWeatherEdgeSourcesOptions
): Promise<WeatherEdgeSourcesReport> {
  const location = await resolveWeatherLocation(config, options);
  const requestedDays = positiveInteger(options.days, 7);
  const sources = options.sources ?? [...WEATHER_SOURCE_IDS];
  const results = await Promise.all(
    sources.map((source) => fetchWeatherSource(config, source, location, requestedDays, options))
  );

  return {
    location,
    requestedDays,
    sources,
    results,
    summary: {
      ok: results.filter((result) => result.ok).length,
      skipped: results.filter((result) => result.skipped).length,
      failed: results.filter((result) => !result.ok && !result.skipped).length
    }
  };
}
