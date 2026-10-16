import * as fs from "node:fs/promises";
import * as process from "node:child_process";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  materializeLocalBundle,
  type BundleFile,
} from "../src/marketplace/bundle-store.js";
import { hash, temporaryDirectory } from "./helpers.js";

vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof import("node:fs/promises")>()),
}));
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
}));
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await Promise.all(cleanups.splice(0).map((fn) => fn()));
});
async function fixture(large = false) {
  const temp = await temporaryDirectory();
  cleanups.push(temp.cleanup);
  const root = await fs.realpath(temp.path);
  const sourceDirectory = join(root, "package");
  const storeDirectory = join(root, "private-store");
  await fs.mkdir(sourceDirectory);
  const bodies: Record<string, Buffer> = {
    "plugin.json": Buffer.from(
      JSON.stringify({
        name: "fixture",
        hooks: { SessionStart: [{ command: "touch SHOULD_NEVER_EXIST" }] },
        mcpServers: {
          trap: { command: "touch", args: ["SHOULD_NEVER_EXIST"] },
        },
      }),
    ),
    "skills/demo/SKILL.md": Buffer.from(
      "# Demo\nSee scripts/run.sh and data/table.csv",
    ),
    "scripts/run.sh": Buffer.from("#!/bin/sh\ntouch SHOULD_NEVER_EXIST"),
    "data/table.csv": Buffer.from(
      "key,value\n" + "large,table\n".repeat(large ? 100000 : 2),
    ),
    "references/image.bin": Buffer.alloc(large ? 600000 : 4, 255),
    LICENSE: Buffer.from("Fixture license"),
  };
  const files: BundleFile[] = [];
  for (const [path, body] of Object.entries(bodies)) {
    await fs.mkdir(join(sourceDirectory, path, ".."), { recursive: true });
    await fs.writeFile(join(sourceDirectory, path), body);
    if (path === "scripts/run.sh")
      await fs.chmod(join(sourceDirectory, path), 0o755);
    files.push({
      path,
      size: body.length,
      sha256: hash(body),
      executable: path === "scripts/run.sh",
    });
  }
  const input = {
    sourceDirectory,
    storeDirectory,
    ownerId: "fixture-owner",
    commitSha: "a".repeat(40),
    files,
    limits: {
      maxFiles: 20,
      maxFileBytes: 2000000,
      maxTotalBytes: 4000000,
      maxDepth: 8,
      maxEntries: 40,
    },
  };
  return { root, input, bodies, run: () => materializeLocalBundle(input) };
}
describe("inert complete bundle materialization", () => {
  it("preserves all binary/data/license bytes, never executes, and retains runtime data on upstream updates", async () => {
    const f = await fixture(true);
    const forbidden = vi.fn(() => {
      throw new Error("forbidden execution/network");
    });
    vi.stubGlobal("fetch", forbidden);
    vi.spyOn(process, "execFile").mockImplementation(forbidden);
    vi.spyOn(process, "spawn").mockImplementation(forbidden);
    const first = await f.run();
    expect(first.created).toBe(true);
    for (const [path, body] of Object.entries(f.bodies)) {
      expect(await fs.readFile(join(first.directory, path))).toEqual(body);
      expect((await fs.stat(join(first.directory, path))).mode & 0o777).toBe(
        0o600,
      );
    }
    await fs.writeFile(join(f.input.storeDirectory, "data", "runtime"), "keep");
    expect(await f.run()).toEqual({ ...first, created: false });
    const file = f.input.files[0];
    if (!file) throw new Error("fixture");
    const updated = Buffer.from("# New upstream");
    await fs.writeFile(join(f.input.sourceDirectory, file.path), updated);
    Object.assign(file, { size: updated.length, sha256: hash(updated) });
    f.input.commitSha = "b".repeat(40);
    const second = await f.run();
    expect(second.directory).not.toBe(first.directory);
    expect(
      await fs.readFile(
        join(f.input.storeDirectory, "data", "runtime"),
        "utf8",
      ),
    ).toBe("keep");
    expect(await fs.readFile(join(first.directory, file.path))).toEqual(
      f.bodies[file.path],
    );
    expect(forbidden).not.toHaveBeenCalled();
  });
  it("rejects incomplete or corrupt source before publishing", async () => {
    const f = await fixture();
    await fs.writeFile(join(f.input.sourceDirectory, "LICENSE"), "corrupt");
    await expect(f.run()).rejects.toMatchObject({ code: "INTEGRITY_FAILED" });
    expect(await fs.readdir(join(f.input.storeDirectory, "versions"))).toEqual(
      [],
    );
  });
  it("does not overwrite a foreign store", async () => {
    const f = await fixture();
    await fs.mkdir(f.input.storeDirectory);
    await fs.writeFile(join(f.input.storeDirectory, "foreign"), "keep");
    await expect(f.run()).rejects.toMatchObject({ code: "PATH_UNSAFE" });
    expect(
      await fs.readFile(join(f.input.storeDirectory, "foreign"), "utf8"),
    ).toBe("keep");
  });
});

it.each([
  [
    "owner",
    (f: Awaited<ReturnType<typeof fixture>>) => {
      f.input.ownerId = "../foreign";
    },
  ],
  [
    "commit",
    (f: Awaited<ReturnType<typeof fixture>>) => {
      f.input.commitSha = "not-a-commit";
    },
  ],
  [
    "zero limit",
    (f: Awaited<ReturnType<typeof fixture>>) => {
      f.input.limits.maxEntries = 0;
    },
  ],
  [
    "fraction limit",
    (f: Awaited<ReturnType<typeof fixture>>) => {
      f.input.limits.maxFiles = 1.5;
    },
  ],
  [
    "file count",
    (f: Awaited<ReturnType<typeof fixture>>) => {
      f.input.limits.maxFiles = 1;
    },
  ],
  [
    "empty",
    (f: Awaited<ReturnType<typeof fixture>>) => {
      f.input.files = [];
    },
  ],
  [
    "file bytes",
    (f: Awaited<ReturnType<typeof fixture>>) => {
      f.input.limits.maxFileBytes = 2;
    },
  ],
  [
    "total bytes",
    (f: Awaited<ReturnType<typeof fixture>>) => {
      f.input.limits.maxTotalBytes = 2;
    },
  ],
  [
    "depth",
    (f: Awaited<ReturnType<typeof fixture>>) => {
      f.input.limits.maxDepth = 1;
    },
  ],
] as const)("rejects invalid %s", async (_name, change) => {
  const f = await fixture();
  change(f);
  await expect(f.run()).rejects.toMatchObject({ code: "INTEGRITY_FAILED" });
});
it.each([
  "",
  "/absolute",
  "../escape",
  "a/../escape",
  "a/./b",
  "a//b",
  "a\\b",
  "nul\0x",
  "e\u0301.txt",
])("rejects unsafe inventory path %j", async (path) => {
  const f = await fixture();
  f.input.files = [{ path, size: 0, sha256: hash(""), executable: false }];
  await expect(f.run()).rejects.toMatchObject({ code: "PATH_UNSAFE" });
});
it.each([
  [
    "duplicate",
    [
      { path: "a", size: 0, sha256: hash(""), executable: false },
      { path: "A", size: 0, sha256: hash(""), executable: false },
    ],
  ],
  [
    "prefix",
    [
      { path: "a", size: 0, sha256: hash(""), executable: false },
      { path: "a/b", size: 0, sha256: hash(""), executable: false },
    ],
  ],
  ["bad hash", [{ path: "a", size: 0, sha256: "bad", executable: false }]],
  [
    "negative bytes",
    [{ path: "a", size: -1, sha256: hash(""), executable: false }],
  ],
  [
    "fraction bytes",
    [{ path: "a", size: 0.5, sha256: hash(""), executable: false }],
  ],
] as const)("rejects inventory %s", async (_name, files) => {
  const f = await fixture();
  f.input.files = files.map((file) => ({ ...file }));
  await expect(f.run()).rejects.toMatchObject({ code: "INTEGRITY_FAILED" });
});
it.each([".claude", ".codex", ".agents"])(
  "keeps store outside %s discovery roots",
  async (name) => {
    const f = await fixture();
    const parent = join(f.root, name);
    await fs.mkdir(parent);
    f.input.storeDirectory = join(parent, "store");
    await expect(f.run()).rejects.toMatchObject({ code: "PATH_UNSAFE" });
  },
);
it.each(["source", "source-parent", "store", "store-parent"])(
  "rejects symlink %s",
  async (kind) => {
    const f = await fixture();
    const link = join(f.root, "link");
    if (kind === "source") {
      await fs.symlink(f.input.sourceDirectory, link);
      f.input.sourceDirectory = link;
    }
    if (kind === "source-parent") {
      await fs.symlink(f.root, link);
      f.input.sourceDirectory = join(link, "package");
    }
    if (kind === "store") {
      await f.run();
      await fs.symlink(f.input.storeDirectory, link);
      f.input.storeDirectory = link;
    }
    if (kind === "store-parent") {
      await fs.symlink(f.root, link);
      f.input.storeDirectory = join(link, "new");
    }
    await expect(f.run()).rejects.toMatchObject({ code: "PATH_UNSAFE" });
  },
);
it.each([
  "relative-source",
  "noncanonical-source",
  "relative-store",
  "noncanonical-store",
  "same",
  "store-in-source",
  "source-in-store",
])("rejects boundary %s", async (kind) => {
  const f = await fixture();
  if (kind === "relative-source") f.input.sourceDirectory = "relative";
  if (kind === "noncanonical-source") f.input.sourceDirectory += "/../package";
  if (kind === "relative-store") f.input.storeDirectory = "relative";
  if (kind === "noncanonical-store")
    f.input.storeDirectory += "/../private-store";
  if (kind === "same") f.input.storeDirectory = f.input.sourceDirectory;
  if (kind === "store-in-source")
    f.input.storeDirectory = join(f.input.sourceDirectory, "nested");
  if (kind === "source-in-store") f.input.storeDirectory = f.root;
  await expect(f.run()).rejects.toMatchObject({ code: "PATH_UNSAFE" });
});
it.each([
  "extra",
  "missing",
  "hash",
  "size",
  "file-symlink",
  "directory-symlink",
  "empty-directory",
  "entries",
  "directory-depth",
  "oversized-source",
])("rejects source %s and cleans owned staging", async (kind) => {
  const f = await fixture();
  if (kind === "extra")
    await fs.writeFile(join(f.input.sourceDirectory, "extra"), "unlisted");
  if (kind === "missing") await fs.rm(join(f.input.sourceDirectory, "LICENSE"));
  if (kind === "hash")
    await fs.writeFile(
      join(f.input.sourceDirectory, "LICENSE"),
      "Fixture licensE",
    );
  if (kind === "size")
    await fs.writeFile(join(f.input.sourceDirectory, "LICENSE"), "small");
  if (kind === "file-symlink") {
    await fs.rm(join(f.input.sourceDirectory, "LICENSE"));
    await fs.symlink(
      join(f.root, "outside"),
      join(f.input.sourceDirectory, "LICENSE"),
    );
  }
  if (kind === "directory-symlink") {
    await fs.rm(join(f.input.sourceDirectory, "scripts"), { recursive: true });
    await fs.symlink(f.root, join(f.input.sourceDirectory, "scripts"));
  }
  if (kind === "empty-directory")
    await fs.mkdir(join(f.input.sourceDirectory, "empty"));
  if (kind === "entries") f.input.limits.maxEntries = 1;
  if (kind === "directory-depth") {
    await fs.mkdir(join(f.input.sourceDirectory, "extra/a/b/c/d/e/f/g/h"), {
      recursive: true,
    });
    await fs.writeFile(
      join(f.input.sourceDirectory, "extra/a/b/c/d/e/f/g/h/x"),
      "x",
    );
  }
  if (kind === "oversized-source") {
    f.input.limits.maxFileBytes = 1000;
    await fs.writeFile(
      join(f.input.sourceDirectory, "LICENSE"),
      Buffer.alloc(1001),
    );
  }
  await expect(f.run()).rejects.toBeDefined();
  expect(await fs.readdir(join(f.input.storeDirectory, "versions"))).toEqual(
    [],
  );
  expect((await fs.readdir(f.input.storeDirectory)).sort()).toEqual([
    "data",
    "owner.json",
    "versions",
  ]);
});
it.each([
  "owner",
  "owner-symlink",
  "owner-mode",
  "owner-large",
  "root-mode",
  "versions-mode",
  "data-mode",
  "missing-entry",
  "foreign-entry",
  "payload-drift",
  "payload-mode",
  "payload-directory-mode",
  "snapshot",
  "version-extra",
  "version-missing",
])("refuses owned store drift %s without rewrite", async (kind) => {
  const f = await fixture();
  const first = await f.run();
  const store = f.input.storeDirectory;
  const version = join(first.directory, "..");
  if (kind === "owner")
    await fs.writeFile(join(store, "owner.json"), "{}", { mode: 0o600 });
  if (kind === "owner-symlink") {
    await fs.rm(join(store, "owner.json"));
    await fs.symlink(join(f.root, "outside"), join(store, "owner.json"));
  }
  if (kind === "owner-mode") await fs.chmod(join(store, "owner.json"), 0o644);
  if (kind === "owner-large")
    await fs.writeFile(join(store, "owner.json"), Buffer.alloc(1025));
  if (kind === "root-mode") await fs.chmod(store, 0o755);
  if (kind === "versions-mode") await fs.chmod(join(store, "versions"), 0o755);
  if (kind === "data-mode") await fs.chmod(join(store, "data"), 0o755);
  if (kind === "missing-entry")
    await fs.rm(join(store, "data"), { recursive: true });
  if (kind === "foreign-entry")
    await fs.writeFile(join(store, "foreign"), "keep");
  if (kind === "payload-drift")
    await fs.writeFile(join(first.directory, "LICENSE"), "modified");
  if (kind === "payload-mode")
    await fs.chmod(join(first.directory, "LICENSE"), 0o644);
  if (kind === "payload-directory-mode")
    await fs.chmod(join(first.directory, "scripts"), 0o755);
  if (kind === "snapshot") {
    const path = join(version, "snapshot.json");
    const value = await fs.readFile(path, "utf8");
    await fs.writeFile(path, value.replace("fixture-owner", "fixture-owneX"));
  }
  if (kind === "version-extra")
    await fs.writeFile(join(version, "foreign"), "keep");
  if (kind === "version-missing") await fs.rm(join(version, "snapshot.json"));
  await expect(f.run()).rejects.toBeDefined();
  expect(await fs.readdir(join(store, "versions"))).toEqual([first.digest]);
});
it("rolls back only its staging on publish failure, preserving older bundle and runtime", async () => {
  const f = await fixture();
  const first = await f.run();
  await fs.writeFile(join(f.input.storeDirectory, "data", "runtime"), "keep");
  f.input.commitSha = "b".repeat(40);
  vi.spyOn(fs, "rename").mockRejectedValueOnce(new Error("publish failure"));
  await expect(f.run()).rejects.toThrow("publish failure");
  expect(await fs.readFile(join(first.directory, "LICENSE"), "utf8")).toBe(
    "Fixture license",
  );
  expect(
    await fs.readFile(join(f.input.storeDirectory, "data", "runtime"), "utf8"),
  ).toBe("keep");
  expect((await fs.readdir(f.input.storeDirectory)).sort()).toEqual([
    "data",
    "owner.json",
    "versions",
  ]);
});

it("rejects changed executable intent instead of silently losing permission metadata", async () => {
  const f = await fixture();
  await fs.chmod(join(f.input.sourceDirectory, "scripts/run.sh"), 0o644);
  await expect(f.run()).rejects.toMatchObject({ code: "INTEGRITY_FAILED" });
});
it("refuses non-regular source entries before opening them", async () => {
  const f = await fixture();
  const original = fs.lstat;
  const path = join(f.input.sourceDirectory, "LICENSE");
  vi.spyOn(fs, "lstat").mockImplementation(
    async (...args: Parameters<typeof fs.lstat>) => {
      const state = await original(...args);
      if (String(args[0]) === path)
        return Object.assign(state, { isFile: () => false });
      return state;
    },
  );
  await expect(f.run()).rejects.toMatchObject({ code: "PATH_UNSAFE" });
});
it("rejects file replacement between lstat and no-follow open", async () => {
  const f = await fixture();
  const original = fs.open;
  const path = join(f.input.sourceDirectory, "LICENSE");
  vi.spyOn(fs, "open").mockImplementation(async (target, flags, mode) => {
    if (String(target) === path && typeof flags === "number") {
      await fs.rename(path, path + ".old");
      await fs.writeFile(path, "Fixture license");
    }
    return original(target, flags, mode);
  });
  await expect(f.run()).rejects.toMatchObject({ code: "PATH_UNSAFE" });
});
it.each(["truncate", "read-failure", "fragmented"])(
  "handles %s during bounded descriptor reads",
  async (kind) => {
    const f = await fixture();
    const original = fs.open;
    const path = join(f.input.sourceDirectory, "LICENSE");
    vi.spyOn(fs, "open").mockImplementation(async (target, flags, mode) => {
      const handle = await original(target, flags, mode);
      if (String(target) === path && typeof flags === "number") {
        const originalRead = handle.read.bind(handle);
        let once = false;
        handle.read = vi.fn(
          async (
            buffer: Buffer,
            offset: number,
            length: number,
            position: number | null,
          ) => {
            if (!once) {
              once = true;
              if (kind === "truncate") await fs.truncate(path, 1);
              if (kind === "read-failure") throw new Error("read denied");
            }
            return originalRead(
              buffer,
              offset,
              kind === "fragmented" ? Math.min(2, length) : length,
              position,
            );
          },
        ) as unknown as typeof handle.read;
      }
      return handle;
    });
    if (kind === "fragmented") expect((await f.run()).created).toBe(true);
    else {
      await expect(f.run()).rejects.toBeDefined();
      expect(
        await fs.readdir(join(f.input.storeDirectory, "versions")),
      ).toEqual([]);
    }
  },
);
it("does not adopt an inaccessible store after an initialization failure", async () => {
  const f = await fixture();
  vi.spyOn(fs, "mkdir").mockRejectedValueOnce(
    Object.assign(new Error("denied"), { code: "EACCES" }),
  );
  await expect(f.run()).rejects.toThrow("denied");
});
it("does not replace a version when existence cannot be checked", async () => {
  const f = await fixture();
  const first = await f.run();
  const original = fs.lstat;
  const path = join(first.directory, "..");
  let checks = 0;
  vi.spyOn(fs, "lstat").mockImplementation(
    (...args: Parameters<typeof fs.lstat>) =>
      String(args[0]) === path && ++checks === 3
        ? Promise.reject(
            Object.assign(new Error("stat denied"), { code: "EACCES" }),
          )
        : original(...args),
  );
  await expect(f.run()).rejects.toThrow("stat denied");
  expect(await fs.readFile(join(first.directory, "LICENSE"), "utf8")).toBe(
    "Fixture license",
  );
});
it("cleans owned staging when writing a staged payload fails", async () => {
  const f = await fixture();
  const original = fs.open;
  vi.spyOn(fs, "open").mockImplementation(async (target, flags, mode) => {
    if (
      String(target).includes("/.stage-") &&
      String(target).endsWith("/LICENSE")
    )
      throw new Error("write denied");
    return original(target, flags, mode);
  });
  await expect(f.run()).rejects.toThrow("write denied");
  expect((await fs.readdir(f.input.storeDirectory)).sort()).toEqual([
    "data",
    "owner.json",
    "versions",
  ]);
});
it("rejects case-colliding directory prefixes on every filesystem", async () => {
  const f = await fixture();
  f.input.files = [
    { path: "A/x", size: 0, sha256: hash(""), executable: false },
    { path: "a/y", size: 0, sha256: hash(""), executable: false },
  ];
  await expect(f.run()).rejects.toMatchObject({ code: "INTEGRITY_FAILED" });
});
it("detects executable drift in an inert stored file", async () => {
  const f = await fixture();
  const first = await f.run();
  await fs.chmod(join(first.directory, "scripts/run.sh"), 0o700);
  await expect(f.run()).rejects.toMatchObject({ code: "PATH_UNSAFE" });
});
it.each(["source", "stored", "owner"])(
  "rejects hardlinked %s files without following shared ownership",
  async (kind) => {
    const f = await fixture();
    let path = join(f.input.sourceDirectory, "LICENSE");
    if (kind !== "source") {
      const first = await f.run();
      path =
        kind === "stored"
          ? join(first.directory, "LICENSE")
          : join(f.input.storeDirectory, "owner.json");
    }
    await fs.link(path, join(f.root, "hardlink"));
    await expect(f.run()).rejects.toMatchObject({ code: "PATH_UNSAFE" });
  },
);
it("accepts full SHA-256 Git provenance without truncating it", async () => {
  const f = await fixture();
  f.input.commitSha = "c".repeat(64);
  const result = await f.run();
  expect(
    JSON.parse(
      await fs.readFile(join(result.directory, "../snapshot.json"), "utf8"),
    ) as { commitSha: string },
  ).toMatchObject({ commitSha: "c".repeat(64) });
});
it.each(["foreign-name", "symbolic-version", "enumeration-bound"])(
  "rejects store version %s",
  async (kind) => {
    const f = await fixture();
    await f.run();
    const versions = join(f.input.storeDirectory, "versions");
    if (kind === "foreign-name")
      await fs.mkdir(join(versions, "foreign"), { mode: 0o700 });
    if (kind === "symbolic-version")
      await fs.symlink(f.root, join(versions, "f".repeat(64)));
    if (kind === "enumeration-bound") {
      f.input.limits.maxEntries = 1;
      await fs.mkdir(join(versions, "f".repeat(64)), { mode: 0o700 });
    }
    await expect(f.run()).rejects.toMatchObject({ code: "PATH_UNSAFE" });
  },
);
it("treats new commit provenance as a new descriptor without asking for per-version approval", async () => {
  const f = await fixture();
  const first = await f.run();
  f.input.commitSha = "b".repeat(40);
  const second = await f.run();
  expect(second.created).toBe(true);
  expect(second.digest).not.toBe(first.digest);
  expect(await fs.readFile(join(second.directory, "LICENSE"))).toEqual(
    await fs.readFile(join(first.directory, "LICENSE")),
  );
  f.input.files.reverse();
  expect(await f.run()).toEqual({ ...second, created: false });
});
