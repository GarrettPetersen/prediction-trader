import { createWalletClient, http, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { AppConfig } from "../config.js";
import type { PolymarketOrderTicket, TradeExecution, TradePreview } from "../types.js";

type ClobModule = typeof import("@polymarket/clob-client-v2");

function requirePolymarketPrivateKey(config: AppConfig): Hex {
  const privateKey = config.polymarket.privateKey;
  if (!privateKey) {
    throw new Error("POLYMARKET_PRIVATE_KEY is required.");
  }
  if (!privateKey.startsWith("0x")) {
    throw new Error("POLYMARKET_PRIVATE_KEY must be a 0x-prefixed private key.");
  }
  return privateKey as Hex;
}

async function createPolymarketClient(config: AppConfig) {
  const mod = (await import("@polymarket/clob-client-v2")) as ClobModule & Record<string, unknown>;
  const ClobClient = mod.ClobClient as any;

  const account = privateKeyToAccount(requirePolymarketPrivateKey(config));
  const signer = createWalletClient({
    account,
    transport: http(config.polymarket.rpcUrl)
  });

  let creds = config.polymarket.apiCreds;
  if (!creds) {
    const tempClient = new ClobClient({
      host: config.polymarket.host,
      chain: config.polymarket.chainId,
      signer
    });
    creds = await tempClient.createOrDeriveApiKey();
  }

  return {
    client: new ClobClient({
      host: config.polymarket.host,
      chain: config.polymarket.chainId,
      signer,
      creds,
      signatureType: config.polymarket.signatureType,
      funderAddress: config.polymarket.funderAddress
    }),
    mod
  };
}

export function previewPolymarketOrder(ticket: PolymarketOrderTicket): TradePreview {
  const notionalUsd = ticket.amountUsd ?? (ticket.shares ?? 0) * ticket.price;
  const sizeDescription = ticket.amountUsd
    ? `$${ticket.amountUsd.toFixed(2)}`
    : `${ticket.shares} shares`;

  return {
    venue: "polymarket",
    summary: `${ticket.side.toUpperCase()} ${sizeDescription} of ${ticket.tokenId} at price ${ticket.price} (${ticket.orderType})`,
    notionalUsd,
    details: {
      ...ticket,
      tickSize: ticket.tickSize ?? "auto",
      negRisk: ticket.negRisk ?? "auto"
    }
  };
}

export async function executePolymarketOrder(
  config: AppConfig,
  ticket: PolymarketOrderTicket
): Promise<TradeExecution> {
  const { client, mod } = await createPolymarketClient(config);
  const Side = (mod as any).Side;
  const OrderType = (mod as any).OrderType;

  const side = ticket.side === "buy" ? Side.BUY : Side.SELL;
  const orderType = OrderType[ticket.orderType];
  const tickSize = ticket.tickSize ?? await client.getTickSize(ticket.tokenId);
  const negRisk = ticket.negRisk ?? await client.getNegRisk(ticket.tokenId);
  const options = { tickSize, negRisk };
  const isMarketType = ticket.orderType === "FOK" || ticket.orderType === "FAK";

  if (isMarketType) {
    const amount = ticket.side === "buy" ? ticket.amountUsd : ticket.shares;
    if (amount === undefined) {
      throw new Error("Market buys require amountUsd; market sells require shares.");
    }

    const signedOrder = await client.createMarketOrder(
      {
        tokenID: ticket.tokenId,
        side,
        amount,
        price: ticket.price
      },
      options
    );
    const response = await client.postOrder(signedOrder, orderType);
    return {
      venue: "polymarket",
      status: response?.success === false ? "failed" : "submitted",
      details: response
    };
  }

  if (ticket.shares === undefined) {
    throw new Error("Limit orders require shares.");
  }

  const signedOrder = await client.createOrder(
    {
      tokenID: ticket.tokenId,
      price: ticket.price,
      size: ticket.shares,
      side
    },
    options
  );
  const response = await client.postOrder(signedOrder, orderType, ticket.postOnly ?? false);

  return {
    venue: "polymarket",
    status: response?.success === false ? "failed" : "submitted",
    details: response
  };
}
