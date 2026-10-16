import { chmod, mkdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ContextUsageReceipt } from "../src/domain.js";
import { AlwaysContextCache } from "../src/context/always-context-cache.js";
import { UsageReceiptOutbox } from "../src/usage/receipt-outbox.js";
import {
  claudeEnterprisePolicyPaths,
  stageClaudeSkillActivation,
} from "../src/context/skill-activation.js";
import { createFilesystemAdapters } from "../src/agents/destinations.js";
import { profileKey } from "../src/organizations/registry.js";
import { defaultDependencies, runCli } from "../src/cli.js";
import {
  bytes,
  captureOutput,
  hash,
  prepared,
  temporaryDirectory,
  writeJson,
} from "./helpers.js";

const cleanups: Array<() => Promise<void>> = [];
const installationId = "00000000-0000-4000-8000-000000000010";

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

function receipt(sequence: number): ContextUsageReceipt {
  return {
    eventId: `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
    eventKind: "always_context_emitted",
    agentHost: "codex",
    observedAt: `2026-08-05T12:00:${String(sequence).padStart(2, "0")}.000Z`,
    contextTrigger: "startup",
    items: [
      {
        artifactId: "00000000-0000-4000-8000-000000000020",
        artifactVersionId: "00000000-0000-4000-8000-000000000021",
        artifactKind: "embedded_document",
      },
    ],
  };
}

describe("private context-usage receipt outbox", () => {
  it("isolates installations, stages atomically with private modes, and drains FIFO", async () => {
    const temp = await temporaryDirectory();
    cleanups.push(temp.cleanup);
    const outbox = new UsageReceiptOutbox({
      stateDirectory: temp.path,
      apiUrl: "https://shared.hivemnd.cloud/eigen",
      installationId,
    });
    const sameTimeSecond = {
      ...receipt(2),
      observedAt: receipt(1).observedAt,
    };
    await Promise.all([outbox.stage(sameTimeSecond), outbox.stage(receipt(1))]);
    await expect(outbox.stage(receipt(1))).resolves.toBeUndefined();
    await expect(
      outbox.stage({ ...receipt(1), agentHost: "claude" }),
    ).rejects.toMatchObject({ code: "INTEGRITY_FAILED" });
    expect(await outbox.pending()).toEqual([receipt(1), sameTimeSecond]);
    expect((await stat(outbox.root)).mode & 0o777).toBe(0o700);
    for (const name of await import("node:fs/promises").then(({ readdir }) =>
      readdir(outbox.root),
    )) {
      expect((await stat(join(outbox.root, name))).mode & 0o777).toBe(0o600);
    }

    const delivered: ContextUsageReceipt[] = [];
    const api = {
      usageReceipt: vi.fn(
        async (_token: string, value: ContextUsageReceipt) => {
          delivered.push(value);
        },
      ),
    };
    await expect(outbox.deliverPending(api, "token")).resolves.toEqual({
      accepted: 2,
      pending: 0,
    });
    expect(delivered).toEqual([receipt(1), sameTimeSecond]);
    expect(await outbox.pending()).toEqual([]);

    const reenrolled = new UsageReceiptOutbox({
      stateDirectory: temp.path,
      apiUrl: "https://shared.hivemnd.cloud/eigen",
      installationId: "00000000-0000-4000-8000-000000000099",
    });
    expect(reenrolled.root).not.toBe(outbox.root);
    expect(await reenrolled.pending()).toEqual([]);
  });

  it("fails closed for capacity, corruption, unsafe state and forbidden fields", async () => {
    const temp = await temporaryDirectory();
    cleanups.push(temp.cleanup);
    const outbox = new UsageReceiptOutbox({
      stateDirectory: temp.path,
      apiUrl: "https://shared.hivemnd.cloud/eigen",
      installationId,
      maximumEntries: 1,
      maximumBytes: 1024 * 1024,
    });
    await outbox.stage(receipt(1));
    await expect(outbox.stage(receipt(2))).rejects.toThrow("full");
    expect(JSON.stringify(await outbox.pending())).not.toMatch(
      /prompt|command_args|session_id|transcript|reason|cwd|path/i,
    );
    await writeFile(join(outbox.root, `${receipt(1).eventId}.json`), "{}\n");
    await expect(outbox.pending()).rejects.toMatchObject({
      code: "INTEGRITY_FAILED",
    });

    const unsafe = new UsageReceiptOutbox({
      stateDirectory: join(temp.path, "unsafe"),
      apiUrl: "https://shared.hivemnd.cloud/eigen",
      installationId,
    });
    await unsafe.stage(receipt(3));
    await chmod(unsafe.root, 0o777);
    await expect(unsafe.stage(receipt(4))).rejects.toMatchObject({
      code: "PATH_UNSAFE",
    });

    const mismatch = new UsageReceiptOutbox({
      stateDirectory: join(temp.path, "mismatch"),
      apiUrl: "https://shared.hivemnd.cloud/eigen",
      installationId,
    });
    await mismatch.stage(receipt(5));
    await writeFile(
      join(mismatch.root, "wrong.json"),
      JSON.stringify(receipt(6)),
    );
    await expect(mismatch.pending()).rejects.toMatchObject({
      code: "INTEGRITY_FAILED",
    });

    const deferred = new UsageReceiptOutbox({
      stateDirectory: join(temp.path, "deferred"),
      apiUrl: "https://shared.hivemnd.cloud/eigen",
      installationId,
    });
    await deferred.stage(receipt(7));
    await expect(
      deferred.deliverPending(
        { usageReceipt: async () => Promise.reject(new Error("offline")) },
        "token",
      ),
    ).resolves.toEqual({ accepted: 0, pending: 1 });

    const collision = new UsageReceiptOutbox({
      stateDirectory: join(temp.path, "collision"),
      apiUrl: "https://shared.hivemnd.cloud/eigen",
      installationId,
    });
    await mkdir(join(collision.root, `${receipt(9).eventId}.json`), {
      recursive: true,
    });
    await expect(collision.stage(receipt(9))).rejects.toBeDefined();

    for (const invalid of [
      { ...receipt(8), contextTrigger: undefined },
      {
        ...receipt(8),
        eventKind: "skill_activated",
        agentHost: "codex",
        contextTrigger: undefined,
      },
      {
        ...receipt(8),
        items: [{ ...receipt(8).items[0]!, artifactKind: "skill" }],
      },
    ]) {
      await expect(
        outbox.stage(invalid as ContextUsageReceipt),
      ).rejects.toThrow("bounded wire contract");
    }
  });
});

describe("always-context exact selection", () => {
  it("returns unchanged output plus the exact selected manifest tuples", async () => {
    const temp = await temporaryDirectory();
    cleanups.push(temp.cleanup);
    const content = bytes("governed context");
    const base = prepared();
    const artifact = {
      ...base.artifacts[0]!,
      artifactVersionId: "00000000-0000-4000-8000-000000000021",
      logicalId: "00000000-0000-4000-8000-000000000020",
      kind: "embedded_document" as const,
      relativePath: "context/governed.md",
      size: content.byteLength,
      sha256: hash(content),
      content,
      targets: ["codex"] as const,
      deliveryTargets: [{ clientKind: "codex", installScope: "user" }] as const,
    };
    const cache = new AlwaysContextCache({
      stateDirectory: temp.path,
      apiUrl: "https://shared.hivemnd.cloud/eigen",
    });
    await cache.apply(await cache.plan({ ...base, artifacts: [artifact] }));
    await expect(cache.select("codex", "user")).resolves.toEqual({
      output: "governed context",
      entries: [
        {
          artifactId: artifact.logicalId,
          artifactVersionId: artifact.artifactVersionId,
          artifactKind: "embedded_document",
        },
      ],
    });
  });
});

describe("explicit Claude Skill usage", () => {
  it("does not infer a nested skill version from cwd for a shared bare command name", async () => {
    const temp = await temporaryDirectory();
    cleanups.push(temp.cleanup);
    const stateDirectory = join(temp.path, "state");
    const homeDirectory = join(temp.path, "home");
    const workspace = join(temp.path, "repo");
    const nested = join(workspace, "apps", "web");
    const apiUrl = "https://shared.hivemnd.cloud/eigen";
    const configPath = join(stateDirectory, "config.json");
    const config = {
      apiUrl,
      installationId,
      destinations: [workspace, nested].map((path, index) => ({
        name: `claude-project-${index}`,
        agent: "claude" as const,
        scope: "workspace" as const,
        path,
      })),
    };
    await writeJson(configPath, config);
    await writeJson(join(stateDirectory, "registry.json"), {
      version: 1,
      profiles: [
        {
          key: profileKey(apiUrl),
          alias: "eigen",
          name: "Eigen",
          slug: "eigen",
          apiUrl,
          configPath,
        },
      ],
      workspaceBindings: [workspace, nested].map((path) => ({
        path,
        organizationKey: profileKey(apiUrl),
      })),
      globalBindings: [],
    });
    const adapters = createFilesystemAdapters(
      config,
      [],
      homeDirectory,
      stateDirectory,
    );
    for (const [index, adapter] of adapters.entries()) {
      const content = bytes(`# Skill version ${index}\n`);
      await adapter.write("skills/team/SKILL.md", content);
      await adapter.replaceOwnership([
        {
          relativePath: "skills/team/SKILL.md",
          logicalId: `artifact-${index}`,
          artifactVersionId: `version-${index}`,
          sha256: hash(content),
          releaseId: "release-1",
        },
      ]);
    }
    const options = {
      scope: "workspace" as const,
      workspace: nested,
      stateDirectory,
      homeDirectory,
      enterprisePolicyPaths: [],
      input: JSON.stringify({
        hook_event_name: "UserPromptExpansion",
        session_id: "private-session",
        transcript_path: "/private/transcript",
        cwd: nested,
        permission_mode: "default",
        expansion_type: "slash_command",
        command_name: "team",
        command_args: "private arguments",
        command_source: "custom",
        prompt: "/team private arguments",
      }),
    };
    const outbox = new UsageReceiptOutbox({
      stateDirectory,
      apiUrl,
      installationId,
    });
    await expect(stageClaudeSkillActivation(options)).resolves.toBe(
      "ambiguous",
    );
    await expect(outbox.pending()).resolves.toEqual([]);
    // An unrelated nested destination must not hide an exact ancestor version.
    await adapters[1]!.remove("skills/team/SKILL.md");
    await adapters[1]!.replaceOwnership([]);
    await expect(stageClaudeSkillActivation(options)).resolves.toBe("staged");
    expect((await outbox.pending())[0]?.items[0]?.artifactVersionId).toBe(
      "version-0",
    );
  });

  it("resolves documented file-based managed-settings paths per host platform", () => {
    expect(claudeEnterprisePolicyPaths("darwin", {})).toEqual([
      "/Library/Application Support/ClaudeCode/managed-settings.json",
      "/Library/Application Support/ClaudeCode/managed-settings.d",
    ]);
    expect(
      claudeEnterprisePolicyPaths("win32", {
        ProgramFiles: "C:\\Program Files",
      }),
    ).toEqual([
      "C:\\Program Files/ClaudeCode/managed-settings.json",
      "C:\\Program Files/ClaudeCode/managed-settings.d",
    ]);
    expect(claudeEnterprisePolicyPaths("win32", {})).toEqual([]);
    expect(claudeEnterprisePolicyPaths("linux", {})).toEqual([
      "/etc/claude-code/managed-settings.json",
      "/etc/claude-code/managed-settings.d",
    ]);
  });

  it("fails closed without leaking local paths when exact ownership cannot be resolved", async () => {
    const temp = await temporaryDirectory();
    cleanups.push(temp.cleanup);
    const stateDirectory = join(temp.path, "private-state");
    const homeDirectory = join(temp.path, "private-home");
    const apiUrl = "https://shared.hivemnd.cloud/eigen";
    const configPath = join(
      stateDirectory,
      "organizations",
      profileKey(apiUrl),
      "private-config.json",
    );
    const config = {
      apiUrl,
      installationId,
      destinations: [
        {
          name: "claude-global",
          agent: "claude" as const,
          scope: "root" as const,
        },
      ],
    };
    const registry = {
      version: 1,
      profiles: [
        {
          key: profileKey(apiUrl),
          alias: "eigen",
          name: "Eigen",
          slug: "eigen",
          apiUrl,
          configPath,
        },
      ],
      workspaceBindings: [],
      globalBindings: [
        { client: "claude" as const, organizationKey: profileKey(apiUrl) },
      ],
    };
    const registryPath = join(stateDirectory, "registry.json");
    await writeJson(configPath, config);
    await writeJson(registryPath, registry);
    const adapter = createFilesystemAdapters(
      config,
      [],
      homeDirectory,
      stateDirectory,
    )[0]!;
    const body = bytes("# Private Team Skill\n");
    const ownership = {
      relativePath: "skills/team/SKILL.md",
      logicalId: "00000000-0000-4000-8000-000000000030",
      artifactVersionId: "00000000-0000-4000-8000-000000000031",
      sha256: hash(body),
      releaseId: "release-1",
    };
    await adapter.write(ownership.relativePath, body);
    await adapter.replaceOwnership([ownership]);
    const payload = {
      hook_event_name: "UserPromptExpansion",
      session_id: "private-session",
      transcript_path: join(temp.path, "private-transcript.jsonl"),
      cwd: temp.path,
      permission_mode: "default",
      expansion_type: "slash_command",
      command_name: "team",
      command_args: "private arguments",
      command_source: "custom",
      prompt: "private prompt",
    };
    const hookArguments = [
      "context",
      "skill-activated",
      "--client",
      "claude",
      "--state-directory",
      stateDirectory,
      "--scope",
      "global",
      "--hivemnd-managed-hook",
      "2",
    ];
    const output = captureOutput();
    const dependencies = {
      ...defaultDependencies,
      cwd: temp.path,
      homeDirectory,
      environment: {
        ...defaultDependencies.environment,
        HIVEMND_HOME: stateDirectory,
      },
      output,
      readHookInput: async () => JSON.stringify(payload),
    };
    const outbox = new UsageReceiptOutbox({
      stateDirectory,
      apiUrl,
      installationId,
    });
    const expectUnavailable = async (
      expected: "ambiguous" | "modified",
    ): Promise<void> => {
      output.errors.length = 0;
      await expect(runCli(hookArguments, dependencies)).resolves.toBe(0);
      expect(output.errors).toEqual([
        `Claude Skill receipt unavailable: ${expected}`,
      ]);
      expect(output.errors.join("\n")).not.toContain(temp.path);
      expect(output.errors.join("\n")).not.toMatch(
        /private-(?:state|home|config|transcript|session)|private prompt|private arguments/i,
      );
      await expect(outbox.pending()).resolves.toEqual([]);
    };

    await writeFile(registryPath, "not-json\n");
    await expectUnavailable("ambiguous");
    await writeJson(registryPath, registry);

    await writeFile(configPath, "not-json\n");
    await expectUnavailable("ambiguous");
    await writeJson(configPath, {
      ...config,
      destinations: [
        ...config.destinations,
        { ...config.destinations[0]!, name: "same-claude-root" },
      ],
    });
    await expectUnavailable("ambiguous");
    await writeJson(configPath, config);

    const ownershipPath = join(
      stateDirectory,
      "destinations",
      profileKey(apiUrl),
      "claude-global",
      "ownership.json",
    );
    await writeFile(ownershipPath, "not-json\n");
    await expectUnavailable("ambiguous");
    await rm(ownershipPath);
    await adapter.replaceOwnership([ownership]);

    const skillPath = join(adapter.root, ownership.relativePath);
    await rm(skillPath);
    await symlink(join(temp.path, "private-unreadable-target"), skillPath);
    await expectUnavailable("modified");
  });

  it("stages only an exact owned slash command without sensitive hook input", async () => {
    const temp = await temporaryDirectory();
    cleanups.push(temp.cleanup);
    const stateDirectory = join(temp.path, "state");
    const homeDirectory = join(temp.path, "home");
    const apiUrl = "https://shared.hivemnd.cloud/eigen";
    const config = {
      apiUrl,
      installationId,
      destinations: [
        {
          name: "claude-global",
          agent: "claude" as const,
          scope: "root" as const,
        },
      ],
    };
    const configPath = join(
      stateDirectory,
      "organizations",
      profileKey(apiUrl),
      "config.json",
    );
    await import("./helpers.js").then(({ writeJson }) =>
      writeJson(configPath, config),
    );
    await import("./helpers.js").then(({ writeJson }) =>
      writeJson(join(stateDirectory, "registry.json"), {
        version: 1,
        profiles: [
          {
            key: profileKey(apiUrl),
            alias: "eigen",
            name: "Eigen",
            slug: "eigen",
            apiUrl,
            configPath,
          },
        ],
        workspaceBindings: [],
        globalBindings: [
          { client: "claude", organizationKey: profileKey(apiUrl) },
        ],
      }),
    );
    const adapter = createFilesystemAdapters(
      config,
      [],
      homeDirectory,
      stateDirectory,
    )[0]!;
    const body = bytes("# Team Skill\n");
    await adapter.write("skills/team/SKILL.md", body);
    await adapter.replaceOwnership([
      {
        relativePath: "skills/team/SKILL.md",
        logicalId: "00000000-0000-4000-8000-000000000030",
        artifactVersionId: "00000000-0000-4000-8000-000000000031",
        sha256: hash(body),
        releaseId: "release-1",
      },
    ]);
    const payload = {
      hook_event_name: "UserPromptExpansion",
      session_id: "private-session",
      transcript_path: "/secret/transcript",
      cwd: temp.path,
      permission_mode: "default",
      expansion_type: "slash_command",
      command_name: "team",
      command_args: "secret args",
      command_source: "custom",
      prompt: "secret prompt",
    };
    await expect(
      stageClaudeSkillActivation({
        scope: "global",
        stateDirectory,
        homeDirectory,
        input: JSON.stringify(payload),
      }),
    ).resolves.toBe("staged");
    const pending = await new UsageReceiptOutbox({
      stateDirectory,
      apiUrl,
      installationId,
    }).pending();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      eventKind: "skill_activated",
      agentHost: "claude",
      items: [{ artifactKind: "skill" }],
    });
    expect(JSON.stringify(pending)).not.toMatch(
      /secret|prompt|command_args|transcript|session|activationMode|cwd|path/i,
    );
    const workspacePath = join(temp.path, "repo");
    await mkdir(workspacePath);
    const scopedConfig = {
      ...config,
      destinations: [
        ...config.destinations,
        {
          name: "claude-workspace",
          agent: "claude" as const,
          scope: "workspace" as const,
          path: workspacePath,
        },
      ],
    };
    await import("./helpers.js").then(({ writeJson }) =>
      writeJson(configPath, scopedConfig),
    );
    await import("./helpers.js").then(({ writeJson }) =>
      writeJson(join(stateDirectory, "registry.json"), {
        version: 1,
        profiles: [
          {
            key: profileKey(apiUrl),
            alias: "eigen",
            name: "Eigen",
            slug: "eigen",
            apiUrl,
            configPath,
          },
        ],
        workspaceBindings: [
          { path: workspacePath, organizationKey: profileKey(apiUrl) },
        ],
        globalBindings: [
          { client: "claude", organizationKey: profileKey(apiUrl) },
        ],
      }),
    );
    const workspaceAdapter = createFilesystemAdapters(
      scopedConfig,
      ["claude-workspace"],
      homeDirectory,
      stateDirectory,
    )[0]!;
    await workspaceAdapter.write("skills/team/SKILL.md", body);
    await workspaceAdapter.replaceOwnership([
      {
        relativePath: "skills/team/SKILL.md",
        logicalId: "00000000-0000-4000-8000-000000000040",
        artifactVersionId: "00000000-0000-4000-8000-000000000041",
        sha256: hash(body),
        releaseId: "release-1",
      },
    ]);
    await expect(
      stageClaudeSkillActivation({
        scope: "workspace",
        workspace: workspacePath,
        stateDirectory,
        homeDirectory,
        input: JSON.stringify({
          ...payload,
          cwd: join(workspacePath, "src"),
        }),
      }),
    ).resolves.toBe("staged");
    expect(
      (
        await new UsageReceiptOutbox({
          stateDirectory,
          apiUrl,
          installationId,
        }).pending()
      )[1]?.items[0]?.artifactVersionId,
    ).toBe("00000000-0000-4000-8000-000000000031");
    // A personal skill still wins when it is outside this tenant's destinations.
    await writeJson(configPath, {
      ...scopedConfig,
      destinations: scopedConfig.destinations.filter(
        (destination) => destination.scope !== "root",
      ),
    });
    const workspaceActivation = {
      scope: "workspace" as const,
      workspace: workspacePath,
      stateDirectory,
      homeDirectory,
      enterprisePolicyPaths: [],
      input: JSON.stringify({ ...payload, cwd: workspacePath }),
    };
    await expect(stageClaudeSkillActivation(workspaceActivation)).resolves.toBe(
      "unmanaged",
    );
    const outbox = new UsageReceiptOutbox({
      stateDirectory,
      apiUrl,
      installationId,
    });
    expect(await outbox.pending()).toHaveLength(2);
    await rm(join(adapter.root, "skills/team/SKILL.md"));
    await expect(stageClaudeSkillActivation(workspaceActivation)).resolves.toBe(
      "staged",
    );
    expect((await outbox.pending()).at(-1)?.items[0]?.artifactVersionId).toBe(
      "00000000-0000-4000-8000-000000000041",
    );
    expect(JSON.stringify(await outbox.pending())).not.toMatch(
      /private|prompt|command_args|transcript|session|cwd|path/i,
    );
    await adapter.write("skills/team/SKILL.md", body);
    await writeJson(configPath, scopedConfig);
    await adapter.write("skills/unknown/SKILL.md", bytes("unmanaged"));
    await expect(
      stageClaudeSkillActivation({
        scope: "global",
        stateDirectory,
        homeDirectory,
        input: JSON.stringify({ ...payload, expansion_type: "implicit" }),
      }),
    ).resolves.toBe("unsupported");
    await expect(
      stageClaudeSkillActivation({
        scope: "global",
        stateDirectory,
        homeDirectory,
        input: JSON.stringify({
          ...payload,
          command_name: "plugin-name:team",
        }),
      }),
    ).resolves.toBe("plugin_override");
    await expect(
      stageClaudeSkillActivation({
        scope: "global",
        stateDirectory,
        homeDirectory,
        input: JSON.stringify({ ...payload, command_source: "plugin" }),
      }),
    ).resolves.toBe("plugin_override");
    await expect(
      stageClaudeSkillActivation({
        scope: "global",
        stateDirectory,
        homeDirectory,
        input: JSON.stringify({ ...payload, command_source: "builtin" }),
      }),
    ).resolves.toBe("unsupported");
    for (const candidate of [
      JSON.stringify({ ...payload, cwd: "relative" }),
      JSON.stringify({ ...payload, command_name: "/bad slug" }),
      JSON.stringify({ ...payload, command_name: "/unknown" }),
      JSON.stringify({ ...payload, command_name: "/missing" }),
      "x".repeat(65 * 1024),
    ]) {
      await expect(
        stageClaudeSkillActivation({
          scope: "global",
          stateDirectory,
          homeDirectory,
          input: candidate,
        }),
      ).resolves.toMatch(/unsupported|unmanaged/);
    }
    await expect(
      stageClaudeSkillActivation({
        scope: "global",
        stateDirectory,
        homeDirectory,
        input: "not-json",
      }),
    ).resolves.toBe("unsupported");
    await adapter.write("skills/team/SKILL.md", bytes("modified"));
    await expect(
      stageClaudeSkillActivation({
        scope: "global",
        stateDirectory,
        homeDirectory,
        input: JSON.stringify(payload),
      }),
    ).resolves.toBe("modified");
    await adapter.write("skills/team/SKILL.md", body);
    const enterprisePolicy = join(temp.path, "managed-settings.json");
    await writeFile(enterprisePolicy, "{}\n");
    await expect(
      stageClaudeSkillActivation({
        scope: "global",
        stateDirectory,
        homeDirectory,
        enterprisePolicyPaths: [enterprisePolicy],
        input: JSON.stringify(payload),
      }),
    ).resolves.toBe("enterprise_override");
    await expect(
      stageClaudeSkillActivation({
        scope: "global",
        stateDirectory,
        homeDirectory,
        enterprisePolicyPaths: ["\0"],
        input: JSON.stringify(payload),
      }),
    ).resolves.toBe("enterprise_override");
    expect(
      await new UsageReceiptOutbox({
        stateDirectory,
        apiUrl,
        installationId,
      }).pending(),
    ).toHaveLength(3);
    const usageOutbox = new UsageReceiptOutbox({
      stateDirectory,
      apiUrl,
      installationId,
    });
    await chmod(usageOutbox.root, 0o777);
    await expect(
      stageClaudeSkillActivation({
        scope: "global",
        stateDirectory,
        homeDirectory,
        enterprisePolicyPaths: [],
        input: JSON.stringify(payload),
      }),
    ).resolves.toBe("staging_failed");
    const hookArguments = [
      "context",
      "skill-activated",
      "--client",
      "claude",
      "--state-directory",
      stateDirectory,
      "--scope",
      "global",
      "--hivemnd-managed-hook",
      "2",
    ];
    const output = captureOutput();
    const hookDependencies = {
      ...defaultDependencies,
      cwd: temp.path,
      homeDirectory,
      environment: {
        ...defaultDependencies.environment,
        HIVEMND_HOME: stateDirectory,
      },
      output,
      readHookInput: async () => JSON.stringify(payload),
    };
    await expect(runCli(hookArguments, hookDependencies)).resolves.toBe(2);
    expect(output.errors).toEqual([
      "[SKILL_RECEIPT_REQUIRED] Claude Skill receipt staging failed",
    ]);
    output.errors.length = 0;
    await expect(
      runCli(hookArguments, {
        ...hookDependencies,
        readHookInput: async () =>
          JSON.stringify({ ...payload, command_name: "plugin-name:team" }),
      }),
    ).resolves.toBe(0);
    expect(output.errors).toEqual([
      "Claude Skill receipt unavailable: plugin_override",
    ]);
    await chmod(usageOutbox.root, 0o700);
    await import("./helpers.js").then(({ writeJson }) =>
      writeJson(configPath, { ...config, destinations: [] }),
    );
    await expect(
      stageClaudeSkillActivation({
        scope: "global",
        stateDirectory,
        homeDirectory,
        input: JSON.stringify(payload),
      }),
    ).resolves.toBe("unmanaged");
  });
});
