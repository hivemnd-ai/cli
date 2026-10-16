import * as filesystem from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultDependencies, runCli } from "../src/cli.js";
import { ConfigRepository } from "../src/config.js";
import { profileKey } from "../src/organizations/registry.js";
import { captureOutput, temporaryDirectory } from "./helpers.js";

vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof import("node:fs/promises")>()),
}));

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});
async function setup(
  options: {
    legacy?: boolean;
    explicit?: boolean;
    defaultState?: boolean;
  } = {},
) {
  const temp = await temporaryDirectory();
  cleanups.push(temp.cleanup);
  const state = join(temp.path, ".hivemnd");
  await filesystem.mkdir(state, { mode: 0o700 });
  const configPath = join(state, "config.json");
  const config = {
    apiUrl: "https://private-tenant.invalid/secret-org",
    ...(!options.legacy ? { installationId: "private-installation" } : {}),
    destinations: [
      {
        name: "private-destination",
        agent: "codex",
        scope: "workspace",
        path: join(temp.path, "private-workspace"),
      },
    ],
  };
  await filesystem.writeFile(configPath, JSON.stringify(config), {
    mode: 0o600,
  });
  const forbidden = vi.fn((): never => {
    throw new Error("must not access private credential, network or updater");
  });
  vi.stubGlobal("fetch", forbidden);
  const output = captureOutput();
  const dependencies = {
    ...defaultDependencies,
    cwd: temp.path,
    homeDirectory: temp.path,
    environment: {
      HOME: temp.path,
      ...(!options.defaultState ? { HIVEMND_HOME: state } : {}),
    },
    output,
    configRepositoryFactory: (cwd: string) => new ConfigRepository(cwd),
    tokenStoreFactory: forbidden,
    apiClientFactory: forbidden,
    adapterFactory: forbidden,
    targetAccess: forbidden,
    updateService: { check: forbidden },
  };
  const root = join(
    state,
    "organizations",
    profileKey(config.apiUrl),
    "usage-outboxes",
    "private-installation",
  );
  const args = options.explicit
    ? ["--config", configPath, "doctor", "--offline"]
    : ["doctor", "--offline"];
  const run = async () => {
    const before = await filesystem.readFile(configPath);
    expect(await runCli(args, dependencies)).toBe(0);
    expect(await filesystem.readFile(configPath)).toEqual(before);
    expect(forbidden).not.toHaveBeenCalled();
    expect(output.errors).toEqual([]);
    const rendered = output.messages.join("\n");
    for (const value of [
      temp.path,
      config.apiUrl,
      "private-installation",
      "private-destination",
      "private-workspace",
      "PRIVATE_RECEIPT_BODY",
    ])
      expect(rendered).not.toContain(value);
    expect(rendered).toContain("not checked credential (offline)");
    expect(rendered).toContain("not checked API (offline)");
    return rendered;
  };
  const queue = async () =>
    filesystem.mkdir(root, { recursive: true, mode: 0o700 });
  const file = async (name: string, body = "PRIVATE_RECEIPT_BODY") =>
    filesystem.writeFile(join(root, name), body, { mode: 0o600 });
  return {
    temp,
    state,
    configPath,
    root,
    run,
    queue,
    file,
    output,
    dependencies,
    args,
  };
}

describe("offline doctor local diagnostics", () => {
  it("reports missing queue empty without creating it or upgrading legacy destination IDs", async () => {
    const fixture = await setup();
    expect(await fixture.run()).toContain(
      "usage outbox: empty; queued-files: 0; bytes: 0",
    );
    await expect(filesystem.lstat(fixture.root)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(await filesystem.readdir(fixture.state)).toEqual(["config.json"]);
  });
  it("inspects explicit config and reports legacy installation identity unknown", async () => {
    const fixture = await setup({ legacy: true, explicit: true });
    expect(await fixture.run()).toContain(
      "usage outbox: unknown (installation identity unavailable)",
    );
    expect(await filesystem.readdir(fixture.state)).toEqual(["config.json"]);
  });
  it("counts JSON files and bytes without parsing contents, labeling filesystem age precisely", async () => {
    const fixture = await setup();
    await fixture.queue();
    await fixture.file("one.json");
    await fixture.file("two.json", "{invalid JSON and PRIVATE_RECEIPT_BODY");
    await fixture.file("ignored.tmp", "not queued");
    const clock = new Date("2026-10-16T12:00:00Z");
    vi.spyOn(Date, "now").mockReturnValue(clock.getTime());
    await filesystem.utimes(
      join(fixture.root, "one.json"),
      clock,
      new Date(clock.getTime() - 90_000),
    );
    await filesystem.utimes(
      join(fixture.root, "two.json"),
      clock,
      new Date(clock.getTime() + 60_000),
    );
    const read = vi.spyOn(filesystem, "readFile");
    const result = await fixture.run();
    expect(result).toContain(
      "usage outbox: queued; queued-files: 2; bytes: 58; oldest-file-mtime-age-seconds: 90",
    );
    expect(result).toContain("file age, not event or delivery latency");
    expect(result).toContain(
      "256 files / 1048576 bytes; receipt contents not validated",
    );
    expect(
      read.mock.calls.every(
        ([path]) =>
          !(typeof path === "string" && path.includes("usage-outboxes")),
      ),
    ).toBe(true);
    expect(
      await filesystem.readFile(join(fixture.root, "one.json"), "utf8"),
    ).toBe("PRIVATE_RECEIPT_BODY");
  });
  it.each(["root", "organizations", "installation", "file"])(
    "rejects %s symlink without reading outside it",
    async (location) => {
      const fixture = await setup();
      await fixture.queue();
      const external = join(fixture.temp.path, "outside");
      await filesystem.mkdir(external, { mode: 0o700 });
      await filesystem.writeFile(
        join(external, "private.json"),
        "PRIVATE_RECEIPT_BODY",
        { mode: 0o600 },
      );
      if (location === "file")
        await filesystem.symlink(
          join(external, "private.json"),
          join(fixture.root, "receipt.json"),
        );
      else {
        const path =
          location === "root"
            ? fixture.state
            : location === "organizations"
              ? join(fixture.state, "organizations")
              : fixture.root;
        if (location === "root") {
          await filesystem.rename(path, external + "-state");
          await filesystem.symlink(external + "-state", path);
        } else {
          await filesystem.rm(path, { recursive: true });
          await filesystem.symlink(external, path);
        }
      }
      expect(await fixture.run()).toContain(
        "usage outbox: unknown (unsafe local state)",
      );
    },
  );
  it.each(["directory", "file", "file-is-directory", "root-is-file"])(
    "reports unsafe %s metadata without changing state",
    async (kind) => {
      const fixture = await setup();
      await fixture.queue();
      if (kind === "directory") await filesystem.chmod(fixture.root, 0o755);
      if (kind === "file") {
        await fixture.file("unsafe.json");
        await filesystem.chmod(join(fixture.root, "unsafe.json"), 0o644);
      }
      if (kind === "file-is-directory")
        await filesystem.mkdir(join(fixture.root, "unsafe.json"), {
          mode: 0o700,
        });
      if (kind === "root-is-file") {
        await filesystem.rm(fixture.root, { recursive: true });
        await filesystem.writeFile(fixture.root, "not a directory", {
          mode: 0o600,
        });
      }
      expect(await fixture.run()).toContain(
        "usage outbox: unknown (unsafe local state)",
      );
    },
  );
  it("reports existing empty queue without inventing oldest timestamp", async () => {
    const fixture = await setup();
    await fixture.queue();
    expect(await fixture.run()).toContain("oldest-file-mtime-age-seconds: n/a");
  });
  it.each(["entries", "bytes", "scan"])(
    "bounds %s inspection without presenting partial totals",
    async (bound) => {
      const fixture = await setup();
      await fixture.queue();
      if (bound === "bytes")
        await fixture.file("big.json", "x".repeat(1048577));
      else
        for (let index = 0; index < (bound === "scan" ? 513 : 257); index++)
          await fixture.file(
            `${index}.${bound === "scan" ? "tmp" : "json"}`,
            "x",
          );
      const result = await fixture.run();
      expect(result).toContain(
        "usage outbox: unknown (inspection limit exceeded)",
      );
      expect(result).not.toContain("queued-files:");
    },
  );
  it("reports directory read failure without leaking exception", async () => {
    const fixture = await setup();
    await fixture.queue();
    vi.spyOn(filesystem, "opendir").mockRejectedValue(
      new Error("PRIVATE_RECEIPT_BODY"),
    );
    expect(await fixture.run()).toContain(
      "usage outbox: unknown (local state unreadable)",
    );
  });
  it("reports file open failure without delivery, deletion or private error output", async () => {
    const fixture = await setup();
    await fixture.queue();
    await fixture.file("one.json");
    vi.spyOn(filesystem, "open").mockRejectedValue(
      new Error("PRIVATE_RECEIPT_BODY"),
    );
    expect(await fixture.run()).toContain(
      "usage outbox: unknown (local state unreadable)",
    );
    expect(await filesystem.readdir(fixture.root)).toEqual(["one.json"]);
  });
  it("redacts invalid config and leaves credentials and API unchecked", async () => {
    const fixture = await setup();
    await filesystem.writeFile(fixture.configPath, "PRIVATE_RECEIPT_BODY", {
      mode: 0o600,
    });
    expect(await fixture.run()).toContain(
      "unknown config (local configuration unavailable)",
    );
  });
  it("accepts exactly the queue capacity and clamps future file mtimes to zero", async () => {
    const fixture = await setup({ explicit: true, defaultState: true });
    await fixture.queue();
    for (let index = 0; index < 256; index++) {
      await fixture.file(`${index}.json`, "x".repeat(4096));
      const future = new Date(Date.now() + 60_000);
      await filesystem.utimes(
        join(fixture.root, `${index}.json`),
        future,
        future,
      );
    }
    expect(await fixture.run()).toContain(
      "queued-files: 256; bytes: 1048576; oldest-file-mtime-age-seconds: 0",
    );
  });
  it("reports inaccessible directory metadata as unknown instead of empty", async () => {
    const fixture = await setup();
    vi.spyOn(filesystem, "lstat").mockRejectedValueOnce(
      Object.assign(new Error("PRIVATE_RECEIPT_BODY"), { code: "EACCES" }),
    );
    expect(await fixture.run()).toContain(
      "usage outbox: unknown (local state unreadable)",
    );
  });
  it.each(["replacement", "permissions", "symlink", "directory"])(
    "refuses a file %s between directory discovery and descriptor inspection",
    async (change) => {
      const fixture = await setup();
      await fixture.queue();
      await fixture.file("one.json");
      const originalOpen = filesystem.open;
      vi.spyOn(filesystem, "open").mockImplementationOnce(async (...args) => {
        const path = join(fixture.root, "one.json");
        if (change === "replacement") {
          await filesystem.rename(path, path + ".previous");
          await filesystem.writeFile(path, "PRIVATE_RECEIPT_BODY", {
            mode: 0o600,
          });
        } else if (change === "permissions")
          await filesystem.chmod(path, 0o644);
        else if (change === "directory") {
          await filesystem.rm(path);
          await filesystem.mkdir(path, { mode: 0o700 });
        } else {
          await filesystem.rename(path, path + ".previous");
          await filesystem.symlink(path + ".previous", path);
        }
        return originalOpen(...args);
      });
      expect(await fixture.run()).toContain("usage outbox: unknown (");
    },
  );
  it.each(["replacement", "permissions", "symlink"])(
    "refuses directory %s during bounded enumeration",
    async (change) => {
      const fixture = await setup();
      await fixture.queue();
      const originalOpen = filesystem.opendir;
      vi.spyOn(filesystem, "opendir").mockImplementationOnce(
        async (...args) => {
          const directory = await originalOpen(...args);
          if (change === "permissions")
            await filesystem.chmod(fixture.root, 0o755);
          else {
            await filesystem.rename(fixture.root, fixture.root + ".previous");
            if (change === "symlink")
              await filesystem.symlink(
                fixture.root + ".previous",
                fixture.root,
              );
            else await filesystem.mkdir(fixture.root, { mode: 0o700 });
          }
          return directory;
        },
      );
      expect(await fixture.run()).toContain(
        "usage outbox: unknown (unsafe local state)",
      );
    },
  );
});
