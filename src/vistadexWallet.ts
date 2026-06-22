import { createRequire } from "node:module";
import { keypairFromSecretKey } from "vistadex";

const require = createRequire(import.meta.url);
const bs58 = require("bs58") as { decode(value: string): Uint8Array };
const BASE58_SECRET_KEY = /^[1-9A-HJ-NP-Za-km-z]+$/;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function keypairFromVistadexSecret(secret: string): ReturnType<typeof keypairFromSecretKey> {
  const trimmed = secret.trim();

  try {
    return keypairFromSecretKey(trimmed);
  } catch (sdkError) {
    if (!trimmed.startsWith("[") && BASE58_SECRET_KEY.test(trimmed)) {
      try {
        return keypairFromSecretKey(Uint8Array.from(bs58.decode(trimmed)));
      } catch (base58Error) {
        throw new Error(
          `Invalid Vistadex secret key. Expected JSON array, base64, or base58 export. ` +
            `SDK parse failed with: ${message(sdkError)}. Base58 parse failed with: ${message(base58Error)}.`
        );
      }
    }

    throw new Error(
      `Invalid Vistadex secret key. Expected JSON array, base64, or base58 export. ` +
        `SDK parse failed with: ${message(sdkError)}.`
    );
  }
}
