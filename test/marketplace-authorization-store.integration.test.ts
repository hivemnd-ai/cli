import {
  chmod,
  mkdir,
  readFile,
  realpath,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MarketplaceAuthorizationStore } from "../src/auth/marketplace-authorization-store.js";
import { temporaryDirectory } from "./helpers.js";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((fn) => fn()));
});
async function setup() {
  const temp = await temporaryDirectory();
  cleanups.push(temp.cleanup);
  const root = await realpath(temp.path);
  return {
    root,
    store: new MarketplaceAuthorizationStore(
      join(root, "state"),
      join(root, "config"),
      {
        apiUrl: "https://host/eigen",
        installationId: "install-1",
        destinations: [],
      },
    ),
  };
}
const future = () => new Date(Date.now() + 60_000).toISOString();
describe("temporary private marketplace authorization ownership", () => {
  it("persists only the scoped opaque grant and expiry with private permissions and removes only that grant", async () => {
    const { root, store } = await setup();
    expect(await store.load()).toBeUndefined();
    await store.save({
      authorizationToken: "a".repeat(43),
      expiresAt: future(),
    });
    expect(await store.load()).toMatchObject({
      authorizationToken: "a".repeat(43),
    });
    const other = new MarketplaceAuthorizationStore(
      join(root, "state"),
      join(root, "other-config"),
      {
        apiUrl: "https://host/eigen",
        installationId: "install-1",
        destinations: [],
      },
    );
    expect(await other.load()).toBeUndefined();
    await store.remove();
    await store.remove();
    expect(await store.load()).toBeUndefined();
  });
  it("leaves expired grants inactive and rejects malformed, widened or symlink state", async () => {
    const { root, store } = await setup();
    await expect(
      store.save({ authorizationToken: "PRIVATE TOKEN", expiresAt: future() }),
    ).rejects.toThrow();
    await store.save({
      authorizationToken: "a".repeat(43),
      expiresAt: future(),
    });
    const path = store.path;
    const original = await readFile(path);
    await writeFile(
      path,
      JSON.stringify({
        authorizationToken: "a".repeat(43),
        expiresAt: new Date(Date.now() - 1000).toISOString(),
      }),
    );
    expect(await store.load()).toBeUndefined();
    await writeFile(
      path,
      JSON.stringify({ authorizationToken: "bad", expiresAt: future() }),
    );
    await expect(store.load()).rejects.toThrow(
      "Invalid temporary marketplace authorization",
    );
    await writeFile(path, "PRIVATE malformed");
    await expect(store.load()).rejects.toThrow(
      "Invalid temporary marketplace authorization",
    );
    await writeFile(path, original);
    await chmod(path, 0o644);
    await expect(store.load()).rejects.toThrow();
    await chmod(path, 0o600);
    const linked = join(root, "linked");
    await symlink(join(root, "state"), linked);
    const unsafe = new MarketplaceAuthorizationStore(
      linked,
      join(root, "config"),
      {
        apiUrl: "https://host/eigen",
        installationId: "install-1",
        destinations: [],
      },
    );
    await expect(unsafe.load()).rejects.toThrow();
    await expect(unsafe.remove()).rejects.toThrow();
    await mkdir(join(root, "other"));
    expect(
      () =>
        new MarketplaceAuthorizationStore(root, "config", {
          apiUrl: "https://host",
          destinations: [],
        }),
    ).toThrow("enrolled installation");
  });
});
