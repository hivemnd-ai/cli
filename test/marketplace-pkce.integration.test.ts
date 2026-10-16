import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createMarketplacePkce } from "../src/auth/marketplace-pkce.js";

describe("private marketplace PKCE binding", () => {
  it("keeps each random verifier independent while exposing only an S256 challenge to the handoff", () => {
    const first = createMarketplacePkce();
    const second = createMarketplacePkce();
    for (const pair of [first, second]) {
      expect(pair.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(pair.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(pair.challenge).not.toBe(pair.verifier);
      expect(pair.challenge).toBe(
        createHash("sha256").update(pair.verifier).digest("base64url"),
      );
    }
    expect(first.verifier).not.toBe(second.verifier);
    expect(first.challenge).not.toBe(second.challenge);
  });
});
