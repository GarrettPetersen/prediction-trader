import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AppConfig } from "./config.js";
import { fahrenheitToCelsius } from "./weatherEdge.js";
import type { ParsedResolutionSource } from "./weatherStations.js";

export interface WeatherResolutionDailyActual {
  provider: "wunderground";
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
}

interface HighLowCandidate {
  high: number;
  low: number;
  unit: "C" | "F";
  score: number;
  path: string;
  raw: unknown;
}

const DEFAULT_WUNDERGROUND_CACHE_MAX_AGE_MS = 15 * 60 * 1000;

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

interface CacheEnvelope {
  cachedAt: string;
  value: string;
}

function cachePath(config: AppConfig, key: string): string {
  const digest = createHash("sha256").update(key).digest("hex");
  return join(config.weather.cacheDir, "wunderground-resolution", `${digest}.html`);
}

async function readCachedHtml(
  config: AppConfig,
  key: string,
  maxAgeMs: number
): Promise<string | undefined> {
  try {
    const envelope = JSON.parse(await readFile(cachePath(config, key), "utf8")) as CacheEnvelope;
    const cachedAt = Date.parse(envelope.cachedAt);
    if (Number.isFinite(cachedAt) && Date.now() - cachedAt <= maxAgeMs) return envelope.value;
  } catch {
    return undefined;
  }
  return undefined;
}

async function writeCachedHtml(config: AppConfig, key: string, value: string): Promise<void> {
  try {
    const path = cachePath(config, key);
    await mkdir(join(config.weather.cacheDir, "wunderground-resolution"), { recursive: true });
    await writeFile(path, JSON.stringify({ cachedAt: new Date().toISOString(), value }), "utf8");
  } catch {
    // Cache failures should not block resolution checks.
  }
}

export async function fetchWundergroundDailyActual(
  config: AppConfig,
  resolution: ParsedResolutionSource,
  date: string,
  options: FetchWeatherResolutionActualOptions = {}
): Promise<WeatherResolutionDailyActual> {
  const stationId = normalizeStationId(resolution.stationId);
  const url = wundergroundDailyHistoryUrl(resolution, date);
  const fetchedAt = options.fetchedAt ?? new Date().toISOString();
  if (resolution.provider !== "wunderground" || !stationId || !url) {
    return {
      provider: "wunderground",
      stationId: stationId ?? "unknown",
      date,
      url: url ?? "",
      fetchedAt,
      ok: false,
      note: "Resolution source is not a parseable Wunderground station history URL."
    };
  }

  try {
    const maxAgeMs = options.cacheMaxAgeMs ?? DEFAULT_WUNDERGROUND_CACHE_MAX_AGE_MS;
    const html = await readCachedHtml(config, url, maxAgeMs) ?? await (async () => {
      const response = await (options.fetchImpl ?? fetch)(url, {
        headers: {
          "User-Agent": "prediction-trader/0.1 weatheredge resolution-audit",
          Accept: "text/html,application/xhtml+xml"
        }
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`);
      }
      const body = await response.text();
      await writeCachedHtml(config, url, body);
      return body;
    })();

    return parseWundergroundDailyActualFromHtml(html, {
      stationId,
      date,
      url,
      fetchedAt,
      unitHint: options.unitHint
    });
  } catch (error) {
    return {
      provider: "wunderground",
      stationId,
      date,
      url,
      fetchedAt,
      ok: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}
