# Prediction Trader

Headless tooling for small prediction-market trading experiments across
Polymarket and Vistadex.

This repo is intentionally execution-first but safety-first: it gives a local
agent enough structure to preview, quote, and submit small trades, while making
live execution difficult to trigger by accident.

## What This Does

- Builds dry-run trade previews for Polymarket and Vistadex.
- Places Polymarket CLOB orders through `@polymarket/clob-client-v2`.
- Requests and submits Vistadex RFQ trades through the public `vistadex` SDK.
- Requires explicit live-trading gates before any command can submit a trade.
- Keeps wallet keys and API credentials out of source control.

This is not a strategy engine yet. It is the execution plumbing an agent can use
after a human or strategy process chooses a market, side, and size.

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

- Node.js 20 or newer.
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
```

Polymarket:

```bash
POLYMARKET_HOST=https://clob.polymarket.com
POLYMARKET_CHAIN_ID=137
POLYMARKET_PRIVATE_KEY=0x...
POLYMARKET_SIGNATURE_TYPE=3
POLYMARKET_FUNDER_ADDRESS=0x...
POLYGON_RPC_URL=
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
VISTADEX_RPC_URL=https://api.mainnet-beta.solana.com
VISTADEX_POSITIONS_API_URL=https://markets.vistadex.com
VISTADEX_SECRET_KEY=
VISTADEX_KEYPAIR_PATH=
```

For Vistadex, provide either `VISTADEX_SECRET_KEY` or `VISTADEX_KEYPAIR_PATH`.
The SDK accepts a base64 secret key, a JSON array string, or a path to a Solana
keypair JSON file.

## Commands

Show help:

```bash
npm run cli -- --help
```

Run checks:

```bash
npm run build
npm test
```

## Polymarket Usage

Polymarket commands currently require a known outcome `token-id`. Market
discovery is not implemented in this repo yet.

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

## Vistadex Usage

Fetch a Vistadex event by slug:

```bash
npm run vistadex:event -- --slug EVENT_SLUG
```

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

## Agent Operating Checklist

Before an agent is allowed to submit trades:

1. Confirm `.env` exists and secrets are local-only.
2. Run `npm run build` and `npm test`.
3. Confirm bankroll and per-trade limits.
4. Confirm the trading mandate:
   - allowed venues
   - max per-trade size
   - max daily spend or loss
   - allowed market categories
   - banned market categories
   - whether resting orders are allowed
   - exit rules
   - whether every trade needs human approval
5. Run the command once without `--execute`.
6. Read the preview output.
7. Only then rerun with `PREDICTION_TRADER_LIVE=1` and `--execute`.

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
- No Polymarket market discovery yet; pass token IDs manually.
- No portfolio reconciliation or daily-loss accounting yet.
- No persistent trade ledger yet.
- No automatic position exit rules yet.
- Vistadex quote/trade commands require a funded Solana wallet and a client API
  key.

## Dependency Notes

`package.json` includes npm overrides for patched `ws` and `uuid` transitive
dependencies. `npm audit --omit=dev` may still report low-severity advisories
through Polymarket's SDK dependency on Ethers v5/`elliptic`; npm currently
reports no non-breaking fix for that chain.

## Research Notes

- Polymarket official docs recommend the TypeScript CLOB v2 client for order
  creation: `@polymarket/clob-client-v2` with `viem`.
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
- [Vistadex npm package](https://www.npmjs.com/package/vistadex)
