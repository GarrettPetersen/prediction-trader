import type { WeatherLocation } from "./weatherEdge.js";
import type { WeatherMarketGroup } from "./weatherMarkets.js";

export interface ParsedResolutionSource {
  raw?: string;
  provider: "wunderground" | "noaa_timeseries" | "hko" | "missing" | "unknown";
  stationId?: string;
  locationPath?: string;
  note?: string;
}

export interface WeatherStationInfo {
  id: string;
  icaoId?: string;
  iataId?: string;
  site?: string;
  latitude: number;
  longitude: number;
  state?: string;
  country?: string;
}

export type WeatherForecastTargetKind = "resolution_station" | "city" | "location";

export interface WeatherStationForecastTarget {
  resolutionSource?: string;
  resolution: ParsedResolutionSource;
  station?: WeatherStationInfo;
  location?: WeatherLocation;
  matched: boolean;
  note?: string;
}

interface AviationWeatherStationRaw {
  id?: unknown;
  icaoId?: unknown;
  iataId?: unknown;
  site?: unknown;
  lat?: unknown;
  lon?: unknown;
  state?: unknown;
  country?: unknown;
}

const stationCache = new Map<string, Promise<WeatherStationInfo | undefined>>();

export const HONG_KONG_OBSERVATORY_STATION: WeatherStationInfo = {
  id: "HKO",
  site: "Hong Kong Observatory",
  latitude: 22.3027,
  longitude: 114.1772,
  country: "HK"
};

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

export function normalizeWeatherCityKey(value: string | undefined): string {
  const normalized = (value ?? "")
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  if (normalized === "new york city") return "new york";
  return normalized;
}

export function weatherCityTargetKey(city: string | undefined): string {
  return `city:${normalizeWeatherCityKey(city)}`;
}

export function weatherStationTargetKey(stationId: string | undefined): string | undefined {
  const normalized = stationId?.trim().toUpperCase();
  return normalized ? `station:${normalized}` : undefined;
}

export function weatherLocationTargetKey(location: { latitude: number; longitude: number }): string {
  return `location:${location.latitude.toFixed(4)},${location.longitude.toFixed(4)}`;
}

export function parseResolutionSource(source: string | undefined): ParsedResolutionSource {
  if (!source) return { provider: "missing" };

  let url: URL;
  try {
    url = new URL(source);
  } catch {
    return {
      raw: source,
      provider: "unknown",
      note: "Resolution source is not a parseable URL."
    };
  }

  if (/weather\.gov$/i.test(url.hostname) && url.pathname.toLowerCase() === "/wrh/timeseries") {
    const stationId = url.searchParams.get("site")?.trim().toUpperCase();
    if (!stationId) {
      return {
        raw: source,
        provider: "noaa_timeseries",
        note: "NOAA timeseries URL did not include a station site."
      };
    }
    return {
      raw: source,
      provider: "noaa_timeseries",
      stationId
    };
  }

  if (/weather\.gov\.hk$/i.test(url.hostname) || /\.weather\.gov\.hk$/i.test(url.hostname)) {
    return {
      raw: source,
      provider: "hko",
      stationId: HONG_KONG_OBSERVATORY_STATION.id
    };
  }

  if (!/wunderground\.com$/i.test(url.hostname) && !/\.wunderground\.com$/i.test(url.hostname)) {
    return {
      raw: source,
      provider: "unknown",
      note: `Unsupported resolution host ${url.hostname}.`
    };
  }

  const segments = url.pathname.split("/").filter(Boolean);
  const dailyIndex = segments.findIndex((segment) => segment.toLowerCase() === "daily");
  const stationId = segments.at(-1)?.toUpperCase();
  if (dailyIndex < 0 || !stationId || stationId === "DAILY") {
    return {
      raw: source,
      provider: "wunderground",
      note: "Wunderground URL did not include the expected /history/daily/.../STATION shape."
    };
  }

  return {
    raw: source,
    provider: "wunderground",
    stationId,
    locationPath: segments.slice(dailyIndex + 1, -1).join("/")
  };
}

export function resolutionSourceFromText(text: string | undefined): string | undefined {
  if (!text) return undefined;

  const wunderground = text.match(/https?:\/\/(?:www\.)?wunderground\.com\/history\/daily\/[^\s"'<>)]*/i);
  if (wunderground) return wunderground[0];

  const noaa = text.match(/https?:\/\/www\.weather\.gov\/wrh\/timeseries\?site=([a-z0-9]+)/i);
  if (noaa) {
    const url = new URL(noaa[0]);
    url.searchParams.set("site", (url.searchParams.get("site") ?? "").toUpperCase());
    return url.toString();
  }

  const hko = text.match(/https?:\/\/(?:www\.)?weather\.gov\.hk\/[^\s"'<>)]*/i);
  if (hko) return hko[0];

  return undefined;
}

export function firstResolutionSource(group: WeatherMarketGroup): string | undefined {
  for (const market of group.markets) {
    const source = market.resolutionSource ?? resolutionSourceFromText(market.description);
    if (source) return source;
  }
  return undefined;
}

export function distanceKm(
  a: { latitude: number; longitude: number },
  b: { latitude: number; longitude: number }
): number {
  const earthRadiusKm = 6371;
  const toRad = (value: number) => value * Math.PI / 180;
  const deltaLat = toRad(b.latitude - a.latitude);
  const deltaLon = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);
  const h = Math.sin(deltaLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(deltaLon / 2) ** 2;
  return earthRadiusKm * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

export async function fetchWeatherStationInfo(stationId: string): Promise<WeatherStationInfo | undefined> {
  const cached = stationCache.get(stationId);
  if (cached) return cached;

  const request = (async () => {
    const url = new URL("https://aviationweather.gov/api/data/stationinfo");
    url.searchParams.set("ids", stationId);
    url.searchParams.set("format", "json");

    const response = await fetch(url);
    if (!response.ok) return undefined;
    const raw = await response.json();
    const first = Array.isArray(raw) ? raw[0] as AviationWeatherStationRaw | undefined : undefined;
    if (!first) return undefined;
    const latitude = numberValue(first.lat);
    const longitude = numberValue(first.lon);
    if (latitude === undefined || longitude === undefined) return undefined;

    return {
      id: stringValue(first.id) ?? stationId,
      icaoId: stringValue(first.icaoId),
      iataId: stringValue(first.iataId),
      site: stringValue(first.site),
      latitude,
      longitude,
      state: stringValue(first.state),
      country: stringValue(first.country)
    };
  })();
  stationCache.set(stationId, request);
  return request;
}

export function stationWeatherLocation(
  station: WeatherStationInfo,
  options: { marketCity: string; timezone?: string }
): WeatherLocation {
  return {
    name: `${options.marketCity} (${station.id})`,
    latitude: station.latitude,
    longitude: station.longitude,
    countryCode: station.country,
    country: station.country,
    admin1: station.state,
    timezone: options.timezone
  };
}

export async function resolveStationForecastTarget(
  group: WeatherMarketGroup
): Promise<WeatherStationForecastTarget> {
  const resolutionSource = firstResolutionSource(group);
  const resolution = parseResolutionSource(resolutionSource);
  if (resolution.provider === "hko") {
    return {
      resolutionSource,
      resolution,
      station: HONG_KONG_OBSERVATORY_STATION,
      location: stationWeatherLocation(HONG_KONG_OBSERVATORY_STATION, {
        marketCity: group.city,
        timezone: "Asia/Hong_Kong"
      }),
      matched: true
    };
  }

  if (
    (resolution.provider !== "wunderground" && resolution.provider !== "noaa_timeseries") ||
    !resolution.stationId
  ) {
    return {
      resolutionSource,
      resolution,
      matched: false,
      note: resolution.note ?? (
        resolution.provider === "missing"
          ? "No resolution source was exposed by Gamma."
          : "Resolution source is not a supported Wunderground station URL."
      )
    };
  }

  const station = await fetchWeatherStationInfo(resolution.stationId);
  if (!station) {
    return {
      resolutionSource,
      resolution,
      matched: false,
      note: `Could not resolve coordinates for station ${resolution.stationId}.`
    };
  }

  return {
    resolutionSource,
    resolution,
    station,
    location: stationWeatherLocation(station, { marketCity: group.city }),
    matched: true
  };
}
