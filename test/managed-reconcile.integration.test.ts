import * as fs from "node:fs/promises";
import * as process from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  canonicalBundleDigest,
  reconcileManagedBundle,
  recoverManagedBundle,
  type ManagedBundleInput,
} from "../src/marketplace/reconcile.js";
import { hash, temporaryDirectory } from "./helpers.js";
import {
  managedAncestry,
  readManagedFile,
  readManagedPointer,
  publishManagedPointer,
  withManagedState,
  type ManagedPointer,
} from "../src/marketplace/managed-state.js";

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
async function fixture() {
  const temp = await temporaryDirectory();
  cleanups.push(temp.cleanup);
  const root = await fs.realpath(temp.path);
  const bodies = {
    ".claude-plugin/plugin.json": Buffer.from(
      '{"name":"fixture","hooks":{"SessionStart":[{"command":"touch TRAP"}]},"mcpServers":{"trap":{"command":"touch","args":["TRAP"]}}}',
    ),
    "skills/demo/SKILL.md": Buffer.from(
      "Read ../../data/table.csv and ../../scripts/run.sh",
    ),
    "scripts/run.sh": Buffer.from("#!/bin/sh\ntouch TRAP"),
    "data/table.csv": Buffer.from("key,value\na,b\n"),
    "references/binary.bin": Buffer.from([0, 255, 42]),
    LICENSE: Buffer.from("Fixture license"),
  };
  const files = Object.entries(bodies).map(([path, content]) => ({
    path,
    content,
    size: content.length,
    sha256: hash(content),
    executable: path.endsWith(".sh"),
    mode: path.endsWith(".sh") ? ("100755" as const) : ("100644" as const),
    blobOid: createHash("sha1")
      .update(`blob ${content.length}\0`)
      .update(content)
      .digest("hex"),
  }));
  const limits = {
    maxFiles: 20,
    maxFileBytes: 2_000_000,
    maxTotalBytes: 4_000_000,
    maxDepth: 10,
    maxEntries: 60,
    maxStateBytes: 100_000,
  };
  const input: ManagedBundleInput = {
    apply: true,
    declaredTarget: {
      id: "11111111-1111-4111-8111-111111111111",
      harness: "claude",
      scope: "user",
      bindingId: null,
    },
    stateDirectory: join(root, "managed"),
    ownerId: "stable-tenant-selection",
    commitSha: "a".repeat(40),
    packageRoot: "plugins/demo",
    files,
    packageSha256: canonicalBundleDigest(files, limits),
    limits,
  };
  return { root, input, bodies };
}
describe("managed full bundle reconciliation", () => {
  it("prepares a typed Claude session-only launch parameter after verified apply without starting a host", async () => {
    const f = await fixture();
    const forbidden = vi.fn(() => {
      throw new Error("no native execution");
    });
    vi.spyOn(process, "spawn").mockImplementation(forbidden);
    vi.spyOn(process, "execFile").mockImplementation(forbidden);
    const harnessProbe = {
      harness: "claude" as const,
      version: "2.1.226 (Claude Code)",
      pluginHelp: "",
      marketplaceHelp: "",
      rootHelp:
        "Usage: claude [options]\n --plugin-dir <paths...> Load plugins",
    };
    const applied = await reconcileManagedBundle({ ...f.input, harnessProbe });
    expect(applied.native.status).toBe("launch-parameter");
    if (applied.native.status !== "launch-parameter")
      throw new Error("Expected launch plan");
    expect(applied.native.argv).toEqual([
      "claude",
      "--plugin-dir",
      applied.directory,
    ]);
    expect(applied.execution).toBe("unknown");
    expect(forbidden).not.toHaveBeenCalled();
    expect(
      (await reconcileManagedBundle({ ...f.input, apply: false, harnessProbe }))
        .native.status,
    ).toBe("unsupported");
    expect(
      (
        await reconcileManagedBundle({
          ...f.input,
          harnessProbe: { ...harnessProbe, rootHelp: "--plugin-dir-unsafe" },
        })
      ).native.status,
    ).toBe("unsupported");
    const file = f.input.files.find(
      (file) => file.path === ".claude-plugin/plugin.json",
    )!;
    const portable = {
      ...f.input,
      ownerId: "portable-owner",
      stateDirectory: join(f.root, "portable"),
      harnessProbe,
      files: f.input.files.map((entry) =>
        entry === file ? { ...entry, path: "plugin.json" } : entry,
      ),
    };
    portable.packageSha256 = canonicalBundleDigest(
      portable.files,
      portable.limits,
    );
    expect((await reconcileManagedBundle(portable)).native.status).toBe(
      "unsupported",
    );
  });
  it("plans without touching the filesystem and matches the approved cross-language inventory vector", async () => {
    const f = await fixture();
    expect(() =>
      canonicalBundleDigest(
        [
          { ...f.input.files[0]!, path: "straße/a" },
          { ...f.input.files[1]!, path: "STRASSE/b" },
        ],
        f.input.limits,
      ),
    ).toThrow();
    expect(
      canonicalBundleDigest(
        [
          {
            path: "scripts/run.sh",
            size: 3,
            sha256: "22".repeat(32),
            executable: true,
          },
          {
            path: "data/é.csv",
            size: 2,
            sha256: "11".repeat(32),
            executable: false,
          },
        ],
        f.input.limits,
      ),
    ).toBe("62716a1f499e02a46002509cb8d6dbc6a875d19f6f2e67f876490644c6f56651");
    expect(
      (await reconcileManagedBundle({ ...f.input, apply: false })).status,
    ).toBe("planned");
    await expect(fs.lstat(f.input.stateDirectory)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
  it("applies all bytes privately and idempotently, updates automatically and preserves runtime data and prior versions without execution", async () => {
    const f = await fixture();
    const forbidden = vi.fn(() => {
      throw new Error("forbidden");
    });
    vi.stubGlobal("fetch", forbidden);
    vi.spyOn(process, "execFile").mockImplementation(forbidden);
    vi.spyOn(process, "spawn").mockImplementation(forbidden);
    const first = await reconcileManagedBundle(f.input);
    expect(first.status).toBe("applied");
    expect(first.execution).toBe("unknown");
    expect(first.native.status).toBe("unsupported");
    for (const [path, body] of Object.entries(f.bodies)) {
      expect(await fs.readFile(join(first.directory!, path))).toEqual(body);
      expect((await fs.stat(join(first.directory!, path))).mode & 0o777).toBe(
        0o600,
      );
    }
    expect((await reconcileManagedBundle(f.input)).status).toBe("unchanged");
    const runtime = join(
      f.input.stateDirectory,
      "bundles",
      "data",
      "user-data",
    );
    await fs.writeFile(runtime, "preserve");
    const updated = await reconcileManagedBundle({
      ...f.input,
      commitSha: "b".repeat(40),
    });
    expect(updated.status).toBe("applied");
    expect(updated.digest).not.toBe(first.digest);
    expect(await fs.readFile(runtime, "utf8")).toBe("preserve");
    expect(await fs.readFile(join(first.directory!, "LICENSE"), "utf8")).toBe(
      "Fixture license",
    );
    const recovered = await recoverManagedBundle({ ...f.input, apply: true });
    expect(recovered.digest).toBe(first.digest);
    expect(recovered.status).toBe("applied");
    expect(forbidden).not.toHaveBeenCalled();
  });
  it("retains the current pointer when publication fails and recovers only a verified owned prior version", async () => {
    const f = await fixture();
    const first = await reconcileManagedBundle(f.input);
    const current = await fs.readFile(
      join(f.input.stateDirectory, "current.json"),
    );
    const rename = fs.rename;
    vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
      if (String(to).endsWith("current.json"))
        throw new Error("synthetic failure");
      return rename(from, to);
    });
    await expect(
      reconcileManagedBundle({ ...f.input, commitSha: "b".repeat(40) }),
    ).rejects.toThrow();
    expect(
      await fs.readFile(join(f.input.stateDirectory, "current.json")),
    ).toEqual(current);
    vi.restoreAllMocks();
    await reconcileManagedBundle({ ...f.input, commitSha: "b".repeat(40) });
    await fs.writeFile(
      join(
        f.input.stateDirectory,
        "bundles",
        "versions",
        first.digest,
        "payload",
        "LICENSE",
      ),
      "drift",
    );
    await expect(
      recoverManagedBundle({ ...f.input, apply: true }),
    ).rejects.toMatchObject({ code: "INTEGRITY_FAILED" });
  });
  it("rejects corrupt provenance, canonical digests, paths and runtime budgets before enrollment", async () => {
    const f = await fixture();
    const first = f.input.files[0]!;
    for (const change of [
      {
        limits: Object.fromEntries(
          Object.entries(f.input.limits).filter(
            ([key]) => key !== "maxStateBytes",
          ),
        ),
      },
      { packageSha256: "0".repeat(64) },
      { commitSha: "main" },
      { packageRoot: "../outside" },
      { ownerId: "../foreign" },
      { files: [{ ...first, blobOid: "0".repeat(40) }] },
      { files: [{ ...first, mode: "100755" }] },
      { files: [{ ...first, path: ".git/config" }] },
      { files: [{ ...first, path: "C:bad" }] },
      { files: [{ ...first, path: "   " }] },
      { limits: { ...f.input.limits, maxStateBytes: 0 } },
    ]) {
      await expect(
        reconcileManagedBundle({ ...f.input, ...change } as ManagedBundleInput),
      ).rejects.toThrow();
    }
    await expect(fs.lstat(f.input.stateDirectory)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
  it("requires an explicit valid declared target and isolates ownership without modifying foreign files", async () => {
    const f = await fixture();
    const discovery = join(f.root, ".claude");
    await expect(
      reconcileManagedBundle({ ...f.input, stateDirectory: discovery }),
    ).rejects.toMatchObject({ code: "PATH_UNSAFE" });
    await expect(fs.lstat(discovery)).rejects.toMatchObject({ code: "ENOENT" });
    for (const target of [
      { ...f.input.declaredTarget, id: "bad" },
      { ...f.input.declaredTarget, harness: "other" },
      { ...f.input.declaredTarget, scope: "workspace", bindingId: null },
      {
        ...f.input.declaredTarget,
        bindingId: "22222222-2222-4222-8222-222222222222",
      },
    ])
      await expect(
        reconcileManagedBundle({
          ...f.input,
          declaredTarget: target,
        } as ManagedBundleInput),
      ).rejects.toThrow();
    await fs.mkdir(f.input.stateDirectory, { mode: 0o700 });
    await fs.writeFile(join(f.input.stateDirectory, "foreign"), "keep");
    await expect(reconcileManagedBundle(f.input)).rejects.toMatchObject({
      code: "PATH_UNSAFE",
    });
    expect(
      await fs.readFile(join(f.input.stateDirectory, "foreign"), "utf8"),
    ).toBe("keep");
  });
  it("accepts a workspace target and refuses changed ownership, symlink ancestry, unsafe modes and tampered pointers", async () => {
    const f = await fixture();
    f.input.declaredTarget = {
      ...f.input.declaredTarget,
      harness: "codex",
      scope: "workspace",
      bindingId: "22222222-2222-4222-8222-222222222222",
    };
    await reconcileManagedBundle(f.input);
    await expect(
      reconcileManagedBundle({ ...f.input, ownerId: "other-owner" }),
    ).rejects.toMatchObject({ code: "PATH_UNSAFE" });
    await fs.writeFile(join(f.input.stateDirectory, "current.json"), "invalid");
    await expect(reconcileManagedBundle(f.input)).rejects.toThrow();
    await fs.chmod(f.input.stateDirectory, 0o755);
    await expect(reconcileManagedBundle(f.input)).rejects.toMatchObject({
      code: "PATH_UNSAFE",
    });
    await fs.symlink(f.input.stateDirectory, join(f.root, "alias"));
    await expect(
      reconcileManagedBundle({
        ...f.input,
        stateDirectory: join(f.root, "alias", "child"),
      }),
    ).rejects.toMatchObject({ code: "PATH_UNSAFE" });
  });
  it("refuses symlinked or linked private state, refuses a lock owned by another writer and never removes it", async () => {
    const f = await fixture();
    await reconcileManagedBundle(f.input);
    const owner = join(f.input.stateDirectory, "owner.json");
    await fs.link(owner, join(f.root, "linked"));
    await expect(reconcileManagedBundle(f.input)).rejects.toMatchObject({
      code: "PATH_UNSAFE",
    });
    await fs.unlink(join(f.root, "linked"));
    const current = join(f.input.stateDirectory, "current.json");
    await fs.rename(current, join(f.root, "saved"));
    await fs.symlink(join(f.root, "saved"), current);
    await expect(reconcileManagedBundle(f.input)).rejects.toMatchObject({
      code: "PATH_UNSAFE",
    });
    await fs.unlink(current);
    await fs.rename(join(f.root, "saved"), current);
    const previous = join(f.input.stateDirectory, "previous.json");
    await fs.symlink(current, previous);
    await expect(
      reconcileManagedBundle({ ...f.input, commitSha: "b".repeat(40) }),
    ).rejects.toMatchObject({ code: "PATH_UNSAFE" });
    expect((await fs.lstat(previous)).isSymbolicLink()).toBe(true);
    await fs.unlink(previous);
    await fs.writeFile(
      join(f.input.stateDirectory, ".reconcile-lock"),
      "foreign",
    );
    await expect(reconcileManagedBundle(f.input)).rejects.toMatchObject({
      code: "SYNC_CONFLICT",
    });
    expect(
      await fs.readFile(
        join(f.input.stateDirectory, ".reconcile-lock"),
        "utf8",
      ),
    ).toBe("foreign");
  });
  it("validates SHA256 Git objects and root packages without relying on a working tree", async () => {
    const f = await fixture();
    f.input.commitSha = "c".repeat(64);
    f.input.packageRoot = ".";
    f.input.files = f.input.files.map((file) => ({
      ...file,
      blobOid: createHash("sha256")
        .update(`blob ${file.content.byteLength}\0`)
        .update(file.content)
        .digest("hex"),
    }));
    expect((await reconcileManagedBundle(f.input)).status).toBe("applied");
    await expect(
      recoverManagedBundle({ ...f.input, apply: false }),
    ).rejects.toMatchObject({ code: "SYNC_CONFLICT" });
    await expect(recoverManagedBundle(f.input)).rejects.toMatchObject({
      code: "INTEGRITY_FAILED",
    });
    for (const change of [
      { limits: { ...f.input.limits, maxStateBytes: 1000 } },
      { limits: { ...f.input.limits, maxStateBytes: undefined } },
      { files: [{ ...f.input.files[0]!, content: Buffer.alloc(0) }] },
    ])
      await expect(
        reconcileManagedBundle({
          ...f.input,
          ...change,
        } as unknown as ManagedBundleInput),
      ).rejects.toThrow();
  });
  it("bounds private metadata reads and rejects substituted files or bytes changed during a read", async () => {
    const f = await fixture();
    await reconcileManagedBundle(f.input);
    const owner = join(f.input.stateDirectory, "owner.json");
    await expect(readManagedFile(owner, 1)).rejects.toMatchObject({
      code: "INTEGRITY_FAILED",
    });
    await expect(readManagedFile(owner, 0)).rejects.toMatchObject({
      code: "INTEGRITY_FAILED",
    });
    const originalOpen = fs.open;
    vi.spyOn(fs, "open").mockImplementation(async (path, flags, mode) => {
      if (path === owner) {
        await fs.rename(owner, join(f.root, "old-owner"));
        await fs.writeFile(owner, "replacement", { mode: 0o600 });
      }
      return originalOpen(path, flags, mode);
    });
    await expect(readManagedFile(owner, 10000)).rejects.toMatchObject({
      code: "PATH_UNSAFE",
    });
    vi.restoreAllMocks();
    const handle = await originalOpen(owner, "r");
    const originalRead = handle.read.bind(handle);
    vi.spyOn(handle, "read").mockImplementation(
      async (...args: Parameters<typeof originalRead>) => {
        const read = await originalRead(...args);
        await fs.appendFile(owner, "changed");
        return read;
      },
    );
    vi.spyOn(fs, "open").mockResolvedValue(handle);
    await expect(readManagedFile(owner, 10000)).rejects.toMatchObject({
      code: "INTEGRITY_FAILED",
    });
  });
  it("rejects invalid pointer schemas, ownership and digest aliases rather than repairing foreign state", async () => {
    const f = await fixture();
    const applied = await reconcileManagedBundle(f.input);
    const path = join(f.input.stateDirectory, "current.json");
    const saved = await fs.readFile(path, "utf8");
    const state = {
      directory: f.input.stateDirectory,
      ownerId: f.input.ownerId,
      target: f.input.declaredTarget,
      limits: f.input.limits,
    };
    await fs.writeFile(path, "{}");
    await expect(readManagedPointer(state, "current")).rejects.toMatchObject({
      code: "INTEGRITY_FAILED",
    });
    const pointer = JSON.parse(saved) as ManagedPointer;
    await fs.writeFile(path, Buffer.from([255, 123, 125]));
    await expect(readManagedPointer(state, "current")).rejects.toMatchObject({
      code: "INTEGRITY_FAILED",
    });
    await fs.writeFile(
      path,
      JSON.stringify({ ...pointer, ownerId: "foreign" }),
    );
    await expect(readManagedPointer(state, "current")).rejects.toMatchObject({
      code: "PATH_UNSAFE",
    });
    await fs.writeFile(
      path,
      JSON.stringify({
        ...pointer,
        target: { ...pointer.target, harness: "codex" },
      }),
    );
    await expect(readManagedPointer(state, "current")).rejects.toMatchObject({
      code: "PATH_UNSAFE",
    });
    const alias = "f".repeat(64);
    await fs.cp(
      join(f.input.stateDirectory, "bundles", "versions", applied.digest),
      join(f.input.stateDirectory, "bundles", "versions", alias),
      { recursive: true, preserveTimestamps: true },
    );
    await fs.writeFile(path, JSON.stringify({ ...pointer, digest: alias }));
    await expect(reconcileManagedBundle(f.input)).rejects.toMatchObject({
      code: "INTEGRITY_FAILED",
    });
    await expect(
      publishManagedPointer(
        { ...state, limits: { ...state.limits, maxStateBytes: 1 } },
        pointer,
      ),
    ).rejects.toMatchObject({ code: "INTEGRITY_FAILED" });
  });
  it("fails safely on filesystem errors, concurrent lock creation and lock replacement", async () => {
    const f = await fixture();
    const mkdir = fs.mkdir;
    vi.spyOn(fs, "mkdir").mockRejectedValueOnce(
      Object.assign(new Error("private path must not escape"), {
        code: "EACCES",
      }),
    );
    await expect(reconcileManagedBundle(f.input)).rejects.toThrow(
      "Managed reconciliation failed",
    );
    vi.restoreAllMocks();
    await mkdir(f.input.stateDirectory, { mode: 0o700 });
    await fs.rmdir(f.input.stateDirectory);
    await reconcileManagedBundle(f.input);
    const state = {
      directory: f.input.stateDirectory,
      ownerId: f.input.ownerId,
      target: f.input.declaredTarget,
      limits: f.input.limits,
    };
    const lock = join(state.directory, ".reconcile-lock");
    const open = fs.open;
    vi.spyOn(fs, "open").mockImplementation(async (path, flags, mode) => {
      if (path === lock)
        await fs.writeFile(lock, "competing writer", { mode: 0o600 });
      return open(path, flags, mode);
    });
    await expect(
      withManagedState(state, async () => true),
    ).rejects.toMatchObject({ code: "SYNC_CONFLICT" });
    vi.restoreAllMocks();
    await fs.unlink(lock);
    vi.spyOn(fs, "open").mockImplementation(async (path, flags, mode) => {
      if (path === lock)
        throw Object.assign(new Error("private"), { code: "EACCES" });
      return open(path, flags, mode);
    });
    await expect(
      withManagedState(state, async () => true),
    ).rejects.toMatchObject({ code: "EACCES" });
    vi.restoreAllMocks();
    await expect(
      withManagedState(state, async () => {
        await fs.rename(lock, join(f.root, "old-lock"));
        await fs.writeFile(lock, "replacement", { mode: 0o600 });
      }),
    ).rejects.toMatchObject({ code: "PATH_UNSAFE" });
    expect(await fs.readFile(lock, "utf8")).toBe("replacement");
    for (const path of [
      "relative/path",
      join(f.root, ".claude", "plugins"),
      `${f.root}/../escape`,
    ])
      await expect(managedAncestry(path)).rejects.toMatchObject({
        code: "PATH_UNSAFE",
      });
  });
});
