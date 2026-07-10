import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DEFAULT_WEATHER_CRON_HOUR_OFFSET,
  DEFAULT_WEATHER_CRON_INTERVAL_HOURS,
  DEFAULT_WEATHER_CRON_MINUTE,
  utcHourMatchesWeatherCron
} from "../src/weatherCronSchedule.js";

describe("WeatherEdge cron schedule", () => {
  it("matches the source-aligned three-hour UTC cadence", () => {
    const hours = Array.from({ length: 24 }, (_, hour) => hour)
      .filter((hour) => utcHourMatchesWeatherCron(
        hour,
        DEFAULT_WEATHER_CRON_INTERVAL_HOURS,
        DEFAULT_WEATHER_CRON_HOUR_OFFSET
      ));

    assert.deepEqual(hours, [2, 5, 8, 11, 14, 17, 20, 23]);
    assert.equal(DEFAULT_WEATHER_CRON_MINUTE, 15);
  });
});
