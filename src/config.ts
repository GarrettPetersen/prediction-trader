import "dotenv/config";
import { z } from "zod";
import { LIVE_TRADING_ENV_VALUE } from "./safety.js";

const envSchema = z.object({
  PREDICTION_TRADER_LIVE: z.string().default("0"),
  PREDICTION_TRADER_MAX_USD: z.coerce.number().positive().default(5),

  POLYMARKET_HOST: z.string().url().default("https://clob.polymarket.com"),
  POLYMARKET_CHAIN_ID: z.coerce.number().int().positive().default(137),
  POLYMARKET_PRIVATE_KEY: z.string().optional(),
  POLYMARKET_SIGNATURE_TYPE: z.coerce.number().int().min(0).max(3).default(3),
  POLYMARKET_FUNDER_ADDRESS: z.string().optional(),
  POLYMARKET_API_KEY: z.string().optional(),
  POLYMARKET_API_SECRET: z.string().optional(),
  POLYMARKET_API_PASSPHRASE: z.string().optional(),
  POLYGON_RPC_URL: z.string().url().optional(),

  VISTADEX_CLIENT_API_KEY: z.string().optional(),
  VISTADEX_RPC_URL: z.string().url().default("https://api.mainnet-beta.solana.com"),
  VISTADEX_POSITIONS_API_URL: z.string().url().default("https://markets.vistadex.com"),
  VISTADEX_SECRET_KEY: z.string().optional(),
  VISTADEX_KEYPAIR_PATH: z.string().optional()
});

export type AppConfig = ReturnType<typeof loadConfig>;

export function loadConfig(overrides: Record<string, string | undefined> = {}) {
  const parsed = envSchema.parse({ ...process.env, ...overrides });

  return {
    safety: {
      liveEnabled: parsed.PREDICTION_TRADER_LIVE === LIVE_TRADING_ENV_VALUE,
      maxUsd: parsed.PREDICTION_TRADER_MAX_USD
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
      rpcUrl: parsed.VISTADEX_RPC_URL,
      positionsBaseUrl: parsed.VISTADEX_POSITIONS_API_URL,
      secretKey: parsed.VISTADEX_SECRET_KEY,
      keypairPath: parsed.VISTADEX_KEYPAIR_PATH
    }
  };
}
