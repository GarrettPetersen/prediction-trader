export const DEFAULT_WEATHER_CRON_INTERVAL_HOURS = 3;
export const DEFAULT_WEATHER_CRON_HOUR_OFFSET = 2;
export const DEFAULT_WEATHER_CRON_MINUTE = 15;

export function utcHourMatchesWeatherCron(
  utcHour: number,
  intervalHours: number,
  hourOffset: number
): boolean {
  const interval = Math.max(1, Math.trunc(intervalHours));
  const offset = ((Math.trunc(hourOffset) % interval) + interval) % interval;
  return ((Math.trunc(utcHour) - offset) % interval + interval) % interval === 0;
}
