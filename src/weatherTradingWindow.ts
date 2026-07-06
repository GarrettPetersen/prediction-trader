import type { WeatherMeasure } from "./weatherMarkets.js";

export type WeatherTradingWindowStatus =
  | "before_market_day"
  | "within_grace"
  | "local_day_started"
  | "after_market_day"
  | "timezone_unknown";

export type WeatherEntryWindowStatus =
  | "inside_entry_window"
  | "before_entry_window"
  | "after_entry_window"
  | "market_day_started"
  | "after_market_day"
  | "timezone_unknown";

export interface WeatherTradingWindowInput {
  targetDate: string;
  measure: WeatherMeasure;
  timezone?: string;
  countryCode?: string;
  country?: string;
  admin1?: string;
  state?: string;
  longitude?: number;
  now?: Date;
  highGraceMinutes?: number;
  lowGraceMinutes?: number;
}

export interface WeatherEntryWindowInput {
  targetDate: string;
  timezone?: string;
  countryCode?: string;
  country?: string;
  admin1?: string;
  state?: string;
  longitude?: number;
  now?: Date;
  entryStartMinutes?: number;
  entryEndMinutes?: number;
}

export interface WeatherTradingWindowAssessment {
  safeToTrade: boolean;
  status: WeatherTradingWindowStatus;
  timezone?: string;
  localDate?: string;
  localTime?: string;
  minutesAfterLocalMidnight?: number;
  graceMinutes: number;
  reason: string;
}

export interface WeatherEntryWindowAssessment {
  shouldEnter: boolean;
  status: WeatherEntryWindowStatus;
  timezone?: string;
  entryLocalDate?: string;
  localDate?: string;
  localTime?: string;
  minutesAfterLocalMidnight?: number;
  entryStartMinutes: number;
  entryEndMinutes: number;
  reason: string;
}

const DEFAULT_HIGH_GRACE_MINUTES = 120;
const DEFAULT_LOW_GRACE_MINUTES = 15;
export const DEFAULT_ENTRY_START_MINUTES = 20 * 60;
export const DEFAULT_ENTRY_END_MINUTES = 23 * 60 + 30;

const COUNTRY_TIMEZONE: Record<string, string> = {
  AT: "Europe/Vienna",
  AU: "Australia/Sydney",
  BE: "Europe/Brussels",
  CH: "Europe/Zurich",
  CN: "Asia/Shanghai",
  DE: "Europe/Berlin",
  DK: "Europe/Copenhagen",
  AE: "Asia/Dubai",
  ES: "Europe/Madrid",
  FI: "Europe/Helsinki",
  FR: "Europe/Paris",
  GB: "Europe/London",
  HK: "Asia/Hong_Kong",
  IE: "Europe/Dublin",
  IN: "Asia/Kolkata",
  ID: "Asia/Jakarta",
  IT: "Europe/Rome",
  JP: "Asia/Tokyo",
  KR: "Asia/Seoul",
  MY: "Asia/Kuala_Lumpur",
  NL: "Europe/Amsterdam",
  NO: "Europe/Oslo",
  NZ: "Pacific/Auckland",
  PH: "Asia/Manila",
  PL: "Europe/Warsaw",
  PT: "Europe/Lisbon",
  SE: "Europe/Stockholm",
  SG: "Asia/Singapore",
  TH: "Asia/Bangkok",
  TW: "Asia/Taipei",
  VN: "Asia/Ho_Chi_Minh"
};

const US_STATE_TIMEZONE: Record<string, string> = {
  AK: "America/Anchorage",
  AZ: "America/Phoenix",
  CA: "America/Los_Angeles",
  CO: "America/Denver",
  FL: "America/New_York",
  GA: "America/New_York",
  HI: "Pacific/Honolulu",
  IL: "America/Chicago",
  MA: "America/New_York",
  MI: "America/Detroit",
  MN: "America/Chicago",
  NV: "America/Los_Angeles",
  NY: "America/New_York",
  OR: "America/Los_Angeles",
  PA: "America/New_York",
  TX: "America/Chicago",
  WA: "America/Los_Angeles"
};

const CA_PROVINCE_TIMEZONE: Record<string, string> = {
  AB: "America/Edmonton",
  BC: "America/Vancouver",
  MB: "America/Winnipeg",
  NB: "America/Moncton",
  NL: "America/St_Johns",
  NS: "America/Halifax",
  NT: "America/Yellowknife",
  NU: "America/Iqaluit",
  ON: "America/Toronto",
  PE: "America/Halifax",
  QC: "America/Montreal",
  SK: "America/Regina",
  YT: "America/Whitehorse"
};

function normalizeCode(value: string | undefined): string | undefined {
  return value?.trim().toUpperCase() || undefined;
}

export function isValidTimeZone(timezone: string | undefined): timezone is string {
  if (!timezone) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function usTimeZoneFromLongitude(longitude: number): string {
  if (longitude <= -130) return "America/Anchorage";
  if (longitude <= -114) return "America/Los_Angeles";
  if (longitude <= -100) return "America/Denver";
  if (longitude <= -85) return "America/Chicago";
  return "America/New_York";
}

function canadaTimeZoneFromLongitude(longitude: number): string {
  if (longitude <= -120) return "America/Vancouver";
  if (longitude <= -105) return "America/Edmonton";
  if (longitude <= -90) return "America/Winnipeg";
  if (longitude <= -70) return "America/Toronto";
  if (longitude <= -60) return "America/Halifax";
  return "America/St_Johns";
}

export function inferWeatherTimeZone(input: {
  timezone?: string;
  countryCode?: string;
  country?: string;
  admin1?: string;
  state?: string;
  longitude?: number;
}): string | undefined {
  if (isValidTimeZone(input.timezone)) return input.timezone;

  const country = normalizeCode(input.countryCode ?? input.country);
  const state = normalizeCode(input.state ?? input.admin1);
  const longitude = input.longitude;

  if (country === "US" || country === "USA") {
    if (state && US_STATE_TIMEZONE[state]) return US_STATE_TIMEZONE[state];
    return longitude === undefined ? undefined : usTimeZoneFromLongitude(longitude);
  }

  if (country === "CA" || country === "CAN") {
    if (state && CA_PROVINCE_TIMEZONE[state]) return CA_PROVINCE_TIMEZONE[state];
    return longitude === undefined ? undefined : canadaTimeZoneFromLongitude(longitude);
  }

  if (country && COUNTRY_TIMEZONE[country]) return COUNTRY_TIMEZONE[country];
  return undefined;
}

function localDateTimeParts(now: Date, timezone: string): {
  date: string;
  time: string;
  minutesAfterMidnight: number;
} {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const date = `${values.year}-${values.month}-${values.day}`;
  const hour = Number(values.hour);
  const minute = Number(values.minute);
  return {
    date,
    time: `${values.hour}:${values.minute}`,
    minutesAfterMidnight: hour * 60 + minute
  };
}

function isoDateDaysFrom(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export function assessWeatherTradingWindow(
  input: WeatherTradingWindowInput
): WeatherTradingWindowAssessment {
  const graceMinutes = input.measure === "temperature_low"
    ? input.lowGraceMinutes ?? DEFAULT_LOW_GRACE_MINUTES
    : input.highGraceMinutes ?? DEFAULT_HIGH_GRACE_MINUTES;
  const timezone = inferWeatherTimeZone(input);
  if (!timezone) {
    return {
      safeToTrade: false,
      status: "timezone_unknown",
      graceMinutes,
      reason: "Could not infer a market-local timezone; skip rather than trade a possibly started weather day."
    };
  }

  const local = localDateTimeParts(input.now ?? new Date(), timezone);
  if (local.date < input.targetDate) {
    return {
      safeToTrade: true,
      status: "before_market_day",
      timezone,
      localDate: local.date,
      localTime: local.time,
      minutesAfterLocalMidnight: local.minutesAfterMidnight,
      graceMinutes,
      reason: `Market-local date is ${local.date}, before target date ${input.targetDate}.`
    };
  }

  if (local.date > input.targetDate) {
    return {
      safeToTrade: false,
      status: "after_market_day",
      timezone,
      localDate: local.date,
      localTime: local.time,
      minutesAfterLocalMidnight: local.minutesAfterMidnight,
      graceMinutes,
      reason: `Market-local date is ${local.date}, after target date ${input.targetDate}.`
    };
  }

  const withinGrace = local.minutesAfterMidnight <= graceMinutes;
  return {
    safeToTrade: withinGrace,
    status: withinGrace ? "within_grace" : "local_day_started",
    timezone,
    localDate: local.date,
    localTime: local.time,
    minutesAfterLocalMidnight: local.minutesAfterMidnight,
    graceMinutes,
    reason: withinGrace
      ? `Target date has started locally, but ${local.time} is within the ${graceMinutes} minute grace window.`
      : `Target date has started locally and ${local.time} is past the ${graceMinutes} minute grace window.`
  };
}

export function assessWeatherEntryWindow(
  input: WeatherEntryWindowInput
): WeatherEntryWindowAssessment {
  const entryStartMinutes = input.entryStartMinutes ?? DEFAULT_ENTRY_START_MINUTES;
  const entryEndMinutes = input.entryEndMinutes ?? DEFAULT_ENTRY_END_MINUTES;
  const timezone = inferWeatherTimeZone(input);
  if (!timezone) {
    return {
      shouldEnter: false,
      status: "timezone_unknown",
      entryStartMinutes,
      entryEndMinutes,
      reason: "Could not infer a market-local timezone; skip rather than enter outside the intended day-ahead window."
    };
  }

  const local = localDateTimeParts(input.now ?? new Date(), timezone);
  const entryLocalDate = isoDateDaysFrom(input.targetDate, -1);

  if (local.date < entryLocalDate) {
    return {
      shouldEnter: false,
      status: "before_entry_window",
      timezone,
      entryLocalDate,
      localDate: local.date,
      localTime: local.time,
      minutesAfterLocalMidnight: local.minutesAfterMidnight,
      entryStartMinutes,
      entryEndMinutes,
      reason: `Market-local date is ${local.date}, before the ${entryLocalDate} day-ahead entry date.`
    };
  }

  if (local.date > input.targetDate) {
    return {
      shouldEnter: false,
      status: "after_market_day",
      timezone,
      entryLocalDate,
      localDate: local.date,
      localTime: local.time,
      minutesAfterLocalMidnight: local.minutesAfterMidnight,
      entryStartMinutes,
      entryEndMinutes,
      reason: `Market-local date is ${local.date}, after target date ${input.targetDate}.`
    };
  }

  if (local.date === input.targetDate) {
    return {
      shouldEnter: false,
      status: "market_day_started",
      timezone,
      entryLocalDate,
      localDate: local.date,
      localTime: local.time,
      minutesAfterLocalMidnight: local.minutesAfterMidnight,
      entryStartMinutes,
      entryEndMinutes,
      reason: `Market-local target date ${input.targetDate} has already started; hold cash for a true day-ahead entry.`
    };
  }

  if (local.minutesAfterMidnight < entryStartMinutes) {
    return {
      shouldEnter: false,
      status: "before_entry_window",
      timezone,
      entryLocalDate,
      localDate: local.date,
      localTime: local.time,
      minutesAfterLocalMidnight: local.minutesAfterMidnight,
      entryStartMinutes,
      entryEndMinutes,
      reason: `Market-local time ${local.time} is before the day-ahead entry window.`
    };
  }

  if (local.minutesAfterMidnight > entryEndMinutes) {
    return {
      shouldEnter: false,
      status: "after_entry_window",
      timezone,
      entryLocalDate,
      localDate: local.date,
      localTime: local.time,
      minutesAfterLocalMidnight: local.minutesAfterMidnight,
      entryStartMinutes,
      entryEndMinutes,
      reason: `Market-local time ${local.time} is after the day-ahead entry window.`
    };
  }

  return {
    shouldEnter: true,
    status: "inside_entry_window",
    timezone,
    entryLocalDate,
    localDate: local.date,
    localTime: local.time,
    minutesAfterLocalMidnight: local.minutesAfterMidnight,
    entryStartMinutes,
    entryEndMinutes,
    reason: `Market-local time ${local.time} is inside the day-ahead entry window for target date ${input.targetDate}.`
  };
}
