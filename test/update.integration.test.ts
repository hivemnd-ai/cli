import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DailyUpdateChecker,
  UPDATE_COMMAND,
} from "../src/update/daily-update-checker.js";
import { compareSemver, parseSemver } from "../src/version/semver.js";
import { temporaryDirectory } from "./helpers.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  vi.restoreAllMocks();
});

describe("daily npm update check", () => {
  it("checks at most daily, stores a private cache, and reports only a newer stable version", async () => {
    const temp = await temporaryDirectory();
    cleanups.push(temp.cleanup);
    const fetcher = vi.fn<typeof fetch>(
      async () =>
        new Response(JSON.stringify({ version: "1.4.0" }), { status: 200 }),
    );
    const checker = new DailyUpdateChecker({
      currentVersion: "1.2.3",
      stateDirectory: temp.path,
      fetcher,
      now: () => new Date("2026-07-27T10:00:00.000Z"),
    });

    await expect(checker.check()).resolves.toEqual({
      checked: true,
      currentVersion: "1.2.3",
      latestVersion: "1.4.0",
      updateAvailable: true,
      command: UPDATE_COMMAND,
    });
    await expect(checker.check()).resolves.toMatchObject({
      checked: false,
      updateAvailable: true,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith(
      "https://registry.npmjs.org/@hivemnd-ai%2fcli/latest",
      expect.objectContaining({ headers: { accept: "application/json" } }),
    );
    expect((await stat(temp.path)).mode & 0o777).toBe(0o700);
    expect(
      (await stat(join(temp.path, "update-check.json"))).mode & 0o777,
    ).toBe(0o600);
    expect(
      JSON.parse(await readFile(join(temp.path, "update-check.json"), "utf8")),
    ).toEqual({
      checkedAt: "2026-07-27T10:00:00.000Z",
      latestStableVersion: "1.4.0",
    });
  });

  it("forces explicit checks and never lets network, schema, timeout, or cache failures break commands", async () => {
    const temp = await temporaryDirectory();
    cleanups.push(temp.cleanup);
    const fetcher = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ version: "2.0.0-beta.1" }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ version: "invalid" }), { status: 200 }),
      )
      .mockResolvedValueOnce(new Response("{}", { status: 503 }))
      .mockResolvedValueOnce(new Response("[]", { status: 200 }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    const checker = new DailyUpdateChecker({
      currentVersion: "1.2.3",
      stateDirectory: temp.path,
      fetcher,
      now: () => new Date("2026-07-27T10:00:00.000Z"),
      timeoutMilliseconds: 5,
    });

    for (let index = 0; index < 6; index += 1) {
      await expect(checker.check({ force: true })).resolves.toMatchObject({
        checked: true,
        updateAvailable: false,
      });
    }

    const invalidCache = join(temp.path, "invalid-cache");
    await writeFile(invalidCache, "not-a-directory");
    await expect(
      new DailyUpdateChecker({
        currentVersion: "1.2.3",
        stateDirectory: invalidCache,
        fetcher: async () => new Response(JSON.stringify({ version: "1.2.3" })),
      }).check(),
    ).resolves.toMatchObject({ updateAvailable: false });

    const aborting = new DailyUpdateChecker({
      currentVersion: "1.2.3",
      stateDirectory: join(temp.path, "timeout"),
      timeoutMilliseconds: 1,
      fetcher: async (_url, init) =>
        new Promise<Response>((_resolve, reject) =>
          init?.signal?.addEventListener("abort", () =>
            reject(new Error("aborted")),
          ),
        ),
    });
    await expect(aborting.check({ force: true })).resolves.toMatchObject({
      updateAvailable: false,
    });
  });

  it("rechecks stale or invalid caches and safely ignores future timestamps and invalid cached versions", async () => {
    const temp = await temporaryDirectory();
    cleanups.push(temp.cleanup);
    const cachePath = join(temp.path, "update-check.json");
    await mkdir(temp.path, { recursive: true });
    const fetcher = vi.fn<typeof fetch>(
      async () => new Response(JSON.stringify({ version: "1.2.3" })),
    );
    const checker = (now: string) =>
      new DailyUpdateChecker({
        currentVersion: "1.2.3",
        stateDirectory: temp.path,
        fetcher,
        now: () => new Date(now),
      });

    for (const cache of [
      { checkedAt: "2026-07-25T00:00:00.000Z" },
      { checkedAt: "invalid" },
      { checkedAt: "2026-07-29T00:00:00.000Z" },
      { checkedAt: "2026-07-27T00:00:00.000Z", latestStableVersion: 42 },
      { checkedAt: "2026-07-27T00:00:00.000Z", latestStableVersion: "bad" },
      [],
    ]) {
      await writeFile(cachePath, JSON.stringify(cache));
      await checker("2026-07-27T00:00:00.000Z").check();
    }
    expect(fetcher).toHaveBeenCalledTimes(6);
  });
});

describe("semantic versions", () => {
  it("validates SemVer and applies prerelease precedence", () => {
    expect(parseSemver("1.2.3+build.4")).toMatchObject({
      major: 1,
      minor: 2,
      patch: 3,
    });
    expect(parseSemver("01.2.3")).toBeUndefined();
    expect(parseSemver("1.2")).toBeUndefined();
    expect(compareSemver("1.2.3", "1.2.3-beta.2")).toBeGreaterThan(0);
    expect(compareSemver("1.2.3-beta.2", "1.2.3")).toBeLessThan(0);
    expect(compareSemver("1.2.3-beta.2", "1.2.3-beta.11")).toBeLessThan(0);
    expect(compareSemver("1.2.3-beta.11", "1.2.3-beta.2")).toBeGreaterThan(0);
    expect(compareSemver("1.2.3-alpha", "1.2.3-beta")).toBeLessThan(0);
    expect(compareSemver("1.2.3-beta", "1.2.3-alpha")).toBeGreaterThan(0);
    expect(compareSemver("1.2.3-alpha", "1.2.3-alpha.1")).toBeLessThan(0);
    expect(compareSemver("1.2.3-alpha.1", "1.2.3-alpha")).toBeGreaterThan(0);
    expect(compareSemver("1.2.3-1", "1.2.3-alpha")).toBeLessThan(0);
    expect(compareSemver("1.2.3-alpha", "1.2.3-1")).toBeGreaterThan(0);
    expect(compareSemver("1.2.3-alpha", "1.2.3-alpha")).toBe(0);
    expect(compareSemver("2.0.0", "1.99.99")).toBeGreaterThan(0);
    expect(compareSemver("1.0.0", "2.0.0")).toBeLessThan(0);
    expect(compareSemver("1.3.0", "1.2.99")).toBeGreaterThan(0);
    expect(compareSemver("1.2.4", "1.2.3")).toBeGreaterThan(0);
    expect(compareSemver("1.2.3", "1.2.3")).toBe(0);
    expect(parseSemver("1.2.3-01")).toBeUndefined();
    expect(() => compareSemver("invalid", "1.0.0")).toThrow(
      "Invalid semantic version",
    );
  });
});
