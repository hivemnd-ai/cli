import { mkdir, readFile, readdir, realpath } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultDependencies, runCli } from "../src/cli.js";
import { createCliContext } from "../src/cli/context.js";
import { runMarketplaceAuthorization } from "../src/workflows/marketplace-authorization.js";
import { MarketplaceAuthorizationStore } from "../src/auth/marketplace-authorization-store.js";
import { MarketplaceTargets } from "../src/workflows/marketplace-targets.js";
import {
  api,
  captureOutput,
  temporaryDirectory,
  writeJson,
} from "./helpers.js";
import {
  requestUrl,
  wireBundle,
  wireEnvelope,
  wireReady,
  wireTarget,
  wireSelection,
  registrationId,
} from "./marketplace-fixtures.js";
vi.mock("../src/marketplace/harness-adapters.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../src/marketplace/harness-adapters.js")
  >()),
  probeDeclaredHarness: vi.fn(async () => undefined),
}));
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(cleanup.splice(0).map((fn) => fn()));
});
const id = "i".repeat(43),
  grant = "g".repeat(43);
async function setup() {
  const temp = await temporaryDirectory();
  cleanup.push(temp.cleanup);
  const root = await realpath(temp.path),
    home = join(root, "home"),
    state = join(home, ".hivemnd");
  await mkdir(state, { recursive: true, mode: 0o700 });
  const path = join(state, "config.json"),
    config = {
      apiUrl: "https://host/eigen",
      installationId: "install-1",
      destinations: [],
    };
  await writeJson(path, config);
  const output = captureOutput();
  const get = vi.fn(async () => ({
    value: "bearer",
    source: "environment" as const,
  }));
  const dependencies = {
    ...defaultDependencies,
    cwd: root,
    homeDirectory: home,
    environment: { HIVEMND_HOME: state },
    output,
    tokenStoreFactory: () => ({ get, save: vi.fn() }),
    apiClientFactory: () => api(),
  };
  const context = createCliContext(dependencies, () => ({
    configPath: path,
    explicitConfig: true,
  }));
  return {
    root,
    home,
    state,
    path,
    config,
    output,
    get,
    dependencies,
    context,
    store: () => new MarketplaceAuthorizationStore(state, path, config),
    invoke: (args: string[]) =>
      runCli(["--config", path, "marketplace", ...args], dependencies),
  };
}
const json = (body: object, status = 200) =>
  Response.json({ ...wireEnvelope, ...body }, { status });
const expiry = () => new Date(Date.now() + 60_000).toISOString();
describe("private marketplace browser handoff", () => {
  it("plans authorization/revocation without credentials or writes, then exchanges and revokes without printing secrets", async () => {
    const test = await setup();
    let verifier = "";
    const expires = expiry();
    const fetcher = vi.fn<typeof fetch>(async (url, options) => {
      if (options?.method === "GET")
        return json(
          requestUrl(url).includes("/targets")
            ? { targets: [wireTarget] }
            : { selections: [wireSelection] },
        );
      if (options?.method === "DELETE")
        return new Response(null, { status: 204 });
      if (requestUrl(url).includes("/exchange")) {
        verifier = (
          JSON.parse(options?.body as string) as { code_verifier: string }
        ).code_verifier;
        return json({
          status: "authorized",
          authorization_token: grant,
          expires_at: expires,
        });
      }
      return json(
        {
          authorization_id: id,
          verification_uri: `https://host/eigen/marketplace/authorizations/${id}`,
          expires_at: expires,
          poll_interval_seconds: 2,
        },
        201,
      );
    });
    vi.stubGlobal("fetch", fetcher);
    expect(await test.invoke(["authorize"])).toBe(0);
    expect(await test.invoke(["revoke-authorization"])).toBe(0);
    const register = [
      "register",
      "--repository-id",
      "42",
      "--name",
      "Private",
      "--format",
      "claude-marketplace",
      "--manifest-path",
      ".claude-plugin/marketplace.json",
      "--ref",
      "main",
      "--managed",
      "--private-source",
    ];
    expect(await test.invoke([...register, "bad"])).toBe(1);
    expect(await test.invoke([...register, registrationId])).toBe(0);
    expect(fetcher).not.toHaveBeenCalled();
    expect(test.get).not.toHaveBeenCalled();
    expect(await test.invoke(["authorize", "--apply"])).toBe(0);
    expect(await test.store().load()).toMatchObject({
      authorizationToken: grant,
    });
    expect(await test.invoke(["status"])).toBe(0);
    expect(test.output.messages.at(-1)).toContain(
      "temporary_authorization_linked",
    );
    expect(test.output.messages.join(" ")).not.toContain(grant);
    expect(test.output.messages.join(" ")).not.toContain(verifier);
    expect(test.output.messages.join(" ")).not.toContain("bearer");
    expect(await test.invoke(["revoke-authorization", "--apply"])).toBe(0);
    expect(await test.store().load()).toBeUndefined();
    expect(test.output.messages.at(-1)).toContain("revoked");
    await writeJson(test.path, {
      apiUrl: test.config.apiUrl,
      destinations: [],
    });
    expect(await test.invoke(["status"])).toBe(0);
    expect(test.output.messages.at(-1)).toContain(
      '"private_authorization":{"status":"unavailable"}',
    );
    expect(await test.invoke(["authorize", "--apply", "--dry-run"])).toBe(1);
  });
  it("polls within the original approval expiry and never accepts renewed or expired grants", async () => {
    const test = await setup();
    const initial = Date.now();
    let now = initial,
      polls = 0;
    const expires = new Date(initial + 4000).toISOString();
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (url) =>
        requestUrl(url).includes("/exchange")
          ? ++polls === 1
            ? json(
                {
                  status: "pending",
                  expires_at: expires,
                  poll_interval_seconds: 2,
                },
                202,
              )
            : json({
                status: "authorized",
                authorization_token: grant,
                expires_at: expires,
              })
          : json(
              {
                authorization_id: id,
                verification_uri: `https://host/eigen/marketplace/authorizations/${id}`,
                expires_at: expires,
                poll_interval_seconds: 2,
              },
              201,
            ),
      ),
    );
    await runMarketplaceAuthorization(
      test.context,
      "authorize",
      { apply: true },
      {
        now: () => now,
        sleep: async (ms) => {
          now += ms;
        },
      },
    );
    expect(polls).toBe(2);
    expect(now - initial).toBe(2000);
    await test.store().remove();
    for (const badExpiry of [
      new Date(initial - 1000).toISOString(),
      new Date(initial + 601_000).toISOString(),
    ]) {
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>(async () =>
          json(
            {
              authorization_id: id,
              verification_uri: `https://host/eigen/marketplace/authorizations/${id}`,
              expires_at: badExpiry,
              poll_interval_seconds: 2,
            },
            201,
          ),
        ),
      );
      await expect(
        runMarketplaceAuthorization(
          test.context,
          "authorize",
          { apply: true },
          { now: () => initial, sleep: async () => undefined },
        ),
      ).rejects.toThrow();
    }
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async (url) =>
        requestUrl(url).includes("/exchange")
          ? json({
              status: "authorized",
              authorization_token: grant,
              expires_at: new Date(initial + 5000).toISOString(),
            })
          : json(
              {
                authorization_id: id,
                verification_uri: `https://host/eigen/marketplace/authorizations/${id}`,
                expires_at: expires,
                poll_interval_seconds: 2,
              },
              201,
            ),
      ),
    );
    await expect(
      runMarketplaceAuthorization(
        test.context,
        "authorize",
        { apply: true },
        { now: () => initial, sleep: async () => undefined },
      ),
    ).rejects.toThrow("expiry");
    expect(await test.store().load()).toBeUndefined();
  });
  it("stops expired or stalled browser approval without extending a grant or leaking verifier material", async () => {
    const test = await setup();
    const initial = Date.now(),
      expires = new Date(initial + 4000).toISOString();
    for (const mode of ["elapsed", "result-expired", "clock-stalled"]) {
      let now = initial,
        polls = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn<typeof fetch>(async (url) => {
          if (!requestUrl(url).includes("/exchange"))
            return json(
              {
                authorization_id: id,
                verification_uri: `https://host/eigen/marketplace/authorizations/${id}`,
                expires_at: expires,
                poll_interval_seconds: 2,
              },
              201,
            );
          polls++;
          return mode === "result-expired"
            ? json({
                status: "authorized",
                authorization_token: grant,
                expires_at: new Date(initial - 1000).toISOString(),
              })
            : json(
                {
                  status: "pending",
                  expires_at: expires,
                  poll_interval_seconds: 2,
                },
                202,
              );
        }),
      );
      await expect(
        runMarketplaceAuthorization(
          test.context,
          "authorize",
          { apply: true },
          {
            now: () => now,
            sleep: async (ms) => {
              if (mode !== "clock-stalled") now += ms;
            },
          },
        ),
      ).rejects.toThrow(
        mode === "clock-stalled" ? "polling capacity" : "authorization_expired",
      );
      expect(polls).toBe(
        mode === "clock-stalled" ? 300 : mode === "elapsed" ? 2 : 1,
      );
      expect(await test.store().load()).toBeUndefined();
    }
  });
  it("uses the cached opaque header for a complete private localhost bundle flow and stops when the grant expires", async () => {
    const test = await setup();
    const expires = expiry();
    let approved = false;
    const seen: string[] = [];
    const server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => {
        body += String(chunk);
      });
      request.on("end", () => {
        response.setHeader("content-type", "application/json");
        const endpoint = request.url!;
        seen.push(endpoint);
        let payload: object;
        if (endpoint.endsWith("/authorizations")) {
          const challenge = (JSON.parse(body) as { code_challenge: string })
            .code_challenge;
          if (!/^[A-Za-z0-9_-]{43}$/.test(challenge))
            throw new Error("Invalid synthetic PKCE");
          payload = {
            authorization_id: id,
            verification_uri: `${test.config.apiUrl}/marketplace/authorizations/${id}`,
            expires_at: expires,
            poll_interval_seconds: 2,
          };
        } else if (endpoint.endsWith("/exchange")) {
          approved = true;
          payload = {
            status: "authorized",
            authorization_token: grant,
            expires_at: expires,
          };
        } else if (
          !approved ||
          request.headers["x-hivemnd-marketplace-authorization"] !== grant
        ) {
          response.statusCode = 403;
          payload = { error: "github_authorization_required" };
        } else if (endpoint.includes("/bundle?")) payload = wireBundle;
        else
          payload = {
            target: wireTarget,
            refresh_requested: false,
            items: [wireReady],
          };
        response.end(JSON.stringify({ ...wireEnvelope, ...payload }));
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    cleanup.push(
      () =>
        new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        ),
    );
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Expected localhost fixture");
    test.config.apiUrl = `http://127.0.0.1:${address.port}/eigen`;
    await writeJson(test.path, test.config);
    await new MarketplaceTargets(test.state, test.path, test.config).remember(
      wireTarget,
    );
    expect(await test.invoke(["sync", "--apply"])).toBe(1);
    expect(await test.invoke(["authorize", "--apply"])).toBe(0);
    expect(await test.invoke(["sync", "--apply"])).toBe(0);
    expect(test.output.messages.at(-1)).toContain('"status":"applied"');
    const original = await readFile(test.store().path, "utf8");
    expect(original).not.toContain("bearer");
    await writeJson(test.store().path, {
      authorizationToken: grant,
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    expect(await test.invoke(["sync", "--apply"])).toBe(1);
    expect(seen.some((path) => path.includes("/bundle?"))).toBe(true);
    expect(await readdir(test.home)).toEqual([".hivemnd"]);
  });
});
