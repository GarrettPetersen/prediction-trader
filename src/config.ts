import "dotenv/config";
import { z } from "zod";
import { LIVE_TRADING_ENV_VALUE } from "./safety.js";

const emptyToUndefined = (value: unknown) => value === "" ? undefined : value;
const optionalString = z.preprocess(emptyToUndefined, z.string().optional());
const optionalUrl = z.preprocess(emptyToUndefined, z.string().url().optional());
const defaultUrl = (url: string) =>
  z.preprocess(emptyToUndefined, z.string().url().default(url));

const envSchema = z.object({
  PREDICTION_TRADER_LIVE: z.string().default("0"),
  PREDICTION_TRADER_MAX_USD: z.coerce.number().positive().default(5),
  PREDICTION_TRADER_LEDGER_PATH: z.string().default("data/trades/ledger.jsonl"),

  POLYMARKET_HOST: defaultUrl("https://clob.polymarket.com"),
  POLYMARKET_CHAIN_ID: z.coerce.number().int().positive().default(137),
  POLYMARKET_PRIVATE_KEY: optionalString,
  POLYMARKET_SIGNATURE_TYPE: z.coerce.number().int().min(0).max(3).default(3),
  POLYMARKET_FUNDER_ADDRESS: optionalString,
  POLYMARKET_API_KEY: optionalString,
  POLYMARKET_API_SECRET: optionalString,
  POLYMARKET_API_PASSPHRASE: optionalString,
  POLYGON_RPC_URL: defaultUrl("https://polygon-bor-rpc.publicnode.com"),

  VISTADEX_CLIENT_API_KEY: optionalString,
  VISTADEX_APP_URL: defaultUrl("https://www.app.vistadex.com"),
  VISTADEX_RPC_URL: defaultUrl("https://api.mainnet-beta.solana.com"),
  VISTADEX_POSITIONS_API_URL: defaultUrl("https://markets.vistadex.com"),
  VISTADEX_SECRET_KEY: optionalString,
  VISTADEX_KEYPAIR_PATH: optionalString,

  OPEN_METEO_FORECAST_URL: defaultUrl("https://api.open-meteo.com/v1/forecast"),
  OPEN_METEO_PREVIOUS_RUNS_URL: defaultUrl("https://previous-runs-api.open-meteo.com/v1/forecast"),
  OPEN_METEO_GEOCODING_URL: defaultUrl("https://geocoding-api.open-meteo.com/v1/"),
  NWS_API_URL: defaultUrl("https://api.weather.gov"),
  NWS_USER_AGENT: z.preprocess(emptyToUndefined, z.string().default("prediction-trader/0.1 weatheredge")),
  HKO_API_URL: defaultUrl("https://data.weather.gov.hk/weatherAPI/opendata/weather.php"),
  NOAA_CDO_API_URL: defaultUrl("https://www.ncei.noaa.gov/cdo-web/api/v2"),
  NOAA_CDO_TOKEN: optionalString,
  WEATHER_CACHE_DIR: z.preprocess(emptyToUndefined, z.string().default(".cache/weatheredge")),
  WEATHER_OBSERVATIONS_PATH: z.preprocess(
    emptyToUndefined,
    z.string().default("data/weather/observations/noaa-ghcnd-daily.jsonl")
  ),
  WEATHER_MARKET_SNAPSHOTS_PATH: z.preprocess(
    emptyToUndefined,
    z.string().default("data/weather/markets/polymarket-weather-snapshots.jsonl")
  ),
  WEATHER_FORECAST_SNAPSHOTS_PATH: z.preprocess(
    emptyToUndefined,
    z.string().default("data/weather/forecasts/provider-forecasts.jsonl")
  ),
  WEATHER_PREVIOUS_RUN_FORECASTS_PATH: z.preprocess(
    emptyToUndefined,
    z.string().default("data/weather/forecasts/openmeteo-previous-runs.jsonl")
  ),
  WEATHER_BACKTEST_RUNS_PATH: z.preprocess(
    emptyToUndefined,
    z.string().default("data/weather/backtests/weatheredge-runs.jsonl")
  ),
  WEATHER_RESOLUTION_ACTUALS_PATH: z.preprocess(
    emptyToUndefined,
    z.string().default("data/weather/resolution/weather-resolution-actuals.jsonl")
  )
});

export type AppConfig = ReturnType<typeof loadConfig>;

export function loadConfig(overrides: Record<string, string | undefined> = {}) {
  const parsed = envSchema.parse({ ...process.env, ...overrides });

  return {
    safety: {
      liveEnabled: parsed.PREDICTION_TRADER_LIVE === LIVE_TRADING_ENV_VALUE,
      maxUsd: parsed.PREDICTION_TRADER_MAX_USD
    },
    ledger: {
      path: parsed.PREDICTION_TRADER_LEDGER_PATH
    },
    polymarket: {
      host: parsed.POLYMARKET_HOST,
      chainId: parsed.POLYMARKET_CHAIN_ID,
      privateKey: parsed.POLYMARKET_PRIVATE_KEY,
      signatureType: parsed.POLYMARKET_SIGNATURE_TYPE,
      funderAddress: parsed.POLYMARKET_FUNDER_ADDRESS,
      apiCreds:
        parsed.POLYMARKET_API_KEY &&
        parsed.POLYMARKET_API_SECRET &&
        parsed.POLYMARKET_API_PASSPHRASE
          ? {
              key: parsed.POLYMARKET_API_KEY,
              secret: parsed.POLYMARKET_API_SECRET,
              passphrase: parsed.POLYMARKET_API_PASSPHRASE
            }
          : undefined,
      rpcUrl: parsed.POLYGON_RPC_URL
    },
    vistadex: {
      apiKey: parsed.VISTADEX_CLIENT_API_KEY,
      appBaseUrl: parsed.VISTADEX_APP_URL,
      rpcUrl: parsed.VISTADEX_RPC_URL,
      positionsBaseUrl: parsed.VISTADEX_POSITIONS_API_URL,
      secretKey: parsed.VISTADEX_SECRET_KEY,
      keypairPath: parsed.VISTADEX_KEYPAIR_PATH
    },
    weather: {
      openMeteoForecastUrl: parsed.OPEN_METEO_FORECAST_URL,
      openMeteoPreviousRunsUrl: parsed.OPEN_METEO_PREVIOUS_RUNS_URL,
      openMeteoGeocodingUrl: parsed.OPEN_METEO_GEOCODING_URL,
      nwsApiUrl: parsed.NWS_API_URL,
      nwsUserAgent: parsed.NWS_USER_AGENT,
      hkoApiUrl: parsed.HKO_API_URL,
      noaaCdoApiUrl: parsed.NOAA_CDO_API_URL,
      noaaCdoToken: parsed.NOAA_CDO_TOKEN,
      cacheDir: parsed.WEATHER_CACHE_DIR,
      datasets: {
        observationsPath: parsed.WEATHER_OBSERVATIONS_PATH,
        marketSnapshotsPath: parsed.WEATHER_MARKET_SNAPSHOTS_PATH,
        forecastSnapshotsPath: parsed.WEATHER_FORECAST_SNAPSHOTS_PATH,
        previousRunForecastsPath: parsed.WEATHER_PREVIOUS_RUN_FORECASTS_PATH,
        backtestRunsPath: parsed.WEATHER_BACKTEST_RUNS_PATH,
        resolutionActualsPath: parsed.WEATHER_RESOLUTION_ACTUALS_PATH
      }
    }
  };
}
