import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, realpath, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultDependencies, runCli } from "../src/cli.js";
import {
  api,
  captureOutput,
  temporaryDirectory,
  writeJson,
} from "./helpers.js";
import { MarketplaceTargets } from "../src/workflows/marketplace-targets.js";
import {
  marketplaceLimits,
  runMarketplaceCommand,
} from "../src/workflows/marketplace-commands.js";
import { defaultMarketplaceLimits } from "../src/api/marketplace-api-client.js";
import { createCliContext } from "../src/cli/context.js";
import { probeDeclaredHarness } from "../src/marketplace/harness-adapters.js";
import { canonicalBundleDigest } from "../src/marketplace/reconcile.js";
import { synchronizeMarketplaces } from "../src/workflows/marketplace-reconcile.js";
import {
  requestUrl,
  registrationId,
  targetId,
  selectionId,
  wireEnvelope,
  wireRegistration,
  wireTarget,
  wireSelection,
  wireBundle,
  wireReady,
} from "./marketplace-fixtures.js";

const cleanups: Array<() => Promise<void>> = [];
vi.mock("../src/marketplace/harness-adapters.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../src/marketplace/harness-adapters.js")
  >()),
  probeDeclaredHarness: vi.fn(async () => undefined),
}));
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function setup() {
  const temp = await temporaryDirectory();
  cleanups.push(temp.cleanup);
  const root = await realpath(temp.path);
  const home = join(root, "home");
  const state = join(home, ".hivemnd");
  await mkdir(state, { recursive: true, mode: 0o700 });
  const configPath = join(state, "config.json");
  const config = {
    apiUrl: "https://shared.hivemnd.cloud/eigen",
    installationId: "installation-1",
    destinations: [],
  };
  await writeJson(configPath, config);
  const output = captureOutput();
  const tokenStore = {
    get: vi.fn(async () => ({
      value: "private-token",
      source: "environment" as const,
    })),
    save: vi.fn(),
  };
  const dependencies = {
    ...defaultDependencies,
    cwd: root,
    homeDirectory: home,
    environment: { HIVEMND_HOME: state },
    output,
    tokenStoreFactory: () => tokenStore,
    apiClientFactory: () => api(),
  };
  const context = createCliContext(dependencies, () => ({
    configPath,
    explicitConfig: true,
  }));
  const invoke = (args: string[]) =>
    runCli(["--config", configPath, "marketplace", ...args], dependencies);
  const store = new MarketplaceTargets(state, configPath, config);
  return {
    root,
    home,
    state,
    configPath,
    config,
    output,
    tokenStore,
    dependencies,
    context,
    invoke,
    store,
  };
}

function respond(body: unknown) {
  return Response.json({
    ...wireEnvelope,
    ...(typeof body === "object" && body !== null && "registrations" in body
      ? {
          unavailable: [],
          private_access_error: "github_authorization_required",
        }
      : {}),
    ...(typeof body === "object" && body !== null && "items" in body
      ? { refresh_requested: false }
      : {}),
    ...(body as object),
  });
}

describe("marketplace CLI authorized operations", () => {
  it("plans every mutation by default without credentials, network or files and requires an explicit lifecycle mode", async () => {
    const test = await setup();
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetcher);
    for (const args of [
      [
        "register",
        "--repository-id",
        "42",
        "--name",
        "Engineering",
        "--format",
        "claude-marketplace",
        "--manifest-path",
        ".claude-plugin/marketplace.json",
        "--ref",
        "main",
        "--managed",
      ],
      [
        "update",
        registrationId,
        "--name",
        "Updated",
        "--native",
        "--expected-lock-version",
        "0",
      ],
      ["refresh", registrationId, "--expected-lock-version", "0"],
      ["declare", "--client", "claude", "--scope", "user"],
      [
        "select",
        "--registration",
        registrationId,
        "--plugin",
        "team",
        "--target",
        targetId,
        "--client",
        "claude",
        "--scope",
        "user",
        "--enabled",
      ],
    ])
      expect(await test.invoke(args)).toBe(0);
    expect(fetcher).not.toHaveBeenCalled();
    expect(test.tokenStore.get).not.toHaveBeenCalled();
    expect(await test.store.list()).toEqual([]);
    expect(test.output.messages).toHaveLength(5);
    expect(test.output.messages.join("\n")).toContain(
      "no new per-version approval",
    );
    expect(test.output.messages.join("\n")).not.toContain("private-token");
  });

  it("applies registration, CAS update and refresh on the Hivemnd tenant API with explicit booleans", async () => {
    const test = await setup();
    const fetcher = vi.fn<typeof fetch>(async (_url, options) => {
      return respond(
        options?.method === "GET"
          ? { registrations: [wireRegistration] }
          : { registration: wireRegistration },
      );
    });
    vi.stubGlobal("fetch", fetcher);
    expect(
      await test.invoke([
        "register",
        "--repository-id",
        "42",
        "--name",
        "Engineering",
        "--format",
        "agent-plugins",
        "--manifest-path",
        "plugin.json",
        "--ref",
        "main",
        "--native",
        "--apply",
      ]),
    ).toBe(0);
    expect(
      await test.invoke([
        "update",
        registrationId,
        "--name",
        "Renamed",
        "--managed",
        "--expected-lock-version",
        "0",
        "--apply",
      ]),
    ).toBe(0);
    expect(
      await test.invoke([
        "refresh",
        registrationId,
        "--expected-lock-version",
        "0",
        "--apply",
      ]),
    ).toBe(0);
    const bodies = fetcher.mock.calls.flatMap(([, options]) =>
      options?.body
        ? [JSON.parse(options.body as string) as Record<string, unknown>]
        : [],
    );
    expect(bodies[0]).toMatchObject({
      sync_with_hivemnd: false,
      provider_repository_id: 42,
    });
    expect(bodies[1]).toMatchObject({
      sync_with_hivemnd: true,
      expected_lock_version: 0,
      name: "Renamed",
      configured_ref: "main",
    });
    expect(bodies[2]).toMatchObject({
      expected_ref: "main",
      expected_sync_with_hivemnd: true,
      limits: defaultMarketplaceLimits,
    });
  });

  it("reads lists/catalog/status and manages explicit target and selection CAS without persisting tokens", async () => {
    const test = await setup();
    const fetcher = vi.fn<typeof fetch>(async (value, options) => {
      const url = requestUrl(value);
      if (url.includes("/reconciliation?"))
        return respond({ target: wireTarget, items: [] });
      if (url.includes("/catalog"))
        return respond({ registration: wireRegistration, entries: [] });
      if (url.includes("/registrations"))
        return respond({ registrations: [wireRegistration] });
      if (url.includes("/targets"))
        return respond(
          options?.method === "GET"
            ? { targets: [wireTarget] }
            : {
                target: {
                  ...wireTarget,
                  status: (
                    JSON.parse(options?.body as string) as { status: string }
                  ).status,
                },
              },
        );
      return respond(
        options?.method === "GET"
          ? { selections: [wireSelection] }
          : { selection: wireSelection },
      );
    });
    vi.stubGlobal("fetch", fetcher);
    for (const args of [
      ["list"],
      ["catalog", registrationId],
      ["status"],
      ["status", "--target", targetId],
      ["declare", "--client", "claude", "--scope", "user", "--apply"],
      [
        "declare",
        targetId,
        "--status",
        "inactive",
        "--expected-lock-version",
        "0",
        "--apply",
      ],
      [
        "select",
        "--registration",
        registrationId,
        "--plugin",
        "team",
        "--audience",
        "workspace",
        "--client",
        "claude",
        "--scope",
        "user",
        "--disabled",
        "--apply",
      ],
      [
        "select",
        selectionId,
        "--enabled",
        "--expected-lock-version",
        "0",
        "--apply",
      ],
    ])
      expect(await test.invoke(args)).toBe(0);
    expect(await test.store.list()).toEqual([
      {
        id: targetId,
        harness_kind: "claude",
        install_scope: "user",
        workspace_binding_id: null,
      },
    ]);
    expect((await stat(test.store.directory)).mode & 0o777).toBe(0o700);
    expect(
      (await stat(join(test.store.directory, `${targetId}.json`))).mode & 0o777,
    ).toBe(0o600);
    expect(
      await readFile(join(test.store.directory, `${targetId}.json`), "utf8"),
    ).not.toContain("private-token");
    expect(test.output.messages.join("\n")).toContain(
      '"session_availability":"unknown"',
    );
  });

  it("rejects ambiguous lifecycle choices, invalid scopes/bindings, missing booleans and malformed CAS/capacity before mutations", async () => {
    const test = await setup();
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetcher);
    for (const args of [
      [
        "register",
        "--repository-id",
        "42",
        "--name",
        "Engineering",
        "--format",
        "claude-marketplace",
        "--manifest-path",
        "marketplace.json",
        "--ref",
        "main",
      ],
      [
        "update",
        registrationId,
        "--managed",
        "--native",
        "--expected-lock-version",
        "0",
      ],
      ["update", "bad-id", "--expected-lock-version", "0"],
      ["update", registrationId, "--expected-lock-version", "-1"],
      [
        "declare",
        "--client",
        "claude",
        "--scope",
        "workspace",
        "--binding",
        "/private/path",
      ],
      [
        "declare",
        "--client",
        "claude",
        "--scope",
        "user",
        "--binding",
        targetId,
      ],
      [
        "declare",
        targetId,
        "--client",
        "claude",
        "--expected-lock-version",
        "0",
      ],
      [
        "declare",
        "--client",
        "claude",
        "--scope",
        "user",
        "--status",
        "unknown",
      ],
      ["select", "--enabled", "--disabled"],
      ["select", "--enabled"],
      [
        "select",
        "--registration",
        registrationId,
        "--plugin",
        "team",
        "--audience",
        "workspace",
        "--enabled",
      ],
      [
        "refresh",
        registrationId,
        "--expected-lock-version",
        "0",
        "--limits",
        "not-json",
      ],
      [
        "declare",
        "--client",
        "claude",
        "--scope",
        "user",
        "--dry-run",
        "--apply",
      ],
    ])
      expect(await test.invoke(args)).toBe(1);
    expect(fetcher).not.toHaveBeenCalled();
    expect(await test.store.list()).toEqual([]);
    expect(marketplaceLimits(JSON.stringify(defaultMarketplaceLimits))).toEqual(
      defaultMarketplaceLimits,
    );
    expect(() => marketplaceLimits("{}")).toThrow();
  });
});

describe("marketplace explicit request boundaries", () => {
  it("validates required identity fields and creation CAS before network", async () => {
    const test = await setup();
    const base = {
      repositoryId: "42",
      name: "Team",
      format: "agent-plugins",
      manifestPath: "manifest.json",
      ref: "main",
      managed: true,
    };
    for (const options of [
      { ...base, name: " " },
      { ...base, format: "other" },
      { ...base, repositoryId: "0" },
      { ...base, repositoryId: "9007199254740992" },
    ])
      await expect(
        runMarketplaceCommand(test.context, "register", undefined, options),
      ).rejects.toThrow();
    for (const command of ["update", "refresh"] as const)
      await expect(
        runMarketplaceCommand(test.context, command, undefined, {
          expectedLockVersion: "0",
        }),
      ).rejects.toThrow("UUID is required");
    await runMarketplaceCommand(test.context, "declare", undefined, {
      client: "claude",
      scope: "workspace",
      binding: targetId,
      expectedLockVersion: "0",
    });
    await runMarketplaceCommand(test.context, "select", undefined, {
      registration: registrationId,
      plugin: "team",
      client: "claude",
      scope: "user",
      target: targetId,
      enabled: true,
      expectedLockVersion: "0",
    });
    expect(test.output.messages.join("\n")).toContain(
      '"expected_lock_version":0',
    );
    expect(test.tokenStore.get).not.toHaveBeenCalled();
  });

  it("preserves omitted registration fields, rejects absent registrations and binds declarations exactly", async () => {
    const test = await setup();
    const bodies: unknown[] = [];
    let available = true;
    let returnedTarget: import("../src/api/marketplace-api-client.js").MarketplaceTarget =
      wireTarget;
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (url, options) => {
        if (requestUrl(url).includes("/targets"))
          return respond({ target: returnedTarget });
        if (options?.body)
          bodies.push(JSON.parse(options.body as string) as unknown);
        return options?.method === "GET"
          ? respond({ registrations: available ? [wireRegistration] : [] })
          : respond({ registration: wireRegistration });
      }),
    );
    await runMarketplaceCommand(test.context, "update", registrationId, {
      ref: "release",
      expectedLockVersion: "0",
      apply: true,
    });
    expect(bodies[0]).toMatchObject({
      name: "Engineering",
      configured_ref: "release",
      sync_with_hivemnd: true,
    });
    available = false;
    for (const command of ["update", "refresh"] as const)
      await expect(
        runMarketplaceCommand(test.context, command, registrationId, {
          expectedLockVersion: "0",
          apply: true,
        }),
      ).rejects.toThrow("unavailable");
    returnedTarget = { ...wireTarget, id: registrationId };
    await expect(
      runMarketplaceCommand(test.context, "declare", targetId, {
        expectedLockVersion: "0",
        apply: true,
      }),
    ).rejects.toThrow("consent");
    returnedTarget = { ...wireTarget, status: "inactive" };
    await expect(
      runMarketplaceCommand(test.context, "declare", undefined, {
        client: "claude",
        scope: "user",
        apply: true,
      }),
    ).rejects.toThrow("consent");
    returnedTarget = {
      ...wireTarget,
      harness_kind: "codex",
    };
    await expect(
      runMarketplaceCommand(test.context, "declare", undefined, {
        client: "claude",
        scope: "user",
        apply: true,
      }),
    ).rejects.toThrow("consent");
    returnedTarget = wireTarget;
    const context = createCliContext(
      { ...test.dependencies, environment: {} },
      () => ({ configPath: test.configPath, explicitConfig: true }),
    );
    await runMarketplaceCommand(context, "declare", undefined, {
      client: "claude",
      scope: "user",
      apply: true,
    });
    await test.store.remember(wireTarget);
    await expect(
      synchronizeMarketplaces(context, {
        apply: false,
        targetId: registrationId,
      }),
    ).rejects.toThrow("Declare a local target");
  });
});

describe("marketplace managed synchronization", () => {
  it("enrolls and synchronizes in the private default home state without HIVEMND_HOME", async () => {
    const test = await setup();
    const dependencies = { ...test.dependencies, environment: {} };
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (url, options) => {
        if (requestUrl(url).endsWith("/targets") && options?.method === "POST")
          return respond({ target: wireTarget });
        return requestUrl(url).includes("/bundle?")
          ? Response.json(wireBundle)
          : respond({ target: wireTarget, items: [wireReady] });
      }),
    );
    const invoke = (args: string[]) =>
      runCli(
        ["--config", test.configPath, "marketplace", ...args],
        dependencies,
      );
    expect(
      await invoke([
        "declare",
        "--client",
        "claude",
        "--scope",
        "user",
        "--apply",
      ]),
    ).toBe(0);
    expect(await invoke(["sync", "--apply"])).toBe(0);
    const files = await filesUnder(join(test.home, ".hivemnd"));
    expect(
      [...files.keys()].filter((path) => path.endsWith("/current.json")),
    ).toHaveLength(1);
    expect((await stat(join(test.home, ".hivemnd"))).mode & 0o777).toBe(0o700);
    expect(test.output.messages.at(-1)).toContain('"status":"applied"');
    expect(await invoke(["sync", "--apply"])).toBe(0);
    expect(test.output.messages.at(-1)).toContain('"status":"unchanged"');
    expect(await filesUnder(join(test.home, ".hivemnd"))).toEqual(files);
    expect(await readdir(test.home)).toEqual([".hivemnd"]);
  });
  it("keeps two plugins across two explicit targets in separate owned directories and retains each current version", async () => {
    const test = await setup();
    const secondTarget = {
      ...wireTarget,
      id: "00000000-0000-4000-8000-000000000007",
      harness_kind: "codex" as const,
    };
    await test.store.remember(wireTarget);
    await test.store.remember(secondTarget);
    const secondPackage = {
      ...wireBundle.package,
      id: "00000000-0000-4000-8000-000000000008",
      plugin_key: "other",
      package_root: "plugins/other",
    };
    const secondItem = {
      ...wireReady,
      selection_id: "00000000-0000-4000-8000-000000000009",
      plugin_key: "other",
      package: { ...secondPackage, files: wireReady.package.files },
      bundle_path: `/eigen/api/v1/marketplace/packages/${secondPackage.id}/bundle`,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (url) => {
        const parsed = new URL(requestUrl(url));
        if (parsed.pathname.endsWith("/reconciliation"))
          return respond({
            target:
              parsed.searchParams.get("target_id") === targetId
                ? wireTarget
                : secondTarget,
            items: [wireReady, secondItem],
          });
        return Response.json(
          parsed.pathname.includes(secondPackage.id)
            ? { ...wireBundle, package: secondPackage }
            : wireBundle,
        );
      }),
    );
    expect(await test.invoke(["sync", "--apply"])).toBe(0);
    const files = await filesUnder(test.state);
    const pointers = [...files].filter(([path]) =>
      path.endsWith("/current.json"),
    );
    expect(pointers).toHaveLength(4);
    const owners = new Set(
      pointers.map(
        ([, bytes]) =>
          (
            JSON.parse(Buffer.from(bytes, "base64").toString()) as {
              ownerId: string;
            }
          ).ownerId,
      ),
    );
    expect(owners.size).toBe(4);
    for (const [path] of pointers) {
      const directory = path.slice(0, -"/current.json".length);
      expect(directory.split("/").at(-1)).toMatch(/^[a-f0-9]{64}$/);
      expect((await stat(directory)).mode & 0o777).toBe(0o700);
    }
    expect(await test.invoke(["sync", "--apply"])).toBe(0);
    expect(await filesUnder(test.state)).toEqual(files);
    expect(
      test.output.messages.filter((message) =>
        message.includes('"status":"unchanged"'),
      ),
    ).toHaveLength(4);
  });
  it("keeps unenrolled and inactive targets inert and reports a verified manual launch plan", async () => {
    const test = await setup();
    await writeJson(test.configPath, {
      ...test.config,
      installationId: undefined,
    });
    await synchronizeMarketplaces(test.context, {
      apply: true,
      automatic: true,
    });
    await expect(
      synchronizeMarketplaces(test.context, { apply: true }),
    ).rejects.toThrow("enrolled installation");
    await writeJson(test.configPath, test.config);
    await test.store.remember(wireTarget);
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () =>
        respond({ target: { ...wireTarget, status: "inactive" }, items: [] }),
      ),
    );
    await synchronizeMarketplaces(test.context, { apply: true });
    expect(test.output.messages.at(-1)).toContain('"status":"inactive"');
    const content = Buffer.from(
      JSON.stringify({ name: "team", version: "1.0.0" }),
    );
    const file = {
      relative_path: ".claude-plugin/plugin.json",
      byte_size: content.byteLength,
      sha256: createHash("sha256").update(content).digest("hex"),
      git_blob_oid: createHash("sha1")
        .update(`blob ${content.byteLength}\0`)
        .update(content)
        .digest("hex"),
      content_base64: content.toString("base64"),
      executable: true,
    };
    const digest = canonicalBundleDigest(
      [
        {
          path: file.relative_path,
          size: file.byte_size,
          sha256: file.sha256,
          executable: true,
        },
      ],
      {
        maxFiles: 10,
        maxFileBytes: 10000,
        maxTotalBytes: 10000,
        maxDepth: 128,
        maxEntries: 20,
      },
    );
    const pkg = {
      ...wireBundle.package,
      package_sha256: digest,
      package_bytes: content.byteLength,
      files: [
        {
          relative_path: file.relative_path,
          git_blob_oid: file.git_blob_oid,
          sha256: file.sha256,
          byte_size: file.byte_size,
          executable: file.executable,
        },
      ],
    };
    vi.mocked(probeDeclaredHarness).mockResolvedValueOnce({
      harness: "claude",
      version: "2.1.226",
      rootHelp: "--plugin-dir",
      pluginHelp: "",
      marketplaceHelp: "",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (url) =>
        requestUrl(url).includes("/bundle?")
          ? respond({ ...wireBundle, package: pkg, files: [file] })
          : respond({
              target: wireTarget,
              items: [
                {
                  ...wireReady,
                  package: {
                    ...pkg,
                    files: [
                      {
                        relative_path: file.relative_path,
                        git_blob_oid: file.git_blob_oid,
                        sha256: file.sha256,
                        byte_size: file.byte_size,
                        executable: file.executable,
                      },
                    ],
                  },
                },
              ],
            }),
      ),
    );
    await synchronizeMarketplaces(test.context, { apply: true });
    expect(test.output.messages.at(-1)).toContain('"launch_plan"');
    expect(test.output.messages.at(-1)).toContain('"currentSession":"unknown"');
  });
  it("rereads a changed HTTP checkpoint twice at most, publishing only the new complete inventory", async () => {
    const test = await setup();
    const nextId = "00000000-0000-4000-8000-000000000006";
    const nextPackage = {
      ...wireBundle.package,
      id: nextId,
      provenance: {
        ...wireBundle.package.provenance,
        commit_sha: "c".repeat(40),
      },
    };
    const nextItem = {
      ...wireReady,
      package: { ...nextPackage, files: wireReady.package.files },
      bundle_path: `/eigen/api/v1/marketplace/packages/${nextId}/bundle`,
    };
    let reconciliationReads = 0;
    let bundleReads = 0;
    let permanentlyStale = false;
    const server = createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      if (request.url?.includes("/reconciliation?")) {
        reconciliationReads += 1;
        response.end(
          JSON.stringify({
            ...wireEnvelope,
            refresh_requested: true,
            target: wireTarget,
            items: [reconciliationReads === 1 ? wireReady : nextItem],
          }),
        );
      } else {
        bundleReads += 1;
        if (permanentlyStale || bundleReads === 1) {
          response.statusCode = 409;
          response.end(
            JSON.stringify({ ...wireEnvelope, error: "stale_package" }),
          );
        } else
          response.end(JSON.stringify({ ...wireBundle, package: nextPackage }));
      }
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    cleanups.push(
      () =>
        new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        ),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Expected local HTTP fixture");
    test.config.apiUrl = `http://127.0.0.1:${address.port}/eigen`;
    await writeJson(test.configPath, test.config);
    await new MarketplaceTargets(
      test.state,
      test.configPath,
      test.config,
    ).remember(wireTarget);
    expect(await test.invoke(["sync", "--apply"])).toBe(0);
    expect(reconciliationReads).toBe(2);
    expect(bundleReads).toBe(2);
    expect(test.output.messages).toHaveLength(1);
    expect(test.output.messages[0]).toContain("c".repeat(40));
    const before = await filesUnder(test.state);
    const pointers = [...before].filter(([path]) =>
      path.endsWith("/current.json"),
    );
    expect(pointers).toHaveLength(1);
    expect(Buffer.from(pointers[0]![1], "base64").toString()).toContain(
      "c".repeat(40),
    );
    permanentlyStale = true;
    const priorReads = reconciliationReads;
    expect(await test.invoke(["sync", "--apply"])).toBe(1);
    expect(reconciliationReads - priorReads).toBe(3);
    expect(await filesUnder(test.state)).toEqual(before);
  });

  it("performs no marketplace calls without local consent, then downloads, verifies and applies a complete inert bundle on explicit and automatic sync", async () => {
    const test = await setup();
    const fetcher = vi.fn<typeof fetch>(async (url) =>
      requestUrl(url).includes("/bundle?")
        ? Response.json(wireBundle)
        : respond({ target: wireTarget, items: [wireReady] }),
    );
    vi.stubGlobal("fetch", fetcher);
    await synchronizeMarketplaces(test.context, {
      apply: true,
      automatic: true,
    });
    expect(fetcher).not.toHaveBeenCalled();
    expect(test.tokenStore.get).not.toHaveBeenCalled();
    await test.store.remember(wireTarget);
    expect(await test.invoke(["sync", "--target", targetId])).toBe(0);
    expect(test.output.messages.at(-1)).toContain('"status":"planned"');
    expect(await test.invoke(["sync", "--apply"])).toBe(0);
    expect(test.output.messages.at(-1)).toContain('"status":"applied"');
    expect(
      await runCli(
        ["--config", test.configPath, "sync", "--all", "--apply"],
        test.dependencies,
      ),
    ).toBe(0);
    expect(test.output.messages.at(-1)).toContain('"status":"unchanged"');
    expect(test.output.messages.join("\n")).not.toContain("# Team skill");
    expect(await readdir(test.home)).toEqual([".hivemnd"]);
  });

  it("reports disabled, private authorization, collision and native unknowns without fetching bundles or fabricating activation", async () => {
    const test = await setup();
    await test.store.remember(wireTarget);
    const fetcher = vi.fn<typeof fetch>(async () =>
      respond({
        target: wireTarget,
        items: [
          { ...wireReady, mode: "native" },
          ...["disabled", "unavailable", "collision"].map((status) => ({
            selection_id: selectionId,
            registration_id: registrationId,
            plugin_key: "team",
            enabled: false,
            mode: "managed",
            status,
          })),
          { selection_id: selectionId, status: "authorization_required" },
        ],
      }),
    );
    vi.stubGlobal("fetch", fetcher);
    expect(await test.invoke(["sync", "--apply"])).toBe(0);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(test.output.messages).toHaveLength(5);
    expect(test.output.messages.join("\n")).toContain(
      "native_activation_unsupported",
    );
    expect(test.output.messages.join("\n")).not.toContain('"package":');
    expect(test.output.messages.join("\n")).not.toContain(
      '"status":"installed"',
    );
  });

  it("rejects target, tenant path, inventory and binary changes before replacing active data", async () => {
    const test = await setup();
    await test.store.remember(wireTarget);
    const scenarios = [
      {
        target: { ...wireTarget, id: registrationId },
        item: wireReady,
        bundle: wireBundle,
      },
      {
        target: wireTarget,
        item: {
          ...wireReady,
          bundle_path: `/other/api/v1/marketplace/packages/${wireBundle.package.id}/bundle`,
        },
        bundle: wireBundle,
      },
      {
        target: wireTarget,
        item: wireReady,
        bundle: { ...wireBundle, registration_id: targetId },
      },
      {
        target: wireTarget,
        item: wireReady,
        bundle: {
          ...wireBundle,
          package: {
            ...wireBundle.package,
            files: [{ ...wireReady.package.files[0]!, sha256: "f".repeat(64) }],
          },
        },
      },
      {
        target: wireTarget,
        item: wireReady,
        bundle: {
          ...wireBundle,
          files: [{ ...wireBundle.files[0]!, sha256: "f".repeat(64) }],
        },
      },
      {
        target: wireTarget,
        item: wireReady,
        bundle: {
          ...wireBundle,
          files: [{ ...wireBundle.files[0]!, content_base64: "not base64" }],
        },
      },
    ];
    for (const scenario of scenarios) {
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>(async (url) =>
          requestUrl(url).includes("/bundle?")
            ? Response.json(scenario.bundle)
            : respond({ target: scenario.target, items: [scenario.item] }),
        ),
      );
      expect(await test.invoke(["sync", "--target", targetId, "--apply"])).toBe(
        1,
      );
    }
    expect(test.output.messages).toEqual([]);
  });
});

async function filesUnder(root: string): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory())
      for (const pair of await filesUnder(path)) result.set(...pair);
    else result.set(path, (await readFile(path)).toString("base64"));
  }
  return result;
}
