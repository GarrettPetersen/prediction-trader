# Prediction Trader

Headless tooling for small prediction-market trading experiments across
Polymarket and Vistadex.

This repo is intentionally execution-first but safety-first: it gives a local
agent enough structure to preview, quote, and submit small trades, while making
live execution difficult to trigger by accident.

## What This Does

- Builds dry-run trade previews for Polymarket and Vistadex.
- Places Polymarket CLOB orders through `@polymarket/clob-client-v2`.
- Redeems resolved Polymarket positions through the official
  `@polymarket/client` SDK gasless workflow.
- Requests and submits Vistadex RFQ trades through the public `vistadex` SDK.
- Finds same-market YES/NO position pairs and can sell equal shares of both
  sides to unlock cash-like complete-set exposure.
- Caches international football Elo ratings and compares model fair prices to
  Polymarket 1X2 soccer markets.
- Predicts soccer scorelines with reusable Poisson/Monte Carlo score-model
  utilities, including exact scores, BTTS, and over/under totals.
- Pulls RainBot-style weather-model inputs from public/user-accessible sources:
  GFS, ECMWF, and UKMO via Open-Meteo; NWS for U.S. forecasts; HKO for Hong
  Kong; and NOAA NCEI CDO for token-gated historical climatology.
- Records executed trades/redemptions and backfilled venue state to a local
  JSONL ledger for audit and PnL reconstruction.
- Runs an optional scheduled Vistadex WeatherEdge reinvestment loop through
  GitHub Actions.
- Requires explicit live-trading gates before any command can submit a trade.
- Keeps wallet keys and API credentials out of source control.

This is not a mature strategy engine yet. It has execution plumbing, football
and weather models, and a narrowly scoped automated weather-trading loop that
still needs careful monitoring.

## Safety Model

Live trading requires all of the following:

1. Pass `--execute` on the command.
2. Set `PREDICTION_TRADER_LIVE=1`.
3. Keep order notional at or below `PREDICTION_TRADER_MAX_USD`, or pass a
   smaller/larger explicit `--max-usd`.

The default max is `$5`, which is conservative for a small test bankroll. The
recommended operating pattern is:

- Use dedicated small wallets, not primary wallets.
- Preview every command before adding `--execute`.
- Start with `$1-$2` trades.
- Keep keys only in local `.env` or local keypair files.
- Do not paste private keys, API secrets, seed phrases, or exported wallet files
  into chat.
- Do not use this tooling to bypass geoblocks, account restrictions, or a
  venue's terms.

## Prerequisites

- Node.js 20 or newer for the original order/RFQ tooling. Node.js 24 or newer
  is recommended for `polymarket:redeem` because the newer
  `@polymarket/client` beta package declares that engine requirement.
- A funded Polymarket wallet/account if you want Polymarket execution.
- A funded Vistadex Solana wallet and Vistadex client API key if you want
  Vistadex execution.
- A local `.env` file copied from `.env.example`.

Install:

```bash
npm install
cp .env.example .env
```

Then edit `.env` locally. The `.gitignore` excludes `.env`, wallet JSON files,
and common keypair filenames.

## Environment Variables

Shared controls:

```bash
PREDICTION_TRADER_LIVE=0
PREDICTION_TRADER_MAX_USD=5
PREDICTION_TRADER_LEDGER_PATH=data/trades/ledger.jsonl
```

The default ledger path is local-only and ignored by git. It contains account
activity, order IDs, transaction hashes/signatures, tickets, and venue responses;
it should be treated as private trading history even though it does not contain
private keys or API secrets.

Polymarket:

```bash
POLYMARKET_HOST=https://clob.polymarket.com
POLYMARKET_CHAIN_ID=137
POLYMARKET_PRIVATE_KEY=0x...
POLYMARKET_SIGNATURE_TYPE=3
POLYMARKET_FUNDER_ADDRESS=0x...
POLYGON_RPC_URL=https://polygon-bor-rpc.publicnode.com
```

Optional Polymarket API credentials:

```bash
POLYMARKET_API_KEY=
POLYMARKET_API_SECRET=
POLYMARKET_API_PASSPHRASE=
```

If the API credentials are omitted, the adapter derives them with the private
key. New API integrations generally use deposit wallets with signature type
`3`. Existing proxy/safe users may need signature type `1` or `2`.

Vistadex:

```bash
VISTADEX_CLIENT_API_KEY=
VISTADEX_APP_URL=https://www.app.vistadex.com
VISTADEX_RPC_URL=https://api.mainnet-beta.solana.com
VISTADEX_POSITIONS_API_URL=https://markets.vistadex.com
VISTADEX_SECRET_KEY=
VISTADEX_KEYPAIR_PATH=
```

For Vistadex, provide either `VISTADEX_SECRET_KEY` or `VISTADEX_KEYPAIR_PATH`.
The SDK accepts a base64 secret key, a JSON array string, or a path to a Solana
keypair JSON file.

WeatherEdge:

```bash
OPEN_METEO_FORECAST_URL=https://api.open-meteo.com/v1/forecast
OPEN_METEO_PREVIOUS_RUNS_URL=https://previous-runs-api.open-meteo.com/v1/forecast
OPEN_METEO_GEOCODING_URL=https://geocoding-api.open-meteo.com/v1/
NWS_API_URL=https://api.weather.gov
NWS_USER_AGENT=prediction-trader/0.1 weatheredge
HKO_API_URL=https://data.weather.gov.hk/weatherAPI/opendata/weather.php
NOAA_CDO_API_URL=https://www.ncei.noaa.gov/cdo-web/api/v2
NOAA_CDO_TOKEN=
WEATHER_CACHE_DIR=.cache/weatheredge
WEATHER_OBSERVATIONS_PATH=data/weather/observations/noaa-ghcnd-daily.jsonl
WEATHER_MARKET_SNAPSHOTS_PATH=data/weather/markets/polymarket-weather-snapshots.jsonl
WEATHER_FORECAST_SNAPSHOTS_PATH=data/weather/forecasts/provider-forecasts.jsonl
WEATHER_PREVIOUS_RUN_FORECASTS_PATH=data/weather/forecasts/openmeteo-previous-runs.jsonl
WEATHER_BACKTEST_RUNS_PATH=data/weather/backtests/weatheredge-runs.jsonl
WEATHER_RESOLUTION_ACTUALS_PATH=data/weather/resolution/weather-resolution-actuals.jsonl
```

Open-Meteo, NWS, and HKO do not require secrets for the basic pulls implemented
here. NOAA NCEI CDO requires a free token, sent as the `token` header. Keep it
local in `.env`; it is not needed for live forecast pulls. NOAA CDO station and
daily-data responses are cached under `WEATHER_CACHE_DIR` so repeated scans do
not burn quota fetching the same climatology dates. The three
`WEATHER_*_PATH` dataset files are durable local JSONL stores for actual NOAA
observations, Polymarket weather market snapshots, provider forecast snapshots,
Open-Meteo previous-run forecasts for already-resolved dates, settlement-source
actuals, and WeatherEdge model runs; they are ignored by git.

## Commands

Show help:

```bash
npm run cli -- --help
```

Run checks:

```bash
npm run build
npm test
npm run check:env
```

Run optional network checks after credentials are filled:

```bash
npm run check:env -- --network
```

The env checker prints public wallet addresses and readiness flags, but never
prints private keys or API secrets. In network mode it also checks Polymarket
geoblocking, the Polymarket deposit wallet contract code, Polymarket CLOB
collateral balance/allowances, and Vistadex USDC balance when a Vistadex client
API key is configured.

## WeatherEdge Sources

RainBot says its weather engine uses GFS, ECMWF, UKMO, NWS, HKO for Hong Kong,
and NOAA NCEI GHCND history for climatology. This repo's first WeatherEdge
layer connects to those source families through public/user-accessible APIs:

- `openmeteo_gfs`: Open-Meteo model `gfs_seamless`.
- `openmeteo_ecmwf`: Open-Meteo model `ecmwf_ifs025`.
- `openmeteo_ukmo`: Open-Meteo model `ukmo_seamless`.
- `nws`: official U.S. National Weather Service `/points` plus hourly forecast
  endpoint. U.S. locations only.
- `hko`: Hong Kong Observatory open data, using `fnd` for 9-day forecast and
  `rhrread` for current readings. Hong Kong only.
- `noaa_ncei`: NOAA NCEI Climate Data Online `GHCND` daily summaries. Requires
  `NOAA_CDO_TOKEN`. By default, the command auto-selects a nearby GHCND station
  with `TMAX` coverage; use `--ncei-location` or `--ncei-station` to force a
  known CDO id.

WeatherEdge research notes:

- [Seven-day weather backtest, 2026-06-24 to 2026-06-30](docs/weather-edge-backtest-2026-06-24-to-30.md)

Pull all applicable sources for Vancouver:

```bash
npm run weather:sources -- --city Vancouver --country CA --days 3
```

That should connect to the three Open-Meteo model families and skip NWS, HKO,
and NOAA NCEI unless you pass the extra location/token inputs.

Smoke-test NWS on a U.S. location:

```bash
npm run weather:sources -- \
  --city "New York" \
  --country US \
  --days 2 \
  --sources nws
```

Smoke-test HKO on Hong Kong:

```bash
npm run weather:sources -- \
  --city "Hong Kong" \
  --country HK \
  --days 3 \
  --sources hko
```

Smoke-test the global model stack on European or Asian cities:

```bash
npm run weather:sources -- \
  --city Paris \
  --country FR \
  --days 2 \
  --sources openmeteo_gfs,openmeteo_ecmwf,openmeteo_ukmo

npm run weather:sources -- \
  --city Beijing \
  --country CN \
  --days 2 \
  --sources openmeteo_gfs,openmeteo_ecmwf,openmeteo_ukmo

npm run weather:sources -- \
  --city "Hong Kong" \
  --country HK \
  --days 2 \
  --sources openmeteo_gfs,openmeteo_ecmwf,openmeteo_ukmo,hko
```

Use NOAA NCEI once you have a CDO token:

```bash
npm run weather:sources -- \
  --city Vancouver \
  --country CA \
  --sources noaa_ncei
```

If `--history-date` is omitted, the command uses the selected station's latest
available date because NOAA daily summaries can lag real time by a few days.
Force a known station or CDO location when needed:

```bash
npm run weather:sources -- \
  --city Vancouver \
  --country CA \
  --sources noaa_ncei \
  --history-date 2026-06-11 \
  --ncei-station GHCND:CA001108446
```

The command prints compact daily/hourly slices by default. Add `--raw` when you
need full provider JSON for parser work.

The NOAA CDO `/data` endpoint supports date ranges, multiple data types, and
pagination, so a long station history can be fetched in bulk-ish pages. The
current climatology implementation still requests the same calendar date for
each prior year because that is usually fewer rows than pulling full years, and
the local cache prevents repeat calls across runs. A future calibration job
should use bulk date ranges when it needs dense historical series.

### WeatherEdge Trading Pipeline

The RainBot-style pipeline is CLI-first and review-first:

1. Discover Polymarket weather events.
2. Parse city, date, market type, and temperature outcome bins.
3. Resolve the market's settlement feed/station, then pull GFS, ECMWF, UKMO,
   NWS/HKO where applicable for that target, plus NOAA NCEI history.
4. Build a weighted consensus forecast.
5. Blend in a 10-year same-calendar-date NOAA prior when available.
6. Price each outcome with a Normal CDF.
7. Compare fair probability to market prices, apply a dynamic edge threshold,
   and size with fractional Kelly. Defaults are quarter-Kelly
   (`--kelly-multiplier 0.25`) capped at 15% of bankroll per trade
   (`--max-kelly-fraction 0.15`). When a city/date ladder has several
   attractive buckets, pass `--sizing city-portfolio` to size the whole
   city/date/measure payoff curve instead of treating each bucket as an
   independent bet.
8. Produce reviewable signals and paper-loop output.

Discover active weather-temperature ladders:

```bash
npm run weather:scan -- --limit 50 --max-pages 4
```

Price one Polymarket weather event by event slug:

```bash
npm run weather:price -- \
  --slug highest-temperature-in-vancouver-on-july-4-2026 \
  --bankroll 100 \
  --max-per-trade 5 \
  --kelly-multiplier 0.25
```

Scan and rank candidate signals:

```bash
npm run weather:signals -- \
  --limit 50 \
  --max-pages 4 \
  --max-events 8 \
  --bankroll 100 \
  --max-per-trade 5 \
  --kelly-multiplier 0.25
```

Compute our edge on every parsed tomorrow weather-temperature market:

```bash
npm run weather:tomorrow -- \
  --bankroll 100 \
  --max-per-trade 5 \
  --kelly-multiplier 0.25 \
  --top 50
```

That command defaults to tomorrow in the local machine timezone, scans the
Polymarket `weather` tag, filters to parsed daily high/low temperature ladders,
prices each binary market, and prints a ranked edge table. Weather scans are
market-local-time conservative by default: after station matching, `weather:edges`
infers the resolution station timezone and skips a market if its local target
day is already underway. High-temperature markets get a small post-midnight
grace window because the high usually has not happened yet; low-temperature
markets get a much tighter grace window because the low can occur overnight.
Use `--allow-started-day` only for manual research, not unattended trading.
Add `--all` to print every priced row, `--signals-only` to show only edges above
the dynamic threshold, or `--date YYYY-MM-DD` with `weather:edges` to inspect
another day:

```bash
npm run weather:edges -- \
  --date 2026-07-04 \
  --bankroll 100 \
  --max-per-trade 5 \
  --kelly-multiplier 0.25 \
  --all
```

Price same-day Vistadex weather ladders after the local day has started:

```bash
npm run weather:midday -- \
  --held-vistadex \
  --date 2026-07-04 \
  --bankroll 50 \
  --max-per-trade 5 \
  --kelly-multiplier 0.25 \
  --resolution-actuals \
  --top 50
```

`weather:midday` is a read-only scanner for partially complete station-day
weather markets. It fetches the Vistadex event metadata for either
`--held-vistadex` positions or explicit `--slug/--slugs`, extracts the
settlement station/feed from the resolution source, pulls same-day station
observations when available, and combines the observed high/low so far with
remaining-hour GFS, ECMWF, UKMO, and NWS forecasts for that station. Hong Kong
markets can also use the Hong Kong Observatory, but only when the market
explicitly references HKO, Hong Kong Observatory, or weather.gov.hk; then HKO
daily forecasts participate even though they are not hourly, and HKO current
readings are the same-day observed feed. For high-temperature markets, a bin
whose upper edge has already been
crossed is priced at zero; for low-temperature markets, a bin whose lower edge
has already been crossed is priced at zero. When no forecast hours remain in
the local station day, the observed station extreme deterministically locks the
outcome instead of leaving a residual model probability. Intraday BUY signals
are skipped unless same-day resolution-station observations are present.

Pass `--reports --resolution-actuals` to include a resolution-source check in
each group. The check confirms the forecast coordinates are at the settlement
station, reports per-source distance from that station, and makes a best-effort
fetch of the dated settlement-source daily high/low where we know how to get
it: Wunderground daily history for Wunderground markets, HKO Daily Extract JSON
for Hong Kong Observatory markets, and the same Weather.gov/Synoptic timeseries
endpoint used by the Weather.gov page for NOAA timeseries markets. If that
exact source cannot be parsed, the check reports that explicitly rather than
substituting a nearby NOAA or METAR feed as if it were exact. The
output ranks YES/NO edges and fractional-Kelly sizes, but it does not quote or
execute trades. Always request a venue quote before trading because the
displayed event price can differ from the executable RFQ.

For Europe/Asia, be explicit about the market-local date. From British
Columbia, Hong Kong, Beijing, Seoul, Singapore, and Tokyo are often already on
the next calendar day, so `--date 2026-07-05` may be the correct "tomorrow"
while the local machine still says July 4. Day-ahead pricing infers timezones
for major Asia-Pacific country codes including `CN`, `HK`, `JP`, `KR`, `SG`,
`TW`, `TH`, `VN`, `MY`, `PH`, `ID`, `IN`, `AE`, `AU`, and `NZ`.

For same-city ladders, portfolio-aware sizing can be more honest than ranked
per-market Kelly. It evaluates all candidate YES/NO positions against the same
temperature distribution, so it can choose between expressions like "buy one
risky 88-89F YES" and "buy several lower-bucket NOs" based on the whole payoff
curve. Use group caps while this is still experimental:

```bash
npm run weather:edges -- \
  --date 2026-07-04 \
  --bankroll 50 \
  --max-per-trade 5 \
  --kelly-multiplier 0.25 \
  --sizing city-portfolio \
  --max-group-fraction 0.25 \
  --portfolio-step-usd 0.25 \
  --signals-only
```

The default grace windows are 120 minutes for highs and 15 minutes for lows.
Override them with `--high-grace-minutes N` and `--low-grace-minutes N` when
running experiments. A future Cloudflare Worker should schedule by market-local
timezone, not by one global UTC cron: run shortly before local midnight for each
city/date bucket, pull fresh forecasts and market prices, apply the timing guard
and Kelly sizing, then write the quote/order/position state to the ledger.

For a fast forecast-only universe scan, skip NOAA climatology:

```bash
npm run weather:tomorrow -- --no-climatology --signals-only
```

Run a paper signal loop:

```bash
npm run weather:run -- \
  --paper \
  --cycles 3 \
  --interval-sec 300 \
  --max-events 8 \
  --bankroll 100 \
  --max-per-trade 5 \
  --kelly-multiplier 0.25
```

Run the Vistadex WeatherEdge reinvestment loop locally:

```bash
npm run weather:reinvest -- \
  --days-ahead 1 \
  --max-per-trade 10 \
  --max-buys 8 \
  --max-group-fraction 0.25 \
  --kelly-multiplier 0.25 \
  --max-kelly-fraction 0.25 \
  --min-edge 0.20 \
  --min-cash-to-reinvest 5 \
  --target-cash-reserve 20 \
  --min-confidence medium \
  --entry-start-local-time 20:00 \
  --entry-end-local-time 23:30 \
  --report-path data/trades/weatheredge-report.json
```

That command checks current Vistadex cash and positions, quotes weather
positions that are effectively locked at `0.99+`, sells only if the live RFQ is
still favorable, refreshes tomorrow's station-aligned weather edges, and buys
positive-edge Vistadex weather positions with city/date portfolio sizing only
inside each market's station-local day-ahead entry window. By default that
window is `20:00-23:30` on the local calendar day before the target date. Cash
freed outside that window is held until a later scheduled run. The loop does
not touch Polymarket. Add `--execute` only after `PREDICTION_TRADER_LIVE=1` is
set and the dry-run report looks sane.

After selling locked weather positions, the loop skips the WeatherEdge
market/forecast scan when deployable cash is below `--min-cash-to-reinvest`
defaulting to `$5`. Deployable cash is current Vistadex USDC cash after
subtracting `--target-cash-reserve`, which lets the bot intentionally hold a
cash buffer instead of spending the whole float. The scheduled GitHub Actions
loop defaults that reserve to `$20`. This keeps scheduled runs cheap when
there is nothing meaningful to deploy.

The `--bankroll` override is optional. If omitted, the command uses current
Vistadex cash plus marked position value. For example, a `$133` bankroll with
`--max-group-fraction 0.25` permits up to `$33.25` of exposure in one
city/station/day group, while `--max-per-trade` still caps each individual RFQ.

### GitHub Actions Weather Loop

The repo includes `.github/workflows/weatheredge.yml`, scheduled every three
hours at minute 17. It is dry-run by default. To allow live Vistadex weather
trading, configure repository secrets:

```text
VISTADEX_CLIENT_API_KEY
VISTADEX_SECRET_KEY
NOAA_CDO_TOKEN
```

`NOAA_CDO_TOKEN` is optional but recommended. Without it, live pricing skips
the climatology prior and relies on forecast models only.

Configure repository variables:

```text
WEATHEREDGE_LIVE=0
WEATHEREDGE_BANKROLL=
WEATHEREDGE_MAX_PER_TRADE=10
WEATHEREDGE_MAX_BUYS=8
WEATHEREDGE_MAX_GROUP_FRACTION=0.25
WEATHEREDGE_KELLY_MULTIPLIER=0.25
WEATHEREDGE_MAX_KELLY_FRACTION=0.25
WEATHEREDGE_MIN_EDGE=0.20
WEATHEREDGE_MIN_CONFIDENCE=medium
WEATHEREDGE_MIN_CASH_TO_REINVEST=5
WEATHEREDGE_TARGET_CASH_RESERVE=20
WEATHEREDGE_ENTRY_START_LOCAL_TIME=20:00
WEATHEREDGE_ENTRY_END_LOCAL_TIME=23:30
WEATHEREDGE_SKIP_CLIMATOLOGY=0
PREDICTION_TRADER_MAX_USD=10
NWS_USER_AGENT=prediction-trader/0.1 weatheredge github-actions
```

`WEATHEREDGE_MIN_EDGE` is intentionally required rather than defaulted. A
missing live-trading edge threshold should fail the scheduled run instead of
quietly widening the strategy.

The workflow sets `TZ=America/Vancouver`, so `--days-ahead 1` means tomorrow
from British Columbia rather than UTC. Candidate buys are still gated by the
resolution station's own timezone: every three-hour run may sell locked
positions, but it opens fresh day-ahead positions only when the station-local
clock is inside `WEATHEREDGE_ENTRY_START_LOCAL_TIME` through
`WEATHEREDGE_ENTRY_END_LOCAL_TIME` on the day before the target date. It
restores and saves `.cache/weatheredge` with `actions/cache` so NOAA
station/data responses and similar implementation caches survive between runs.
It also uploads `data/trades/ledger.jsonl` and
`data/trades/weatheredge-report.json` as run artifacts.

The ignored `data/weather/**/*.jsonl` datasets are not required for this live
loop to start. The live loop fetches current market pages, current forecasts,
and current Vistadex state on every run. Those ignored datasets are for
backtesting, calibration research, settlement-source audits, and later PnL
analysis. GitHub Actions artifacts/cache are convenient but not a durable
database; if this becomes production, move the ledger, price snapshots,
forecasts, and settlement actuals into durable storage such as Cloudflare D1,
R2, S3, Postgres, or a private database service.

Recommended rollout:

1. Leave `WEATHEREDGE_LIVE=0` and run the workflow manually.
2. Inspect the uploaded `weatheredge-report.json`.
3. Set `WEATHEREDGE_BANKROLL` if the computed Vistadex-only bankroll is not the
   risk budget you want.
4. Set `WEATHEREDGE_LIVE=1`.
5. Trigger one manual run with `execute=true`.
6. Let the three-hour schedule continue only after the first live artifact and
   Vistadex activity both look right.

Backtest the NOAA climatology prior for a city/date:

```bash
npm run weather:backtest -- \
  --city Vancouver \
  --country CA \
  --date 2026-07-04 \
  --measure temperature_high \
  --years 10 \
  --threshold 24
```

### WeatherEdge Dataset Loop

The cache under `.cache/weatheredge` is an implementation detail: it prevents
repeat API calls, but it is not a research dataset. For calibration and future
backtests, write durable JSONL records under `data/weather/`.

Collect actual daily NOAA observations for a station/date range:

```bash
npm run weather:dataset:observations -- \
  --city Vancouver \
  --country CA \
  --start-date 2026-06-01 \
  --end-date 2026-06-30 \
  --ncei-station GHCND:CA001108446
```

Snapshot currently available Polymarket weather markets and prices:

```bash
npm run weather:dataset:markets -- \
  --days-ahead 1 \
  --limit 100 \
  --max-pages 20
```

Snapshot provider forecasts for the latest saved market snapshot:

```bash
npm run weather:dataset:forecasts
```

That command reads the latest `WEATHER_MARKET_SNAPSHOTS_PATH`, reconstructs
each city/date/measure market group, resolves its settlement station/feed, then
saves per-provider forecast values for that exact target. Wunderground station
markets use station coordinates; explicit HKO markets use the Hong Kong
Observatory target; markets without a usable station/feed are skipped instead
of silently falling back to city coordinates. Each forecast record is keyed to
the market snapshot timestamp and includes compact `resolutionTarget` metadata
so later backtests can join:

```text
market price at T + provider forecast at T + actual observed weather after resolution
```

After the market day has mostly or fully finished, snapshot settlement-source
actuals and free-feed comparisons for the same market snapshot:

```bash
npm run weather:dataset:resolution-actuals -- \
  --date 2026-07-04 \
  --metar-hours 72
```

This reads the latest saved market snapshot, resolves each market group to its
settlement source, and writes records to
`WEATHER_RESOLUTION_ACTUALS_PATH`. Each record stores:

- `resolution`: the best exact settlement-source daily high/low we can fetch
  for the market, currently Weather.com historical station observations for
  Wunderground-resolved markets, HKO Daily Extract JSON, or Weather.gov/Synoptic
  station timeseries.
- `wunderground`: the legacy Wunderground parse when the market resolves by
  Wunderground, kept for old backtest compatibility.
- `metar`: the free AviationWeather METAR station-day high/low where a station
  METAR feed exists; this is diagnostic unless it is explicitly the fallback
  for a Weather.gov timeseries market.
- Per-bucket `resolutionYes`, `wundergroundYes`, and `metarYes` flags so we can
  audit whether proxy feeds would resolve the market the same way as the exact
  settlement source.
- Warnings when the exact source cannot be parsed or when a proxy station feed
  differs materially from the parsed settlement value.

Collect historical day-ahead forecasts for dates that have already happened:

```bash
npm run weather:dataset:previous-runs -- \
  --market-captured-at 2026-07-05T04:55:43.151Z \
  --start-date 2024-01-01 \
  --end-date 2024-12-31 \
  --lead-days 1 \
  --sources openmeteo_gfs,openmeteo_ecmwf,openmeteo_ukmo
```

This uses Open-Meteo's Previous Model Runs API, not the normal historical
weather API. By default, the command reads the latest saved market snapshot,
resolves each market group to the same settlement station/feed used by live
pricing, and stores rows keyed by a stable forecast target such as
`station:KATL` or `station:EHAM`. Each row also records the display city,
station id/name, and city-to-station distance so backtests can prove they are
calibrating against the same target they would trade. Pass
`--market-captured-at` to backfill forecasts for an older saved market snapshot
instead of the latest one. Passing `--cities` explicitly is still supported for
research, but those rows are keyed as `city:...` and should not be mixed with
production station-target backtests.
For each target/date/source/lead time it stores the forecast value that the
model predicted before valid time, such as `leadDays=1` for the value predicted
roughly 24 hours earlier.

Run a resolved-market strategy backtest for a specific date:

```bash
npm run weather:backtest:markets -- \
  --date 2026-06-30 \
  --lead-days 1 \
  --bankroll 100 \
  --min-edge 0.20 \
  --min-trade-price 0.05 \
  --sizing city-portfolio \
  --kelly-multiplier 0.25 \
  --max-kelly-fraction 0.15 \
  --max-group-fraction 0.25 \
  --max-portfolio-fraction 1 \
  --calibration-half-life-days 365 \
  --city-bias-prior-weight 30
```

That command fetches resolved Polymarket weather binaries for the date, resolves
each market to its settlement forecast target, joins historical price just
before the decision time to matching station-keyed Open-Meteo previous-run
forecasts, settles PnL from Polymarket's final resolved outcome, and sizes every
side whose calibrated probability edge exceeds `--min-edge` with fractional
Kelly. For a binary contract priced `c` with fair probability `p`,
full Kelly stakes `(p - c) / (1 - c)` of bankroll; the default quarter-Kelly
multiplier makes that conservative, `--max-kelly-fraction` caps each trade,
`--max-per-trade` caps absolute dollars, and `--max-portfolio-fraction` scales
the whole day's stake down if the total would exceed the portfolio risk budget.
With `--sizing city-portfolio`, candidates are first grouped by
`city/date/measure` and optimized over a discretized Normal temperature
distribution before the daily portfolio cap is applied. `--max-group-fraction`
limits exposure to one correlated station-day, and `--portfolio-step-usd`
controls the optimizer's dollar granularity. Keep
`--sizing independent-kelly` available as the baseline when comparing changes.
Settlement-source actuals from `weather:dataset:resolution-actuals` are used for
station-keyed calibration when available; NOAA actuals remain useful diagnostics
for older city-keyed research rows, but they are not used as a proxy for market
settlement. The backtest still assumes fills at historical YES prices, infers NO
prices as `1 - YES`, and does not yet model order-book depth, spread, fees, or
liquidity caps. Use `--min-trade-price` to exclude very cheap contracts while we
are still using last-trade/price-history fills instead of full order-book
simulation.

The market backtest calibrates the forecast before pricing bins:

- source-specific bias and reliability are learned from prior forecast errors;
- recent errors count more than older errors via `--calibration-half-life-days`;
- city-level residual bias is learned with shrinkage controlled by
  `--city-bias-prior-weight`, so thin cities stay close to the global bias.

Audit resolution sources before trusting a weather signal:

```bash
npm run weather:resolution-audit -- \
  --date 2026-07-04 \
  --status active \
  --top 50
```

This command compares each Polymarket weather event's exposed resolution source
against the display city. Wunderground station-based markets such as `KLAX`,
`KSEA`, or `KLGA` are flagged when the city geocode is materially away from the
settlement station. Live pricing uses the station/feed target, not the display
city, and treats `STATION_COORDS_MISSING` and `MISSING_RESOLUTION_SOURCE` rows
as blockers unless you explicitly opt into city-forecast research mode.

Live weather pricing is strict by default: if a Polymarket weather market
exposes a Wunderground station such as `KLAX`, `KATL`, `EHAM`, or `ZBAA`, the
forecast is pulled for that station's coordinates instead of the display city.
If the market explicitly resolves to HKO/Hong Kong Observatory/weather.gov.hk,
the forecast target is HKO. The pricing output includes `resolution.matched`,
`stationId`, and `cityDistanceKm` for every signal. Markets without a usable
station/feed resolution source are not priced unless you explicitly pass
`--allow-city-forecast`.
Historical previous-run backtests should be refreshed after market snapshots are
saved so rows are keyed to `station:...` targets. Old rows collected by city name
are useful only for rough model development, and station-settled markets will no
longer be satisfied by those city rows.

Save a WeatherEdge pricing run for later audit:

```bash
npm run weather:dataset:run -- \
  --days-ahead 1 \
  --bankroll 100 \
  --max-per-trade 5 \
  --max-events 25
```

Summarize the local dataset stores:

```bash
npm run weather:dataset:summary
```

The intended loop is: snapshot markets before trading, snapshot provider
forecasts for the same market timestamp, save model runs when signals are
generated, then collect NOAA observations after the relevant dates resolve. That
gives us enough local evidence to measure forecast calibration, market edge,
slippage, and realized outcomes.

Current WeatherEdge limits:

- Live auto-execution exists only in the narrowly scoped `weather:reinvest`
  Vistadex WeatherEdge loop. `weather:run` remains paper-only, and Polymarket is
  not traded by the scheduled loop.
- The parser currently targets city daily high/low temperature ladders. Global
  monthly temperature anomaly and record-rank markets are intentionally skipped.
- Polymarket weather discovery uses the public Gamma `weather` tag and keyword
  shape checks. If Gamma tagging changes, use `--include-unparsed` to inspect
  misses.
- Day-ahead forecast pricing does not use live observed running highs. Use
  `weather:midday` for same-day station markets: exact resolution-source
  actuals are available for Wunderground, HKO Daily Extract, and Weather.gov
  timeseries markets where the public source can be fetched; AviationWeather
  METARs remain a proxy/fallback for station diagnostics. If
  `weather:edges --allow-started-day` is used for inspection, rows from
  already-started market-local days are downgraded to `SKIP`; use
  `weather:midday` for actual intraday signal generation.
- Market backtests now use station-target Open-Meteo previous-run forecasts
  where resolution stations are exposed, plus settlement-source actuals when
  collected. International markets without exposed resolution stations, such as
  some Hong Kong snapshots, still need explicit feed mapping before they can be
  treated as production-grade evidence. Execution modeling is intentionally
  conservative research scaffolding, not a fill simulator.

## Football Edge Model

The first strategy helper is a pre-match international soccer model built on
World Football Elo ratings. It downloads and caches:

- `https://www.eloratings.net/World.tsv`
- `https://www.eloratings.net/en.teams.tsv`

The cached copies live under `data/football/`. Refresh them when you want a new
rating snapshot:

```bash
npm run football:ratings -- --refresh --team Mexico
npm run football:ratings -- --team "Côte d'Ivoire"
```

The model estimates home win, draw, and away win probabilities from Elo
difference. Draw probability starts near `27%` for evenly matched teams and
decays as the Elo gap grows. These defaults are intentionally simple and should
be treated as a baseline, not a finished edge.

Price one Polymarket football event:

```bash
npm run football:price -- --slug fifwc-cze-mex-2026-06-24
```

Screen several slugs and show only model-backed buy signals:

```bash
npm run football:screen -- \
  --slugs fifwc-tun-nld-2026-06-25,fifwc-tur-usa-2026-06-25,fifwc-ecu-ger-2026-06-25 \
  --edge-threshold 0.03
```

Useful options:

- `--refresh` fetches a fresh Elo snapshot before pricing.
- `--home TEAM --away TEAM` overrides team inference from the event title.
- `--edge-threshold N` changes the minimum model edge required for a buy signal.
- `--home-advantage N`, `--draw-base N`, `--draw-min N`, `--draw-scale N`, and
  `--elo-scale N` let you tune model assumptions.

Current limits:

- It is pre-match only. Live score, red cards, time remaining, shots, xG, player
  availability, and weather are not included.
- It has not been backtested against historical prediction-market prices.
- It does not price market fees, spread/slippage, or correlated exposure across
  multiple bets.
- It is a candidate generator. Review `yesBestAsk`, model probability, edge,
  market liquidity, and timing before trading.

## Football Score Model

The score model is separate from the trading adapters so it can be reused across
venues and, later, other sports. The reusable pieces live in
`src/models/scoreDistribution.ts`:

- independent Poisson score grids
- seeded Monte Carlo score simulations
- exact-score probabilities
- home/draw/away summaries
- both-teams-to-score probabilities
- over/under totals for configurable lines

The soccer adapter in `src/models/soccerPoisson.ts` can fit team attack and
defense rates from historical match CSVs. It supports a simple canonical schema:

```csv
date,home_team,away_team,home_score,away_score,neutral
2026-01-01,Team A,Team B,2,1,false
```

It also accepts common football-data style columns such as `HomeTeam`,
`AwayTeam`, `FTHG`, and `FTAG`.

Fit from historical data and ask for exact scores plus high/low lines:

```bash
npm run score:predict -- \
  --sport soccer \
  --home "Team A" \
  --away "Team B" \
  --history data/football/history.csv \
  --scores 0-0,1-0,1-1,2-1 \
  --total-lines 1.5,2.5,3.5 \
  --simulations 100000 \
  --seed team-a-team-b
```

Useful fitting options:

- `--prior-weight N` shrinks low-sample teams toward league average. The default
  is `8`.
- `--half-life-days N` downweights older matches exponentially.
- `--neutral` removes home-field framing and uses blended home/away rates.
- `--max-score N` controls the exact score grid. The default is `10`.
- `--top N` controls how many exact scores are printed.

For international matches where we do not yet have a clean historical results
file, `football:score` can derive a scoreline distribution from the current
Football Elo 1X2 model. It fits Poisson means to the Elo home/draw/away prior at
a configurable expected total goals level:

```bash
npm run football:score -- \
  --home "Türkiye" \
  --away "United States" \
  --scores 0-0,1-1,2-1 \
  --total-lines 1.5,2.5,3.5 \
  --expected-total-goals 2.6 \
  --simulations 50000 \
  --seed tur-usa
```

You can also pass a Polymarket event slug to infer teams from the event title:

```bash
npm run football:score -- \
  --slug fifwc-tur-usa-2026-06-25 \
  --scores 0-0,1-1,2-1 \
  --total-lines 1.5,2.5,3.5
```

If `--history` is supplied to `football:score`, it uses the historical CSV
soccer model instead of the Elo-derived fallback.

Current score-model limits:

- The historical soccer model uses team-level goals for/against. It does not
  include injuries, lineups, cards, rest, travel, weather, shots, or xG yet.
- The Elo fallback is a bridge for immediate international use; real historical
  result data should be preferred when available.
- Exact score and total-goals probabilities should be compared to market prices,
  spreads, liquidity, fees, and correlation with the existing portfolio before
  trading.
- The generic distribution utilities can be reused for other sports, but each
  sport still needs its own scoring-rate fitter. Basketball, hockey, baseball,
  and football should not share soccer's low-scoring Poisson assumptions without
  sport-specific validation.

## Credential Setup

### Polymarket

Use the Polymarket-created wallet private key for API signing:

```bash
POLYMARKET_PRIVATE_KEY=0x...
```

The public address derived from that private key does not need a separate env
var. If the Polymarket profile page shows an address labeled "Do not send funds
to this address. For API use only", treat that as the signer/public address and
do not use it as the funder.

Use the EVM/Polygon address from Polymarket's Deposit flow as the funder:

```bash
POLYMARKET_FUNDER_ADDRESS=0x...
POLYMARKET_SIGNATURE_TYPE=3
```

For new deposit-wallet accounts, the signer address and funder address are
expected to be different. The funder should be the smart wallet holding pUSD and
positions. The env checker can verify that shape locally, and `--network` can
also confirm the funder has contract code on Polygon.

If Polymarket shows "Upgrade your account" or asks you to migrate to a new
wallet, deploy the new deposit wallet and transfer funds in the Polymarket UI
first. Then update `POLYMARKET_FUNDER_ADDRESS` to the new Polygon/EVM deposit
wallet address. The old deposit address may still be a valid contract while
showing zero CLOB buying power.

Before live trading, `npm run check:env -- --network` should show non-zero
`network.polymarketCollateral.balance` and non-zero allowances. If the signer
and funder validate but Polymarket collateral is `0`, the account can sign API
requests but does not yet have CLOB buying power. Polymarket's deposit-wallet
docs say pUSD must be held by the deposit wallet, approvals must come from the
deposit wallet, and the CLOB balance/allowance sync must be run after funding or
approval changes.

Optional CLOB API credentials can stay blank at first:

```bash
POLYMARKET_API_KEY=
POLYMARKET_API_SECRET=
POLYMARKET_API_PASSPHRASE=
```

When these are blank, the adapter asks the Polymarket SDK to derive/create API
credentials from the signing key.

### Vistadex

Vistadex has two separate credentials in the current SDK model:

- a Solana wallet private key, which a normal Vistadex user can export from the
  account UI and use to sign transactions
- a `VISTADEX_CLIENT_API_KEY`, which authorizes access to the RFQ server

As of this repo's initial setup, the second item does not appear to be a
self-serve end-user credential. The public `vistadex` npm package requires it,
but the local Vistadex server docs describe client keys as Unkey keys created
under the internal `vistadex-clients` API. That means a normal Vistadex user
should not be expected to create an Unkey account or know about Unkey.

If Vistadex wants ordinary users and their agents to trade through the SDK, the
product likely needs one of these user-facing flows:

- a Developer/API Keys page in Vistadex account settings that issues scoped
  personal client keys
- wallet-authenticated RFQ access, where the SDK proves wallet ownership instead
  of requiring a separate server API key
- a documented support/request flow for client API keys

If you do have a user-facing client API key, store it locally:

```bash
VISTADEX_CLIENT_API_KEY=...
```

Do not use a `vistadex-fillers` key; filler keys are scoped to market-maker
endpoints and will not pass client endpoint auth.

The SDK sends this key as `Authorization: Bearer <key>` to
`https://server.vistadex.com` and uses it as the `apiKey` query parameter for
user websocket updates.

Historical Vistadex profile activity is separate from the SDK/RFQ flow. The
public profile page at `https://www.app.vistadex.com/profile/<username>` calls
`/api/public/user?username=<username>` and then pages
`/api/public/order-history?wallet=<wallet>&limit=<n>`. Those read-only profile
endpoints are used by `vistadex:activity` and `ledger:backfill`; they do not
require `VISTADEX_CLIENT_API_KEY` when you provide `--username` or `--wallet`.
`VISTADEX_APP_URL` controls the base URL for those public web-app endpoints.

Then create a dedicated Solana hot wallet for the agent:

```bash
mkdir -p wallets
node --input-type=module -e "import { createWallet } from 'vistadex'; import { writeFileSync, chmodSync } from 'node:fs'; const path = 'wallets/vistadex-agent.keypair.json'; const wallet = createWallet(); writeFileSync(path, JSON.stringify(Array.from(wallet.secretKey)), { mode: 0o600 }); chmodSync(path, 0o600); console.log(wallet.publicKey.toBase58());"
```

Set the keypair path in `.env`:

```bash
VISTADEX_KEYPAIR_PATH=wallets/vistadex-agent.keypair.json
```

Or use an exported Vistadex/Solana private key directly:

```bash
VISTADEX_SECRET_KEY=...
```

`VISTADEX_SECRET_KEY` accepts the base58 private-key export used by many Solana
wallets, the Vistadex SDK's base64 format, or a JSON array string. It takes
priority over `VISTADEX_KEYPAIR_PATH`. The public key does not need to go in
`.env`; `npm run check:env` derives it from the private key so you can compare
it to the public address shown in the Vistadex account UI.

Fund the printed Solana public key with the small Vistadex budget you want the
agent to control. Keep enough SOL for transaction fees and enough USDC for buy
orders. The keypair JSON is wallet material; keep it local and do not commit it.

## Polymarket Usage

List current positions and redeemable rows:

```bash
npm run polymarket:positions
npm run polymarket:positions -- --redeemable
```

Fetch a Polymarket event by slug. Add `--orderbook` when you want best bid/ask
for each outcome token before deciding whether to trade or exit:

```bash
npm run polymarket:event -- --slug fifwc-col-cdr-2026-06-23
npm run polymarket:event -- --slug fifwc-col-cdr-2026-06-23 --orderbook
```

Order commands require a known outcome `token-id`. Use `polymarket:event
--orderbook`, the Polymarket UI, or another market-data feed to get token IDs.

Preview a market buy without submitting:

```bash
npm run polymarket:order -- \
  --side buy \
  --token-id YOUR_TOKEN_ID \
  --amount-usd 2 \
  --price 0.50 \
  --order-type FOK
```

Submit only after reviewing the preview:

```bash
PREDICTION_TRADER_LIVE=1 npm run polymarket:order -- \
  --execute \
  --side buy \
  --token-id YOUR_TOKEN_ID \
  --amount-usd 2 \
  --price 0.50 \
  --order-type FOK
```

Limit order example:

```bash
npm run polymarket:order -- \
  --side buy \
  --token-id YOUR_TOKEN_ID \
  --shares 4 \
  --price 0.48 \
  --order-type GTC
```

Sizing rules:

- Market buys (`FOK` or `FAK`) use `--amount-usd`.
- Market sells (`FOK` or `FAK`) use `--shares`.
- Limit orders (`GTC` or `GTD`) use `--shares`.
- `--price` is the limit or worst acceptable price.

Redeem resolved winnings:

```bash
npm run polymarket:redeem -- \
  --condition-id CONDITION_ID
```

Submit only after reviewing the preview:

```bash
PREDICTION_TRADER_LIVE=1 npm run polymarket:redeem -- \
  --execute \
  --condition-id CONDITION_ID
```

You can pass `--market-id` instead of `--condition-id` if you have the numeric
Polymarket market ID. For protocol v2 combo positions, pass `--position-id`.
Redemption is not capped by `PREDICTION_TRADER_MAX_USD` because it claims
resolved collateral rather than opening new risk, but it still requires both
`--execute` and `PREDICTION_TRADER_LIVE=1`. For deposit-wallet accounts, the
command creates a temporary Polymarket builder API key through the SDK, uses it
for the gasless relayer call, and attempts to revoke it afterward. The key is
never printed or written to `.env`.

## Vistadex Usage

Fetch a Vistadex event by slug:

```bash
npm run vistadex:event -- --slug EVENT_SLUG
```

List current Vistadex positions:

```bash
npm run vistadex:positions
```

Fetch public Vistadex profile activity without submitting anything:

```bash
npm run vistadex:activity -- --username tongbao --limit 25
```

If `--username` and `--wallet` are omitted, the command derives the wallet
address from `VISTADEX_SECRET_KEY` or `VISTADEX_KEYPAIR_PATH`.

Request a quote without signing or submitting:

```bash
npm run vistadex:quote -- \
  --side buy \
  --condition-id CONDITION_ID \
  --outcome-index 0 \
  --amount-usd 2
```

Preview a Vistadex trade:

```bash
npm run vistadex:trade -- \
  --side buy \
  --condition-id CONDITION_ID \
  --outcome-index 0 \
  --amount-usd 2
```

Submit after review:

```bash
PREDICTION_TRADER_LIVE=1 npm run vistadex:trade -- \
  --execute \
  --side buy \
  --condition-id CONDITION_ID \
  --outcome-index 0 \
  --amount-usd 2
```

Vistadex sells use shares:

```bash
npm run vistadex:trade -- \
  --side sell \
  --condition-id CONDITION_ID \
  --outcome-index 0 \
  --shares 4 \
  --limit-price 0.50
```

For Vistadex sells, pass `--limit-price` before live execution so the safety
gate can estimate notional. Vistadex execution uses the public `vistadex` SDK,
which handles RFQ creation, quote waiting, transaction signing, submission, and
waiting for filler acceptance.

## Portfolio Cleanup

Sometimes the agent ends up holding both sides of the same binary market, for
example YES and NO on the same condition. Equal shares of both sides behave like
locked cash: one side will pay `$1` and the other side will pay `$0`, regardless
of the outcome. The `portfolio:unlock` command finds those pairs and prepares
equal-size sell orders so the remaining portfolio keeps the same directional
shape while freeing cash, minus bid/RFQ spread.

Preview paired exposure across both venues:

```bash
npm run portfolio:unlock -- --venue all
```

Limit the preview to Polymarket, or ignore tiny pairs:

```bash
npm run portfolio:unlock -- \
  --venue polymarket \
  --min-unlock-usd 1
```

Submit the paired sells only after reviewing the preview:

```bash
PREDICTION_TRADER_LIVE=1 npm run portfolio:unlock -- \
  --execute \
  --venue all \
  --max-usd 25
```

Execution is not atomic. The command sends two sell orders per pair, using
Polymarket `FOK` sells at current best bids and Vistadex RFQ sells with the
quoted price as the sell limit. If one leg fails, the command reports it and
does not silently pretend the pair was fully unlocked. Exact protocol-level
merge/split operations are not implemented yet.

## Trade Ledger

Live `polymarket:order`, `polymarket:redeem`, `vistadex:trade`, and
`portfolio:unlock` executions append a JSONL record to
`PREDICTION_TRADER_LEDGER_PATH`. The record includes the command, ticket,
preview, execution response, stable venue IDs when available, and a dedupe key.
The default file is `data/trades/ledger.jsonl`, which is ignored by git.

Update the ledger from venue APIs:

```bash
npm run ledger:update
```

This is the normal audit command to run before and after a trading session. It
is safe to rerun: records dedupe by venue-provided IDs, stable position snapshot
keys, and daily cash snapshot keys. Current coverage:

- Polymarket CLOB fills via the authenticated CLOB `getTrades` endpoint.
- Polymarket current and redeemable positions via the data API.
- Polymarket pUSD/collateral cash balance from the Polygon deposit wallet.
- Vistadex public profile activity via `/api/public/order-history`, including
  historical trades and redemptions.
- Vistadex current positions via the published SDK.
- Vistadex USDC cash balance from the wallet's Solana token account.

The published Vistadex SDK still does not expose historical user fills directly;
the ledger uses the Vistadex web app's public profile activity endpoint for
that history and the SDK positions endpoint for current position snapshots.

Useful update variants:

```bash
npm run ledger:update -- --venue polymarket
npm run ledger:update -- --venue vistadex
npm run ledger:update -- --no-cash
npm run ledger:update -- --no-positions
npm run ledger:update -- --activity-limit 100 --max-pages 5
```

`ledger:update` continues if one venue or stage fails, and prints any errors in
the report. That lets a Vistadex cash snapshot still land even if Polymarket is
temporarily blocked, or vice versa.

`ledger:backfill` remains available for lower-level historical pulls:

```bash
npm run ledger:backfill
```

Inspect the local ledger:

```bash
npm run ledger:summary
npm run ledger:list -- --limit 20
npm run ledger:list -- --venue polymarket --action fill
npm run ledger:list -- --limit 5 --raw
```

Use `--ledger PATH` with any ledger command or execution command if you want a
separate audit file for a run. `ledger:list` prints compact rows by default;
add `--raw` when you want the full venue payload for an audit. The
`estimatedNotionalUsd` field in summaries is total recorded audit notional
across fills and snapshots; it is not realized PnL and can double-count when a
fill and the resulting position are both present.

## Agent Operating Checklist

Before an agent is allowed to submit trades:

1. Confirm `.env` exists and secrets are local-only.
2. Run `npm run build` and `npm test`.
3. Run `npm run ledger:update` if this is a new checkout or the ledger may be
   stale.
4. Confirm bankroll and per-trade limits.
5. Confirm the trading mandate:
   - allowed venues
   - max per-trade size
   - max daily spend or loss
   - allowed market categories
   - banned market categories
   - whether resting orders are allowed
   - exit rules
   - whether every trade needs human approval
6. Run the command once without `--execute`.
7. Read the preview output.
8. Only then rerun with `PREDICTION_TRADER_LIVE=1` and `--execute`.
9. Run `npm run ledger:update` and then `npm run ledger:summary` after trading
   to confirm the execution and cash state were recorded.

Suggested first live test:

```bash
PREDICTION_TRADER_LIVE=1 npm run vistadex:trade -- \
  --execute \
  --side buy \
  --condition-id CONDITION_ID \
  --outcome-index 0 \
  --amount-usd 1 \
  --max-usd 1
```

## Current Limitations

- No strategy loop yet.
- Polymarket event lookup can fetch outcome token IDs and orderbook tops by
  slug, but there is no broad market screener yet.
- Position, fill, redemption, and cash snapshots exist, but there is no full
  tax-grade portfolio reconciliation or daily-loss accounting yet.
- The trade ledger records executions and backfilled state, but it is not yet a
  full tax-grade accounting system or realized/unrealized PnL reconciler.
- No automatic position exit rules yet.
- Vistadex quote/trade commands require a funded Solana wallet and a client API
  key.

## Dependency Notes

`package.json` includes npm overrides for patched `ws` and `uuid` transitive
dependencies. `@polymarket/client@0.1.0-beta.4` currently declares
`node >=24`; it installed and imported on local Node `v23.7.0`, but Node 24 is
the safer runtime for redemption work. `npm audit --omit=dev` may still report
low-severity advisories through Polymarket's SDK dependency on Ethers
v5/`elliptic`; npm currently reports no non-breaking fix for that chain.

## Research Notes

- Polymarket official docs recommend the TypeScript CLOB v2 client for order
  creation: `@polymarket/clob-client-v2` with `viem`.
- Resolved Polymarket positions are not redeemed through the CLOB client. The
  official `@polymarket/client` package exposes `client.redeemPositions(...)`,
  but the current beta helper did not find our closed Croatia market without
  `closed=true`. This repo resolves closed market metadata from Gamma, then uses
  official SDK pieces: `ctfRedeemPositionsCall(...)` plus
  `prepareGaslessTransaction(...)`.
- Polymarket orders need L1 wallet signing plus L2 API credentials; new API
  users generally use deposit wallets with signature type `3`.
- Vistadex exposes a public npm SDK, `vistadex@0.4.0`, which is easier than
  reverse-engineering the private RFQ routes.
- The private Vistadex app/server code confirms the SDK flow: create RFQ, wait
  for a filler quote, sign the returned Solana transaction, submit the signed
  transaction, then wait for filler accept/bail.

Useful source links:

- [Polymarket trading quickstart](https://docs.polymarket.com/trading/quickstart)
- [Polymarket create order docs](https://docs.polymarket.com/trading/orders/create)
- [Polymarket TypeScript SDK docs](https://docs.polymarket.com/dev-tooling/typescript)
- [Polymarket client npm package](https://www.npmjs.com/package/@polymarket/client)
- [Vistadex npm package](https://www.npmjs.com/package/vistadex)
