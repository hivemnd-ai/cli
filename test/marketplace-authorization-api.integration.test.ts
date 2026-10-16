import { describe, expect, it, vi } from "vitest";
import { MarketplaceApiClient } from "../src/api/marketplace-api-client.js";
import { wireEnvelope, requestUrl } from "./marketplace-fixtures.js";
const id = "a".repeat(43);
const opaque = "b".repeat(43);
const expires = () => new Date(Date.now() + 60_000).toISOString();
describe("private authorization HTTP boundary", () => {
  it("sends PKCE only to tenant endpoints and the opaque grant only in its header", async () => {
    const replies = [
      Response.json(
        {
          ...wireEnvelope,
          authorization_id: id,
          verification_uri: `https://host/eigen/marketplace/authorizations/${id}`,
          expires_at: expires(),
          poll_interval_seconds: 2,
        },
        { status: 201 },
      ),
      Response.json(
        {
          ...wireEnvelope,
          status: "pending",
          expires_at: expires(),
          poll_interval_seconds: 2,
        },
        { status: 202 },
      ),
      Response.json({
        ...wireEnvelope,
        status: "authorized",
        authorization_token: opaque,
        expires_at: expires(),
      }),
      new Response(null, { status: 204 }),
    ];
    const fetcher = vi.fn<typeof fetch>(async () => replies.shift()!);
    const client = new MarketplaceApiClient(
      "https://host/eigen",
      "0.5.4",
      fetcher,
      10000,
      opaque,
    );
    await client.startAuthorization("bearer", "c".repeat(43));
    await client.exchangeAuthorization("bearer", id, "v".repeat(43));
    await client.exchangeAuthorization("bearer", id, "v".repeat(43));
    await client.revokeAuthorization("bearer");
    expect(fetcher.mock.calls.map(([url]) => requestUrl(url))).toEqual([
      `https://host/eigen/api/v1/marketplace/authorizations`,
      ...Array<string>(2).fill(
        `https://host/eigen/api/v1/marketplace/authorizations/${id}/exchange`,
      ),
      `https://host/eigen/api/v1/marketplace/authorization`,
    ]);
    for (const [url, options] of fetcher.mock.calls) {
      expect(requestUrl(url)).not.toContain(opaque);
      expect(options?.headers).toMatchObject({
        authorization: "Bearer bearer",
        "x-hivemnd-marketplace-authorization": opaque,
      });
    }
  });
  it("rejects credential-shaped links and preserves only allowlisted authorization error messages", async () => {
    const client = (body: unknown, status = 200) =>
      new MarketplaceApiClient("https://host/eigen", "0.5.4", async () =>
        Response.json(body, { status }),
      );
    const start = {
      ...wireEnvelope,
      authorization_id: id,
      verification_uri: `https://host/eigen/marketplace/authorizations/${id}`,
      expires_at: expires(),
      poll_interval_seconds: 2,
    };
    for (const uri of [
      "https://host/other/private",
      `https://evil/eigen/marketplace/authorizations/${id}`,
      `${start.verification_uri}?token=secret`,
    ])
      await expect(
        client({ ...start, verification_uri: uri }).startAuthorization(
          "bearer",
          "c".repeat(43),
        ),
      ).rejects.toThrow();
    for (const code of [
      "invalid_request",
      "forbidden",
      "authorization_invalid",
      "authorization_expired",
      "authorization_denied",
      "authorization_unavailable",
    ])
      await expect(
        client({ ...wireEnvelope, error: code }, 403).exchangeAuthorization(
          "bearer",
          id,
          "v".repeat(43),
        ),
      ).rejects.toThrow(code);
    await expect(
      client({ error: "PRIVATE raw secret" }, 503).exchangeAuthorization(
        "bearer",
        id,
        "v".repeat(43),
      ),
    ).rejects.toThrow("Marketplace API request failed");
    const fetcher = vi.fn<typeof fetch>();
    const invalid = new MarketplaceApiClient(
      "https://host/eigen",
      "0.5.4",
      fetcher,
    );
    await expect(
      invalid.startAuthorization("token", "invalid"),
    ).rejects.toThrow();
    await expect(
      invalid.exchangeAuthorization("token", "../escape", "v".repeat(43)),
    ).rejects.toThrow();
    await expect(
      invalid.exchangeAuthorization("token", id, "short"),
    ).rejects.toThrow();
    expect(
      () =>
        new MarketplaceApiClient(
          "https://host/eigen",
          "0.5.4",
          fetcher,
          1000,
          "bad",
        ),
    ).toThrow();
    expect(fetcher).not.toHaveBeenCalled();
    await expect(
      client({ ...wireEnvelope }, 200).revokeAuthorization("bearer"),
    ).rejects.toThrow();
  });
});
