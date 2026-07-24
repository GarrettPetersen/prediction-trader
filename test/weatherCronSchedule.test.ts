import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  DEFAULT_WEATHER_CRON_HOUR_OFFSET,
  DEFAULT_WEATHER_CRON_INTERVAL_HOURS,
  DEFAULT_WEATHER_CRON_MINUTE,
  utcHourMatchesWeatherCron
} from "../src/weatherCronSchedule.js";

describe("WeatherEdge cron schedule", () => {
  it("matches the hourly UTC cadence", () => {
    const hours = Array.from({ length: 24 }, (_, hour) => hour)
      .filter((hour) => utcHourMatchesWeatherCron(
        hour,
        DEFAULT_WEATHER_CRON_INTERVAL_HOURS,
        DEFAULT_WEATHER_CRON_HOUR_OFFSET
      ));

    assert.deepEqual(hours, Array.from({ length: 24 }, (_, hour) => hour));
    assert.equal(DEFAULT_WEATHER_CRON_MINUTE, 15);
  });

  it("keeps the primary workflow tick aligned and adds a recovery tick", () => {
    const workflow = readFileSync(
      new URL("../.github/workflows/weatheredge.yml", import.meta.url),
      "utf8"
    );

    assert.match(
      workflow,
      new RegExp(
        `- cron: "${DEFAULT_WEATHER_CRON_MINUTE},45 \\* \\* \\* \\*"`
      )
    );
    assert.match(workflow, /WEATHEREDGE_SOURCE_FETCH_MAX_ATTEMPTS:.*'2'/);
    assert.match(workflow, /--source-fetch-max-attempts \$\{WEATHEREDGE_SOURCE_FETCH_MAX_ATTEMPTS\}/);
  });
});
