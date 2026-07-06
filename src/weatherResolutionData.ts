import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AppConfig } from "./config.js";
import { fahrenheitToCelsius } from "./weatherEdge.js";
import type { ParsedResolutionSource } from "./weatherStations.js";

export interface WeatherResolutionDailyActual {
  provider: "wunderground" | "noaa_timeseries" | "hko" | "unsupported";
  stationId: string;
  date: string;
  url: string;
  fetchedAt: string;
  ok: boolean;
  maxTempC?: number;
  minTempC?: number;
  rawUnit?: "C" | "F";
  note?: string;
  error?: string;
  raw?: unknown;
}

export interface FetchWeatherResolutionActualOptions {
  unitHint?: "C" | "F";
  fetchImpl?: typeof fetch;
  fetchedAt?: string;
  cacheMaxAgeMs?: number;
  hours?: number;
  timezone?: string;
}

interface HighLowCandidate {
  high: number;
  low: number;
  unit: "C" | "F";
  score: number;
  path: string;
  raw: unknown;
}

const DEFAULT_RESOLUTION_CACHE_MAX_AGE_MS = 15 * 60 * 1000;
const WEATHER_GOV_SYNOPTIC_TOKEN = "7c76618b66c74aee913bdbae4b448bdd";
const WEATHER_COM_HISTORY_API_KEY = "e1f10a1e78da46f5b10a1e78da96f525";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numberValue(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function celsiusValue(value: number, unit: "C" | "F"): number {
  return unit === "F" ? fahrenheitToCelsius(value) : value;
}

function compactDatePath(date: string): string {
  const [year, month, day] = date.split("-");
  return `${Number(year)}-${Number(month)}-${Number(day)}`;
}

function normalizeStationId(value: string | undefined): string | undefined {
  return value?.trim().toUpperCase() || undefined;
}

function compactMonth(date: string): string {
  const [year, month] = date.split("-");
  return `${year}${month}`;
}

function compactDay(date: string): string {
  return date.replace(/-/g, "");
}

function localDateKey(date: Date, timezone?: string): string {
  if (!timezone) return date.toISOString().slice(0, 10);
  try {
    const parts = new Intl.DateTimeFormat("en", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).formatToParts(date);
    const year = parts.find((part) => part.type === "year")?.value;
    const month = parts.find((part) => part.type === "month")?.value;
    const day = parts.find((part) => part.type === "day")?.value;
    if (year && month && day) return `${year}-${month}-${day}`;
  } catch {
    // Fall back to UTC below when the runtime lacks the requested timezone.
  }
  return date.toISOString().slice(0, 10);
}

export function wundergroundDailyHistoryUrl(
  resolution: ParsedResolutionSource,
  date: string
): string | undefined {
  const stationId = normalizeStationId(resolution.stationId);
  if (resolution.provider !== "wunderground" || !stationId) return undefined;

  if (resolution.locationPath) {
    return `https://www.wunderground.com/history/daily/${resolution.locationPath}/${stationId}/date/${compactDatePath(date)}`;
  }

  if (!resolution.raw) return undefined;
  try {
    const url = new URL(resolution.raw);
    const segments = url.pathname.split("/").filter(Boolean);
    const dateIndex = segments.findIndex((segment) => segment.toLowerCase() === "date");
    if (dateIndex >= 0) {
      segments.splice(dateIndex, segments.length - dateIndex, "date", compactDatePath(date));
    } else {
      segments.push("date", compactDatePath(date));
    }
    url.pathname = `/${segments.join("/")}`;
    return url.toString();
  } catch {
    return undefined;
  }
}

function normalizeWeatherComCountryCode(value: string | undefined): string | undefined {
  const normalized = value?.trim().toUpperCase();
  if (!normalized) return undefined;
  if (normalized === "UK") return "GB";
  if (normalized === "USA") return "US";
  return /^[A-Z]{2}$/.test(normalized) ? normalized : undefined;
}

function wundergroundWeatherComCountryCode(resolution: ParsedResolutionSource): string | undefined {
  const fromLocationPath = normalizeWeatherComCountryCode(resolution.locationPath?.split("/").filter(Boolean)[0]);
  if (fromLocationPath) return fromLocationPath;

  if (resolution.raw) {
    try {
      const url = new URL(resolution.raw);
      const segments = url.pathname.split("/").filter(Boolean);
      const dailyIndex = segments.findIndex((segment) => segment.toLowerCase() === "daily");
      const countrySegment = dailyIndex >= 0 ? segments[dailyIndex + 1] : undefined;
      const fromRaw = normalizeWeatherComCountryCode(countrySegment);
      if (fromRaw) return fromRaw;
    } catch {
      // Fall through to station-prefix heuristics below.
    }
  }

  const stationId = normalizeStationId(resolution.stationId);
  if (!stationId) return undefined;
  if (stationId.startsWith("K")) return "US";
  if (stationId.startsWith("C")) return "CA";
  if (stationId.startsWith("EG")) return "GB";
  return undefined;
}

export function weatherComHistoricalObservationsUrl(
  resolution: ParsedResolutionSource,
  date: string
): string | undefined {
  const stationId = normalizeStationId(resolution.stationId);
  const country = wundergroundWeatherComCountryCode(resolution);
  if (resolution.provider !== "wunderground" || !stationId || !country) return undefined;

  const url = new URL(`https://api.weather.com/v1/location/${stationId}:9:${country}/observations/historical.json`);
  url.searchParams.set("apiKey", WEATHER_COM_HISTORY_API_KEY);
  url.searchParams.set("units", "e");
  url.searchParams.set("startDate", compactDay(date));
  url.searchParams.set("endDate", compactDay(date));
  return url.toString();
}

export function noaaTimeseriesSynopticUrl(
  stationId: string,
  date: string
): string {
  const normalized = stationId.trim().toUpperCase();
  const day = compactDay(date);
  const url = new URL("https://api.synopticdata.com/v2/stations/timeseries");
  url.searchParams.set("STID", normalized);
  url.searchParams.set("showemptystations", "1");
  url.searchParams.set("start", `${day}0000`);
  url.searchParams.set("end", `${day}2359`);
  url.searchParams.set("complete", "1");
  url.searchParams.set("token", WEATHER_GOV_SYNOPTIC_TOKEN);
  url.searchParams.set("obtimezone", "local");
  return url.toString();
}

export function noaaTimeseriesAviationMetarUrl(
  stationId: string,
  hours: number
): string {
  const url = new URL("https://aviationweather.gov/api/data/metar");
  url.searchParams.set("ids", stationId.trim().toUpperCase());
  url.searchParams.set("format", "json");
  url.searchParams.set("hours", String(Math.max(1, Math.min(360, Math.trunc(hours)))));
  return url.toString();
}

export function hkoMonthlyDailyExtractUrl(date: string): string {
  return `https://www.weather.gov.hk/cis/dailyExtract/dailyExtract_${compactMonth(date)}.xml`;
}

export function hkoAnnualDailyExtractUrl(date: string): string {
  return `https://www.weather.gov.hk/cis/dailyExtract/dailyExtract_${date.slice(0, 4)}.xml`;
}

function candidateValue(record: Record<string, unknown>, keys: RegExp[]): number | undefined {
  for (const [key, value] of Object.entries(record)) {
    if (!keys.some((pattern) => pattern.test(key))) continue;
    const direct = numberValue(value);
    if (direct !== undefined) return direct;
    if (isRecord(value)) {
      const nested = numberValue(value.value) ??
        numberValue(value.avg) ??
        numberValue(value.max) ??
        numberValue(value.min);
      if (nested !== undefined) return nested;
    }
  }
  return undefined;
}

function unitFromRecord(path: string, record: Record<string, unknown>, unitHint?: "C" | "F"): "C" | "F" {
  const joined = `${path} ${Object.keys(record).join(" ")}`;
  if (/\b(metric|celsius|degc|_c|temp_c)\b/i.test(joined)) return "C";
  if (/\b(imperial|fahrenheit|degf|_f|temp_f|english)\b/i.test(joined)) return "F";

  const unit = stringValue(record.unit) ?? stringValue(record.temperatureUnit);
  if (unit && /^f/i.test(unit)) return "F";
  if (unit && /^c/i.test(unit)) return "C";
  return unitHint ?? "C";
}

function candidateScore(path: string, high: number, low: number): number {
  let score = 0;
  if (/daily|history|summary|observation|almanac/i.test(path)) score += 5;
  if (/imperial|metric|temperature/i.test(path)) score += 2;
  if (/hourly|periods|forecast/i.test(path)) score -= 3;
  if (low <= high) score += 3;
  if (high > -80 && high < 160 && low > -100 && low < 140) score += 2;
  return score;
}

function collectHighLowCandidates(
  value: unknown,
  path: string,
  unitHint: "C" | "F" | undefined,
  output: HighLowCandidate[]
): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectHighLowCandidates(item, `${path}[${index}]`, unitHint, output));
    return;
  }
  if (!isRecord(value)) return;

  const high = candidateValue(value, [
    /^(?:temperature)?high$/i,
    /^(?:temperature)?max$/i,
    /^temp(?:erature)?High$/i,
    /^temp(?:erature)?Max$/i,
    /^maxTemp(?:erature)?$/i,
    /^maxtemp$/i
  ]);
  const low = candidateValue(value, [
    /^(?:temperature)?low$/i,
    /^(?:temperature)?min$/i,
    /^temp(?:erature)?Low$/i,
    /^temp(?:erature)?Min$/i,
    /^minTemp(?:erature)?$/i,
    /^mintemp$/i
  ]);
  if (high !== undefined && low !== undefined) {
    const unit = unitFromRecord(path, value, unitHint);
    output.push({
      high,
      low,
      unit,
      score: candidateScore(path, high, low),
      path,
      raw: value
    });
  }

  for (const [key, nested] of Object.entries(value)) {
    collectHighLowCandidates(nested, path ? `${path}.${key}` : key, unitHint, output);
  }
}

function scriptJsonPayloads(html: string): unknown[] {
  const payloads: unknown[] = [];
  const scripts = html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi);
  for (const match of scripts) {
    const raw = match[1]?.trim();
    if (!raw || !raw.startsWith("{")) continue;
    try {
      payloads.push(JSON.parse(raw));
    } catch {
      // Most Wunderground scripts are JavaScript bundles, not pure JSON.
    }
  }
  return payloads;
}

function parseHtmlTableText(html: string, unitHint?: "C" | "F"): HighLowCandidate[] {
  const text = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&deg;/g, " deg ")
    .replace(/\s+/g, " ");
  const highMatch = text.match(/(?:Max(?:imum)?|High)\s+Temperature\s+(-?\d+(?:\.\d+)?)/i);
  const lowMatch = text.match(/(?:Min(?:imum)?|Low)\s+Temperature\s+(-?\d+(?:\.\d+)?)/i);
  const high = numberValue(highMatch?.[1]);
  const low = numberValue(lowMatch?.[1]);
  if (high === undefined || low === undefined) return [];
  return [{
    high,
    low,
    unit: unitHint ?? (Math.max(high, low) > 60 ? "F" : "C"),
    score: 1,
    path: "htmlText",
    raw: { high, low }
  }];
}

export function parseWundergroundDailyActualFromHtml(
  html: string,
  options: {
    stationId: string;
    date: string;
    url: string;
    fetchedAt?: string;
    unitHint?: "C" | "F";
  }
): WeatherResolutionDailyActual {
  const payloads = scriptJsonPayloads(html);
  const candidates: HighLowCandidate[] = [];
  for (const payload of payloads) {
    collectHighLowCandidates(payload, "", options.unitHint, candidates);
  }
  candidates.push(...parseHtmlTableText(html, options.unitHint));

  const best = candidates
    .filter((candidate) => candidate.low <= candidate.high)
    .sort((a, b) => b.score - a.score)[0];
  if (!best) {
    return {
      provider: "wunderground",
      stationId: options.stationId,
      date: options.date,
      url: options.url,
      fetchedAt: options.fetchedAt ?? new Date().toISOString(),
      ok: false,
      note: "Fetched Wunderground history page, but could not parse daily high/low from the page payload."
    };
  }

  return {
    provider: "wunderground",
    stationId: options.stationId,
    date: options.date,
    url: options.url,
    fetchedAt: options.fetchedAt ?? new Date().toISOString(),
    ok: true,
    maxTempC: celsiusValue(best.high, best.unit),
    minTempC: celsiusValue(best.low, best.unit),
    rawUnit: best.unit,
    note: `Parsed daily high/low from ${best.path}.`,
    raw: best.raw
  };
}

export function parseWeatherComHistoricalDailyActualFromJson(
  raw: string,
  options: {
    stationId: string;
    date: string;
    url: string;
    fetchedAt?: string;
  }
): WeatherResolutionDailyActual {
  const fetchedAt = options.fetchedAt ?? new Date().toISOString();
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch (error) {
    return {
      provider: "wunderground",
      stationId: options.stationId,
      date: options.date,
      url: options.url,
      fetchedAt,
      ok: false,
      error: `Weather.com historical observations payload was not JSON: ${error instanceof Error ? error.message : String(error)}`
    };
  }

  const observations = isRecord(payload) && Array.isArray(payload.observations)
    ? payload.observations
    : [];
  const explicitPairs: Array<{ high: number; low: number; index: number }> = [];
  const observedTempsF: number[] = [];
  for (let index = 0; index < observations.length; index += 1) {
    const item = observations[index];
    if (!isRecord(item)) continue;
    const observationStation = normalizeStationId(
      stringValue(item.key) ?? stringValue(item.stationId) ?? stringValue(item.icaoId)
    );
    if (observationStation && observationStation !== normalizeStationId(options.stationId)) continue;

    const high = numberValue(item.max_temp) ?? numberValue(item.maxTemp);
    const low = numberValue(item.min_temp) ?? numberValue(item.minTemp);
    if (high !== undefined && low !== undefined && low <= high) {
      explicitPairs.push({ high, low, index });
    }

    const temp = numberValue(item.temp) ?? numberValue(item.temperature);
    if (temp !== undefined) observedTempsF.push(temp);
  }

  const observedMaxF = observedTempsF.length > 0 ? Math.max(...observedTempsF) : undefined;
  const observedMinF = observedTempsF.length > 0 ? Math.min(...observedTempsF) : undefined;
  const explicitPair = explicitPairs
    .filter((pair) => {
      if (pair.high !== 0 || pair.low !== 0) return true;
      return observedTempsF.some((temp) => Math.abs(temp) < 0.1);
    })
    .map((pair) => {
      const range = pair.high - pair.low;
      let score = 0;
      if (range >= 0 && range <= 70) score += 10;
      if (pair.high !== 0 && pair.low !== 0) score += 5;
      if (range <= 45) score += 2;
      if (observedMaxF !== undefined) score -= Math.abs(pair.high - observedMaxF) * 0.25;
      if (observedMinF !== undefined) score -= Math.abs(pair.low - observedMinF) * 0.25;
      score -= pair.index * 0.001;
      return { ...pair, score };
    })
    .sort((a, b) => b.score - a.score)[0];

  let maxTempF = explicitPair?.high;
  let minTempF = explicitPair?.low;
  const usedExplicitDailySummary = maxTempF !== undefined && minTempF !== undefined;
  if (!usedExplicitDailySummary) {
    if (observedMaxF !== undefined) maxTempF = observedMaxF;
    if (observedMinF !== undefined) minTempF = observedMinF;
  }

  if (maxTempF === undefined || minTempF === undefined) {
    return {
      provider: "wunderground",
      stationId: options.stationId,
      date: options.date,
      url: options.url,
      fetchedAt,
      ok: false,
      note: "Weather.com historical observations JSON did not contain parseable daily high/low or same-day temperatures."
    };
  }

  return {
    provider: "wunderground",
    stationId: options.stationId,
    date: options.date,
    url: options.url,
    fetchedAt,
    ok: true,
    maxTempC: celsiusValue(maxTempF, "F"),
    minTempC: celsiusValue(minTempF, "F"),
    rawUnit: "F",
    note: usedExplicitDailySummary
      ? "Parsed daily high/low from Weather.com historical observations endpoint used by Wunderground station pages."
      : "Computed daily high/low from Weather.com historical observations endpoint used by Wunderground station pages.",
    raw: {
      source: "weather_com_historical_observations",
      observationCount: observations.length,
      usedExplicitDailySummary
    }
  };
}

function parseTemperatureCell(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string") return undefined;
  const cleaned = value.replace(/\*/g, "").replace(/#/g, "").trim();
  if (!cleaned || /^trace$/i.test(cleaned)) return undefined;
  return numberValue(cleaned);
}

export function parseHkoDailyActualFromJson(
  raw: string,
  options: {
    date: string;
    url: string;
    fetchedAt?: string;
  }
): WeatherResolutionDailyActual {
  const fetchedAt = options.fetchedAt ?? new Date().toISOString();
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch (error) {
    return {
      provider: "hko",
      stationId: "HKO",
      date: options.date,
      url: options.url,
      fetchedAt,
      ok: false,
      error: `HKO Daily Extract payload was not JSON: ${error instanceof Error ? error.message : String(error)}`
    };
  }

  const month = Number(options.date.slice(5, 7));
  const day = options.date.slice(8, 10);
  const data = isRecord(payload) && isRecord(payload.stn) && Array.isArray(payload.stn.data)
    ? payload.stn.data
    : [];
  const monthData = data.find((item) => isRecord(item) && Number(item.month) === month);
  const dayData = isRecord(monthData) && Array.isArray(monthData.dayData) ? monthData.dayData : [];
  const row = dayData.find((item) => {
    if (!Array.isArray(item)) return false;
    const rowDay = String(item[0] ?? "").trim().padStart(2, "0");
    return rowDay === day;
  });
  if (!Array.isArray(row)) {
    return {
      provider: "hko",
      stationId: "HKO",
      date: options.date,
      url: options.url,
      fetchedAt,
      ok: false,
      note: "HKO Daily Extract JSON did not contain a row for the target date."
    };
  }

  const maxTempC = parseTemperatureCell(row[2]);
  const minTempC = parseTemperatureCell(row[4]);
  if (maxTempC === undefined || minTempC === undefined) {
    return {
      provider: "hko",
      stationId: "HKO",
      date: options.date,
      url: options.url,
      fetchedAt,
      ok: false,
      note: "HKO Daily Extract row did not contain parseable absolute daily max/min temperatures.",
      raw: { row }
    };
  }

  return {
    provider: "hko",
    stationId: "HKO",
    date: options.date,
    url: options.url,
    fetchedAt,
    ok: true,
    maxTempC,
    minTempC,
    rawUnit: "C",
    note: "Parsed absolute daily max/min from HKO Daily Extract JSON.",
    raw: { row }
  };
}

function parseSynopticDate(raw: string | undefined): Date | undefined {
  if (!raw) return undefined;
  const normalized = raw.replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
  const parsed = new Date(normalized);
  return Number.isFinite(parsed.getTime()) ? parsed : undefined;
}

export function parseNoaaTimeseriesDailyActualFromSynoptic(
  raw: string,
  options: {
    stationId: string;
    date: string;
    url: string;
    fetchedAt?: string;
    timezone?: string;
  }
): WeatherResolutionDailyActual {
  const fetchedAt = options.fetchedAt ?? new Date().toISOString();
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch (error) {
    return {
      provider: "noaa_timeseries",
      stationId: options.stationId,
      date: options.date,
      url: options.url,
      fetchedAt,
      ok: false,
      error: `Weather.gov/Synoptic timeseries payload was not JSON: ${error instanceof Error ? error.message : String(error)}`
    };
  }

  const summary = isRecord(payload) && isRecord(payload.SUMMARY) ? payload.SUMMARY : undefined;
  const responseMessage = stringValue(summary?.RESPONSE_MESSAGE);
  if (responseMessage && responseMessage !== "OK") {
    return {
      provider: "noaa_timeseries",
      stationId: options.stationId,
      date: options.date,
      url: options.url,
      fetchedAt,
      ok: false,
      error: `Weather.gov/Synoptic timeseries returned ${responseMessage}.`
    };
  }

  const station = isRecord(payload) && Array.isArray(payload.STATION) && isRecord(payload.STATION[0])
    ? payload.STATION[0]
    : undefined;
  const observations = isRecord(station?.OBSERVATIONS) ? station.OBSERVATIONS : undefined;
  const times = Array.isArray(observations?.date_time) ? observations.date_time : [];
  const temps = Array.isArray(observations?.air_temp_set_1) ? observations.air_temp_set_1 : [];
  const timezone = stringValue(station?.TIMEZONE) ?? options.timezone;
  const dayTemps: Array<{ observedAt: string; tempC: number }> = [];
  for (let index = 0; index < Math.min(times.length, temps.length); index += 1) {
    const observedAt = stringValue(times[index]);
    const tempC = numberValue(temps[index]);
    if (!observedAt || tempC === undefined) continue;
    const parsedDate = parseSynopticDate(observedAt);
    const observedDate = parsedDate ? localDateKey(parsedDate, timezone) : observedAt.slice(0, 10);
    if (observedDate !== options.date) continue;
    dayTemps.push({ observedAt, tempC });
  }

  if (dayTemps.length === 0) {
    return {
      provider: "noaa_timeseries",
      stationId: options.stationId,
      date: options.date,
      url: options.url,
      fetchedAt,
      ok: false,
      note: "Weather.gov/Synoptic timeseries JSON did not contain same-day air_temp_set_1 observations."
    };
  }

  const values = dayTemps.map((item) => item.tempC);
  return {
    provider: "noaa_timeseries",
    stationId: options.stationId,
    date: options.date,
    url: options.url,
    fetchedAt,
    ok: true,
    maxTempC: Math.max(...values),
    minTempC: Math.min(...values),
    rawUnit: "C",
    note: `Parsed ${dayTemps.length} same-day temperature observations from the same Synoptic endpoint used by Weather.gov timeseries.`,
    raw: {
      source: "synoptic",
      timezone,
      observationCount: dayTemps.length,
      firstObservedAt: dayTemps[0]?.observedAt,
      lastObservedAt: dayTemps.at(-1)?.observedAt
    }
  };
}

export function parseNoaaTimeseriesDailyActualFromAviationMetars(
  raw: string,
  options: {
    stationId: string;
    date: string;
    url: string;
    fetchedAt?: string;
    timezone?: string;
    notePrefix?: string;
  }
): WeatherResolutionDailyActual {
  const fetchedAt = options.fetchedAt ?? new Date().toISOString();
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch (error) {
    return {
      provider: "noaa_timeseries",
      stationId: options.stationId,
      date: options.date,
      url: options.url,
      fetchedAt,
      ok: false,
      error: `AviationWeather METAR payload was not JSON: ${error instanceof Error ? error.message : String(error)}`
    };
  }

  if (!Array.isArray(payload)) {
    return {
      provider: "noaa_timeseries",
      stationId: options.stationId,
      date: options.date,
      url: options.url,
      fetchedAt,
      ok: false,
      note: "AviationWeather METAR payload was not an array."
    };
  }

  const stationId = options.stationId.trim().toUpperCase();
  const dayTemps: Array<{ observedAt: string; tempC: number }> = [];
  for (const item of payload) {
    if (!isRecord(item)) continue;
    const icaoId = normalizeStationId(stringValue(item.icaoId) ?? stringValue(item.id));
    if (icaoId && icaoId !== stationId) continue;
    const observedAt = stringValue(item.reportTime) ?? stringValue(item.obsTime);
    const tempC = numberValue(item.temp);
    if (!observedAt || tempC === undefined) continue;
    const parsedDate = new Date(observedAt);
    if (!Number.isFinite(parsedDate.getTime())) continue;
    if (localDateKey(parsedDate, options.timezone) !== options.date) continue;
    dayTemps.push({ observedAt, tempC });
  }

  if (dayTemps.length === 0) {
    return {
      provider: "noaa_timeseries",
      stationId,
      date: options.date,
      url: options.url,
      fetchedAt,
      ok: false,
      note: "AviationWeather METAR JSON did not contain same-day temperature observations."
    };
  }

  const values = dayTemps.map((item) => item.tempC);
  return {
    provider: "noaa_timeseries",
    stationId,
    date: options.date,
    url: options.url,
    fetchedAt,
    ok: true,
    maxTempC: Math.max(...values),
    minTempC: Math.min(...values),
    rawUnit: "C",
    note: `${options.notePrefix ? `${options.notePrefix} ` : ""}Parsed ${dayTemps.length} same-day METAR/SPECI temperature observations from AviationWeather fallback.`,
    raw: {
      source: "aviationweather_metar",
      timezone: options.timezone,
      observationCount: dayTemps.length,
      firstObservedAt: dayTemps[0]?.observedAt,
      lastObservedAt: dayTemps.at(-1)?.observedAt
    }
  };
}

interface CacheEnvelope {
  cachedAt: string;
  value: string;
}

function cachePath(config: AppConfig, namespace: string, key: string): string {
  const digest = createHash("sha256").update(key).digest("hex");
  return join(config.weather.cacheDir, "resolution-actuals", namespace, `${digest}.txt`);
}

async function readCachedText(
  config: AppConfig,
  namespace: string,
  key: string,
  maxAgeMs: number
): Promise<string | undefined> {
  try {
    const envelope = JSON.parse(await readFile(cachePath(config, namespace, key), "utf8")) as CacheEnvelope;
    const cachedAt = Date.parse(envelope.cachedAt);
    if (Number.isFinite(cachedAt) && Date.now() - cachedAt <= maxAgeMs) return envelope.value;
  } catch {
    return undefined;
  }
  return undefined;
}

async function writeCachedText(config: AppConfig, namespace: string, key: string, value: string): Promise<void> {
  try {
    const path = cachePath(config, namespace, key);
    await mkdir(join(config.weather.cacheDir, "resolution-actuals", namespace), { recursive: true });
    await writeFile(path, JSON.stringify({ cachedAt: new Date().toISOString(), value }), "utf8");
  } catch {
    // Cache failures should not block resolution checks.
  }
}

async function fetchCachedText(
  config: AppConfig,
  namespace: string,
  url: string,
  options: FetchWeatherResolutionActualOptions,
  headers: Record<string, string>
): Promise<string> {
  const maxAgeMs = options.cacheMaxAgeMs ?? DEFAULT_RESOLUTION_CACHE_MAX_AGE_MS;
  const cached = await readCachedText(config, namespace, url, maxAgeMs);
  if (cached !== undefined) return cached;

  const response = await (options.fetchImpl ?? fetch)(url, { headers });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText}`);
  }
  const body = await response.text();
  await writeCachedText(config, namespace, url, body);
  return body;
}

export async function fetchWundergroundDailyActual(
  config: AppConfig,
  resolution: ParsedResolutionSource,
  date: string,
  options: FetchWeatherResolutionActualOptions = {}
): Promise<WeatherResolutionDailyActual> {
  const stationId = normalizeStationId(resolution.stationId);
  const weatherComUrl = weatherComHistoricalObservationsUrl(resolution, date);
  const historyUrl = wundergroundDailyHistoryUrl(resolution, date);
  const fetchedAt = options.fetchedAt ?? new Date().toISOString();
  if (resolution.provider !== "wunderground" || !stationId) {
    return {
      provider: "wunderground",
      stationId: stationId ?? "unknown",
      date,
      url: weatherComUrl ?? historyUrl ?? "",
      fetchedAt,
      ok: false,
      note: "Resolution source is not a parseable Wunderground station history URL."
    };
  }

  let weatherComFailure: string | undefined;
  if (weatherComUrl) {
    try {
      const body = await fetchCachedText(config, "weathercom-historical-observations", weatherComUrl, options, {
        "User-Agent": "prediction-trader/0.1 weatheredge resolution-audit",
        Accept: "application/json",
        Origin: "https://www.wunderground.com",
        Referer: resolution.raw ?? "https://www.wunderground.com/"
      });
      const actual = parseWeatherComHistoricalDailyActualFromJson(body, {
        stationId,
        date,
        url: weatherComUrl,
        fetchedAt
      });
      if (actual.ok) return actual;
      weatherComFailure = actual.error ?? actual.note;
    } catch (error) {
      weatherComFailure = error instanceof Error ? error.message : String(error);
    }
  } else {
    weatherComFailure = "Could not build a Weather.com historical observations URL for this Wunderground station.";
  }

  if (!historyUrl) {
    return {
      provider: "wunderground",
      stationId,
      date,
      url: weatherComUrl ?? "",
      fetchedAt,
      ok: false,
      error: weatherComFailure,
      note: "Could not fall back to Wunderground HTML because the resolution source is not a dated station history URL."
    };
  }

  try {
    const html = await fetchCachedText(config, "wunderground", historyUrl, options, {
      "User-Agent": "prediction-trader/0.1 weatheredge resolution-audit",
      Accept: "text/html,application/xhtml+xml"
    });

    const actual = parseWundergroundDailyActualFromHtml(html, {
      stationId,
      date,
      url: historyUrl,
      fetchedAt,
      unitHint: options.unitHint
    });
    if (actual.ok || !weatherComFailure) return actual;
    return {
      ...actual,
      error: actual.error,
      note: [
        `Weather.com historical observations unavailable (${weatherComFailure}).`,
        actual.note
      ].filter(Boolean).join(" ")
    };
  } catch (error) {
    return {
      provider: "wunderground",
      stationId,
      date,
      url: historyUrl,
      fetchedAt,
      ok: false,
      error: [weatherComFailure, error instanceof Error ? error.message : String(error)].filter(Boolean).join(" | ")
    };
  }
}

export async function fetchHkoDailyActual(
  config: AppConfig,
  resolution: ParsedResolutionSource,
  date: string,
  options: FetchWeatherResolutionActualOptions = {}
): Promise<WeatherResolutionDailyActual> {
  const fetchedAt = options.fetchedAt ?? new Date().toISOString();
  if (resolution.provider !== "hko") {
    return {
      provider: "hko",
      stationId: "HKO",
      date,
      url: "",
      fetchedAt,
      ok: false,
      note: "Resolution source is not HKO."
    };
  }

  const urls = [...new Set([hkoMonthlyDailyExtractUrl(date), hkoAnnualDailyExtractUrl(date)])];
  const failures: string[] = [];
  for (const url of urls) {
    try {
      const body = await fetchCachedText(config, "hko-daily-extract", url, options, {
        "User-Agent": "prediction-trader/0.1 weatheredge resolution-audit",
        Accept: "application/json,text/plain,*/*"
      });
      const actual = parseHkoDailyActualFromJson(body, { date, url, fetchedAt });
      if (actual.ok) return actual;
      failures.push(actual.error ?? actual.note ?? `Could not parse ${url}`);
    } catch (error) {
      failures.push(`${url}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return {
    provider: "hko",
    stationId: "HKO",
    date,
    url: urls[0] ?? "",
    fetchedAt,
    ok: false,
    error: failures.join(" | ") || "HKO Daily Extract actual was unavailable."
  };
}

export async function fetchNoaaTimeseriesDailyActual(
  config: AppConfig,
  resolution: ParsedResolutionSource,
  date: string,
  options: FetchWeatherResolutionActualOptions = {}
): Promise<WeatherResolutionDailyActual> {
  const stationId = normalizeStationId(resolution.stationId);
  const fetchedAt = options.fetchedAt ?? new Date().toISOString();
  if (resolution.provider !== "noaa_timeseries" || !stationId) {
    return {
      provider: "noaa_timeseries",
      stationId: stationId ?? "unknown",
      date,
      url: "",
      fetchedAt,
      ok: false,
      note: "Resolution source is not a parseable NOAA Weather.gov timeseries URL."
    };
  }

  const synopticUrl = noaaTimeseriesSynopticUrl(stationId, date);
  let synopticFailure: string | undefined;
  try {
    const body = await fetchCachedText(config, "noaa-timeseries-synoptic", synopticUrl, options, {
      "User-Agent": "prediction-trader/0.1 weatheredge resolution-audit",
      Accept: "application/json",
      Origin: "https://www.weather.gov",
      Referer: resolution.raw ?? `https://www.weather.gov/wrh/timeseries?site=${stationId}`
    });
    const actual = parseNoaaTimeseriesDailyActualFromSynoptic(body, {
      stationId,
      date,
      url: synopticUrl,
      fetchedAt,
      timezone: options.timezone
    });
    if (actual.ok) return actual;
    synopticFailure = actual.error ?? actual.note;
  } catch (error) {
    synopticFailure = error instanceof Error ? error.message : String(error);
  }

  const aviationUrl = noaaTimeseriesAviationMetarUrl(stationId, options.hours ?? 360);
  try {
    const body = await fetchCachedText(config, "aviationweather-metar", aviationUrl, options, {
      "User-Agent": "prediction-trader/0.1 weatheredge resolution-audit",
      Accept: "application/json"
    });
    const actual = parseNoaaTimeseriesDailyActualFromAviationMetars(body, {
      stationId,
      date,
      url: aviationUrl,
      fetchedAt,
      timezone: options.timezone,
      notePrefix: synopticFailure
        ? `Weather.gov/Synoptic exact endpoint unavailable (${synopticFailure}).`
        : undefined
    });
    if (actual.ok) return actual;
    return {
      ...actual,
      error: [synopticFailure, actual.error ?? actual.note].filter(Boolean).join(" | ") || undefined
    };
  } catch (error) {
    return {
      provider: "noaa_timeseries",
      stationId,
      date,
      url: aviationUrl,
      fetchedAt,
      ok: false,
      error: [synopticFailure, error instanceof Error ? error.message : String(error)].filter(Boolean).join(" | ")
    };
  }
}

export async function fetchResolutionDailyActual(
  config: AppConfig,
  resolution: ParsedResolutionSource,
  date: string,
  options: FetchWeatherResolutionActualOptions = {}
): Promise<WeatherResolutionDailyActual> {
  switch (resolution.provider) {
    case "wunderground":
      return fetchWundergroundDailyActual(config, resolution, date, options);
    case "noaa_timeseries":
      return fetchNoaaTimeseriesDailyActual(config, resolution, date, options);
    case "hko":
      return fetchHkoDailyActual(config, resolution, date, options);
    default:
      return {
        provider: "unsupported",
        stationId: normalizeStationId(resolution.stationId) ?? "unknown",
        date,
        url: resolution.raw ?? "",
        fetchedAt: options.fetchedAt ?? new Date().toISOString(),
        ok: false,
        note: `Unsupported resolution actual provider ${resolution.provider}.`
      };
  }
}
