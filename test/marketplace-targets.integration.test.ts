import {
  chmod,
  mkdir,
  realpath,
  rename,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MarketplaceTargets } from "../src/workflows/marketplace-targets.js";
import { temporaryDirectory } from "./helpers.js";
import { targetId, wireTarget } from "./marketplace-fixtures.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((fn) => fn()));
});
async function setup() {
  const temp = await temporaryDirectory();
  cleanup.push(temp.cleanup);
  const root = await realpath(temp.path);
  const config = {
    apiUrl: "https://shared.hivemnd.cloud/eigen",
    installationId: "installation-1",
    destinations: [],
  };
  const store = new MarketplaceTargets(
    join(root, "state"),
    join(root, "config.json"),
    config,
  );
  return { root, store, config };
}
describe("explicit marketplace consent ownership", () => {
  it("requires an enrolled safe installation and stores immutable scope identity idempotently", async () => {
    const test = await setup();
    for (const installationId of [undefined, "../escape"])
      expect(
        () =>
          new MarketplaceTargets(test.root, "config", {
            apiUrl: test.config.apiUrl,
            destinations: [],
            ...(installationId === undefined ? {} : { installationId }),
          }),
      ).toThrow("enrolled installation");
    expect(await test.store.list()).toEqual([]);
    await test.store.remember(wireTarget);
    await test.store.remember(wireTarget);
    await expect(
      test.store.remember({ ...wireTarget, harness_kind: "codex" }),
    ).rejects.toThrow("identity changed");
    expect(await test.store.list()).toHaveLength(1);
  });
  it("rejects malformed, unknown and filename-mismatched consent without accepting partial identity", async () => {
    const { store } = await setup();
    await store.remember(wireTarget);
    const file = join(store.directory, `${targetId}.json`);
    for (const text of [
      "not-json",
      JSON.stringify({ id: targetId }),
      JSON.stringify({
        ...wireTarget,
        status: undefined,
        lock_version: undefined,
        token: "private",
      }),
    ]) {
      await writeFile(file, text, { mode: 0o600 });
      await expect(store.list()).rejects.toThrow(
        "Invalid marketplace target consent",
      );
    }
    await writeFile(
      file,
      JSON.stringify({
        id: targetId,
        harness_kind: "claude",
        install_scope: "user",
        workspace_binding_id: null,
      }),
      { mode: 0o600 },
    );
    await rename(file, join(store.directory, "wrong.json"));
    await expect(store.list()).rejects.toThrow(
      "Invalid marketplace target consent",
    );
  });
  it("fails closed on symlink ancestry and directories whose permissions were widened", async () => {
    const first = await setup();
    await first.store.remember(wireTarget);
    await chmod(first.store.directory, 0o755);
    await expect(first.store.remember(wireTarget)).rejects.toThrow(
      "must be private",
    );
    const second = await setup();
    await mkdir(join(second.root, "state"), { mode: 0o700 });
    await symlink(first.root, join(second.root, "state", "organizations"));
    await expect(second.store.remember(wireTarget)).rejects.toThrow();
    // A missing opt-in is inert, even if an unrelated ancestor is a symlink.
    expect(await second.store.list()).toEqual([]);
    // Existing consent behind a symlink still fails closed.
    const linked = new MarketplaceTargets(
      join(second.root, "linked"),
      "config",
      second.config,
    );
    await symlink(first.root, join(second.root, "linked"));
    const existing = new MarketplaceTargets(first.root, "config", first.config);
    await existing.remember(wireTarget);
    await expect(linked.list()).rejects.toThrow();
  });
});
