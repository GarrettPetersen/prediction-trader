# WeatherEdge Backtest: 2026-06-24 to 2026-06-30

This note records a seven-day, one-day-ahead backtest of the WeatherEdge
temperature-market model after adding city-level portfolio optimization.

Update: live WeatherEdge pricing now uses the same historical previous-run
residual calibration machinery as the market backtest, and
`weather:backtest:markets` can run in `--entry-mode cron-entry-window` with
slippage and executable-edge penalties. Treat the results below as an older
research snapshot, not proof that the scheduled live bot is positive EV.

The short version: the model is interesting, but not proven positive EV yet.
Independent Kelly sizing and uncapped city portfolio sizing were slightly
negative over this sample. A city-capped portfolio variant was positive, but
seven days is too small to treat as proof.

## Setup

- Backtest window: `2026-06-24` through `2026-06-30`
- Forecast horizon: `1` day ahead
- Bankroll per day: `$100`
- Edge threshold: `5%`
- Minimum trade price: `0.03`
- Kelly multiplier: `0.25`
- Maximum Kelly fraction per trade: `0.15`
- Maximum per-trade notional: `$8`
- Maximum portfolio fraction: `1.0`
- Maximum price staleness: `12` hours
- Calibration half-life: `365` days
- City bias prior weight: `30`

Strategies tested:

- `independent_kelly`: sizes every candidate market independently.
- `city_portfolio`: optimizes candidate positions jointly within each city.
- `city_portfolio` with `maxGroupFraction = 0.25`: same city optimizer, but
  caps exposure to any single city at 25% of bankroll.

## Aggregate Results

| Strategy | Days | Winning Days | Losing Days | Stake | PnL | ROI on Stake |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Independent Kelly | 7 | 4 | 3 | `$700` | `-$5.58` | `-0.8%` |
| City portfolio | 7 | 4 | 3 | `$700` | `-$7.20` | `-1.0%` |
| City portfolio, 25% city cap | 7 | 5 | 2 | `$700` | `+$26.39` | `+3.8%` |

## Daily Results

| Date | Strategy | Candidates | Wins | Losses | Stake | Payout | PnL | ROI |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| 2026-06-24 | Independent Kelly | 189 | 93 | 96 | `$100` | `$96.78` | `-$3.22` | `-3.2%` |
| 2026-06-24 | City portfolio | 186 | 90 | 96 | `$100` | `$94.48` | `-$5.52` | `-5.5%` |
| 2026-06-24 | City portfolio, 25% city cap | 87 | 39 | 48 | `$100` | `$104.88` | `+$4.88` | `+4.9%` |
| 2026-06-25 | Independent Kelly | 156 | 85 | 71 | `$100` | `$103.16` | `+$3.16` | `+3.2%` |
| 2026-06-25 | City portfolio | 154 | 83 | 71 | `$100` | `$101.75` | `+$1.75` | `+1.8%` |
| 2026-06-25 | City portfolio, 25% city cap | 128 | 70 | 58 | `$100` | `$105.74` | `+$5.74` | `+5.7%` |
| 2026-06-26 | Independent Kelly | 186 | 87 | 99 | `$100` | `$87.21` | `-$12.79` | `-12.8%` |
| 2026-06-26 | City portfolio | 150 | 69 | 81 | `$100` | `$89.16` | `-$10.84` | `-10.8%` |
| 2026-06-26 | City portfolio, 25% city cap | 90 | 41 | 49 | `$100` | `$80.28` | `-$19.72` | `-19.7%` |
| 2026-06-27 | Independent Kelly | 196 | 94 | 102 | `$100` | `$109.48` | `+$9.48` | `+9.5%` |
| 2026-06-27 | City portfolio | 170 | 80 | 90 | `$100` | `$112.67` | `+$12.67` | `+12.7%` |
| 2026-06-27 | City portfolio, 25% city cap | 55 | 24 | 31 | `$100` | `$102.39` | `+$2.39` | `+2.4%` |
| 2026-06-28 | Independent Kelly | 156 | 84 | 72 | `$100` | `$105.61` | `+$5.61` | `+5.6%` |
| 2026-06-28 | City portfolio | 118 | 61 | 57 | `$100` | `$100.11` | `+$0.11` | `+0.1%` |
| 2026-06-28 | City portfolio, 25% city cap | 109 | 61 | 48 | `$100` | `$113.71` | `+$13.71` | `+13.7%` |
| 2026-06-29 | Independent Kelly | 192 | 95 | 97 | `$100` | `$103.64` | `+$3.64` | `+3.6%` |
| 2026-06-29 | City portfolio | 165 | 82 | 83 | `$100` | `$109.62` | `+$9.62` | `+9.6%` |
| 2026-06-29 | City portfolio, 25% city cap | 82 | 40 | 42 | `$100` | `$129.44` | `+$29.44` | `+29.4%` |
| 2026-06-30 | Independent Kelly | 171 | 89 | 82 | `$100` | `$88.54` | `-$11.46` | `-11.5%` |
| 2026-06-30 | City portfolio | 121 | 63 | 58 | `$100` | `$85.01` | `-$14.99` | `-15.0%` |
| 2026-06-30 | City portfolio, 25% city cap | 119 | 64 | 55 | `$100` | `$89.95` | `-$10.05` | `-10.1%` |

## Interpretation

The safest conclusion is that WeatherEdge is directionally useful but not yet
proven positive EV.

The uncapped strategies did not make money in this run. That matters because
it suggests the raw edge estimates can over-concentrate in correlated weather
ladders, especially when several markets are all different thresholds for the
same city and date.

The 25% city cap did better, with a `+3.8%` return on stake across the week.
That supports the idea that correlation-aware sizing is important. It does not
prove the strategy is robust, because the sample is small and the cap value was
chosen after we had already seen some early behavior.

## Caveats

- This is a short sample: seven target dates is not enough to establish
  statistical confidence.
- Results are sensitive to realistic fills, spreads, order book depth, and
  price staleness. The backtest uses market snapshots and price history, not
  guaranteed executable fills.
- Some historical Polymarket weather markets are global. Settlement outcomes
  are used for scoring, but station diagnostics are strongest for markets that
  cleanly map to known weather stations.
- The strategy needs to be locked before a larger backtest. Repeatedly tuning
  thresholds, caps, or edge filters after seeing results can overfit the sample.
- Market resolution criteria must continue to be audited city by city and
  threshold by threshold.

## Trading Implication

For live trading, this result supports using the capped city optimizer at small
size, not sizing aggressively.

Recommended live posture:

- Use `city_portfolio` sizing with a city exposure cap.
- Keep fractional Kelly sizing.
- Require a meaningful minimum edge.
- Avoid piling into many correlated thresholds for the same city.
- Prefer station-matched markets with clear resolution criteria.
- Keep recording snapshots, forecasts, trades, and outcomes so the model can be
  audited against real fills.

## Next Backtest Improvements

- Run a longer locked-strategy backtest before changing parameters again.
- Separate U.S. station-matched markets from global markets.
- Add realized fill/slippage assumptions.
- Compare fixed-fraction, independent Kelly, capped Kelly, and city portfolio
  sizing on the same frozen market universe.
- Report confidence intervals or bootstrap distributions for daily PnL.
- Track edge calibration by probability bucket, city, provider, and threshold.
