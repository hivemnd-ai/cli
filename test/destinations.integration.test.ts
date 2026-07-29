import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createFilesystemAdapters,
  resolveAgentRoot,
} from "../src/agents/destinations.js";
import type { HivemndConfig } from "../src/domain.js";
import { bytes, hash, temporaryDirectory } from "./helpers.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("named installation destinations", () => {
  it("resolves Codex and Claude roots at global, workspace, and explicit scopes", async () => {
    const temp = await temporaryDirectory();
    cleanups.push(temp.cleanup);
    const home = join(temp.path, "home");
    const state = join(home, ".hivemnd");
    const workspace = join(temp.path, "repo");
    const explicit = join(temp.path, "custom-agent-root");
    const config: HivemndConfig = {
      apiUrl: "https://hivemnd.test",
      destinations: [
        { name: "codex-global", agent: "codex", scope: "root" },
        {
          name: "codex-repo",
          agent: "codex",
          scope: "workspace",
          path: workspace,
        },
        {
          name: "claude-repo",
          agent: "claude",
          scope: "workspace",
          path: workspace,
        },
        {
          name: "claude-custom",
          agent: "claude",
          scope: "directory",
          path: explicit,
        },
      ],
    };

    const adapters = createFilesystemAdapters(config, [], home, state);

    expect(
      adapters.map(({ name, kind, root, instructionPath }) => ({
        name,
        kind,
        root,
        instructionPath,
      })),
    ).toEqual([
      {
        name: "codex-global",
        kind: "codex",
        root: join(home, ".agents"),
        instructionPath: join(home, ".codex/AGENTS.md"),
      },
      {
        name: "codex-repo",
        kind: "codex",
        root: join(workspace, ".agents"),
        instructionPath: join(workspace, "AGENTS.md"),
      },
      {
        name: "claude-repo",
        kind: "claude",
        root: join(workspace, ".claude"),
        instructionPath: join(workspace, "CLAUDE.md"),
      },
      {
        name: "claude-custom",
        kind: "claude",
        root: explicit,
        instructionPath: undefined,
      },
    ]);
  });

  it("selects several same-agent destinations and isolates ownership under ~/.hivemnd", async () => {
    const temp = await temporaryDirectory();
    cleanups.push(temp.cleanup);
    const state = join(temp.path, ".hivemnd");
    const config: HivemndConfig = {
      apiUrl: "https://hivemnd.test",
      destinations: [
        {
          name: "api",
          agent: "codex",
          scope: "workspace",
          path: join(temp.path, "api"),
        },
        {
          name: "web",
          agent: "codex",
          scope: "workspace",
          path: join(temp.path, "web"),
        },
      ],
    };
    const [api, web] = createFilesystemAdapters(
      config,
      ["api", "web"],
      join(temp.path, "home"),
      state,
    );
    const ownership = [
      {
        relativePath: "skills/team/SKILL.md",
        logicalId: "skill-1",
        artifactVersionId: "version-1",
        sha256: hash("skill"),
        releaseId: "release-1",
      },
    ];

    await api!.write("skills/team/SKILL.md", bytes("skill"));
    await api!.replaceOwnership(ownership);
    await web!.replaceOwnership([]);

    await expect(api!.readOwnership()).resolves.toEqual(ownership);
    await expect(web!.readOwnership()).resolves.toEqual([]);
    await expect(
      readFile(
        join(
          state,
          "destinations",
          createHash("sha256")
            .update("https://hivemnd.test/")
            .digest("hex")
            .slice(0, 16),
          "api/ownership.json",
        ),
        "utf8",
      ),
    ).resolves.toContain('"logicalId": "skill-1"');
    await expect(
      readFile(join(api!.root, ".hivemnd/ownership.json"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects unknown names and duplicate physical destinations for one agent", () => {
    const base: HivemndConfig = {
      apiUrl: "https://hivemnd.test",
      destinations: [
        { name: "one", agent: "codex", scope: "root" },
        { name: "two", agent: "codex", scope: "root" },
      ],
    };

    expect(() =>
      createFilesystemAdapters(base, ["missing"], "/home/test", "/state"),
    ).toThrow("Unknown destination");
    expect(() =>
      createFilesystemAdapters(base, [], "/home/test", "/state"),
    ).toThrow("same agent directory");
    expect(() =>
      resolveAgentRoot(
        { name: "invalid", agent: "codex", scope: "directory" },
        "/home/test",
      ),
    ).toThrow("requires an absolute path");
  });
});
