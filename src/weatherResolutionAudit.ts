import type { AppConfig } from "./config.js";
import { resolveWeatherLocation, type WeatherLocation } from "./weatherEdge.js";
import { localIsoDateDaysFrom } from "./weatherEdges.js";
import { fetchPolymarketWeatherMarkets, type WeatherMarketGroup } from "./weatherMarkets.js";
import { DEFAULT_WEATHER_MARKET_COUNTRY_CODES } from "./weatherDatasets.js";
import {
  distanceKm,
  fetchWeatherStationInfo,
  firstResolutionSource,
  parseResolutionSource,
  type ParsedResolutionSource,
  type WeatherStationInfo
} from "./weatherStations.js";

export type WeatherResolutionAuditStatus =
  | "MATCHES_STATION"
  | "NEAR_STATION"
  | "CITY_FORECAST_MISMATCH"
  | "STATION_COORDS_MISSING"
  | "MISSING_RESOLUTION_SOURCE"
  | "UNSUPPORTED_RESOLUTION_SOURCE";

export interface WeatherResolutionAuditOptions {
  date?: string;
  daysAhead?: number;
  status?: "active" | "closed";
  limit?: number;
  maxPages?: number;
  distanceOkKm?: number;
  distanceWarnKm?: number;
  countryCodes?: Record<string, string | undefined>;
}

export interface WeatherResolutionAuditRow {
  eventSlug: string;
  eventTitle: string;
  eventEndDate?: string;
  city: string;
  date: string;
  measure: string;
  marketCount: number;
  resolutionSource?: string;
  resolution: ParsedResolutionSource;
  forecastLocation?: Pick<WeatherLocation, "name" | "latitude" | "longitude" | "countryCode" | "country" | "admin1">;
  station?: WeatherStationInfo;
  distanceKm?: number;
  status: WeatherResolutionAuditStatus;
  recommendation: string;
}

export interface WeatherResolutionAuditReport {
  targetDate: string;
  status: "active" | "closed";
  scannedGroups: number;
  auditedGroups: number;
  rows: WeatherResolutionAuditRow[];
  summary: Record<WeatherResolutionAuditStatus, number>;
}

function compactLocation(location: WeatherLocation): WeatherResolutionAuditRow["forecastLocation"] {
  return {
    name: location.name,
    latitude: location.latitude,
    longitude: location.longitude,
    countryCode: location.countryCode,
    country: location.country,
    admin1: location.admin1
  };
}

async function mapWithConcurrency<T, U>(
  items: T[],
  concurrency: number,
  task: (item: T) => Promise<U>
): Promise<U[]> {
  const results = new Array<U>(items.length);
  let nextIndex = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length || 1) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await task(items[index]);
    }
  }));
  return results;
}

function auditStatus(
  resolution: ParsedResolutionSource,
  station: WeatherStationInfo | undefined,
  distance: number | undefined,
  options: { okKm: number; warnKm: number }
): WeatherResolutionAuditStatus {
  if (resolution.provider === "missing") return "MISSING_RESOLUTION_SOURCE";
  if (resolution.provider !== "wunderground") return "UNSUPPORTED_RESOLUTION_SOURCE";
  if (!station) return "STATION_COORDS_MISSING";
  if (distance === undefined || distance <= options.okKm) return "MATCHES_STATION";
  if (distance <= options.warnKm) return "NEAR_STATION";
  return "CITY_FORECAST_MISMATCH";
}

function recommendationFor(row: {
  status: WeatherResolutionAuditStatus;
  resolution: ParsedResolutionSource;
  distanceKm?: number;
}): string {
  if (row.status === "MATCHES_STATION") {
    return "City geocode is close to the resolution station; station-coordinate forecasting is still preferred.";
  }
  if (row.status === "NEAR_STATION") {
    return `Forecast at station ${row.resolution.stationId} before trading; city geocode is ${row.distanceKm?.toFixed(1)} km away.`;
  }
  if (row.status === "CITY_FORECAST_MISMATCH") {
    return `Do not use city-level forecast. Resolve and forecast at station ${row.resolution.stationId}.`;
  }
  if (row.status === "STATION_COORDS_MISSING") {
    return `Manually resolve coordinates for station ${row.resolution.stationId} before trading.`;
  }
  if (row.status === "MISSING_RESOLUTION_SOURCE") {
    return "No resolution source was exposed by Gamma; inspect the market page/rules manually.";
  }
  return "Unsupported resolution source; inspect the market page/rules manually.";
}

export async function auditWeatherResolutionSources(
  config: AppConfig,
  options: WeatherResolutionAuditOptions = {}
): Promise<WeatherResolutionAuditReport> {
  const targetDate = options.date ?? localIsoDateDaysFrom(new Date(), options.daysAhead ?? 1);
  const status = options.status ?? "active";
  const groups = await fetchPolymarketWeatherMarkets(config, {
    limit: options.limit ?? 100,
    maxPages: options.maxPages ?? 20,
    closed: status === "closed",
    includeExpired: status === "closed"
  });
  const targetGroups = groups.filter((group) => group.date === targetDate);
  const countryCodes = {
    ...DEFAULT_WEATHER_MARKET_COUNTRY_CODES,
    ...(options.countryCodes ?? {})
  };
  const stationCache = new Map<string, Promise<WeatherStationInfo | undefined>>();
  const locationCache = new Map<string, Promise<WeatherLocation>>();

  const rows = await mapWithConcurrency(targetGroups, 8, async (group) => {
    const resolutionSource = firstResolutionSource(group);
    const resolution = parseResolutionSource(resolutionSource);
    const station = resolution.stationId
      ? await (stationCache.get(resolution.stationId) ?? (() => {
        const request = fetchWeatherStationInfo(resolution.stationId as string);
        stationCache.set(resolution.stationId as string, request);
        return request;
      })())
      : undefined;
    const countryCode = countryCodes[group.city];
    const locationKey = `${group.city}|${countryCode ?? ""}`;
    const forecastLocation = await (locationCache.get(locationKey) ?? (() => {
      const request = resolveWeatherLocation(config, { city: group.city, countryCode });
      locationCache.set(locationKey, request);
      return request;
    })());
    const distance = station
      ? distanceKm(
        { latitude: forecastLocation.latitude, longitude: forecastLocation.longitude },
        { latitude: station.latitude, longitude: station.longitude }
      )
      : undefined;
    const rowStatus = auditStatus(resolution, station, distance, {
      okKm: options.distanceOkKm ?? 2,
      warnKm: options.distanceWarnKm ?? 10
    });
    const row = {
      eventSlug: group.eventSlug,
      eventTitle: group.eventTitle,
      eventEndDate: group.eventEndDate,
      city: group.city,
      date: group.date,
      measure: group.measure,
      marketCount: group.markets.length,
      resolutionSource,
      resolution,
      forecastLocation: compactLocation(forecastLocation),
      station,
      distanceKm: distance,
      status: rowStatus,
      recommendation: ""
    };
    return {
      ...row,
      recommendation: recommendationFor(row)
    };
  });

  const sortedRows = rows.sort((a, b) => {
    const statusCompare = a.status.localeCompare(b.status);
    if (statusCompare !== 0) return statusCompare;
    return (b.distanceKm ?? -1) - (a.distanceKm ?? -1);
  });
  const summary = sortedRows.reduce((acc, row) => {
    acc[row.status] = (acc[row.status] ?? 0) + 1;
    return acc;
  }, {
    MATCHES_STATION: 0,
    NEAR_STATION: 0,
    CITY_FORECAST_MISMATCH: 0,
    STATION_COORDS_MISSING: 0,
    MISSING_RESOLUTION_SOURCE: 0,
    UNSUPPORTED_RESOLUTION_SOURCE: 0
  } as Record<WeatherResolutionAuditStatus, number>);

  return {
    targetDate,
    status,
    scannedGroups: groups.length,
    auditedGroups: sortedRows.length,
    rows: sortedRows,
    summary
  };
}
