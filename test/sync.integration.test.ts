import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FilesystemAgentAdapter } from "../src/agents/filesystem-agent-adapter.js";
import type {
  AgentAdapter,
  AgentKind,
  DestinationScope,
  OwnershipEntry,
  SyncChange,
} from "../src/domain.js";
import { SyncApplier } from "../src/sync/applier.js";
import { assertCompatibleDeliveryTargets } from "../src/sync/delivery-targets.js";
import { sha256 } from "../src/sync/hash.js";
import { SyncPlanner } from "../src/sync/planner.js";
import { SyncPreparer } from "../src/sync/preparer.js";
import {
  api,
  bytes,
  hash,
  manifest,
  prepared,
  temporaryDirectory,
} from "./helpers.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

function entry(
  content: string,
  overrides: Partial<OwnershipEntry> = {},
): OwnershipEntry {
  return {
    relativePath: "skills/team/SKILL.md",
    logicalId: "artifact-1",
    artifactVersionId: "version-0",
    sha256: hash(content),
    releaseId: "release-0",
    ...overrides,
  };
}

describe("download preparation", () => {
  it("downloads and validates every artifact before planning", async () => {
    const client = api();
    await expect(
      new SyncPreparer().prepare(manifest(), "token", client),
    ).resolves.toEqual(prepared());
  });

  it("rejects size and hash mismatches", async () => {
    const client = api("wrong");
    await expect(
      new SyncPreparer().prepare(manifest(), "token", client),
    ).rejects.toMatchObject({
      code: "INTEGRITY_FAILED",
    });
    const sameSizeWrongHash = api("# Wrong skill\n");
    const expected = manifest("# Other skill\n");
    await expect(
      new SyncPreparer().prepare(expected, "token", sameSizeWrongHash),
    ).rejects.toMatchObject({
      code: "INTEGRITY_FAILED",
    });
  });
});

describe("filesystem safety and ownership ledger", () => {
  it("propagates unexpected filesystem errors while resolving file modes", async () => {
    const temp = await temporaryDirectory();
    cleanups.push(temp.cleanup);
    const adapter = new FilesystemAgentAdapter(
      "codex-test",
      "codex",
      join(temp.path, "agent"),
      join(temp.path, ".hivemnd/codex-test/ownership.json"),
      join(temp.path, ".hivemnd"),
    );
    const internals = adapter as unknown as {
      existingMode(path: string): Promise<number>;
    };

    await expect(
      internals.existingMode(`/${"x".repeat(5_000)}`),
    ).rejects.toMatchObject({
      code: "ENAMETOOLONG",
    });
  });

  it("writes binary content atomically and persists a validated v2 ledger", async () => {
    const temp = await temporaryDirectory();
    cleanups.push(temp.cleanup);
    const adapter = new FilesystemAgentAdapter(
      "codex-test",
      "codex",
      join(temp.path, "target"),
      join(temp.path, ".hivemnd/codex-test/ownership.json"),
      join(temp.path, ".hivemnd"),
    );
    await adapter.write("skills/team/SKILL.md", bytes("content"));
    const other = entry("other", {
      relativePath: "documents/other.md",
      logicalId: "other",
      artifactVersionId: "other-version",
    });
    await adapter.replaceOwnership([other, entry("content")]);
    await expect(adapter.read("skills/team/SKILL.md")).resolves.toEqual(
      bytes("content"),
    );
    await expect(adapter.readOwnership()).resolves.toEqual([
      other,
      entry("content"),
    ]);
    await adapter.remove("skills/team/SKILL.md");
    await expect(adapter.read("skills/team/SKILL.md")).resolves.toBeUndefined();
  });

  it.each(["", "/absolute", "../escape", ".hivemnd/ownership.json"])(
    "rejects unsafe destination %j",
    async (path) => {
      const temp = await temporaryDirectory();
      cleanups.push(temp.cleanup);
      const adapter = new FilesystemAgentAdapter(
        "codex-test",
        "codex",
        join(temp.path, "root"),
        join(temp.path, ".hivemnd/codex-test/ownership.json"),
        join(temp.path, ".hivemnd"),
      );
      expect(() => adapter.destination(path)).toThrow();
    },
  );

  it("rejects a path resolving to the root and propagates non-missing read and write failures", async () => {
    const temp = await temporaryDirectory();
    cleanups.push(temp.cleanup);
    const root = join(temp.path, "root");
    const adapter = new FilesystemAgentAdapter(
      "codex-test",
      "codex",
      root,
      join(temp.path, ".hivemnd/codex-test/ownership.json"),
      join(temp.path, ".hivemnd"),
    );
    expect(() => adapter.destination(".")).toThrow("inside the target root");
    await mkdir(join(root, "directory"), { recursive: true });
    await expect(adapter.read("directory")).rejects.toThrow();
    await expect(
      adapter.write("directory", bytes("cannot replace directory")),
    ).rejects.toThrow();
  });

  it("rejects symlink traversal and corrupt or duplicate ledger entries", async () => {
    const temp = await temporaryDirectory();
    cleanups.push(temp.cleanup);
    const root = join(temp.path, "root");
    await mkdir(root, { recursive: true });
    await symlink(temp.path, join(root, "skills"));
    const adapter = new FilesystemAgentAdapter(
      "codex-test",
      "codex",
      root,
      join(temp.path, ".hivemnd/codex-test/ownership.json"),
      join(temp.path, ".hivemnd"),
    );
    await expect(adapter.read("skills/file.md")).rejects.toMatchObject({
      code: "PATH_UNSAFE",
    });

    const cleanRoot = join(temp.path, "clean");
    const ownershipPath = join(temp.path, ".hivemnd/clean/ownership.json");
    const clean = new FilesystemAgentAdapter(
      "clean",
      "codex",
      cleanRoot,
      ownershipPath,
      join(temp.path, ".hivemnd"),
    );
    await mkdir(join(temp.path, ".hivemnd/clean"), { recursive: true });
    await writeFile(ownershipPath, "{}", "utf8");
    await expect(clean.readOwnership()).rejects.toThrow();
    await expect(
      clean.replaceOwnership([entry("one"), entry("two")]),
    ).rejects.toThrow("Duplicate ownership");

    const unsafeState = join(temp.path, "unsafe-state");
    await symlink(temp.path, unsafeState);
    const unsafeOwnership = new FilesystemAgentAdapter(
      "unsafe",
      "codex",
      cleanRoot,
      join(unsafeState, "unsafe/ownership.json"),
      unsafeState,
    );
    await expect(
      unsafeOwnership.replaceOwnership([entry("content")]),
    ).rejects.toMatchObject({ code: "PATH_UNSAFE" });
  });
});

describe("ownership-aware planning", () => {
  async function setup(
    current?: string,
    ownership: readonly OwnershipEntry[] = [],
  ) {
    const temp = await temporaryDirectory();
    cleanups.push(temp.cleanup);
    const adapter = new FilesystemAgentAdapter(
      "codex-test",
      "codex",
      join(temp.path, "root"),
      join(temp.path, ".hivemnd/codex-test/ownership.json"),
      join(temp.path, ".hivemnd"),
    );
    if (current !== undefined)
      await adapter.write("skills/team/SKILL.md", bytes(current));
    if (ownership.length) await adapter.replaceOwnership(ownership);
    return adapter;
  }

  it("plans create, unchanged, update, and safe removal", async () => {
    const create = await setup();
    expect((await new SyncPlanner().plan(prepared(), [create]))[0]!.kind).toBe(
      "create",
    );

    const unchanged = await setup("# Team skill\n", [entry("# Team skill\n")]);
    expect(
      (await new SyncPlanner().plan(prepared(), [unchanged]))[0]!.kind,
    ).toBe("unchanged");

    const update = await setup("old", [entry("old")]);
    expect((await new SyncPlanner().plan(prepared(), [update]))[0]!.kind).toBe(
      "update",
    );

    const removal = await setup("old", [entry("old")]);
    const empty = { ...prepared(), artifacts: [] };
    expect((await new SyncPlanner().plan(empty, [removal]))[0]!.kind).toBe(
      "remove",
    );
  });

  it("plans adoption only for unmanaged content matching the authorized hash", async () => {
    const identical = await setup("# Team skill\n");
    expect(
      (
        await new SyncPlanner().plan(prepared(), [identical], {
          adoptExisting: true,
        })
      )[0],
    ).toMatchObject({ kind: "adopt" });

    const different = await setup("# Local version\n");
    expect(
      (
        await new SyncPlanner().plan(prepared(), [different], {
          adoptExisting: true,
        })
      )[0],
    ).toMatchObject({
      kind: "conflict",
      conflictReason: "unmanaged-existing-file",
    });
  });

  it.each([
    ["unmanaged-existing-file", "current", undefined],
    ["owned-file-missing", undefined, entry("old")],
    ["owned-content-drift", "changed", entry("old")],
    [
      "artifact-ownership-mismatch",
      "old",
      entry("old", { logicalId: "other" }),
    ],
  ] as const)("detects %s", async (reason, current, ownership) => {
    const adapter = await setup(current, ownership ? [ownership] : []);
    expect(
      (await new SyncPlanner().plan(prepared(), [adapter]))[0],
    ).toMatchObject({
      kind: "conflict",
      conflictReason: reason,
    });
  });

  it("treats a missing or modified removal as conflict", async () => {
    const missing = await setup(undefined, [entry("old")]);
    expect(
      (
        await new SyncPlanner().plan({ ...prepared(), artifacts: [] }, [
          missing,
        ])
      )[0],
    ).toMatchObject({
      conflictReason: "owned-file-missing",
    });
    const drift = await setup("changed", [entry("old")]);
    expect(
      (
        await new SyncPlanner().plan({ ...prepared(), artifacts: [] }, [drift])
      )[0],
    ).toMatchObject({
      conflictReason: "owned-content-drift",
    });
  });

  it("rejects duplicate version, logical identity, and target path", async () => {
    const adapter = await setup();
    const artifact = prepared().artifacts[0]!;
    await expect(
      new SyncPlanner().plan(
        {
          ...prepared(),
          artifacts: [artifact, { ...artifact, relativePath: "other" }],
        },
        [adapter],
      ),
    ).rejects.toThrow("Duplicate artifact version");
    await expect(
      new SyncPlanner().plan(
        {
          ...prepared(),
          artifacts: [
            artifact,
            {
              ...artifact,
              artifactVersionId: "version-2",
              relativePath: "other",
            },
          ],
        },
        [adapter],
      ),
    ).rejects.toThrow("Duplicate logical artifact");
    await expect(
      new SyncPlanner().plan(
        {
          ...prepared(),
          artifacts: [
            artifact,
            {
              ...artifact,
              artifactVersionId: "version-2",
              logicalId: "artifact-2",
            },
          ],
        },
        [adapter],
      ),
    ).rejects.toThrow("Duplicate artifact assignment");
  });

  it("plans exact user targets for root and direct agent roots but not workspaces", async () => {
    function scopedAdapter(
      name: string,
      scope: DestinationScope,
    ): AgentAdapter {
      return {
        name,
        kind: "codex",
        scope,
        root: `/${name}`,
        destination: (path) => `/${name}/${path}`,
        read: async () => undefined,
        write: async () => undefined,
        remove: async () => undefined,
        readOwnership: async () => [],
        replaceOwnership: async () => undefined,
      };
    }
    const base = prepared();
    const scoped = {
      ...base,
      artifacts: base.artifacts.map((artifact) => ({
        ...artifact,
        deliveryTargets: [
          {
            clientKind: "codex",
            installScope: "user",
          },
        ],
      })),
    } as typeof base;

    const changes = await new SyncPlanner().plan(scoped, [
      scopedAdapter("global", "root"),
      scopedAdapter("workspace", "workspace"),
      scopedAdapter("direct", "directory"),
    ]);

    expect(
      changes
        .filter(({ kind }) => kind === "create")
        .map(({ destinationName }) => destinationName),
    ).toEqual(["global", "direct"]);
  });

  it("plans one compatible assignment when several exact targets match", async () => {
    const adapter = await setup();
    Object.assign(adapter, { scope: "workspace" });
    const base = prepared();
    const scoped = {
      ...base,
      artifacts: base.artifacts.map((artifact) => ({
        ...artifact,
        deliveryTargets: [
          {
            clientKind: "codex",
            installScope: "workspace",
            minimumClientVersion: "2.0.0",
          },
          {
            clientKind: "codex",
            installScope: "workspace",
            minimumClientVersion: "1.0.0",
          },
        ],
      })),
    } as typeof base;

    await expect(
      new SyncPlanner().plan(scoped, [adapter], {
        adoptExisting: false,
        clientVersion: "1.5.0",
      }),
    ).resolves.toHaveLength(1);
    expect(() =>
      assertCompatibleDeliveryTargets(scoped.artifacts, [adapter], "next"),
    ).toThrow("Hivemnd CLI next or newer is required");
  });
});

describe("transactional apply", () => {
  function memoryAdapter(
    kind: AgentKind,
    failOnWrite = false,
  ): AgentAdapter & {
    files: Map<string, Uint8Array>;
    ledger: OwnershipEntry[];
  } {
    const adapter = {
      name: `${kind}-destination`,
      kind,
      scope: "directory" as const,
      root: `/${kind}`,
      files: new Map<string, Uint8Array>(),
      ledger: [] as OwnershipEntry[],
      destination: (path: string) => `/${kind}/${path}`,
      read: async (path: string) => adapter.files.get(path),
      write: async (path: string, content: Uint8Array) => {
        if (failOnWrite) throw new Error("disk full");
        adapter.files.set(path, content);
      },
      remove: async (path: string) => void adapter.files.delete(path),
      readOwnership: async () => adapter.ledger,
      replaceOwnership: async (entries: readonly OwnershipEntry[]) => {
        adapter.ledger = [...entries];
      },
    };
    return adapter;
  }

  function change(
    kind: SyncChange["kind"],
    agent: AgentKind = "codex",
  ): SyncChange {
    const artifact = prepared().artifacts[0]!;
    return {
      artifact,
      agent,
      destinationName: `${agent}-destination`,
      relativePath: artifact.relativePath,
      destination: `/${agent}/${artifact.relativePath}`,
      kind,
      ...(kind === "conflict"
        ? { conflictReason: "unmanaged-existing-file" as const }
        : {}),
    };
  }

  it("applies content and ledger, reports operations, and handles unchanged and removal", async () => {
    const adapter = memoryAdapter("codex");
    const result = await new SyncApplier().apply(
      prepared(),
      [change("create")],
      [adapter],
    );
    expect(result.applied).toBe(1);
    expect(result.operations[0]).toMatchObject({
      action: "create",
      result: "applied",
    });
    expect(adapter.ledger[0]).toMatchObject({
      releaseId: "release-1",
      artifactVersionId: "version-1",
    });

    const adoptedAdapter = memoryAdapter("codex");
    adoptedAdapter.files.set("skills/team/SKILL.md", bytes("# Team skill\n"));
    const adopted = await new SyncApplier().apply(
      prepared(),
      [change("adopt")],
      [adoptedAdapter],
    );
    expect(adopted).toMatchObject({ applied: 1 });
    expect(adopted.operations[0]).toMatchObject({
      action: "unchanged",
      result: "skipped",
    });
    expect(adoptedAdapter.ledger[0]).toMatchObject({
      logicalId: "artifact-1",
    });

    const unchanged = await new SyncApplier().apply(
      prepared(),
      [change("unchanged")],
      [adapter],
    );
    expect(unchanged).toMatchObject({ applied: 0 });
    expect(unchanged.operations[0]).toMatchObject({
      action: "unchanged",
      result: "skipped",
    });

    const owned = adapter.ledger[0]!;
    const remove: SyncChange = {
      owned,
      agent: "codex",
      destinationName: "codex-destination",
      relativePath: owned.relativePath,
      destination: `/codex/${owned.relativePath}`,
      kind: "remove",
    };
    const removed = await new SyncApplier().apply(
      { ...prepared(), artifacts: [] },
      [remove],
      [adapter],
    );
    expect(removed.applied).toBe(1);
    expect(adapter.files.size).toBe(0);
    expect(adapter.ledger).toEqual([]);
  });

  it("aborts conflicts, duplicate assignments, missing adapters, and malformed changes before mutation", async () => {
    const adapter = memoryAdapter("codex");
    await expect(
      new SyncApplier().apply(prepared(), [change("conflict")], [adapter]),
    ).rejects.toMatchObject({
      code: "SYNC_CONFLICT",
    });
    await expect(
      new SyncApplier().apply(
        prepared(),
        [change("create"), change("update")],
        [adapter],
      ),
    ).rejects.toThrow("duplicate artifact assignment");
    await expect(
      new SyncApplier().apply(
        prepared(),
        [change("create", "claude")],
        [adapter],
      ),
    ).rejects.toThrow("Missing adapter");
    await expect(
      new SyncApplier().apply(
        prepared(),
        [{ ...change("create"), artifact: undefined } as unknown as SyncChange],
        [adapter],
      ),
    ).rejects.toThrow("Missing artifact");
    await expect(
      new SyncApplier().apply(
        prepared(),
        [
          {
            agent: "codex",
            destinationName: "codex-destination",
            relativePath: "skills/old.md",
            destination: "/codex/skills/old.md",
            kind: "remove",
          },
        ],
        [adapter],
      ),
    ).rejects.toThrow("Missing ownership");
  });

  it("rolls back files and ledgers if any target fails", async () => {
    const codex = memoryAdapter("codex");
    const claude = memoryAdapter("claude", true);
    await expect(
      new SyncApplier().apply(
        prepared(),
        [change("create"), change("create", "claude")],
        [codex, claude],
      ),
    ).rejects.toMatchObject({ code: "SYNC_FAILED" });
    expect(codex.files.size).toBe(0);
    expect(codex.ledger).toEqual([]);
  });

  it("restores previous file contents during rollback", async () => {
    const codex = memoryAdapter("codex");
    codex.files.set("skills/team/SKILL.md", bytes("old"));
    codex.ledger = [entry("old")];
    const claude = memoryAdapter("claude", true);
    await expect(
      new SyncApplier().apply(
        prepared(),
        [change("update"), change("create", "claude")],
        [codex, claude],
      ),
    ).rejects.toMatchObject({ code: "SYNC_FAILED" });
    expect(
      Buffer.from(codex.files.get("skills/team/SKILL.md")!).toString(),
    ).toBe("old");
    expect(codex.ledger).toEqual([entry("old")]);
  });
});

describe("hash", () => {
  it("hashes strings and binary buffers", () => {
    expect(sha256("value")).toBe(sha256(bytes("value")));
  });
});
