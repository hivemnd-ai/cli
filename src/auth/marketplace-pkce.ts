import { createHash, randomBytes } from "node:crypto";

/** Memory-only PKCE material. Only challenge belongs in the browser handoff request. */
export function createMarketplacePkce(): {
  verifier: string;
  challenge: string;
} {
  const verifier = randomBytes(32).toString("base64url");
  return {
    verifier,
    challenge: createHash("sha256").update(verifier).digest("base64url"),
  };
}
