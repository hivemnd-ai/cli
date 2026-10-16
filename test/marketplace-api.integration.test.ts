import { describe, expect, it, vi } from "vitest";
import { requestUrl } from "./marketplace-fixtures.js";
import { MarketplaceApiClient } from "../src/api/marketplace-api-client.js";

const id = "00000000-0000-4000-8000-000000000001";
const envelope = { schema_version: 1, minimum_client_version: "0.5.4" };
const indexMetadata = {
  unavailable: [],
  private_access_error: "github_authorization_required",
};
const registration = {
  id,
  name: "Engineering",
  provider_repository_id: 42,
  repository_owner: "fixture",
  repository_name: "plugins",
  format: "claude_marketplace",
  manifest_path: ".claude-plugin/marketplace.json",
  configured_ref: "main",
  sync_with_hivemnd: true,
  status: "active",
  source_visibility: "public",
  lock_version: 0,
  current_catalog_snapshot: null,
  head_observed_at: null,
  last_checked_at: null,
  last_error_code: null,
};
const target = {
  id,
  harness_kind: "claude",
  install_scope: "user",
  workspace_binding_id: null,
  status: "active",
  lock_version: 0,
};
const selection = {
  id,
  registration_id: id,
  plugin_key: "team",
  audience: "installation",
  harness_kind: "claude",
  install_scope: "user",
  target_id: id,
  enabled: true,
  lock_version: 0,
};

describe("marketplace authenticated wire adapter", () => {
  it("keeps tenant paths and bearer auth for registry, catalog, declarations and selection mutations", async () => {
    const replies = [
      { ...indexMetadata, registrations: [registration] },
      { registration },
      { registration },
      { registration },
      { registration, entries: [] },
      { targets: [target] },
      { target },
      { target },
      { selections: [selection] },
      { selection },
      { selection },
      { target, items: [], refresh_requested: false },
    ];
    const fetcher = vi.fn<typeof fetch>(async () =>
      Response.json({ ...envelope, ...replies.shift() }),
    );
    const client = new MarketplaceApiClient(
      "https://shared.hivemnd.cloud/eigen",
      "0.5.4",
      fetcher,
    );
    expect(await client.registrations("private-token")).toEqual([registration]);
    expect(
      await client.saveRegistration("private-token", undefined, {
        sync_with_hivemnd: true,
      }),
    ).toEqual(registration);
    await client.saveRegistration("private-token", id, {
      expected_lock_version: 0,
    });
    await client.refresh("private-token", id, { expected_lock_version: 0 });
    expect((await client.catalog("private-token", id)).entries).toEqual([]);
    expect(await client.targets("private-token")).toEqual([target]);
    await client.saveTarget("private-token", undefined, {
      harness_kind: "claude",
    });
    await client.saveTarget("private-token", id, {
      status: "inactive",
      expected_lock_version: 0,
    });
    expect(await client.selections("private-token")).toEqual([selection]);
    await client.saveSelection("private-token", undefined, { enabled: true });
    await client.saveSelection("private-token", id, {
      enabled: false,
      expected_lock_version: 0,
    });
    expect((await client.reconciliation("private-token", id)).items).toEqual(
      [],
    );
    expect(fetcher.mock.calls.map(([url]) => requestUrl(url))).toEqual(
      [
        "/registrations",
        "/registrations",
        `/registrations/${id}`,
        `/registrations/${id}/refresh`,
        `/registrations/${id}/catalog`,
        "/targets",
        "/targets",
        `/targets/${id}`,
        "/selections",
        "/selections",
        `/selections/${id}`,
        `/reconciliation?target_id=${id}`,
      ].map(
        (path) =>
          `https://shared.hivemnd.cloud/eigen/api/v1/marketplace${path}`,
      ),
    );
    expect(fetcher.mock.calls.map(([, options]) => options?.method)).toEqual([
      "GET",
      "POST",
      "PATCH",
      "POST",
      "GET",
      "GET",
      "POST",
      "PATCH",
      "GET",
      "POST",
      "PATCH",
      "GET",
    ]);
    for (const [, options] of fetcher.mock.calls) {
      expect(options).toMatchObject({
        redirect: "error",
        headers: { authorization: "Bearer private-token" },
      });
    }
  });

  it("fails closed with bounded public messages for incompatible, invalid, failed and redirected responses", async () => {
    for (const response of [
      Response.json({
        ...envelope,
        minimum_client_version: "99.0.0",
        ...indexMetadata,
        registrations: [],
      }),
      Response.json({
        ...envelope,
        schema_version: 2,
        ...indexMetadata,
        registrations: [],
      }),
      Response.json({
        ...envelope,
        ...indexMetadata,
        registrations: [{ ...registration, sync_with_hivemnd: "true" }],
      }),
      new Response("PRIVATE BODY", { status: 401 }),
      Response.json(
        { ...envelope, error: "github_authorization_required" },
        { status: 403 },
      ),
      new Response("PRIVATE BODY", { status: 409 }),
      new Response("PRIVATE BODY", { status: 500 }),
      new Response("not-json"),
    ]) {
      const client = new MarketplaceApiClient(
        "https://hivemnd.cloud",
        "0.5.4",
        async () => response,
      );
      await expect(
        client.registrations("private-token"),
      ).rejects.toBeInstanceOf(Error);
      await client
        .registrations("private-token")
        .catch((error: unknown) =>
          expect(String(error)).not.toMatch(/PRIVATE BODY|private-token/),
        );
    }
    const fetcher = vi.fn<typeof fetch>(async () => {
      throw new Error("private-token PRIVATE BODY");
    });
    const client = new MarketplaceApiClient(
      "https://shared.hivemnd.cloud/eigen",
      "0.5.4",
      fetcher,
    );
    await expect(client.registrations("private-token")).rejects.toThrow(
      "Marketplace API request unavailable",
    );
    await expect(
      client.catalog("private-token", "../escape"),
    ).rejects.toThrow();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("accepts actual Rails access metadata but rejects arbitrary private details or error text", async () => {
    const response = {
      ...envelope,
      registrations: [registration],
      unavailable: [{ id, error: "provider_unavailable" }],
      private_access_error: "github_authorization_required",
    };
    const client = (body: unknown) =>
      new MarketplaceApiClient("https://host/eigen", "0.5.4", async () =>
        Response.json(body),
      );
    expect(await client(response).registrations("token")).toEqual([
      registration,
    ]);
    for (const body of [
      { ...response, private_access_error: null },
      { ...response, unavailable: [] },
    ])
      expect(await client(body).registrations("token")).toEqual([registration]);
    for (const body of [
      { ...response, private_access_error: "PRIVATE DETAILS" },
      { ...response, unavailable: [{ id, error: "PRIVATE DETAILS" }] },
      {
        ...response,
        unavailable: [{ id, error: "forbidden", repository: "private" }],
      },
      { ...response, private_repository: "secret" },
    ])
      await expect(client(body).registrations("token")).rejects.toThrow(
        "response contract",
      );
  });
  it("bounds response bytes, validates tenant redirects and rejects missing or invalid wire bodies", async () => {
    for (const capacity of [0, Number.NaN])
      expect(
        () =>
          new MarketplaceApiClient(
            "https://host/eigen",
            "0.5.4",
            fetch,
            capacity,
          ),
      ).toThrow("capacity");
    const escaped = Response.json({
      ...envelope,
      ...indexMetadata,
      registrations: [],
    });
    Object.defineProperty(escaped, "url", {
      value: "https://host/other/api/v1/marketplace/registrations",
    });
    const bodylessFailure = new Response(null, { status: 401 });
    for (const response of [
      escaped,
      bodylessFailure,
      new Response(null),
      new Response("{}", { headers: { "content-length": "invalid" } }),
      new Response("{}", { headers: { "content-length": "9999" } }),
      new Response("x".repeat(101)),
      new Response(Uint8Array.from([255])),
    ]) {
      const client = new MarketplaceApiClient(
        "https://host/eigen",
        "0.5.4",
        async () => response,
        100,
      );
      await expect(client.registrations("private-token")).rejects.toThrow();
    }
    const valid = Response.json(
      { ...envelope, ...indexMetadata, registrations: [] },
      { headers: { "content-length": "90" } },
    );
    Object.defineProperty(valid, "url", {
      value: "https://host/eigen/api/v1/marketplace/registrations",
    });
    expect(
      await new MarketplaceApiClient(
        "https://host/eigen",
        "0.5.4",
        async () => valid,
      ).registrations("token"),
    ).toEqual([]);
    await expect(
      new MarketplaceApiClient("https://host/eigen", "invalid", async () =>
        Response.json({ ...envelope, ...indexMetadata, registrations: [] }),
      ).registrations("token"),
    ).rejects.toThrow("bounded strict SemVer");
  });
});
