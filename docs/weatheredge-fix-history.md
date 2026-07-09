# WeatherEdge Fix History

This note records the WeatherEdge live-trading fixes that changed how future
trade audits should be sliced. The goal is to avoid mixing trades from different
code regimes and then drawing a false conclusion about the current strategy.

All local times below are `America/Vancouver`. The UTC cutoffs are the values to
use with `--since` in ledger commands.

## Canonical Cutoffs

| Regime | Commit | Local time | UTC cutoff | Audit meaning |
| --- | --- | --- | --- | --- |
| Pre-fail-fast bug era | before `e62c4d2` | before 2026-07-07 10:47:04 | before `2026-07-07T17:47:04Z` | Trades can include missing min-edge configuration, missing calibration data, and heuristic pricing behavior. Do not treat this as evidence for the corrected strategy. |
| Fail-fast bug fix | `e62c4d2` | 2026-07-07 10:47:04 | `2026-07-07T17:47:04Z` | Live reinvestment must fail rather than trade with uncalibrated heuristic pricing. This is the first reasonable cutoff for post-bug-fix audits. |
| Timing/freshness fix | `f6acde4` | 2026-07-08 20:59:15 | `2026-07-09T03:59:15Z` | Buys are gated on forecast source freshness and a common model run. This is the cutoff for post-timing-fix audits. |
| Small-size risk cap | `38f192d` | 2026-07-08 23:08:43 | `2026-07-09T06:08:43Z` | Scheduled buys are capped at `$1` per trade and `5%` of bankroll per run by default. Use this cutoff to evaluate the current low-risk live posture. |

## Detailed Timeline

### Reinvestment plumbing and cash controls

- `f59f956` at `2026-07-06T15:49:25Z`: used fill-implied cash after selling
  locked WeatherEdge positions. This avoided under-deploying after successful
  sells, but it did not fix model quality.
- `7a582eb` at `2026-07-06T18:31:59Z`: gated WeatherEdge buys by market-local
  entry windows. This was the first timing guard, but it was still a broad
  day-window rule.
- `02bde2f` at `2026-07-06T20:53:27Z`: added a target cash reserve so the bot
  did not try to deploy every dollar.

### Fail-fast and calibration bug fix series

- `b49971c` at `2026-07-07T15:45:10Z`: required an explicit WeatherEdge
  minimum edge in scheduled execution. The old behavior could silently run with
  an unintended edge threshold.
- `a2d31cc` at `2026-07-07T16:42:09Z`: moved live WeatherEdge pricing onto
  historical previous-run residual calibration. This made live scoring closer
  to the backtest path.
- `5a1794f` at `2026-07-07T16:56:04Z`: restored WeatherEdge calibration
  datasets in GitHub Actions. Without this, the scheduled job did not have the
  same information as the local model.
- `e62c4d2` at `2026-07-07T17:47:04Z`: made live reinvestment fail if it lacks
  calibrated historical residuals. This is the main bug-fix cutoff because it
  closed the path where the bot could trade on diagnostic heuristic pricing.
- `663cb9d` at `2026-07-07T21:56:09Z`: documented the fail-closed/no-fallback
  policy and cleaned up fallback wording. This did not create a new trading
  cutoff by itself, but it records the engineering rule: missing required data
  should stop trading loudly.

### Audit and strategy safety

- `a6f5a76` at `2026-07-08T17:16:30Z`: added `ledger:pnl`,
  `weather:trade-audit`, and the recent-audit gate. This lets us compare the
  actual WeatherEdge portfolio with a same-dollar opposite-side portfolio and
  block future buys when recent performance is poor.

### Timing fix series

- `9ed3d8a` at `2026-07-09T03:44:11Z`: split entry windows by measure. The
  current rule is to consider high-temperature markets near market-local
  midnight and low-temperature markets midday on the previous market-local day.
- `f6acde4` at `2026-07-09T03:59:15Z`: required fresh forecast metadata before
  opening new positions. The loop checks Open-Meteo model initialization
  metadata and skips buys if the common forecast run is stale or unavailable.
  Sells of locked positions can still proceed.

### Current risk cap

- `38f192d` at `2026-07-09T06:08:43Z`: capped scheduled WeatherEdge buying at
  `$1` per trade and `5%` of bankroll for new buys by default. This is the
  current live-risk cutoff. Trades before this can be directionally useful for
  model audit, but they overstate the loss rate of the current bankroll policy.

## Known Polluted Cohorts

- Before `2026-07-07T17:47:04Z`: polluted by the fallback/calibration bug. Do
  not use these trades to judge the corrected strategy.
- From `2026-07-07T17:47:04Z` through `2026-07-09T03:59:15Z`: fail-fast
  calibration is present, but the timing/freshness fix is not. These trades can
  help identify bad model buckets, but they should not be used as final evidence
  for the timed strategy.
- From `2026-07-09T03:59:15Z` through `2026-07-09T06:08:43Z`: timing/freshness
  is present, but the old larger sizing is still active.
- After `2026-07-09T06:08:43Z`: current low-risk regime. This is the cleanest
  live audit period once enough trades accumulate.

## Re-Audit Commands

Refresh the local ledger first:

```bash
npm run ledger:update -- --venue vistadex --limit 100
```

Audit post-bug-fix WeatherEdge PnL:

```bash
npm run ledger:pnl -- \
  --venue vistadex \
  --category weather \
  --since 2026-07-07T17:47:04.000Z \
  --mark bid \
  --top 20
```

Audit post-timing-fix WeatherEdge PnL:

```bash
npm run ledger:pnl -- \
  --venue vistadex \
  --category weather \
  --since 2026-07-09T03:59:15.000Z \
  --mark bid \
  --top 20
```

Audit the current `$1` capped regime:

```bash
npm run ledger:pnl -- \
  --venue vistadex \
  --category weather \
  --since 2026-07-09T06:08:43.000Z \
  --mark bid \
  --top 20
```

Compare against the opposite-side portfolio:

```bash
npm run weather:trade-audit -- \
  --venue vistadex \
  --since 2026-07-09T06:08:43.000Z \
  --mark bid \
  --top 20
```

Use `--include-sell-only` on `ledger:pnl` only when auditing total cash flow
from liquidating older positions. The default cohort PnL intentionally excludes
sell-only rows so that selling a pre-window position does not make a later
strategy window look profitable.

## Last Manual Baseline

After refreshing the Vistadex ledger on 2026-07-09, the post-bug-fix weather
cohort from `2026-07-07T17:47:04Z` was still negative:

- Buy cost: `$207.13`
- Realized sells in cohort PnL: `$119.81`
- Live bid value: `$22.21`
- Bid-marked PnL: `-$65.12`
- Bid-marked ROI: `-31.4%`

The post-timing-fix weather cohort from `2026-07-09T03:59:15Z` had only two
new weather buys:

- Houston high 94-95F `NO`: `-$3.11` at live bid
- Seattle high 74-75F `NO`: `+$1.19` at live bid
- Combined bid-marked PnL: `-$1.92`

That two-trade sample is too small to judge the timing fix. It is mainly useful
as a sanity check that the cohort split works.

There were no new weather buys in the ledger after the `$1` cap cutoff when
this baseline was recorded. Future audits should focus on that period once
enough capped trades exist.

## What To Watch

- Exact-temperature and narrow-range `NO` positions have repeatedly lost when
  the market strongly disagreed with our forecast. Treat that as possible
  adverse selection, not just bad luck.
- Selling locked `NO` positions near `0.99` has worked operationally, but those
  wins can hide earlier bad entry selection if audits include sell-only rows.
- The opposite-side audit is important. If the market-informed opposite keeps
  beating us in a bucket, that bucket should be disabled or inverted before
  increasing size.
- Audit failures caused by missing live marks should fail loudly. Do not replace
  missing marks with guessed values.
