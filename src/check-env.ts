import "dotenv/config";
import { existsSync, readFileSync } from "node:fs";
import { AssetType, ClobClient } from "@polymarket/clob-client-v2";
import { createWalletClient } from "viem";
import { createPublicClient, http, isAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";
import { VistadexClient } from "vistadex";
import { keypairFromVistadexSecret } from "./vistadexWallet.js";

function optionalEnv(name: string): string | undefined {
  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function getPolygonCode(address: `0x${string}`) {
  const rpcUrls = [
    optionalEnv("POLYGON_RPC_URL"),
    "https://polygon-bor-rpc.publicnode.com",
    "https://polygon.drpc.org",
    "https://rpc.ankr.com/polygon"
  ].filter((url): url is string => Boolean(url));

  let lastError: unknown;
  for (const rpcUrl of rpcUrls) {
    try {
      const client = createPublicClient({ chain: polygon, transport: http(rpcUrl) });
      const code = await client.getCode({ address });
      return {
        rpcUrl,
        hasContractCode: Boolean(code && code !== "0x"),
        codeBytes: code && code !== "0x" ? (code.length - 2) / 2 : 0
      };
    } catch (error) {
      lastError = error;
    }
  }

  return { error: errorMessage(lastError) };
}

async function getPolymarketBalanceAllowance() {
  const privateKey = optionalEnv("POLYMARKET_PRIVATE_KEY");
  if (!privateKey || !/^0x[0-9a-fA-F]{64}$/.test(privateKey)) {
    return "skipped; requires a valid POLYMARKET_PRIVATE_KEY";
  }

  try {
    const host = optionalEnv("POLYMARKET_HOST") ?? "https://clob.polymarket.com";
    const chain = Number(optionalEnv("POLYMARKET_CHAIN_ID") ?? "137");
    const signer = createWalletClient({
      account: privateKeyToAccount(privateKey as `0x${string}`),
      transport: http(optionalEnv("POLYGON_RPC_URL") ?? "https://polygon-bor-rpc.publicnode.com")
    });
    const tempClient = new ClobClient({ host, chain, signer });
    const creds = optionalEnv("POLYMARKET_API_KEY") &&
      optionalEnv("POLYMARKET_API_SECRET") &&
      optionalEnv("POLYMARKET_API_PASSPHRASE")
      ? {
          key: optionalEnv("POLYMARKET_API_KEY") as string,
          secret: optionalEnv("POLYMARKET_API_SECRET") as string,
          passphrase: optionalEnv("POLYMARKET_API_PASSPHRASE") as string
        }
      : await tempClient.createOrDeriveApiKey();
    const client = new ClobClient({
      host,
      chain,
      signer,
      creds,
      signatureType: Number(optionalEnv("POLYMARKET_SIGNATURE_TYPE") ?? "3"),
      funderAddress: optionalEnv("POLYMARKET_FUNDER_ADDRESS")
    });

    return await client.getBalanceAllowance({ asset_type: AssetType.COLLATERAL });
  } catch (error) {
    return { error: errorMessage(error) };
  }
}

async function main() {
  const network = process.argv.includes("--network");
  const errors: string[] = [];
  const warnings: string[] = [];

  const polymarketPrivateKey = optionalEnv("POLYMARKET_PRIVATE_KEY");
  const polymarketFunder = optionalEnv("POLYMARKET_FUNDER_ADDRESS");
  const polymarketSignatureType = optionalEnv("POLYMARKET_SIGNATURE_TYPE") ?? "3";

  let polymarketSignerAddress: string | undefined;
  if (!polymarketPrivateKey) {
    warnings.push("POLYMARKET_PRIVATE_KEY is not set.");
  } else if (!/^0x[0-9a-fA-F]{64}$/.test(polymarketPrivateKey)) {
    errors.push("POLYMARKET_PRIVATE_KEY is not a 0x-prefixed 32-byte hex private key.");
  } else {
    polymarketSignerAddress = privateKeyToAccount(polymarketPrivateKey as `0x${string}`).address;
  }

  if (!polymarketFunder) {
    warnings.push("POLYMARKET_FUNDER_ADDRESS is not set.");
  } else if (!isAddress(polymarketFunder)) {
    errors.push("POLYMARKET_FUNDER_ADDRESS is not a valid EVM address.");
  }

  if (polymarketSignatureType !== "3") {
    warnings.push("POLYMARKET_SIGNATURE_TYPE is not 3; this is unusual for new deposit-wallet accounts.");
  }

  const vistadexApiKey = optionalEnv("VISTADEX_CLIENT_API_KEY");
  const vistadexSecretKey = optionalEnv("VISTADEX_SECRET_KEY");
  const vistadexKeypairPath = optionalEnv("VISTADEX_KEYPAIR_PATH");
  let vistadexPublicKey: string | undefined;
  let vistadexWalletError: string | undefined;

  if (!vistadexApiKey) {
    warnings.push("VISTADEX_CLIENT_API_KEY is not set.");
  }

  if (!vistadexSecretKey && !vistadexKeypairPath) {
    warnings.push("Neither VISTADEX_SECRET_KEY nor VISTADEX_KEYPAIR_PATH is set.");
  } else {
    try {
      const secretMaterial = vistadexSecretKey ?? readFileSync(vistadexKeypairPath as string, "utf8");
      vistadexPublicKey = keypairFromVistadexSecret(secretMaterial).publicKey.toBase58();
    } catch (error) {
      vistadexWalletError = errorMessage(error);
      errors.push(`Could not load Vistadex wallet: ${vistadexWalletError}`);
    }
  }

  const result: Record<string, unknown> = {
    ok: errors.length === 0,
    errors,
    warnings,
    polymarket: {
      signerAddress: polymarketSignerAddress,
      funderAddress: polymarketFunder,
      signerEqualsFunder:
        polymarketSignerAddress && polymarketFunder
          ? polymarketSignerAddress.toLowerCase() === polymarketFunder.toLowerCase()
          : undefined,
      signatureType: polymarketSignatureType,
      apiCredsPresent: Boolean(
        optionalEnv("POLYMARKET_API_KEY") &&
          optionalEnv("POLYMARKET_API_SECRET") &&
          optionalEnv("POLYMARKET_API_PASSPHRASE")
      )
    },
    vistadex: {
      apiKeyPresent: Boolean(vistadexApiKey),
      keypairPath: vistadexKeypairPath,
      keypairPathExists: vistadexKeypairPath ? existsSync(vistadexKeypairPath) : undefined,
      secretKeyPresent: Boolean(vistadexSecretKey),
      publicKey: vistadexPublicKey,
      rpcUrl: optionalEnv("VISTADEX_RPC_URL") ?? "https://api.mainnet-beta.solana.com",
      positionsBaseUrl: optionalEnv("VISTADEX_POSITIONS_API_URL") ?? "https://markets.vistadex.com"
    }
  };

  if (network) {
    result.network = {
      polymarketGeoblock: await fetch("https://polymarket.com/api/geoblock").then((response) =>
        response.json()
      ),
      polymarketFunderCode:
        polymarketFunder && isAddress(polymarketFunder)
          ? await getPolygonCode(polymarketFunder as `0x${string}`)
          : undefined,
      polymarketCollateral: await getPolymarketBalanceAllowance(),
      vistadexUsdcBalance:
        vistadexApiKey && vistadexPublicKey
          ? await new VistadexClient({
              apiKey: vistadexApiKey,
              rpcUrl: optionalEnv("VISTADEX_RPC_URL"),
              positionsBaseUrl: optionalEnv("VISTADEX_POSITIONS_API_URL")
            }).getUSDCBalance({ walletAddress: vistadexPublicKey })
          : "skipped; requires VISTADEX_CLIENT_API_KEY and a Vistadex wallet"
    };
  }

  console.log(JSON.stringify(result, null, 2));
  process.exitCode = errors.length === 0 ? 0 : 1;
}

main().catch((error) => {
  console.error(errorMessage(error));
  process.exitCode = 1;
});
