import type { AppConfig } from "./config.js";
import type { WeatherSourceId } from "./weatherEdge.js";

export const OPEN_METEO_FRESHNESS_SOURCES = [
  "openmeteo_gfs",
  "openmeteo_ecmwf",
  "openmeteo_ukmo"
] as const satisfies readonly WeatherSourceId[];

type OpenMeteoFreshnessSource = typeof OPEN_METEO_FRESHNESS_SOURCES[number];

const OPEN_METEO_METADATA_MODELS: Record<
  OpenMeteoFreshnessSource,
  { model: string; label: string }
> = {
  openmeteo_gfs: {
    model: "ncep_gfs013",
    label: "NCEP GFS 0.13"
  },
  openmeteo_ecmwf: {
    model: "ecmwf_ifs025",
    label: "ECMWF IFS 0.25"
  },
  openmeteo_ukmo: {
    model: "ukmo_global_deterministic_10km",
    label: "UKMO Global 10km"
  }
};

const OPEN_METEO_AVAILABILITY_BUFFER_MS = 10 * 60 * 1000;

export type WeatherForecastFreshnessStatus =
  | "fresh"
  | "not_available_yet"
  | "too_old"
  | "sources_out_of_sync";

export interface OpenMeteoModelFreshness {
  source: OpenMeteoFreshnessSource;
  label: string;
  metadataModel: string;
  metadataUrl: string;
  lastRunInitialisationTime: string;
  lastRunAvailabilityTime: string;
  usableAfter: string;
  nextExpectedInitialisationTime?: string;
  updateIntervalSeconds?: number;
  temporalResolutionSeconds?: number;
}

export interface WeatherForecastFreshnessAssessment {
  ok: boolean;
  status: WeatherForecastFreshnessStatus;
  checkedAt: string;
  requiredSources: OpenMeteoFreshnessSource[];
  maxRunAgeHours: number;
  commonInitialisationTime?: string;
  allSourcesUsableAfter?: string;
  runAgeHours?: number;
  nextExpectedInitialisationTime?: string;
  sources: OpenMeteoModelFreshness[];
  reason: string;
}

interface OpenMeteoModelMetadataRaw {
  last_run_initialisation_time?: unknown;
  last_run_availability_time?: unknown;
  temporal_resolution_seconds?: unknown;
  update_interval_seconds?: unknown;
}

function numberValue(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function parseMetadataTimestamp(value: unknown, field: string, source: WeatherSourceId): Date {
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value * 1000);
  }
  if (typeof value === "string" && value.length > 0) {
    const numeric = Number(value);
    const millis = Number.isFinite(numeric)
      ? numeric * 1000
      : Date.parse(value);
    if (Number.isFinite(millis)) return new Date(millis);
  }
  throw new Error(`Open-Meteo metadata for ${source} did not include a parseable ${field}.`);
}

function metadataUrlFromForecastUrl(forecastUrl: string, metadataModel: string): string {
  const url = new URL(forecastUrl);
  url.pathname = `/data/${metadataModel}/static/meta.json`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function isoNoMs(date: Date): string {
  return date.toISOString().replace(".000Z", "Z");
}

function newestIso(values: string[]): string | undefined {
  const max = values.reduce<number | undefined>((latest, value) => {
    const millis = Date.parse(value);
    if (!Number.isFinite(millis)) return latest;
    return latest === undefined ? millis : Math.max(latest, millis);
  }, undefined);
  return max === undefined ? undefined : isoNoMs(new Date(max));
}

function oldestIso(values: string[]): string | undefined {
  const min = values.reduce<number | undefined>((earliest, value) => {
    const millis = Date.parse(value);
    if (!Number.isFinite(millis)) return earliest;
    return earliest === undefined ? millis : Math.min(earliest, millis);
  }, undefined);
  return min === undefined ? undefined : isoNoMs(new Date(min));
}

export function assessOpenMeteoForecastFreshness(input: {
  now: Date;
  maxRunAgeHours: number;
  sources: OpenMeteoModelFreshness[];
}): WeatherForecastFreshnessAssessment {
  if (!Number.isFinite(input.maxRunAgeHours) || input.maxRunAgeHours <= 0) {
    throw new Error("maxRunAgeHours must be a positive number.");
  }
  if (input.sources.length === 0) {
    throw new Error("At least one Open-Meteo source is required for forecast freshness assessment.");
  }

  const checkedAt = isoNoMs(input.now);
  const requiredSources = input.sources.map((source) => source.source);
  const initTimes = [...new Set(input.sources.map((source) => source.lastRunInitialisationTime))].sort();
  const allSourcesUsableAfter = newestIso(input.sources.map((source) => source.usableAfter));
  const nextExpectedInitialisationTime = oldestIso(
    input.sources.flatMap((source) => source.nextExpectedInitialisationTime ? [source.nextExpectedInitialisationTime] : [])
  );

  if (initTimes.length !== 1) {
    return {
      ok: false,
      status: "sources_out_of_sync",
      checkedAt,
      requiredSources,
      maxRunAgeHours: input.maxRunAgeHours,
      allSourcesUsableAfter,
      nextExpectedInitialisationTime,
      sources: input.sources,
      reason: `Open-Meteo model sources are on different initialization cycles: ${initTimes.join(", ")}.`
    };
  }

  const commonInitialisationTime = initTimes[0];
  if (!allSourcesUsableAfter) {
    throw new Error("Could not compute Open-Meteo common usability time.");
  }

  const usableAfterMs = Date.parse(allSourcesUsableAfter);
  if (!Number.isFinite(usableAfterMs)) {
    throw new Error(`Open-Meteo common usability time is invalid: ${allSourcesUsableAfter}.`);
  }

  if (input.now.getTime() < usableAfterMs) {
    return {
      ok: false,
      status: "not_available_yet",
      checkedAt,
      requiredSources,
      maxRunAgeHours: input.maxRunAgeHours,
      commonInitialisationTime,
      allSourcesUsableAfter,
      nextExpectedInitialisationTime,
      sources: input.sources,
      reason: `Open-Meteo common run ${commonInitialisationTime} is not usable until ${allSourcesUsableAfter}.`
    };
  }

  const initMs = Date.parse(commonInitialisationTime);
  if (!Number.isFinite(initMs)) {
    throw new Error(`Open-Meteo common initialization time is invalid: ${commonInitialisationTime}.`);
  }
  const runAgeHours = (input.now.getTime() - initMs) / 3_600_000;
  if (runAgeHours > input.maxRunAgeHours) {
    return {
      ok: false,
      status: "too_old",
      checkedAt,
      requiredSources,
      maxRunAgeHours: input.maxRunAgeHours,
      commonInitialisationTime,
      allSourcesUsableAfter,
      runAgeHours,
      nextExpectedInitialisationTime,
      sources: input.sources,
      reason: `Open-Meteo common run ${commonInitialisationTime} is ${runAgeHours.toFixed(2)}h old, above max ${input.maxRunAgeHours.toFixed(2)}h.`
    };
  }

  return {
    ok: true,
    status: "fresh",
    checkedAt,
    requiredSources,
    maxRunAgeHours: input.maxRunAgeHours,
    commonInitialisationTime,
    allSourcesUsableAfter,
    runAgeHours,
    nextExpectedInitialisationTime,
    sources: input.sources,
    reason: `Open-Meteo common run ${commonInitialisationTime} is usable and ${runAgeHours.toFixed(2)}h old.`
  };
}

function normalizeOpenMeteoFreshness(
  source: OpenMeteoFreshnessSource,
  metadataUrl: string,
  raw: OpenMeteoModelMetadataRaw
): OpenMeteoModelFreshness {
  const model = OPEN_METEO_METADATA_MODELS[source];
  const init = parseMetadataTimestamp(raw.last_run_initialisation_time, "last_run_initialisation_time", source);
  const availability = parseMetadataTimestamp(raw.last_run_availability_time, "last_run_availability_time", source);
  const updateIntervalSeconds = numberValue(raw.update_interval_seconds);
  const temporalResolutionSeconds = numberValue(raw.temporal_resolution_seconds);
  const nextExpectedInitialisationTime = updateIntervalSeconds === undefined
    ? undefined
    : isoNoMs(new Date(init.getTime() + updateIntervalSeconds * 1000));
  return {
    source,
    label: model.label,
    metadataModel: model.model,
    metadataUrl,
    lastRunInitialisationTime: isoNoMs(init),
    lastRunAvailabilityTime: isoNoMs(availability),
    usableAfter: isoNoMs(new Date(availability.getTime() + OPEN_METEO_AVAILABILITY_BUFFER_MS)),
    nextExpectedInitialisationTime,
    updateIntervalSeconds,
    temporalResolutionSeconds
  };
}

async function fetchOpenMeteoMetadata(url: string): Promise<OpenMeteoModelMetadataRaw> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Open-Meteo metadata request failed ${response.status} ${response.statusText} for ${url}.`);
  }
  const value = await response.json() as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Open-Meteo metadata response was not an object for ${url}.`);
  }
  return value as OpenMeteoModelMetadataRaw;
}

export async function fetchOpenMeteoForecastFreshness(
  config: AppConfig,
  options: {
    now?: Date;
    maxRunAgeHours: number;
    sources?: readonly OpenMeteoFreshnessSource[];
  }
): Promise<WeatherForecastFreshnessAssessment> {
  const sources = options.sources ?? OPEN_METEO_FRESHNESS_SOURCES;
  const modelFreshness = await Promise.all(sources.map(async (source) => {
    const metadataModel = OPEN_METEO_METADATA_MODELS[source].model;
    const url = metadataUrlFromForecastUrl(config.weather.openMeteoForecastUrl, metadataModel);
    const raw = await fetchOpenMeteoMetadata(url);
    return normalizeOpenMeteoFreshness(source, url, raw);
  }));
  return assessOpenMeteoForecastFreshness({
    now: options.now ?? new Date(),
    maxRunAgeHours: options.maxRunAgeHours,
    sources: modelFreshness
  });
}
