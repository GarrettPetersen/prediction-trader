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

    assert.deepEqual(hours, [1, 4, 7, 10, 13, 16, 19, 22]);
    assert.equal(DEFAULT_WEATHER_CRON_MINUTE, 47);
  });
});
