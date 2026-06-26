import { createWalletClient, http, type Hex } from "viem";
import { polygon } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import type { AppConfig } from "../config.js";
import type {
  PolymarketOrderTicket,
  PolymarketRedeemTicket,
  TradeExecution,
  TradePreview
} from "../types.js";

type ClobModule = typeof import("@polymarket/clob-client-v2");
type PolymarketClientModule = typeof import("@polymarket/client");
type PolymarketActionsModule = typeof import("@polymarket/client/actions");
type PolymarketNodeModule = typeof import("@polymarket/client/node");
type PolymarketViemModule = typeof import("@polymarket/client/viem");

const POLYMARKET_COLLATERAL_TOKEN = "0xC011a7E12a19f7B1f670d46F03B03f3342E82DFB";
const POLYMARKET_COLLATERAL_ADAPTER = "0xAdA100Db00Ca00073811820692005400218FcE1f";
const POLYMARKET_NEG_RISK_COLLATERAL_ADAPTER = "0xadA2005600Dec949baf300f4C6120000bDB6eAab";
const POLYMARKET_GAMMA_BASE_URL = "https://gamma-api.polymarket.com";

export function getPolymarketExecutionStatus(response: any): TradeExecution["status"] {
  if (
    response?.success === false ||
    response?.error ||
    (typeof response?.status === "number" && response.status >= 400)
  ) {
    return "failed";
  }

  const status = typeof response?.status === "string" ? response.status.toLowerCase() : "";
  if (status === "matched" || status === "filled") {
    return "filled";
  }

  return "submitted";
}

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

async function createPolymarketSdkClient(config: AppConfig) {
  const [
    { createSecureClient },
    { createBuilderApiKey, revokeBuilderApiKey },
    { builderApiKey },
    { privateKey }
  ] = await Promise.all([
    import("@polymarket/client") as Promise<PolymarketClientModule>,
    import("@polymarket/client/actions") as Promise<PolymarketActionsModule>,
    import("@polymarket/client/node") as Promise<PolymarketNodeModule>,
    import("@polymarket/client/viem") as Promise<PolymarketViemModule>
  ]);
  const signerPrivateKey = requirePolymarketPrivateKey(config);
  const signer = privateKey(signerPrivateKey, {
    chain: polygon,
    transport: http(config.polymarket.rpcUrl)
  });

  const options: Parameters<typeof createSecureClient>[0] = { signer };
  if (config.polymarket.funderAddress) {
    options.wallet = config.polymarket.funderAddress;
  }
  if (config.polymarket.apiCreds) {
    options.credentials = config.polymarket.apiCreds as Parameters<typeof createSecureClient>[0]["credentials"];
  }

  let client = await createSecureClient(options);
  const temporaryBuilderCreds = await createBuilderApiKey(client);
  options.credentials = client.credentials;
  options.apiKey = builderApiKey(temporaryBuilderCreds);
  client = await createSecureClient(options);

  return {
    client,
    signer,
    revokeBuilderKey: async () => {
      await revokeBuilderApiKey(client);
    }
  };
}

async function resolvePolymarketRedeemMarket(ticket: PolymarketRedeemTicket) {
  const url = new URL("/markets", POLYMARKET_GAMMA_BASE_URL);
  url.searchParams.set("closed", "true");

  if (ticket.conditionId) {
    url.searchParams.set("condition_ids", ticket.conditionId);
  } else if (ticket.marketId) {
    url.searchParams.set("id", ticket.marketId);
  } else {
    throw new Error("Market metadata lookup requires --condition-id or --market-id.");
  }

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Polymarket Gamma lookup failed with HTTP ${response.status}.`);
  }

  const markets = await response.json();
  if (!Array.isArray(markets) || markets.length !== 1) {
    const target = ticket.conditionId ? `condition ${ticket.conditionId}` : `market ${ticket.marketId}`;
    throw new Error(`Expected exactly one closed Polymarket market for ${target}.`);
  }

  const market = markets[0] as Record<string, unknown>;
  if (typeof market.conditionId !== "string") {
    throw new Error("Polymarket Gamma response did not include conditionId.");
  }

  return {
    marketId: String(market.id),
    conditionId: market.conditionId,
    negRisk: market.negRisk === true,
    question: typeof market.question === "string" ? market.question : undefined
  };
}

async function completeGaslessWorkflow(workflow: AsyncGenerator<any, any, any>, signer: any) {
  let step = await workflow.next();
  while (!step.done) {
    const request = step.value;
    if (request.kind === "requestAddress") {
      step = await workflow.next(await signer.getAddress());
      continue;
    }
    if (request.kind === "signGaslessMessage") {
      step = await workflow.next(await signer.signMessage(request.payload));
      continue;
    }
    if (request.kind === "signGaslessTypedData") {
      step = await workflow.next(await signer.signTypedData(request.payload));
      continue;
    }

    throw new Error(`Unsupported gasless workflow request: ${String(request.kind)}`);
  }

  return step.value;
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

export function previewPolymarketRedeem(ticket: PolymarketRedeemTicket): TradePreview {
  const target = ticket.conditionId
    ? `condition ${ticket.conditionId}`
    : ticket.marketId
      ? `market ${ticket.marketId}`
      : `position ${ticket.positionId}`;

  return {
    venue: "polymarket",
    summary: `Redeem resolved Polymarket positions for ${target}`,
    notionalUsd: 0,
    details: { ...ticket }
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
      status: getPolymarketExecutionStatus(response),
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
    status: getPolymarketExecutionStatus(response),
    details: response
  };
}

export async function executePolymarketRedeem(
  config: AppConfig,
  ticket: PolymarketRedeemTicket
): Promise<TradeExecution> {
  const { client, signer, revokeBuilderKey } = await createPolymarketSdkClient(config);
  let result: TradeExecution | undefined;

  try {
    if (ticket.positionId) {
      const request = { positionId: ticket.positionId };
      const handle = await client.redeemPositions(request);
      const outcome = await handle.wait();
      result = {
        venue: "polymarket",
        status: "filled",
        details: {
          account: client.account,
          request,
          transactionHash: outcome.transactionHash,
          transactionId: outcome.transactionId
        }
      };
      return result;
    }

    const [{ ctfRedeemPositionsCall }, { prepareGaslessTransaction }] = await Promise.all([
      import("@polymarket/client") as Promise<PolymarketClientModule>,
      import("@polymarket/client/actions") as Promise<PolymarketActionsModule>
    ]);
    const market = await resolvePolymarketRedeemMarket(ticket);
    const adapterAddress = market.negRisk
      ? POLYMARKET_NEG_RISK_COLLATERAL_ADAPTER
      : POLYMARKET_COLLATERAL_ADAPTER;
    const call = ctfRedeemPositionsCall(
      adapterAddress as any,
      POLYMARKET_COLLATERAL_TOKEN as any,
      market.conditionId as any
    );
    const isEoaAccount = client.account.wallet.toLowerCase() === client.account.signer.toLowerCase();
    const handle = isEoaAccount
      ? await signer.sendTransaction({
          chainId: config.polymarket.chainId,
          to: call.to,
          data: call.data,
          value: call.value
        })
      : await completeGaslessWorkflow(
          await prepareGaslessTransaction(client, {
            calls: [call],
            metadata: `Redeem positions for market ${market.marketId} (condition ${market.conditionId})`
          }),
          signer
        );
    const outcome = await handle.wait();

    result = {
      venue: "polymarket",
      status: "filled",
      details: {
        account: client.account,
        request: ticket,
        market,
        adapterAddress,
        transactionHash: outcome.transactionHash,
        transactionId: outcome.transactionId
      }
    };
    return result;
  } finally {
    try {
      await revokeBuilderKey();
    } catch (error) {
      if (result) {
        result.details.builderKeyRevokeWarning = error instanceof Error ? error.message : String(error);
      }
    }
  }
}

export interface PolymarketTradeHistoryOptions {
  market?: string;
  assetId?: string;
  after?: string;
  before?: string;
  onlyFirstPage?: boolean;
}

export async function getPolymarketTradeHistory(
  config: AppConfig,
  options: PolymarketTradeHistoryOptions = {}
): Promise<unknown[]> {
  const { client } = await createPolymarketClient(config);
  const params: Record<string, string> = {};
  if (options.market) params.market = options.market;
  if (options.assetId) params.asset_id = options.assetId;
  if (options.after) params.after = options.after;
  if (options.before) params.before = options.before;
  return client.getTrades(params, options.onlyFirstPage ?? false);
}
