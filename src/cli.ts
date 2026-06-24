import { inspect } from "node:util";
import { loadConfig } from "./config.js";
import { assertCanExecute, assertLiveMutation } from "./safety.js";
import {
  executePolymarketOrder,
  executePolymarketRedeem,
  previewPolymarketRedeem,
  previewPolymarketOrder
} from "./marketplaces/polymarket.js";
import {
  getPolymarketEvent,
  getPolymarketPositions
} from "./marketplaces/polymarketData.js";
import {
  executeVistadexTrade,
  getVistadexEvent,
  getVistadexPositions,
  previewVistadexTrade,
  quoteVistadexTrade
} from "./marketplaces/vistadex.js";
import type {
  PolymarketOrderTicket,
  PolymarketRedeemTicket,
  TradeSide,
  VistadexTradeTicket
} from "./types.js";

type Args = Record<string, string | boolean>;
const POLYMARKET_ORDER_TYPES = new Set(["GTC", "GTD", "FOK", "FAK"]);

function parseArgs(argv: string[]): { command: string; args: Args } {
  const [command = "help", ...rest] = argv;
  const args: Args = {};

  for (let i = 0; i < rest.length; i += 1) {
    const item = rest[i];
    if (!item.startsWith("--")) continue;

    const key = item.slice(2);
    const next = rest[i + 1];
    if (!next || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      i += 1;
    }
  }

  return { command, args };
}

function stringArg(args: Args, key: string, required = true): string | undefined {
  const value = args[key];
  if (typeof value === "string" && value.length > 0) return value;
  if (required) throw new Error(`Missing --${key}.`);
  return undefined;
}

function requiredStringArg(args: Args, key: string): string {
  return stringArg(args, key, true) as string;
}

function numberArg(args: Args, key: string, required = true): number | undefined {
  const raw = stringArg(args, key, required);
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`--${key} must be a number.`);
  return value;
}

function requiredNumberArg(args: Args, key: string): number {
  return numberArg(args, key, true) as number;
}

function sideArg(args: Args): TradeSide {
  const side = requiredStringArg(args, "side");
  if (side !== "buy" && side !== "sell") {
    throw new Error("--side must be buy or sell.");
  }
  return side;
}

function polymarketOrderTypeArg(args: Args): PolymarketOrderTicket["orderType"] {
  const orderType = (stringArg(args, "order-type", false) ?? "FOK").toUpperCase();
  if (!POLYMARKET_ORDER_TYPES.has(orderType)) {
    throw new Error("--order-type must be one of GTC, GTD, FOK, FAK.");
  }
  return orderType as PolymarketOrderTicket["orderType"];
}

function validatePolymarketTicket(ticket: PolymarketOrderTicket): void {
  const isMarketType = ticket.orderType === "FOK" || ticket.orderType === "FAK";
  if (ticket.amountUsd !== undefined && ticket.shares !== undefined) {
    throw new Error("Pass only one of --amount-usd or --shares.");
  }
  if (isMarketType && ticket.side === "buy" && ticket.amountUsd === undefined) {
    throw new Error("Polymarket market buys require --amount-usd.");
  }
  if (isMarketType && ticket.side === "sell" && ticket.shares === undefined) {
    throw new Error("Polymarket market sells require --shares.");
  }
  if (!isMarketType && ticket.shares === undefined) {
    throw new Error("Polymarket limit orders require --shares.");
  }
}

function validatePolymarketRedeemTicket(ticket: PolymarketRedeemTicket): void {
  const targets = [ticket.conditionId, ticket.marketId, ticket.positionId].filter(Boolean);
  if (targets.length !== 1) {
    throw new Error("Pass exactly one of --condition-id, --market-id, or --position-id.");
  }
}

function validateVistadexTicket(ticket: VistadexTradeTicket): void {
  if (ticket.side === "buy" && ticket.amountUsd === undefined) {
    throw new Error("Vistadex buys require --amount-usd.");
  }
  if (ticket.side === "sell" && ticket.shares === undefined) {
    throw new Error("Vistadex sells require --shares.");
  }
}

function print(value: unknown): void {
  console.log(inspect(value, { depth: null, colors: true }));
}

function usage(): void {
  console.log(`Prediction Trader

Commands:
  polymarket:positions [--redeemable] [--include-zero] [--limit N]
  polymarket:event --slug SLUG [--orderbook]
  polymarket:order --side buy|sell --token-id ID --price N (--amount-usd N | --shares N) [--order-type FOK|FAK|GTC|GTD] [--execute]
  polymarket:redeem (--condition-id HEX | --market-id ID | --position-id ID) [--execute]
  vistadex:event --slug SLUG
  vistadex:positions [--include-zero] [--limit N]
  vistadex:quote --side buy|sell --condition-id HEX --outcome-index 0|1 (--amount-usd N | --shares N) [--limit-price N]
  vistadex:trade --side buy|sell --condition-id HEX --outcome-index 0|1 (--amount-usd N | --shares N) [--limit-price N] [--execute]

Live trading requires --execute and PREDICTION_TRADER_LIVE=1.
`);
}

async function run(): Promise<void> {
  const { command, args } = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const execute = args.execute === true;
  const maxUsd = numberArg(args, "max-usd", false);
  const safety = {
    ...config.safety,
    maxUsd: maxUsd ?? config.safety.maxUsd
  };

  if (command === "help" || command === "--help" || command === "-h") {
    usage();
    return;
  }

  if (command === "polymarket:positions") {
    print(await getPolymarketPositions(config, {
      includeZero: args["include-zero"] === true,
      limit: numberArg(args, "limit", false),
      redeemableOnly: args.redeemable === true
    }));
    return;
  }

  if (command === "polymarket:event") {
    print(await getPolymarketEvent(config, requiredStringArg(args, "slug"), {
      includeOrderbook: args.orderbook === true
    }));
    return;
  }

  if (command === "polymarket:order") {
    const ticket: PolymarketOrderTicket = {
      venue: "polymarket",
      side: sideArg(args),
      tokenId: requiredStringArg(args, "token-id"),
      price: requiredNumberArg(args, "price"),
      orderType: polymarketOrderTypeArg(args),
      amountUsd: numberArg(args, "amount-usd", false),
      shares: numberArg(args, "shares", false),
      tickSize: stringArg(args, "tick-size", false),
      negRisk: args["neg-risk"] === true ? true : undefined,
      postOnly: args["post-only"] === true
    };
    validatePolymarketTicket(ticket);

    const preview = previewPolymarketOrder(ticket);
    print({ execute, preview, safety });
    if (!execute) return;

    assertCanExecute(ticket, safety, execute);
    print(await executePolymarketOrder(config, ticket));
    return;
  }

  if (command === "polymarket:redeem") {
    const ticket: PolymarketRedeemTicket = {
      venue: "polymarket",
      conditionId: stringArg(args, "condition-id", false),
      marketId: stringArg(args, "market-id", false),
      positionId: stringArg(args, "position-id", false)
    };
    validatePolymarketRedeemTicket(ticket);

    print({ execute, preview: previewPolymarketRedeem(ticket), safety });
    if (!execute) return;

    assertLiveMutation(safety, execute);
    print(await executePolymarketRedeem(config, ticket));
    return;
  }

  if (command === "vistadex:event") {
    print(await getVistadexEvent(config, requiredStringArg(args, "slug")));
    return;
  }

  if (command === "vistadex:positions") {
    print(await getVistadexPositions(config, {
      includeZero: args["include-zero"] === true,
      limit: numberArg(args, "limit", false)
    }));
    return;
  }

  if (command === "vistadex:quote" || command === "vistadex:trade") {
    const outcomeIndex = requiredNumberArg(args, "outcome-index");
    if (outcomeIndex !== 0 && outcomeIndex !== 1) {
      throw new Error("--outcome-index must be 0 or 1.");
    }

    const ticket: VistadexTradeTicket = {
      venue: "vistadex",
      side: sideArg(args),
      conditionId: requiredStringArg(args, "condition-id"),
      outcomeIndex,
      collateralMint: stringArg(args, "collateral-mint", false),
      amountUsd: numberArg(args, "amount-usd", false),
      shares: numberArg(args, "shares", false),
      limitPrice: numberArg(args, "limit-price", false)
    };
    validateVistadexTicket(ticket);

    const preview = previewVistadexTrade(ticket);
    print({ execute, preview, safety });
    if (command === "vistadex:quote") {
      print(await quoteVistadexTrade(config, ticket));
      return;
    }
    if (!execute) return;

    assertCanExecute(ticket, safety, execute);
    print(await executeVistadexTrade(config, ticket));
    return;
  }

  usage();
  throw new Error(`Unknown command: ${command}`);
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
