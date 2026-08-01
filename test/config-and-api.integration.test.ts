import { createServer, type RequestListener, type Server } from "node:http";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpApiClient } from "../src/api/http-api-client.js";
import {
  MacOsKeychain,
  SecureTokenStore,
  keychainAccount,
  runCommand,
} from "../src/auth/token-store.js";
import { parseActivationUrl } from "../src/auth/activation-url.js";
import { ConfigRepository, loadConfig } from "../src/config.js";
import { HivemndError, asHivemndError, assertDefined } from "../src/errors.js";
import {
  bytes,
  config,
  manifest,
  temporaryDirectory,
  wireManifest,
  writeJson,
} from "./helpers.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("configuration repository", () => {
  it("creates private config, loads relative and absolute paths, and supports explicit replacement", async () => {
    const temp = await temporaryDirectory();
    cleanups.push(temp.cleanup);
    const repository = new ConfigRepository(temp.path);
    const value = config(temp.path);

    await repository.create("nested/hivemnd.json", value);
    await expect(repository.load("nested/hivemnd.json")).resolves.toEqual(
      value,
    );
    await expect(
      loadConfig(join(temp.path, "nested/hivemnd.json"), "/elsewhere"),
    ).resolves.toEqual(value);
    await expect(
      repository.create("nested/hivemnd.json", value),
    ).rejects.toMatchObject({
      code: "CONFIG_EXISTS",
    });
    await expect(
      repository.create("nested/hivemnd.json", value, true),
    ).resolves.toBeUndefined();
    await expect(repository.create(temp.path, value, true)).rejects.toThrow();
  });

  it("wraps malformed, missing, and unsafe config values", async () => {
    const temp = await temporaryDirectory();
    cleanups.push(temp.cleanup);
    const path = join(temp.path, "bad.json");
    await writeJson(path, { apiUrl: "file:///private", destinations: [] });
    await expect(loadConfig(path, temp.path)).rejects.toMatchObject({
      code: "CONFIG_INVALID",
    });
    await expect(loadConfig("missing.json", temp.path)).rejects.toMatchObject({
      code: "CONFIG_INVALID",
    });
    await expect(
      new ConfigRepository(temp.path).create("bad\0path", config(temp.path)),
    ).rejects.toThrow();
    await expect(
      new ConfigRepository(temp.path).create("duplicate.json", {
        apiUrl: "https://hivemnd.test",
        destinations: [
          { name: "same", agent: "codex", scope: "directory", path: "/one" },
          { name: "same", agent: "codex", scope: "directory", path: "/two" },
        ],
      }),
    ).rejects.toThrow("Destination names must be unique");
    await expect(
      new ConfigRepository(temp.path).create("root-path.json", {
        apiUrl: "https://hivemnd.test",
        destinations: [
          {
            name: "root",
            agent: "codex",
            scope: "root",
            path: "/unexpected",
          },
        ],
      }),
    ).rejects.toThrow("root destinations must not define path");
    await expect(
      new ConfigRepository(temp.path).create("missing-path.json", {
        apiUrl: "https://hivemnd.test",
        destinations: [
          { name: "workspace", agent: "codex", scope: "workspace" },
        ],
      }),
    ).rejects.toThrow("workspace destinations require path");
    await expect(
      new ConfigRepository(temp.path).create("relative.json", {
        apiUrl: "https://hivemnd.test",
        destinations: [
          {
            name: "relative",
            agent: "claude",
            scope: "directory",
            path: "relative/path",
          },
        ],
      }),
    ).rejects.toThrow("destination path must be absolute");
  });
});

describe("secure credential storage", () => {
  it("isolates keychain accounts by full deployment base path", () => {
    expect(keychainAccount("https://shared.hivemnd.cloud/eigen")).toBe(
      "https://shared.hivemnd.cloud/eigen/",
    );
    expect(keychainAccount("https://shared.hivemnd.cloud/other")).not.toBe(
      keychainAccount("https://shared.hivemnd.cloud/eigen"),
    );
  });
  it("prefers the environment, falls back to keychain, and validates saves", async () => {
    const keychain = {
      get: vi.fn<() => Promise<string | undefined>>(async () => "keychain"),
      save: vi.fn(async () => undefined),
    };
    await expect(
      new SecureTokenStore({ HIVEMND_TOKEN: " env " }, keychain).get(),
    ).resolves.toEqual({
      value: "env",
      source: "environment",
    });
    await expect(new SecureTokenStore({}, keychain).get()).resolves.toEqual({
      value: "keychain",
      source: "keychain",
    });
    keychain.get.mockResolvedValueOnce(undefined);
    await expect(
      new SecureTokenStore({}, keychain).get(),
    ).resolves.toBeUndefined();
    await expect(
      new SecureTokenStore({}, keychain).save("token"),
    ).resolves.toBeUndefined();
    expect(() => new SecureTokenStore({}, keychain).save("  ")).toThrow(
      "cannot be empty",
    );
  });

  it("uses macOS security and rejects unsupported platforms", async () => {
    const execute = vi.fn(async () => ({ stdout: " stored-token\n" }));
    const keychain = new MacOsKeychain("tenant", "darwin", execute);
    await expect(keychain.get()).resolves.toBe("stored-token");
    await expect(keychain.save("new-token")).resolves.toBeUndefined();
    expect(execute).toHaveBeenLastCalledWith("security", [
      "add-generic-password",
      "-U",
      "-a",
      "tenant",
      "-s",
      "hivemnd-cli",
      "-w",
      "new-token",
    ]);
    execute.mockRejectedValueOnce(new Error("not found"));
    await expect(keychain.get()).resolves.toBeUndefined();
    execute.mockResolvedValueOnce({ stdout: "" });
    await expect(keychain.get()).resolves.toBeUndefined();
    await expect(
      new MacOsKeychain("tenant", "linux", execute).get(),
    ).rejects.toMatchObject({
      code: "KEYCHAIN_UNAVAILABLE",
    });
    await expect(
      new MacOsKeychain("tenant", "linux", execute).save("x"),
    ).rejects.toMatchObject({
      code: "KEYCHAIN_UNAVAILABLE",
    });
    await expect(
      new MacOsKeychain("hivemnd-test-nonexistent", "darwin").get(),
    ).resolves.toBeUndefined();
    await expect(
      runCommand(
        process.execPath,
        ["-e", "process.stdin.pipe(process.stdout)"],
        "private-input",
      ),
    ).resolves.toEqual({ stdout: "private-input" });
    await expect(
      runCommand(process.execPath, [
        "-e",
        "process.stderr.write('failed'); process.exit(2)",
      ]),
    ).rejects.toThrow("failed");
    await expect(
      runCommand("/definitely/missing/hivemnd-command", []),
    ).rejects.toThrow();
    expect(new MacOsKeychain("tenant", "darwin", execute).available()).toBe(
      true,
    );
    expect(new MacOsKeychain("tenant", "linux", execute).available()).toBe(
      false,
    );
    expect(
      new SecureTokenStore(
        {},
        new MacOsKeychain("tenant", "darwin", execute),
      ).supportsPersistentStorage(),
    ).toBe(true);
    expect(
      new SecureTokenStore(
        {},
        { get: async () => undefined, save: async () => undefined },
      ).supportsPersistentStorage(),
    ).toBe(false);
  });
});

describe("activation URL", () => {
  it("preserves tenant bases and supports root dedicated deployments", () => {
    expect(
      parseActivationUrl(
        "https://shared.hivemnd.cloud/eigen/enroll?token=x#ignored",
      ),
    ).toEqual({ apiUrl: "https://shared.hivemnd.cloud/eigen", token: "x" });
    expect(
      parseActivationUrl("https://eigen.hivemnd.cloud/enroll?token=root"),
    ).toEqual({ apiUrl: "https://eigen.hivemnd.cloud", token: "root" });
  });

  it.each([
    "not a url",
    "file:///enroll?token=x",
    "https://hivemnd.test/enroll",
    "https://hivemnd.test/login?token=x",
  ])("rejects unsafe or incomplete activation URL %s", (value) => {
    expect(() => parseActivationUrl(value)).toThrow();
  });
});

describe("HTTP API adapter", () => {
  async function serve(
    handler: RequestListener,
  ): Promise<{ server: Server; url: string }> {
    const server = createServer(handler);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    cleanups.push(
      () => new Promise<void>((resolve) => server.close(() => resolve())),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Expected TCP server address");
    return { server, url: `http://127.0.0.1:${address.port}` };
  }

  it("implements manifest, content, enrollment, and receipt contracts with Rails wire casing", async () => {
    const requests: Array<{
      path: string | undefined;
      method: string | undefined;
      body: string;
    }> = [];
    const content = "# Team skill\n";
    const { url } = await serve((request, response) => {
      let body = "";
      request.on("data", (chunk) => (body += String(chunk)));
      request.on("end", () => {
        requests.push({ path: request.url, method: request.method, body });
        response.statusCode = 200;
        if (
          request.url === "/api/v1/enrollments/preview" ||
          request.url === "/api/v1/client-configuration"
        ) {
          response.end(
            JSON.stringify({
              organization: { name: "Eigen", slug: "eigen" },
              enabled_clients: ["codex", "claude"],
            }),
          );
        } else if (request.url === "/api/v1/enrollments/exchange") {
          response.end(
            JSON.stringify({
              access_token: "access",
              installation_id: "install",
            }),
          );
        } else if (request.url?.includes("receipts")) {
          response.end("{}");
        } else if (request.url?.includes("artifact-versions")) {
          response.end(content);
        } else {
          response.end(JSON.stringify(wireManifest(content)));
        }
      });
    });
    const client = new HttpApiClient(
      url,
      fetch,
      () => new Date("2026-07-25T11:00:00.000Z"),
    );

    await expect(client.manifest("bearer")).resolves.toEqual(manifest(content));
    await expect(client.previewEnrollment("one-time")).resolves.toEqual({
      organization: { name: "Eigen", slug: "eigen" },
      enabledClients: ["codex", "claude"],
    });
    await expect(client.clientConfiguration("bearer")).resolves.toEqual({
      organization: { name: "Eigen", slug: "eigen" },
      enabledClients: ["codex", "claude"],
    });
    await expect(
      client
        .download("bearer", manifest(content).artifacts[0]!)
        .then((value) => [...value]),
    ).resolves.toEqual([...bytes(content)]);
    await expect(
      client.exchangeEnrollment("one-time", {
        clientKind: "hivemnd_cli",
        platform: "darwin-arm64",
        clientVersion: "0.1.0",
      }),
    ).resolves.toEqual({
      accessToken: "access",
      installationId: "install",
    });
    await expect(
      client.receipt("bearer", {
        idempotencyKey: "receipt-1",
        releaseId: "release-1",
        status: "applied",
        operations: [
          {
            artifactVersionId: "version-1",
            target: "codex",
            action: "create",
            result: "applied",
          },
        ],
      }),
    ).resolves.toBeUndefined();
    expect(requests.map(({ path, method }) => ({ path, method }))).toEqual([
      { path: "/api/v1/sync/manifest", method: "GET" },
      { path: "/api/v1/enrollments/preview", method: "POST" },
      { path: "/api/v1/client-configuration", method: "GET" },
      { path: "/api/v1/artifact-versions/version-1/content", method: "GET" },
      { path: "/api/v1/enrollments/exchange", method: "POST" },
      { path: "/api/v1/sync/receipts", method: "POST" },
    ]);
    expect(JSON.parse(requests[1]!.body)).toEqual({
      enrollment_token: "one-time",
    });
    expect(JSON.parse(requests[4]!.body)).toEqual({
      enrollment_token: "one-time",
      client_kind: "hivemnd_cli",
      platform: "darwin-arm64",
      client_version: "0.1.0",
    });
    expect(requests[5]!.body).toContain('"idempotency_key":"receipt-1"');

    const currentManifest = wireManifest(content);
    currentManifest.expires_at = "2099-01-01T00:00:00.000Z";
    const defaultClock = await serve((_request, response) =>
      response.end(JSON.stringify(currentManifest)),
    );
    await expect(
      new HttpApiClient(defaultClock.url).manifest("token"),
    ).resolves.toMatchObject({
      release: { id: "release-1" },
    });
  });

  it("parses exact delivery targets and the effective always-context limit while retaining legacy compatibility", async () => {
    const exact = wireManifest();
    Object.assign(exact, { always_context_byte_limit: 8_000 });
    Object.assign(exact.artifacts[0]!, {
      delivery_targets: [
        {
          client_kind: "claude",
          install_scope: "workspace",
          minimum_client_version: "1.2.3-beta.1+build.7",
        },
        {
          client_kind: "codex",
          install_scope: "user",
          minimum_client_version: null,
        },
      ],
    });
    const exactServer = await serve((_request, response) =>
      response.end(JSON.stringify(exact)),
    );

    await expect(
      new HttpApiClient(
        exactServer.url,
        fetch,
        () => new Date("2026-07-25T11:00:00.000Z"),
      ).manifest("token"),
    ).resolves.toMatchObject({
      alwaysContextByteLimit: 8_000,
      artifacts: [
        {
          deliveryTargets: [
            {
              clientKind: "claude",
              installScope: "workspace",
              minimumClientVersion: "1.2.3-beta.1+build.7",
            },
            { clientKind: "codex", installScope: "user" },
          ],
        },
      ],
    });

    const legacyServer = await serve((_request, response) =>
      response.end(JSON.stringify(wireManifest())),
    );
    await expect(
      new HttpApiClient(
        legacyServer.url,
        fetch,
        () => new Date("2026-07-25T11:00:00.000Z"),
      ).manifest("token"),
    ).resolves.toMatchObject({
      alwaysContextByteLimit: 10_000,
      artifacts: [
        {
          deliveryTargets: [
            { clientKind: "claude", installScope: "any" },
            { clientKind: "codex", installScope: "any" },
          ],
        },
      ],
    });
  });

  it.each([
    [
      "legacy and exact target disagreement",
      [
        {
          client_kind: "codex",
          install_scope: "user",
          minimum_client_version: null,
        },
      ],
    ],
    [
      "unknown exact scope",
      [
        {
          client_kind: "codex",
          install_scope: "computer",
          minimum_client_version: null,
        },
        {
          client_kind: "claude",
          install_scope: "workspace",
          minimum_client_version: null,
        },
      ],
    ],
    [
      "invalid target minimum",
      [
        {
          client_kind: "codex",
          install_scope: "user",
          minimum_client_version: "next",
        },
        {
          client_kind: "claude",
          install_scope: "workspace",
          minimum_client_version: null,
        },
      ],
    ],
    [
      "oversized target minimum",
      [
        {
          client_kind: "claude",
          install_scope: "workspace",
          minimum_client_version: `1.2.3+${"a".repeat(128)}`,
        },
        {
          client_kind: "codex",
          install_scope: "user",
          minimum_client_version: null,
        },
      ],
    ],
  ])("rejects %s", async (_label, deliveryTargets) => {
    const wire = wireManifest();
    Object.assign(wire.artifacts[0]!, {
      delivery_targets: deliveryTargets,
    });
    const server = await serve((_request, response) =>
      response.end(JSON.stringify(wire)),
    );

    await expect(
      new HttpApiClient(
        server.url,
        fetch,
        () => new Date("2026-07-25T11:00:00.000Z"),
      ).manifest("token"),
    ).rejects.toMatchObject({ code: "MANIFEST_INVALID" });
  });

  it("rejects a legacy client-kind list that is not deterministic", async () => {
    const wire = wireManifest();
    Object.assign(wire.artifacts[0]!, { targets: ["codex", "claude"] });
    const server = await serve((_request, response) =>
      response.end(JSON.stringify(wire)),
    );

    await expect(
      new HttpApiClient(
        server.url,
        fetch,
        () => new Date("2026-07-25T11:00:00.000Z"),
      ).manifest("token"),
    ).rejects.toMatchObject({ code: "MANIFEST_INVALID" });
  });

  it("sends only bounded runtime compatibility metadata on authenticated API traffic", async () => {
    const seen: Array<{
      path: string;
      version: string | undefined;
      features: string | undefined;
    }> = [];
    const server = await serve((request, response) => {
      seen.push({
        path: request.url ?? "",
        version: request.headers["hivemnd-client-version"] as
          string | undefined,
        features: request.headers["hivemnd-client-features"] as
          string | undefined,
      });
      if (request.url?.includes("client-configuration")) {
        const configuration = {
          organization: { name: "Eigen", slug: "eigen" },
          enabled_clients: ["codex"],
        };
        response.end(
          JSON.stringify(
            request.headers["hivemnd-client-features"]
              ? {
                  ...configuration,
                  installation: {
                    client_version: "0.4.0",
                    capability_keys: ["read_artifacts"],
                  },
                }
              : configuration,
          ),
        );
        return;
      }
      response.end(JSON.stringify(wireManifest()));
    });
    const client = new HttpApiClient(
      server.url,
      fetch,
      () => new Date("2026-07-25T11:00:00.000Z"),
      {
        clientVersion: "0.4.0",
        clientFeatures: ["exact-delivery-targets-v1"],
      },
    );

    await client.manifest("token");
    await expect(client.clientConfiguration("token")).resolves.toMatchObject({
      installation: {
        clientVersion: "0.4.0",
        capabilityKeys: ["read_artifacts"],
      },
    });
    await expect(
      new HttpApiClient(
        server.url,
        fetch,
        () => new Date("2026-07-25T11:00:00.000Z"),
        { clientVersion: "0.4.0", clientFeatures: [] },
      ).clientConfiguration("token"),
    ).resolves.not.toHaveProperty("installation");

    expect(seen).toEqual([
      {
        path: "/api/v1/sync/manifest",
        version: "0.4.0",
        features: "exact-delivery-targets-v1",
      },
      {
        path: "/api/v1/client-configuration",
        version: "0.4.0",
        features: "exact-delivery-targets-v1",
      },
      {
        path: "/api/v1/client-configuration",
        version: "0.4.0",
        features: undefined,
      },
    ]);
    expect(JSON.stringify(seen)).not.toMatch(
      /workspace|artifact content|prompt|authority/i,
    );
  });

  it.each([
    ["invalid version", { clientVersion: "next", clientFeatures: [] }],
    [
      "oversized version",
      {
        clientVersion: `1.2.3+${"a".repeat(128)}`,
        clientFeatures: [],
      },
    ],
    [
      "unknown feature",
      { clientVersion: "1.2.3", clientFeatures: ["authority-v1"] },
    ],
    [
      "oversized features",
      { clientVersion: "1.2.3", clientFeatures: ["a".repeat(129)] },
    ],
  ])("rejects %s metadata before network access", async (_label, metadata) => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(
      new HttpApiClient(
        "https://shared.hivemnd.cloud/eigen",
        fetcher,
        () => new Date("2026-07-25T11:00:00.000Z"),
        metadata,
      ).clientConfiguration("token"),
    ).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("returns stable typed failures for HTTP, schema, expiry, enrollment, and cross-origin paths", async () => {
    const failure = await serve((_request, response) => {
      response.statusCode = 500;
      response.end();
    });
    await expect(
      new HttpApiClient(failure.url).manifest("secret"),
    ).rejects.toMatchObject({ code: "HTTP_FAILED" });

    const unauthorized = await serve((_request, response) => {
      response.statusCode = 401;
      response.end();
    });
    await expect(
      new HttpApiClient(unauthorized.url).clientConfiguration("expired"),
    ).rejects.toMatchObject({ code: "AUTH_MISSING" });

    const malformed = await serve((_request, response) =>
      response.end(JSON.stringify({ schema_version: 9 })),
    );
    await expect(
      new HttpApiClient(malformed.url).manifest("token"),
    ).rejects.toMatchObject({ code: "MANIFEST_INVALID" });

    const invalidMinimum = await serve((_request, response) => {
      const wire = wireManifest();
      wire.minimum_client_version = "next";
      response.end(JSON.stringify(wire));
    });
    await expect(
      new HttpApiClient(invalidMinimum.url).manifest("token"),
    ).rejects.toMatchObject({ code: "MANIFEST_INVALID" });

    const expired = await serve((_request, response) =>
      response.end(JSON.stringify(wireManifest())),
    );
    await expect(
      new HttpApiClient(
        expired.url,
        fetch,
        () => new Date("2026-07-27T00:00:00.000Z"),
      ).manifest("token"),
    ).rejects.toMatchObject({ code: "MANIFEST_EXPIRED" });

    const badEnrollment = await serve((_request, response) =>
      response.end("{}"),
    );
    await expect(
      new HttpApiClient(badEnrollment.url).exchangeEnrollment("x", {
        clientKind: "hivemnd_cli",
        platform: "test",
        clientVersion: "0.1.0",
      }),
    ).rejects.toMatchObject({
      code: "ENROLLMENT_INVALID",
    });

    await expect(
      new HttpApiClient(badEnrollment.url).previewEnrollment("x"),
    ).rejects.toMatchObject({ code: "CLIENT_CONFIGURATION_INVALID" });
    await expect(
      new HttpApiClient(badEnrollment.url).clientConfiguration("x"),
    ).rejects.toMatchObject({ code: "CLIENT_CONFIGURATION_INVALID" });

    const client = new HttpApiClient("https://hivemnd.test");
    await expect(
      client.download("do-not-leak", {
        ...manifest().artifacts[0]!,
        contentPath: "//evil.test/file",
      }),
    ).rejects.toMatchObject({ code: "PATH_UNSAFE" });
  });

  it("preserves a tenant base path and rejects same-origin cross-tenant content", async () => {
    const requests: string[] = [];
    const content = "# Tenant skill\n";
    const { url } = await serve((request, response) => {
      requests.push(request.url ?? "");
      if (request.url === "/eigen/api/v1/sync/manifest") {
        const wire = wireManifest(content);
        wire.artifacts[0]!.content_path =
          "/eigen/api/v1/artifact-versions/version-1/content";
        response.end(JSON.stringify(wire));
        return;
      }
      response.end(content);
    });
    const client = new HttpApiClient(
      `${url}/eigen`,
      fetch,
      () => new Date("2026-07-25T11:00:00.000Z"),
    );
    const tenantManifest = await client.manifest("tenant-token");

    await expect(
      client
        .download("tenant-token", tenantManifest.artifacts[0]!)
        .then((value) => [...value]),
    ).resolves.toEqual([...bytes(content)]);
    expect(requests).toEqual([
      "/eigen/api/v1/sync/manifest",
      "/eigen/api/v1/artifact-versions/version-1/content",
    ]);
    await expect(
      client.download("tenant-token", {
        ...tenantManifest.artifacts[0]!,
        contentPath: "/other/api/v1/artifact-versions/version-1/content",
      }),
    ).rejects.toMatchObject({ code: "PATH_UNSAFE" });
  });
});

describe("typed errors", () => {
  it("enforces internal defined-value invariants", () => {
    const value: string | undefined = "present";
    assertDefined(value, "missing");
    expect(value).toBe("present");
    expect(() => assertDefined(undefined, "missing")).toThrow(
      expect.objectContaining({ code: "CONFIG_INVALID", message: "missing" }),
    );
  });

  it("preserves domain failures and normalizes Error and unknown values", () => {
    const typed = new HivemndError("AUTH_MISSING", "missing");
    expect(asHivemndError(typed)).toBe(typed);
    expect(asHivemndError(new Error("broken"))).toMatchObject({
      code: "SYNC_FAILED",
      message: "broken",
    });
    expect(asHivemndError("broken")).toMatchObject({
      code: "SYNC_FAILED",
      message: "Unknown error",
    });
  });
});
