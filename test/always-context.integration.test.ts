import {
  chmod,
  lstat,
  mkdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFilesystemAdapters } from "../src/agents/destinations.js";
import type {
  AgentAdapter,
  AgentKind,
  HivemndConfig,
  PreparedManifest,
} from "../src/domain.js";
import {
  AlwaysContextCache,
  MAX_ALWAYS_CONTEXT_BYTES,
} from "../src/context/always-context-cache.js";
import { injectAlwaysContext } from "../src/context/injector.js";
import {
  AlwaysContextPlanner,
  HIVEMND_CONTEXT_BEGIN,
  HIVEMND_CONTEXT_END,
  withoutAlwaysContext,
} from "../src/sync/always-context.js";
import { SyncApplier } from "../src/sync/applier.js";
import { SyncPlanner } from "../src/sync/planner.js";
import { profileKey } from "../src/organizations/registry.js";
import {
  bytes,
  hash,
  prepared,
  temporaryDirectory,
  writeJson,
} from "./helpers.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

function contextManifest(
  markdown = "# EIGEN\n\nOrchestrate subagents.\n",
  targets: readonly AgentKind[] = ["codex", "claude"],
): PreparedManifest {
  const base = prepared();
  const content = bytes(markdown);
  return {
    ...base,
    artifacts: [
      base.artifacts[0]!,
      {
        ...base.artifacts[0]!,
        artifactVersionId: "context-version-1",
        logicalId: "context-artifact-1",
        kind: "embedded_document",
        relativePath: "context/eigen-operating-principles.md",
        size: content.byteLength,
        sha256: hash(content),
        content,
        targets,
      },
    ],
  };
}

describe("central always-context cache", () => {
  it("stores one private organization/version copy and never plans destination copies", async () => {
    const temp = await temporaryDirectory();
    cleanups.push(temp.cleanup);
    const state = join(temp.path, "state");
    const apiUrl = "https://shared.hivemnd.cloud/eigen";
    const manifest = contextManifest();
    const cache = new AlwaysContextCache({ stateDirectory: state, apiUrl });
    const change = await cache.plan(manifest);

    expect(change.kind).toBe("update");
    await cache.apply(change);
    const unchanged = await cache.plan(manifest);
    expect(unchanged.kind).toBe("unchanged");
    await cache.apply(unchanged);
    await cache.apply(change);
    const current = JSON.parse(
      await readFile(
        join(
          state,
          "organizations",
          profileKey(apiUrl),
          "always-context",
          "current.json",
        ),
        "utf8",
      ),
    ) as { entries: Array<{ file: string }> };
    expect(current.entries).toHaveLength(1);
    const versionPath = join(
      state,
      "organizations",
      profileKey(apiUrl),
      "always-context",
      "versions",
      current.entries[0]!.file,
    );
    expect(await readFile(versionPath, "utf8")).toContain("Orchestrate");
    expect((await stat(versionPath)).mode & 0o777).toBe(0o600);
    expect(
      (await stat(join(state, "organizations", profileKey(apiUrl)))).mode &
        0o777,
    ).toBe(0o700);

    const workspace = join(temp.path, "repo");
    await mkdir(workspace);
    const adapters = createFilesystemAdapters(
      {
        apiUrl,
        destinations: [
          {
            name: "codex-workspace",
            agent: "codex",
            scope: "workspace",
            path: workspace,
          },
        ],
      },
      [],
      join(temp.path, "home"),
      state,
    );
    const changes = await new SyncPlanner().plan(
      withoutAlwaysContext(manifest),
      adapters,
    );
    expect(changes.map(({ relativePath }) => relativePath)).toEqual([
      "skills/team/SKILL.md",
    ]);
    expect(
      changes.some(({ destination }) => destination.includes("context")),
    ).toBe(false);
    await writeFile(versionPath, "modified immutable version");
    await expect(cache.apply(change)).rejects.toThrow("Immutable");
  });

  it("updates the pointer atomically, retains immutable versions, removes the pointer, and restores snapshots", async () => {
    const temp = await temporaryDirectory();
    cleanups.push(temp.cleanup);
    const stateDirectory = join(temp.path, "state");
    const apiUrl = "https://shared.hivemnd.cloud/eigen";
    const cache = new AlwaysContextCache({ stateDirectory, apiUrl });
    const first = contextManifest("# First\n");
    await cache.apply(await cache.plan(first));
    const snapshot = await cache.snapshot();
    const second = {
      ...contextManifest("# Second\n"),
      release: { id: "release-2", sequence: 2 },
      artifacts: contextManifest("# Second\n").artifacts.map((artifact) =>
        artifact.kind === "embedded_document"
          ? { ...artifact, artifactVersionId: "context-version-2" }
          : artifact,
      ),
    };
    await cache.apply(await cache.plan(second));
    expect(await cache.read("codex")).toBe("# Second\n");
    await cache.restore(snapshot);
    expect(await cache.read("codex")).toBe("# First\n");
    await cache.apply(await cache.plan({ ...first, artifacts: [] }));
    await expect(cache.read("codex")).resolves.toBe("");
    expect(
      await lstat(join(cache.root, "versions")).then((value) =>
        value.isDirectory(),
      ),
    ).toBe(true);
    const emptySnapshot = await cache.snapshot();
    await cache.restore(emptySnapshot);
  });

  it("writes cache v2 with exact targets and emits only the matching hook scope", async () => {
    const temp = await temporaryDirectory();
    cleanups.push(temp.cleanup);
    const cache = new AlwaysContextCache({
      stateDirectory: join(temp.path, "state"),
      apiUrl: "https://shared.hivemnd.cloud/eigen",
    });
    const base = contextManifest("global");
    const global = {
      ...base.artifacts[1]!,
      targets: ["codex"] as const,
      deliveryTargets: [
        {
          clientKind: "codex",
          installScope: "user",
          minimumClientVersion: "1.2.3",
        },
      ] as const,
    };
    const workspaceContent = bytes("workspace");
    const workspace = {
      ...global,
      artifactVersionId: "context-version-2",
      logicalId: "context-artifact-2",
      relativePath: "context/workspace.md",
      size: workspaceContent.byteLength,
      sha256: hash(workspaceContent),
      content: workspaceContent,
      deliveryTargets: [
        { clientKind: "codex", installScope: "workspace" },
      ] as const,
    };
    const manifest = {
      ...base,
      alwaysContextByteLimit: 10_000,
      artifacts: [global, workspace],
    } as typeof base;

    await cache.apply(await cache.plan(manifest));
    const current = JSON.parse(
      await readFile(join(cache.root, "current.json"), "utf8"),
    ) as {
      version: number;
      alwaysContextByteLimit: number;
      entries: Array<{ deliveryTargets: unknown[] }>;
    };
    expect(current).toMatchObject({
      version: 2,
      alwaysContextByteLimit: 10_000,
      entries: [
        {
          deliveryTargets: [
            {
              clientKind: "codex",
              installScope: "user",
              minimumClientVersion: "1.2.3",
            },
          ],
        },
        {
          deliveryTargets: [{ clientKind: "codex", installScope: "workspace" }],
        },
      ],
    });
    await expect(cache.read("codex", "user")).resolves.toBe("global");
    await expect(cache.read("codex", "workspace")).resolves.toBe("workspace");

    current.entries[0]!.deliveryTargets = [
      {
        clientKind: "codex",
        installScope: "user",
        minimumClientVersion: `1.2.3+${"a".repeat(128)}`,
      },
    ];
    await writeFile(join(cache.root, "current.json"), JSON.stringify(current));
    await expect(cache.read("codex", "user")).rejects.toMatchObject({
      code: "INTEGRITY_FAILED",
    });
  });

  it("reads a legacy cache as any scope and enforces exact rendered bytes without advancing the pointer", async () => {
    const temp = await temporaryDirectory();
    cleanups.push(temp.cleanup);
    const stateDirectory = join(temp.path, "state");
    const apiUrl = "https://shared.hivemnd.cloud/eigen";
    const cache = new AlwaysContextCache({ stateDirectory, apiUrl });
    const legacyBody = bytes("legacy");
    const legacyVersion = "legacy-version";
    const legacyFile = `${hash(legacyVersion)}.md`;
    const newlineBody = bytes("newline\n");
    const newlineVersion = "legacy-newline-version";
    const newlineFile = `${hash(newlineVersion)}.md`;
    await mkdir(join(cache.root, "versions"), { recursive: true });
    await writeFile(join(cache.root, "versions", legacyFile), legacyBody);
    await writeFile(join(cache.root, "versions", newlineFile), newlineBody);
    await writeFile(
      join(cache.root, "current.json"),
      JSON.stringify({
        version: 1,
        organizationKey: profileKey(apiUrl),
        apiUrl,
        releaseId: "legacy-release",
        entries: [
          {
            logicalId: "legacy-artifact",
            artifactVersionId: legacyVersion,
            relativePath: "context/legacy.md",
            sha256: hash(legacyBody),
            size: legacyBody.byteLength,
            targets: ["codex"],
            file: legacyFile,
          },
          {
            logicalId: "legacy-newline-artifact",
            artifactVersionId: newlineVersion,
            relativePath: "context/legacy-newline.md",
            sha256: hash(newlineBody),
            size: newlineBody.byteLength,
            targets: ["codex"],
            file: newlineFile,
          },
        ],
      }),
    );
    await expect(cache.read("codex", "user")).resolves.toBe(
      "legacy\n\nnewline\n",
    );
    await expect(cache.read("codex", "workspace")).resolves.toBe(
      "legacy\n\nnewline\n",
    );

    const base = contextManifest("12", ["codex"]);
    const first = {
      ...base.artifacts[1]!,
      deliveryTargets: [{ clientKind: "codex", installScope: "user" }] as const,
    };
    const secondContent = bytes("34");
    const second = {
      ...first,
      artifactVersionId: "context-version-2",
      logicalId: "context-artifact-2",
      relativePath: "context/second.md",
      size: secondContent.byteLength,
      sha256: hash(secondContent),
      content: secondContent,
    };
    const exactBoundary = {
      ...base,
      alwaysContextByteLimit: 5,
      artifacts: [first, second],
    } as typeof base;
    await cache.apply(await cache.plan(exactBoundary));
    await expect(cache.read("codex", "user")).resolves.toBe("12\n34");
    const pointer = await readFile(join(cache.root, "current.json"), "utf8");
    const overflowContent = bytes("345");

    await expect(
      cache.plan({
        ...exactBoundary,
        artifacts: [
          first,
          {
            ...second,
            size: overflowContent.byteLength,
            sha256: hash(overflowContent),
            content: overflowContent,
          },
        ],
      }),
    ).rejects.toThrow("5-byte limit");
    await expect(
      readFile(join(cache.root, "current.json"), "utf8"),
    ).resolves.toBe(pointer);
  });

  it("rejects unsafe manifests, invalid UTF-8, hash drift, symlinks, malformed ownership and output overflow", async () => {
    const temp = await temporaryDirectory();
    cleanups.push(temp.cleanup);
    const cache = new AlwaysContextCache({
      stateDirectory: join(temp.path, "state"),
      apiUrl: "https://shared.hivemnd.cloud/eigen",
    });
    const base = contextManifest();
    const embedded = base.artifacts[1]!;
    await expect(
      cache.plan({ ...base, alwaysContextByteLimit: -1 }),
    ).rejects.toThrow("non-negative integer");
    await expect(
      cache.plan({
        ...base,
        artifacts: [{ ...embedded, sha256: hash("different") }],
      }),
    ).rejects.toThrow("do not match manifest");
    await expect(
      cache.plan({
        ...base,
        artifacts: [
          embedded,
          {
            ...embedded,
            artifactVersionId: "context-version-2",
          },
        ],
      }),
    ).rejects.toThrow("Duplicate always-context");
    const otherContent = bytes("# Other\n");
    await expect(
      cache.plan({
        ...base,
        artifacts: [
          embedded,
          {
            ...embedded,
            logicalId: "other",
            relativePath: "context/other.md",
            content: otherContent,
            size: otherContent.byteLength,
            sha256: hash(otherContent),
          },
        ],
      }),
    ).rejects.toThrow("collide");
    const secondContent = bytes("# Second context\n");
    await expect(
      cache.plan({
        ...base,
        artifacts: [
          embedded,
          {
            ...embedded,
            artifactVersionId: "context-version-2",
            logicalId: "context-artifact-2",
            relativePath: "context/second.md",
            content: secondContent,
            size: secondContent.byteLength,
            sha256: hash(secondContent),
          },
        ],
      }),
    ).resolves.toMatchObject({
      manifest: { entries: [{}, {}] },
    });
    for (const [artifact, message] of [
      [
        {
          ...embedded,
          content: new Uint8Array([0xff]),
          size: 1,
          sha256: hash(new Uint8Array([0xff])),
        },
        "UTF-8",
      ],
      [
        {
          ...embedded,
          content: bytes("x".repeat(MAX_ALWAYS_CONTEXT_BYTES + 1)),
          size: MAX_ALWAYS_CONTEXT_BYTES + 1,
          sha256: hash("x".repeat(MAX_ALWAYS_CONTEXT_BYTES + 1)),
        },
        "limit",
      ],
    ] as const) {
      await expect(
        cache.plan({ ...base, artifacts: [artifact] }),
      ).rejects.toThrow(message);
    }

    await cache.apply(await cache.plan(base));
    const metadata = JSON.parse(
      await readFile(join(cache.root, "current.json"), "utf8"),
    ) as {
      organizationKey: string;
      entries: Array<{
        artifactVersionId: string;
        file: string;
        size: number;
        sha256: string;
      }>;
    };
    const file = join(cache.root, "versions", metadata.entries[0]!.file);
    await writeFile(file, "tampered");
    await expect(cache.read("codex")).rejects.toMatchObject({
      code: "INTEGRITY_FAILED",
    });
    await writeFile(join(cache.root, "current.json"), "{broken");
    await expect(cache.read("codex")).rejects.toMatchObject({
      code: "INTEGRITY_FAILED",
    });
    await writeFile(join(cache.root, "current.json"), JSON.stringify(metadata));
    await rm(file);
    await expect(cache.read("codex")).rejects.toThrow("is missing");
    const invalid = new Uint8Array([0xff]);
    await writeFile(file, invalid);
    metadata.entries[0]!.size = 1;
    metadata.entries[0]!.sha256 = hash(invalid);
    await writeFile(join(cache.root, "current.json"), JSON.stringify(metadata));
    await expect(cache.read("codex")).rejects.toThrow("not valid UTF-8");
    const overflow = bytes("x".repeat(MAX_ALWAYS_CONTEXT_BYTES + 1));
    await writeFile(file, overflow);
    metadata.entries[0]!.size = overflow.byteLength;
    metadata.entries[0]!.sha256 = hash(overflow);
    await writeFile(join(cache.root, "current.json"), JSON.stringify(metadata));
    await expect(cache.read("codex")).rejects.toThrow("exceeds");
    metadata.organizationKey = "0000000000000000";
    await writeFile(join(cache.root, "current.json"), JSON.stringify(metadata));
    await expect(cache.read("codex")).rejects.toThrow("metadata is invalid");
    metadata.organizationKey = profileKey("https://shared.hivemnd.cloud/eigen");
    await writeFile(join(cache.root, "current.json"), JSON.stringify(metadata));
    await writeFile(file, embedded.content);
    const target = join(temp.path, "outside.md");
    await writeFile(target, "outside");
    await writeFile(join(cache.root, "current.json"), JSON.stringify(metadata));
    await writeFile(file, embedded.content);
    await chmod(file, 0o600);
    await rm(file);
    await symlink(target, file);
    await expect(cache.read("codex")).rejects.toMatchObject({
      code: "PATH_UNSAFE",
    });
    await rm(file);
    await writeFile(file, embedded.content);
    metadata.entries[0]!.size = embedded.size;
    metadata.entries[0]!.sha256 = embedded.sha256;
    await writeFile(join(cache.root, "current.json"), JSON.stringify(metadata));
    await expect(
      cache.apply({
        kind: "update",
        manifest: metadata as never,
        contents: new Map(),
      }),
    ).rejects.toThrow("Missing always-context bytes");
    await expect(
      cache.apply({ kind: "update", contents: new Map() }),
    ).rejects.toThrow("Missing always-context cache manifest");
    await writeFile(join(cache.root, "versions", "unexpected"), "x");
    await expect(cache.snapshot()).rejects.toMatchObject({
      code: "PATH_UNSAFE",
    });
    await rm(join(cache.root, "versions", "unexpected"));
    await mkdir(join(cache.root, "versions", `${"a".repeat(64)}.md`));
    await expect(cache.snapshot()).rejects.toMatchObject({
      code: "PATH_UNSAFE",
    });
    await rm(join(cache.root, "versions", `${"a".repeat(64)}.md`), {
      recursive: true,
    });
    const currentPath = join(cache.root, "current.json");
    const outsideMetadata = join(temp.path, "outside.json");
    await writeFile(outsideMetadata, JSON.stringify(metadata));
    await rm(currentPath);
    await symlink(outsideMetadata, currentPath);
    await expect(cache.read("codex")).rejects.toMatchObject({
      code: "PATH_UNSAFE",
    });
  });
});

describe("primary-session injection", () => {
  it("resolves workspace before global organization and filters by client without network or token access", async () => {
    const temp = await temporaryDirectory();
    cleanups.push(temp.cleanup);
    const stateDirectory = join(temp.path, "state");
    const workspace = join(temp.path, "repo");
    await mkdir(workspace);
    const eigenUrl = "https://shared.hivemnd.cloud/eigen";
    const acmeUrl = "https://shared.hivemnd.cloud/acme";
    const eigen = new AlwaysContextCache({ stateDirectory, apiUrl: eigenUrl });
    const acme = new AlwaysContextCache({ stateDirectory, apiUrl: acmeUrl });
    await eigen.apply(
      await eigen.plan(contextManifest("# EIGEN\n", ["codex"])),
    );
    await acme.apply(await acme.plan(contextManifest("# ACME\n", ["claude"])));
    await writeJson(join(stateDirectory, "registry.json"), {
      version: 1,
      profiles: [
        profile("eigen", eigenUrl, stateDirectory),
        profile("acme", acmeUrl, stateDirectory),
      ],
      workspaceBindings: [
        { path: temp.path, organizationKey: profileKey(eigenUrl) },
        { path: workspace, organizationKey: profileKey(acmeUrl) },
      ],
      globalBindings: [
        { client: "codex", organizationKey: profileKey(eigenUrl) },
      ],
    });

    await expect(
      injectAlwaysContext({
        client: "claude",
        scope: "workspace",
        workspace,
        stateDirectory,
        input: JSON.stringify({
          hook_event_name: "SessionStart",
          source: "startup",
          cwd: workspace,
        }),
      }),
    ).resolves.toBe("# ACME\n");
    await expect(
      injectAlwaysContext({
        client: "codex",
        scope: "global",
        stateDirectory,
        input: JSON.stringify({
          hook_event_name: "SessionStart",
          source: "compact",
          cwd: `${temp.path}-unbound`,
        }),
      }),
    ).resolves.toBe("# EIGEN\n");
  });

  it("suppresses Claude subagents and rejects malformed or non-SessionStart payloads", async () => {
    const temp = await temporaryDirectory();
    cleanups.push(temp.cleanup);
    const options = {
      client: "claude" as const,
      scope: "global" as const,
      stateDirectory: join(temp.path, "state"),
    };
    await expect(
      injectAlwaysContext({
        ...options,
        input: JSON.stringify({
          hook_event_name: "SessionStart",
          source: "startup",
          cwd: temp.path,
          agent_id: "child-1",
        }),
      }),
    ).resolves.toBe("");
    await expect(
      injectAlwaysContext({ ...options, input: "not-json" }),
    ).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(
      injectAlwaysContext({
        ...options,
        input: JSON.stringify({
          hook_event_name: "SubagentStart",
          cwd: temp.path,
        }),
      }),
    ).rejects.toThrow("SessionStart");
    await expect(
      injectAlwaysContext({
        client: "codex",
        scope: "global",
        stateDirectory: "relative",
        input: "{}",
      }),
    ).rejects.toThrow("absolute Hivemnd state");
    await expect(
      injectAlwaysContext({
        ...options,
        input: "x".repeat(65 * 1024),
      }),
    ).rejects.toThrow("too large");
    await expect(
      injectAlwaysContext({
        ...options,
        input: JSON.stringify({
          hook_event_name: "SessionStart",
          source: "startup",
          cwd: "relative",
        }),
      }),
    ).rejects.toThrow("cwd must be an absolute path");

    await writeJson(join(options.stateDirectory, "registry.json"), {
      version: 1,
      profiles: [],
      workspaceBindings: [],
      globalBindings: [],
    });
    await expect(
      injectAlwaysContext({
        ...options,
        input: JSON.stringify({
          hook_event_name: "SessionStart",
          source: "resume",
          cwd: temp.path,
        }),
      }),
    ).resolves.toBe("");
    await expect(
      injectAlwaysContext({
        ...options,
        scope: "workspace",
        input: JSON.stringify({
          hook_event_name: "SessionStart",
          source: "resume",
          cwd: temp.path,
        }),
      }),
    ).rejects.toThrow("workspace path");
    await expect(
      injectAlwaysContext({
        ...options,
        scope: "workspace",
        workspace: "relative",
        input: JSON.stringify({
          hook_event_name: "SessionStart",
          source: "resume",
          cwd: temp.path,
        }),
      }),
    ).rejects.toThrow("absolute and canonical");
    await expect(
      injectAlwaysContext({
        ...options,
        workspace: temp.path,
        input: JSON.stringify({
          hook_event_name: "SessionStart",
          source: "resume",
          cwd: temp.path,
        }),
      }),
    ).rejects.toThrow("cannot declare");
  });

  it("emits exactly once across global, workspace, and nested workspace hooks", async () => {
    const temp = await temporaryDirectory();
    cleanups.push(temp.cleanup);
    const stateDirectory = join(temp.path, "state");
    const outer = join(temp.path, "outer");
    const nested = join(outer, "nested");
    const nestedCwd = join(nested, "src");
    await mkdir(nestedCwd, { recursive: true });
    const globalUrl = "https://shared.hivemnd.cloud/global";
    const outerUrl = "https://shared.hivemnd.cloud/outer";
    const nestedUrl = "https://shared.hivemnd.cloud/nested";
    for (const [apiUrl, markdown] of [
      [globalUrl, "# Global\n"],
      [outerUrl, "# Outer\n"],
      [nestedUrl, "# Nested\n"],
    ] as const) {
      const cache = new AlwaysContextCache({ stateDirectory, apiUrl });
      await cache.apply(await cache.plan(contextManifest(markdown, ["codex"])));
    }
    await writeJson(join(stateDirectory, "registry.json"), {
      version: 1,
      profiles: [
        profile("global", globalUrl, stateDirectory),
        profile("outer", outerUrl, stateDirectory),
        profile("nested", nestedUrl, stateDirectory),
      ],
      workspaceBindings: [
        { path: outer, organizationKey: profileKey(outerUrl) },
        { path: nested, organizationKey: profileKey(nestedUrl) },
      ],
      globalBindings: [
        { client: "codex", organizationKey: profileKey(globalUrl) },
      ],
    });
    const payload = (cwd: string) =>
      JSON.stringify({
        hook_event_name: "SessionStart",
        source: "startup",
        cwd,
      });

    await expect(
      injectAlwaysContext({
        client: "codex",
        scope: "global",
        stateDirectory,
        input: payload(nestedCwd),
      }),
    ).resolves.toBe("");
    await expect(
      injectAlwaysContext({
        client: "codex",
        scope: "workspace",
        workspace: outer,
        stateDirectory,
        input: payload(nestedCwd),
      }),
    ).resolves.toBe("");
    await expect(
      injectAlwaysContext({
        client: "codex",
        scope: "workspace",
        workspace: nested,
        stateDirectory,
        input: payload(nestedCwd),
      }),
    ).resolves.toBe("# Nested\n");

    await expect(
      injectAlwaysContext({
        client: "codex",
        scope: "global",
        stateDirectory,
        input: payload(temp.path),
      }),
    ).resolves.toBe("# Global\n");
  });
});

describe("legacy managed instruction migration", () => {
  it("removes only an exactly owned legacy block and preserves user content", async () => {
    const temp = await temporaryDirectory();
    cleanups.push(temp.cleanup);
    const workspace = join(temp.path, "repo");
    await mkdir(workspace);
    const config: HivemndConfig = {
      apiUrl: "https://shared.hivemnd.cloud/eigen",
      destinations: [
        {
          name: "codex-workspace",
          agent: "codex",
          scope: "workspace",
          path: workspace,
        },
      ],
    };
    const adapters = createFilesystemAdapters(
      config,
      [],
      join(temp.path, "home"),
      join(temp.path, "state"),
    );
    const block = `${HIVEMND_CONTEXT_BEGIN}\n# Old context\n${HIVEMND_CONTEXT_END}`;
    await writeFile(join(workspace, "AGENTS.md"), `# User rules\n\n${block}`);
    await adapters[0]!.replaceOwnership([], {
      blockSha256: hash(block),
      prefix: "\n",
      createdFile: false,
    });
    const legacy = await new AlwaysContextPlanner().plan(adapters);
    expect(legacy).toEqual([
      expect.objectContaining({
        kind: "remove",
        content: bytes("# User rules\n"),
      }),
    ]);
    await new SyncApplier().apply(prepared(), [], adapters, legacy);
    expect(await readFile(join(workspace, "AGENTS.md"), "utf8")).toBe(
      "# User rules\n",
    );
    await expect(
      adapters[0]!.readContextInstructionOwnership?.(),
    ).resolves.toBeUndefined();
  });

  it("does not claim marker text without ownership and conflicts on edited owned content", async () => {
    const temp = await temporaryDirectory();
    cleanups.push(temp.cleanup);
    const workspace = join(temp.path, "repo");
    await mkdir(workspace);
    const adapters = createFilesystemAdapters(
      {
        apiUrl: "https://shared.hivemnd.cloud/eigen",
        destinations: [
          {
            name: "codex-workspace",
            agent: "codex",
            scope: "workspace",
            path: workspace,
          },
        ],
      },
      [],
      join(temp.path, "home"),
      join(temp.path, "state"),
    );
    const path = join(workspace, "AGENTS.md");
    const block = `${HIVEMND_CONTEXT_BEGIN}\nuser text\n${HIVEMND_CONTEXT_END}`;
    await writeFile(path, block);
    await expect(new AlwaysContextPlanner().plan(adapters)).resolves.toEqual(
      [],
    );
    await adapters[0]!.replaceOwnership([], {
      blockSha256: hash("different"),
      prefix: "",
      createdFile: true,
    });
    await expect(new AlwaysContextPlanner().plan(adapters)).resolves.toEqual([
      expect.objectContaining({
        kind: "conflict",
        conflictReason: "managed-context-block-edited",
      }),
    ]);

    await writeFile(path, `${HIVEMND_CONTEXT_BEGIN}\nincomplete`);
    await expect(new AlwaysContextPlanner().plan(adapters)).resolves.toEqual([
      expect.objectContaining({
        conflictReason: "managed-context-markers-invalid",
      }),
    ]);
    await rm(path);
    await expect(new AlwaysContextPlanner().plan(adapters)).resolves.toEqual([
      expect.objectContaining({
        conflictReason: "managed-context-block-missing",
      }),
    ]);
    await writeFile(path, new Uint8Array([0xff]));
    await expect(new AlwaysContextPlanner().plan(adapters)).rejects.toThrow(
      "not valid UTF-8",
    );

    const exact = `${HIVEMND_CONTEXT_BEGIN}\nowned\n${HIVEMND_CONTEXT_END}`;
    await writeFile(path, exact);
    await adapters[0]!.replaceOwnership([], {
      blockSha256: hash(exact),
      prefix: "",
      createdFile: true,
    });
    const createdRemoval = await new AlwaysContextPlanner().plan(adapters);
    expect(createdRemoval).toEqual([
      expect.objectContaining({ kind: "remove" }),
    ]);
    expect(createdRemoval[0]).not.toHaveProperty("content");
    await new SyncApplier().apply(prepared(), [], adapters, createdRemoval);
    await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
    const directoryAdapter = createFilesystemAdapters(
      {
        apiUrl: "https://shared.hivemnd.cloud/eigen",
        destinations: [
          {
            name: "directory",
            agent: "codex",
            scope: "directory",
            path: join(temp.path, "agent-root"),
          },
        ],
      },
      [],
      join(temp.path, "home"),
      join(temp.path, "state"),
    );
    await expect(
      new AlwaysContextPlanner().plan(directoryAdapter),
    ).resolves.toEqual([]);
    await expect(
      new AlwaysContextPlanner().plan([
        {
          ...adapters[0]!,
          readContextInstructionOwnership: undefined,
        } as unknown as AgentAdapter,
      ]),
    ).rejects.toThrow("incomplete legacy");
  });
});

describe("always-context synchronization transaction", () => {
  it("validates instruction assignments and rolls back instruction and cache changes together", async () => {
    const temp = await temporaryDirectory();
    cleanups.push(temp.cleanup);
    const workspace = join(temp.path, "repo");
    await mkdir(workspace);
    const [adapter] = createFilesystemAdapters(
      {
        apiUrl: "https://shared.hivemnd.cloud/eigen",
        destinations: [
          {
            name: "codex-workspace",
            agent: "codex",
            scope: "workspace",
            path: workspace,
          },
        ],
      },
      [],
      join(temp.path, "home"),
      join(temp.path, "state"),
    );
    expect(adapter).toBeDefined();
    const path = join(workspace, "AGENTS.md");
    await writeFile(path, "old");
    const baseChange = {
      agent: "codex" as const,
      destinationName: adapter!.name,
      destination: path,
      kind: "update" as const,
      expectedFileSha256: hash("old"),
      content: bytes("new"),
      ownership: null,
    };
    await expect(
      new SyncApplier().apply(
        prepared(),
        [],
        [adapter!],
        [{ ...baseChange, kind: "unchanged" }],
      ),
    ).resolves.toMatchObject({ applied: 0 });
    await expect(
      new SyncApplier().apply(
        prepared(),
        [],
        [adapter!],
        [baseChange, baseChange],
      ),
    ).rejects.toThrow("duplicate context");
    await expect(
      new SyncApplier().apply(
        prepared(),
        [],
        [adapter!],
        [{ ...baseChange, expectedFileSha256: hash("different") }],
      ),
    ).rejects.toThrow("changed while synchronization");

    const restore = vi.fn(async () => undefined);
    await expect(
      new SyncApplier().apply(prepared(), [], [adapter!], [baseChange], {
        cache: {
          snapshot: async () => ({ versionFiles: new Set<string>() }),
          apply: async () => {
            throw new Error("cache failure");
          },
          restore,
        } as never,
        change: { kind: "update", contents: new Map() },
      }),
    ).rejects.toThrow("rolled back");
    expect(await readFile(path, "utf8")).toBe("old");
    expect(restore).toHaveBeenCalledOnce();

    await rm(path);
    const { content, ...missingContent } = baseChange;
    expect(content).toEqual(bytes("new"));
    await expect(
      new SyncApplier().apply(
        prepared(),
        [],
        [adapter!],
        [{ ...missingContent, expectedFileSha256: null }],
      ),
    ).rejects.toThrow("rolled back");
    await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects destinations without instruction support and reports cached context receipts", async () => {
    const temp = await temporaryDirectory();
    cleanups.push(temp.cleanup);
    const root = join(temp.path, "agent-root");
    await mkdir(root);
    const [directory] = createFilesystemAdapters(
      {
        apiUrl: "https://shared.hivemnd.cloud/eigen",
        destinations: [
          { name: "directory", agent: "codex", scope: "directory", path: root },
        ],
      },
      [],
      join(temp.path, "home"),
      join(temp.path, "state"),
    );
    await expect(
      new SyncApplier().apply(
        prepared(),
        [],
        [directory!],
        [
          {
            agent: "codex",
            destinationName: "directory",
            destination: "/none",
            kind: "remove",
            expectedFileSha256: null,
          },
        ],
      ),
    ).rejects.toThrow("does not support");
    await expect(
      new SyncApplier().apply(
        prepared(),
        [],
        [
          {
            ...directory!,
            readInstruction: undefined,
            writeInstruction: undefined,
            removeInstruction: undefined,
          } as unknown as AgentAdapter,
        ],
        [
          {
            agent: "codex",
            destinationName: "directory",
            destination: "/none",
            kind: "remove",
            expectedFileSha256: null,
          },
        ],
      ),
    ).rejects.toThrow("does not support");

    const manifest = contextManifest();
    const cache = new AlwaysContextCache({
      stateDirectory: join(temp.path, "state"),
      apiUrl: "https://shared.hivemnd.cloud/eigen",
    });
    const change = await cache.plan(manifest);
    const result = await new SyncApplier().apply(manifest, [], [], [], {
      cache,
      change,
    });
    expect(result.applied).toBe(1);
    expect(result.operations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          artifactVersionId: "context-version-1",
          result: "applied",
        }),
      ]),
    );
    const unchanged = await cache.plan(manifest);
    const second = await new SyncApplier().apply(manifest, [], [], [], {
      cache,
      change: unchanged,
    });
    expect(second.applied).toBe(0);
    expect(second.operations[0]?.result).toBe("skipped");
  });
});

function profile(alias: string, apiUrl: string, stateDirectory: string) {
  return {
    key: profileKey(apiUrl),
    alias,
    name: alias.toUpperCase(),
    slug: alias,
    apiUrl,
    configPath: join(
      stateDirectory,
      "organizations",
      profileKey(apiUrl),
      "config.json",
    ),
  };
}
