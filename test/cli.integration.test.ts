import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { homedir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFilesystemAdapters } from "../src/agents/destinations.js";
import {
  defaultDependencies,
  runCli,
  type RuntimeDependencies,
} from "../src/cli.js";
import { parseEnrollmentUrl } from "../src/auth/enrollment-url.js";
import { ConfigRepository } from "../src/config.js";
import { createProgram } from "../src/cli/program.js";
import {
  resolveCliScriptPath,
  resolveUserId,
} from "../src/runtime/defaults.js";
import type {
  ApiClient,
  HivemndConfig,
  ManifestArtifact,
  TokenStore,
} from "../src/domain.js";
import { AlwaysContextCache } from "../src/context/always-context-cache.js";
import { profileKey } from "../src/organizations/registry.js";
import { prepared } from "./helpers.js";
import {
  api,
  captureOutput,
  config,
  temporaryDirectory,
  writeJson,
} from "./helpers.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  vi.restoreAllMocks();
});

async function setup(
  overrides: Partial<RuntimeDependencies> & {
    selectedConfig?: HivemndConfig;
    selectedApi?: ApiClient;
    selectedStore?: TokenStore;
  } = {},
) {
  const temp = await temporaryDirectory();
  cleanups.push(temp.cleanup);
  const selectedConfig = overrides.selectedConfig ?? config(temp.path);
  await writeJson(join(temp.path, ".hivemnd/config.json"), selectedConfig);
  const selectedApi = overrides.selectedApi ?? api();
  const selectedStore =
    overrides.selectedStore ??
    ({
      get: async () => ({ value: "token", source: "environment" as const }),
      save: async () => undefined,
    } satisfies TokenStore);
  const output = captureOutput();
  const environment = {
    HIVEMND_HOME: join(temp.path, ".hivemnd"),
    ...overrides.environment,
  };
  const deps: RuntimeDependencies & { output: typeof output } = {
    cwd: temp.path,
    homeDirectory: join(temp.path, "home"),
    prompt: { interactive: false, input: vi.fn(), confirm: vi.fn() },
    readHookInput: async () => "",
    configRepositoryFactory: (cwd) => new ConfigRepository(cwd),
    tokenStoreFactory: () => selectedStore,
    apiClientFactory: () => selectedApi,
    adapterFactory: (value, destinationNames) =>
      createFilesystemAdapters(
        value,
        destinationNames,
        join(temp.path, "home"),
        join(temp.path, ".hivemnd"),
      ),
    targetAccess: async () => undefined,
    id: () => "receipt-id",
    clientPlatform: "test-platform",
    clientVersion: "9.8.7-test",
    clientFeatures: ["exact-delivery-targets-v1"],
    updateService: {
      check: async () => ({
        checked: false,
        currentVersion: "9.8.7-test",
        updateAvailable: false,
        command: "npm install --global @hivemnd-ai/cli@latest",
      }),
    },
    scheduleManagerFactory: () => ({
      install: async (intervalMinutes) => ({
        identity: "test",
        installed: true,
        active: true,
        intervalMinutes,
        lastRunFailed: undefined,
        errorLogPath: "/tmp/hivemnd.error.log",
      }),
      status: async () => ({
        identity: "test",
        installed: false,
        active: false,
        intervalMinutes: 15,
        lastRunFailed: false,
        errorLogPath: "/tmp/hivemnd.error.log",
      }),
      remove: async () => ({
        identity: "test",
        installed: false,
        active: false,
        intervalMinutes: 15,
        lastRunFailed: false,
        errorLogPath: "/tmp/hivemnd.error.log",
      }),
    }),
    ...overrides,
    environment,
    output,
  };
  return { temp, deps, selectedConfig, selectedApi, selectedStore };
}

describe("configuration commands", () => {
  it("initializes and manages named root, workspace, and explicit directory destinations", async () => {
    const { temp, deps } = await setup();
    const newPath = join(temp.path, "new.json");
    await expect(
      runCli(
        [
          "--config",
          newPath,
          "config",
          "init",
          "--api-url",
          "https://company.test",
        ],
        deps,
      ),
    ).resolves.toBe(0);
    expect(JSON.parse(await readFile(newPath, "utf8"))).toEqual({
      apiUrl: "https://company.test",
      destinations: [],
    });
    await expect(
      runCli(
        [
          "--config",
          newPath,
          "config",
          "destination",
          "add",
          "codex-global",
          "--agent",
          "codex",
          "--scope",
          "root",
        ],
        deps,
      ),
    ).resolves.toBe(0);
    await expect(
      runCli(
        [
          "--config",
          newPath,
          "config",
          "destination",
          "add",
          "claude-api",
          "--agent",
          "claude",
          "--scope",
          "workspace",
          "--path",
          "services/api",
        ],
        deps,
      ),
    ).resolves.toBe(0);
    await expect(
      runCli(
        [
          "--config",
          newPath,
          "config",
          "destination",
          "add",
          "codex-custom",
          "--agent",
          "codex",
          "--scope",
          "directory",
          "--path",
          "/managed/codex-skills-root",
        ],
        deps,
      ),
    ).resolves.toBe(0);
    expect(JSON.parse(await readFile(newPath, "utf8"))).toEqual({
      apiUrl: "https://company.test",
      destinations: [
        { name: "codex-global", agent: "codex", scope: "root" },
        {
          name: "claude-api",
          agent: "claude",
          scope: "workspace",
          path: join(temp.path, "services/api"),
        },
        {
          name: "codex-custom",
          agent: "codex",
          scope: "directory",
          path: "/managed/codex-skills-root",
        },
      ],
    });
    deps.output.messages.length = 0;
    await expect(
      runCli(["--config", newPath, "config", "show"], deps),
    ).resolves.toBe(0);
    expect(deps.output.messages).toEqual([
      "api: https://company.test",
      "codex-global | codex | root",
      `claude-api | claude | workspace | ${join(temp.path, "services/api")}`,
      "codex-custom | codex | directory | /managed/codex-skills-root",
    ]);
    await expect(
      runCli(
        [
          "--config",
          newPath,
          "config",
          "destination",
          "remove",
          "codex-custom",
        ],
        deps,
      ),
    ).resolves.toBe(0);
    expect(
      (
        JSON.parse(await readFile(newPath, "utf8")) as {
          destinations: unknown[];
        }
      ).destinations,
    ).toHaveLength(2);
  });

  it("rejects invalid destination options, duplicate names, and unknown removals", async () => {
    const { temp, deps } = await setup();
    const path = join(temp.path, "empty.json");
    await expect(
      runCli(
        [
          "--config",
          path,
          "config",
          "init",
          "--api-url",
          "https://company.test",
        ],
        deps,
      ),
    ).resolves.toBe(0);
    await expect(
      runCli(
        [
          "--config",
          path,
          "config",
          "destination",
          "add",
          "bad",
          "--agent",
          "codex",
          "--scope",
          "workspace",
        ],
        deps,
      ),
    ).resolves.toBe(1);
    await expect(
      runCli(
        [
          "--config",
          path,
          "config",
          "destination",
          "add",
          "invalid-agent",
          "--agent",
          "cursor",
          "--scope",
          "root",
        ],
        deps,
      ),
    ).resolves.toBe(1);
    await expect(
      runCli(
        [
          "--config",
          path,
          "config",
          "destination",
          "add",
          "invalid-scope",
          "--agent",
          "codex",
          "--scope",
          "team",
        ],
        deps,
      ),
    ).resolves.toBe(1);
    await expect(
      runCli(
        [
          "--config",
          path,
          "config",
          "destination",
          "add",
          "root",
          "--agent",
          "codex",
          "--scope",
          "root",
          "--path",
          "/not-allowed",
        ],
        deps,
      ),
    ).resolves.toBe(1);
    await expect(
      runCli(
        ["--config", path, "config", "destination", "remove", "missing"],
        deps,
      ),
    ).resolves.toBe(1);
  });
});

describe("workspace onboarding command", () => {
  it("adds all enabled AI tools to a canonical workspace idempotently and prints a shell-safe next step", async () => {
    const { temp, deps } = await setup();
    const workspace = join(temp.path, "my team's repo");
    await mkdir(workspace);
    const canonicalWorkspace = await realpath(workspace);

    await expect(
      runCli(["workspace", "add", "my team's repo", "--apply"], deps),
    ).resolves.toBe(0);
    await expect(
      readFile(
        join(canonicalWorkspace, ".agents/skills/team/SKILL.md"),
        "utf8",
      ),
    ).resolves.toBe("# Team skill\n");
    await expect(
      readFile(
        join(canonicalWorkspace, ".claude/skills/team/SKILL.md"),
        "utf8",
      ),
    ).resolves.toBe("# Team skill\n");
    await expect(
      runCli(["workspace", "add", "my team's repo", "--apply"], deps),
    ).resolves.toBe(0);

    const saved = await new ConfigRepository(temp.path).load(
      join(temp.path, ".hivemnd/config.json"),
    );
    expect(
      saved.destinations.filter(
        (destination) => destination.path === canonicalWorkspace,
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ agent: "codex", scope: "workspace" }),
        expect.objectContaining({ agent: "claude", scope: "workspace" }),
      ]),
    );
    expect(
      saved.destinations.filter(
        (destination) => destination.path === canonicalWorkspace,
      ),
    ).toHaveLength(2);
    expect(deps.output.messages).toContain(
      `Run hivemnd sync --apply '${canonicalWorkspace.replaceAll("'", `'"'"'`)}'`,
    );
  });

  it("rejects missing workspaces and organizations without enabled AI tools without rewriting config", async () => {
    const missing = await setup();
    const before = await readFile(
      join(missing.temp.path, ".hivemnd/config.json"),
      "utf8",
    );
    await expect(
      runCli(["workspace", "add", "missing"], missing.deps),
    ).resolves.toBe(1);
    expect(
      await readFile(join(missing.temp.path, ".hivemnd/config.json"), "utf8"),
    ).toBe(before);

    const disabled = await setup({
      selectedApi: {
        ...api(),
        clientConfiguration: async () => ({
          organization: { name: "Eigen", slug: "eigen" },
          enabledClients: [],
        }),
      },
    });
    await expect(
      runCli(["workspace", "add", "."], disabled.deps),
    ).resolves.toBe(1);
    expect(disabled.deps.output.errors.at(-1)).toContain("no enabled AI tools");
  });

  it("supports an explicit AI tool subset and reports active automatic sync", async () => {
    const { deps } = await setup({
      scheduleManagerFactory: () => ({
        install: vi.fn(),
        status: async () => ({
          identity: "x",
          installed: true,
          active: true,
          intervalMinutes: 15,
          lastRunFailed: false,
          errorLogPath: "/x",
        }),
        remove: vi.fn(),
      }),
    });
    await expect(
      runCli(["workspace", "add", ".", "--client", "codex", "--apply"], deps),
    ).resolves.toBe(0);
    expect(deps.output.messages).toContain(
      "Automatic sync will include this workspace.",
    );

    await expect(
      runCli(["workspace", "add", ".", "--client", "unknown"], deps),
    ).resolves.toBe(1);
    await expect(
      runCli(["workspace", "add", "--client", "codex", "--apply"], deps),
    ).resolves.toBe(0);
    const disabledApi = {
      ...api(),
      clientConfiguration: async () => ({
        organization: { name: "Eigen", slug: "eigen" },
        enabledClients: ["codex"] as const,
      }),
    };
    const disabled = await setup({ selectedApi: disabledApi });
    await expect(
      runCli(["workspace", "add", ".", "--client", "claude"], disabled.deps),
    ).resolves.toBe(1);
  });
});

describe("init command", () => {
  it("resumes an authenticated config non-interactively and performs the first all-destination sync", async () => {
    const { deps } = await setup();
    await expect(
      runCli(
        [
          "init",
          "--client",
          "codex",
          "--scope",
          "codex=global",
          "--automatic-sync",
          "skip",
          "--apply",
        ],
        deps,
      ),
    ).resolves.toBe(0);
    expect(deps.output.messages).toContain("Connected to Eigen.");
    expect(deps.output.messages).toContain("applied: 3 change(s)");
  });

  it("activates from the environment, configures repeated clients, and installs automatic sync", async () => {
    let token: string | undefined;
    const save = vi.fn(async (value: string) => {
      token = value;
    });
    const install = vi.fn(async (intervalMinutes: number) => ({
      identity: "x",
      installed: true,
      active: true,
      intervalMinutes,
      lastRunFailed: false,
      errorLogPath: "/x",
    }));
    const { temp, deps } = await setup({
      environment: {
        HIVEMND_ACTIVATION_URL:
          "https://shared.hivemnd.cloud/eigen/enroll?token=hidden",
      },
      selectedStore: {
        get: async () =>
          token ? { value: token, source: "keychain" as const } : undefined,
        save,
        supportsPersistentStorage: () => true,
      },
      scheduleManagerFactory: () => ({
        install,
        status: async () => ({
          identity: "x",
          installed: false,
          active: false,
          intervalMinutes: 15,
          lastRunFailed: undefined,
          errorLogPath: "/x",
        }),
        remove: vi.fn(),
      }),
    });
    const freshConfig = join(temp.path, "fresh.json");
    await expect(
      runCli(
        [
          "--config",
          freshConfig,
          "init",
          "--client",
          "codex",
          "--client",
          "claude",
          "--scope",
          "codex=global",
          "--scope",
          "claude=skip",
          "--automatic-sync",
          "install",
          "--adopt-existing",
          "--apply",
        ],
        {
          ...deps,
          environment: {
            HIVEMND_ACTIVATION_URL: deps.environment.HIVEMND_ACTIVATION_URL!,
          },
        },
      ),
    ).resolves.toBe(0);
    expect(save).toHaveBeenCalledWith("enrolled-token");
    expect(install).toHaveBeenCalledWith(15);
    expect(deps.output.messages.join(" ")).not.toContain("hidden");

    await expect(
      runCli(["init", "--automatic-sync", "later"], deps),
    ).resolves.toBe(1);
  });

  it("requires an explicit automatic-sync choice headlessly", async () => {
    const { deps } = await setup({
      selectedStore: {
        get: async () => ({ value: "stored", source: "keychain" }),
        save: vi.fn(),
        supportsPersistentStorage: () => true,
      },
    });
    await expect(
      runCli(
        ["init", "--client", "codex", "--scope", "codex=skip", "--apply"],
        deps,
      ),
    ).resolves.toBe(1);
    expect(deps.output.errors.at(-1)).toContain("--automatic-sync");
  });
});

describe("authentication and diagnostics commands", () => {
  it("validates and stores direct and enrollment tokens without printing secrets", async () => {
    const save = vi.fn(async () => undefined);
    const exchangeEnrollment = vi.fn(async () => ({
      accessToken: "enrolled-secret",
      installationId: "installation-1",
    }));
    const { deps } = await setup({
      environment: { HIVEMND_TOKEN: "environment-secret" },
      selectedStore: { get: async () => undefined, save },
      selectedApi: { ...api(), exchangeEnrollment },
    });

    await expect(runCli(["login"], deps)).resolves.toBe(0);
    expect(save).toHaveBeenCalledWith("environment-secret");
    await expect(
      runCli(
        [
          "login",
          "--enrollment-url",
          "https://shared.hivemnd.cloud/eigen/login?token=one-time",
        ],
        deps,
      ),
    ).resolves.toBe(0);
    expect(exchangeEnrollment).toHaveBeenCalledWith("one-time", {
      clientKind: "hivemnd_cli",
      platform: "test-platform",
      clientVersion: "9.8.7-test",
    });
    expect(save).toHaveBeenCalledWith("enrolled-secret");
    expect(deps.output.messages.join(" ")).not.toContain("secret");
  });

  it("rejects ambiguous, absent, malformed, foreign, and tokenless enrollment input", async () => {
    const { deps } = await setup({
      selectedStore: {
        get: async () => undefined,
        save: async () => undefined,
      },
    });
    await expect(
      runCli(
        [
          "login",
          "--token",
          "x",
          "--enrollment-url",
          "https://hivemnd.test/?token=x",
        ],
        deps,
      ),
    ).resolves.toBe(1);
    await expect(runCli(["login"], deps)).resolves.toBe(1);
    await expect(runCli(["auth"], deps)).resolves.toBe(1);
    expect(() =>
      parseEnrollmentUrl("not a URL", "https://hivemnd.test"),
    ).toThrow();
    expect(() =>
      parseEnrollmentUrl("https://evil.test/?token=x", "https://hivemnd.test"),
    ).toThrow();
    expect(() =>
      parseEnrollmentUrl(
        "https://shared.hivemnd.cloud/other/login?token=x",
        "https://shared.hivemnd.cloud/eigen",
      ),
    ).toThrow();
    expect(
      parseEnrollmentUrl(
        "https://shared.hivemnd.cloud/eigen/login?token=x",
        "https://shared.hivemnd.cloud/eigen",
      ),
    ).toBe("x");
    expect(() =>
      parseEnrollmentUrl("https://hivemnd.test/enroll", "https://hivemnd.test"),
    ).toThrow();
  });

  it("reports status and doctor checks", async () => {
    const { deps, selectedConfig } = await setup();
    for (const destination of selectedConfig.destinations)
      await mkdir(destination.path!, { recursive: true });
    await expect(runCli(["status"], deps)).resolves.toBe(0);
    expect(deps.output.messages.at(-1)).toContain("release release-1");
    deps.output.messages.length = 0;
    await expect(runCli(["doctor"], deps)).resolves.toBe(0);
    expect(deps.output.messages).toEqual([
      "pass config",
      expect.stringMatching(/^pass destination codex-workspace \(codex\)/),
      expect.stringMatching(/^pass destination claude-workspace \(claude\)/),
      "pass credential (environment)",
      "pass API (release release-1)",
    ]);
  });

  it("fails doctor on inaccessible targets and status without credentials", async () => {
    const inaccessible = await setup({
      targetAccess: async () => Promise.reject(new Error("denied")),
    });
    await expect(runCli(["doctor"], inaccessible.deps)).resolves.toBe(1);
    expect(inaccessible.deps.output.errors[0]).toContain(
      "Destination is not readable and writable",
    );
    const missing = await setup({
      selectedStore: {
        get: async () => undefined,
        save: async () => undefined,
      },
    });
    await expect(runCli(["status"], missing.deps)).resolves.toBe(1);
    expect(missing.deps.output.errors[0]).toContain("[AUTH_MISSING]");

    const empty = await setup({
      selectedConfig: {
        apiUrl: "https://hivemnd.test",
        destinations: [],
      },
    });
    await expect(runCli(["doctor"], empty.deps)).resolves.toBe(1);
    expect(empty.deps.output.errors.at(-1)).toContain(
      "No synchronization destinations",
    );
    await expect(
      runCli(["sync", "--all", "--apply"], empty.deps),
    ).resolves.toBe(0);
    expect(empty.deps.output.messages.at(-1)).toBe("applied: 0 change(s)");
    empty.deps.output.messages.length = 0;
    await expect(runCli(["sync", "--all"], empty.deps)).resolves.toBe(0);
    expect(empty.deps.output.messages).toEqual([
      "dry-run: 0 change(s); no destinations are configured",
    ]);
  });
});

describe("SessionStart context command", () => {
  it("prints verified primary context and validates its managed invocation", async () => {
    const setupResult = await setup();
    const { temp, deps } = setupResult;
    const stateDirectory = deps.environment.HIVEMND_HOME!;
    const apiUrl = "https://shared.hivemnd.cloud/eigen";
    const base = prepared("# Context\n");
    const artifact = {
      ...base.artifacts[0]!,
      kind: "embedded_document" as const,
      relativePath: "context/eigen.md",
    };
    const cache = new AlwaysContextCache({ stateDirectory, apiUrl });
    await cache.apply(await cache.plan({ ...base, artifacts: [artifact] }));
    await writeJson(join(stateDirectory, "registry.json"), {
      version: 1,
      profiles: [
        {
          key: profileKey(apiUrl),
          alias: "eigen",
          name: "EIGEN",
          slug: "eigen",
          apiUrl,
          configPath: join(stateDirectory, "config.json"),
        },
      ],
      workspaceBindings: [],
      globalBindings: [
        { client: "codex", organizationKey: profileKey(apiUrl) },
      ],
    });
    await expect(
      runCli(
        [
          "context",
          "inject",
          "--client",
          "codex",
          "--state-directory",
          stateDirectory,
          "--scope",
          "global",
          "--hivemnd-managed-hook",
          "1",
        ],
        {
          ...deps,
          readHookInput: async () =>
            JSON.stringify({
              hook_event_name: "SessionStart",
              source: "startup",
              cwd: temp.path,
            }),
        },
      ),
    ).resolves.toBe(0);
    expect(deps.output.messages).toContain("# Context\n");
    const messageCount = deps.output.messages.length;
    await expect(
      runCli(
        [
          "context",
          "inject",
          "--client",
          "claude",
          "--state-directory",
          stateDirectory,
          "--scope",
          "global",
          "--hivemnd-managed-hook",
          "1",
        ],
        {
          ...deps,
          readHookInput: async () =>
            JSON.stringify({
              hook_event_name: "SessionStart",
              source: "startup",
              cwd: temp.path,
              agent_id: "subagent",
            }),
        },
      ),
    ).resolves.toBe(0);
    expect(deps.output.messages).toHaveLength(messageCount);
    await expect(
      runCli(
        [
          "context",
          "inject",
          "--client",
          "codex",
          "--state-directory",
          stateDirectory,
          "--scope",
          "workspace",
          "--workspace",
          temp.path,
          "--hivemnd-managed-hook",
          "1",
        ],
        {
          ...deps,
          readHookInput: async () =>
            JSON.stringify({
              hook_event_name: "SessionStart",
              source: "startup",
              cwd: temp.path,
            }),
        },
      ),
    ).resolves.toBe(0);
    expect(deps.output.messages).toHaveLength(messageCount);

    for (const args of [
      [
        "context",
        "inject",
        "--client",
        "other",
        "--state-directory",
        stateDirectory,
        "--scope",
        "global",
        "--hivemnd-managed-hook",
        "1",
      ],
      [
        "context",
        "inject",
        "--client",
        "codex",
        "--state-directory",
        "relative",
        "--scope",
        "global",
        "--hivemnd-managed-hook",
        "1",
      ],
      [
        "context",
        "inject",
        "--client",
        "codex",
        "--state-directory",
        stateDirectory,
        "--scope",
        "global",
        "--hivemnd-managed-hook",
        "2",
      ],
      [
        "context",
        "inject",
        "--client",
        "codex",
        "--state-directory",
        stateDirectory,
        "--scope",
        "other",
        "--hivemnd-managed-hook",
        "1",
      ],
      [
        "context",
        "inject",
        "--client",
        "codex",
        "--state-directory",
        stateDirectory,
        "--scope",
        "workspace",
        "--hivemnd-managed-hook",
        "1",
      ],
    ]) {
      await expect(runCli(args, deps)).resolves.toBe(1);
    }
  });
});

describe("sync command", () => {
  it("reports missing adapters and ignores unowned legacy instruction markers", async () => {
    const missingAdapters = await setup({ adapterFactory: () => [] });
    await expect(
      runCli(["sync", "--all", "--apply"], missingAdapters.deps),
    ).resolves.toBe(1);
    expect(missingAdapters.deps.output.errors.at(-1)).toContain(
      "No synchronization destinations",
    );

    const contextContent = Buffer.from("# Always context\n");
    const baseApi = api();
    const context = await setup({
      selectedApi: {
        ...baseApi,
        manifest: async () => {
          const base = await baseApi.manifest("token");
          return {
            ...base,
            artifacts: [
              {
                ...base.artifacts[0]!,
                kind: "embedded_document",
                relativePath: "context/company.md",
                size: contextContent.byteLength,
                sha256: createHash("sha256")
                  .update(contextContent)
                  .digest("hex"),
              },
            ],
          };
        },
        download: async () => contextContent,
      },
    });
    const codexWorkspace = context.selectedConfig.destinations.find(
      ({ agent }) => agent === "codex",
    )!.path!;
    await mkdir(codexWorkspace, { recursive: true });
    await writeFile(
      join(codexWorkspace, "AGENTS.md"),
      "<!-- BEGIN HIVEMND MANAGED ALWAYS CONTEXT -->\nincomplete",
    );

    await expect(runCli(["sync", "--all"], context.deps)).resolves.toBe(0);
    expect(context.deps.output.messages.join("\n")).not.toContain(
      "managed-context-markers-invalid",
    );
    expect(context.deps.output.messages.at(-1)).toContain(
      "1 change(s); pass --apply",
    );
    const legacyBlock =
      "<!-- BEGIN HIVEMND MANAGED ALWAYS CONTEXT -->\n# Legacy\n<!-- END HIVEMND MANAGED ALWAYS CONTEXT -->";
    await writeFile(join(codexWorkspace, "AGENTS.md"), legacyBlock);
    const [codexAdapter] = context.deps.adapterFactory(context.selectedConfig, [
      "codex-workspace",
    ]);
    await codexAdapter?.replaceOwnership([], {
      blockSha256: createHash("sha256").update(legacyBlock).digest("hex"),
      prefix: "",
      createdFile: true,
    });
    context.deps.output.messages.length = 0;
    await expect(runCli(["sync", "--all"], context.deps)).resolves.toBe(0);
    expect(context.deps.output.messages.join("\n")).toContain(
      "remove    codex-workspace",
    );
    await writeFile(
      join(codexWorkspace, "AGENTS.md"),
      legacyBlock.replace("# Legacy", "# Locally edited"),
    );
    context.deps.output.messages.length = 0;
    await expect(
      runCli(
        [
          "--config",
          join(context.temp.path, ".hivemnd/config.json"),
          "sync",
          "--all",
        ],
        { ...context.deps, environment: {} },
      ),
    ).resolves.toBe(0);
    expect(context.deps.output.messages.join("\n")).toContain(
      "managed-context-block-edited",
    );
  });

  it("keeps legacy scheduled --config sync --apply invocations synchronized across all destinations", async () => {
    const { temp, deps } = await setup();
    const configPath = join(temp.path, ".hivemnd/config.json");

    await expect(
      runCli(["--config", configPath, "sync", "--apply"], deps),
    ).resolves.toBe(0);

    expect(deps.output.messages).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^create\s+codex-workspace/),
        expect.stringMatching(/^create\s+claude-workspace/),
      ]),
    );
  });

  it("rejects an incompatible minimum client version before downloading or planning", async () => {
    const selectedApi = api();
    const download = vi.fn((token: string, artifact: ManifestArtifact) =>
      selectedApi.download(token, artifact),
    );
    const { deps } = await setup({
      clientVersion: "1.2.3",
      selectedApi: {
        ...selectedApi,
        manifest: async () => ({
          ...(await selectedApi.manifest("token")),
          minimumClientVersion: "2.0.0",
        }),
        download,
      },
    });

    await expect(runCli(["sync", "--all", "--apply"], deps)).resolves.toBe(1);
    expect(download).not.toHaveBeenCalled();
    expect(deps.output.errors).toEqual([
      "[CLIENT_UPDATE_REQUIRED] Hivemnd CLI 2.0.0 or newer is required; installed: 1.2.3. Run: npm install --global @hivemnd-ai/cli@latest",
    ]);
  });

  it("rejects an incompatible applicable delivery target before download or ownership reads", async () => {
    const selectedApi = api();
    const download = vi.fn((token: string, artifact: ManifestArtifact) =>
      selectedApi.download(token, artifact),
    );
    const { deps } = await setup({
      clientVersion: "1.2.3",
      selectedApi: {
        ...selectedApi,
        manifest: async () => {
          const current = await selectedApi.manifest("token");
          return {
            ...current,
            artifacts: current.artifacts.map((artifact) => ({
              ...artifact,
              deliveryTargets: [
                {
                  clientKind: "codex",
                  installScope: "workspace",
                  minimumClientVersion: "2.0.0",
                },
                {
                  clientKind: "claude",
                  installScope: "workspace",
                },
              ],
            })),
          };
        },
        download,
      },
    });
    const ownershipRead = vi.fn(async () => []);
    const adapterFactory: RuntimeDependencies["adapterFactory"] = (
      value,
      names,
    ) => {
      const adapters = deps.adapterFactory(value, names);
      for (const adapter of adapters) {
        vi.spyOn(adapter, "readOwnership").mockImplementation(ownershipRead);
      }
      return adapters;
    };

    await expect(
      runCli(["sync", "--destination", "codex-workspace", "--apply"], {
        ...deps,
        adapterFactory,
      }),
    ).resolves.toBe(1);
    expect(download).not.toHaveBeenCalled();
    expect(ownershipRead).not.toHaveBeenCalled();
    expect(deps.output.errors.at(-1)).toContain(
      "Hivemnd CLI 2.0.0 or newer is required",
    );
  });

  it("does not block a selected workspace for an incompatible non-applicable user target", async () => {
    const selectedApi = api();
    const { deps } = await setup({
      clientVersion: "1.2.3",
      selectedApi: {
        ...selectedApi,
        manifest: async () => {
          const current = await selectedApi.manifest("token");
          return {
            ...current,
            artifacts: current.artifacts.map((artifact) => ({
              ...artifact,
              deliveryTargets: [
                {
                  clientKind: "codex",
                  installScope: "user",
                  minimumClientVersion: "2.0.0",
                },
                {
                  clientKind: "claude",
                  installScope: "workspace",
                },
              ],
            })),
          };
        },
      },
    });

    await expect(
      runCli(["sync", "--destination", "codex-workspace"], deps),
    ).resolves.toBe(0);
    expect(deps.output.errors).toEqual([]);
    expect(deps.output.messages.join("\n")).not.toMatch(
      /^create\s+codex-workspace/m,
    );
  });

  it("rejects --all combined with a path or named destination", async () => {
    const { deps } = await setup();
    await expect(runCli(["sync", ".", "--all"], deps)).resolves.toBe(1);
    await expect(
      runCli(["sync", "--all", "--destination", "codex-workspace"], deps),
    ).resolves.toBe(1);
  });

  it("is a dry run by default and recognizes explicit --dry-run", async () => {
    const first = await setup();
    const contextualWorkspace = first.selectedConfig.destinations[0]!.path!;
    await mkdir(contextualWorkspace, { recursive: true });
    await expect(
      runCli(["sync", contextualWorkspace], first.deps),
    ).resolves.toBe(0);
    await expect(runCli(["sync", "--all"], first.deps)).resolves.toBe(0);
    expect(first.deps.output.messages.at(-1)).toBe(
      "dry-run: 2 change(s); pass --apply to write",
    );
    const second = await setup();
    await expect(
      runCli(["sync", "--all", "--dry-run"], second.deps),
    ).resolves.toBe(0);
    expect(second.deps.output.messages.at(-1)).toContain("dry-run");
    await expect(
      runCli(["sync", "--all", "--dry-run", "--apply"], second.deps),
    ).resolves.toBe(1);
  });

  it("shows conflicts without changing unmanaged files", async () => {
    const { deps, selectedConfig } = await setup();
    const target = selectedConfig.destinations[0]!;
    await mkdir(join(target.path!, ".agents/skills/team"), { recursive: true });
    await writeFile(
      join(target.path!, ".agents/skills/team/SKILL.md"),
      "local",
      "utf8",
    );
    await expect(runCli(["sync", "--all"], deps)).resolves.toBe(0);
    expect(
      deps.output.messages.some((message) =>
        /^conflict\s+codex-workspace \(codex\) .*unmanaged-existing-file/.test(
          message,
        ),
      ),
    ).toBe(true);
    expect(deps.output.messages.at(-1)).toContain("1 conflict(s)");
  });

  it("adopts an identical existing skill only when explicitly requested", async () => {
    const { deps, selectedConfig } = await setup();
    const destination = selectedConfig.destinations[0]!;
    const skillPath = join(destination.path!, ".agents/skills/team/SKILL.md");
    await mkdir(join(destination.path!, ".agents/skills/team"), {
      recursive: true,
    });
    await writeFile(skillPath, "# Team skill\n", "utf8");

    await expect(
      runCli(["sync", "--destination", destination.name], deps),
    ).resolves.toBe(0);
    expect(
      deps.output.messages.some((message) => message.startsWith("conflict")),
    ).toBe(true);

    deps.output.messages.length = 0;
    await expect(
      runCli(
        ["sync", "--destination", destination.name, "--adopt-existing"],
        deps,
      ),
    ).resolves.toBe(0);
    expect(
      deps.output.messages.some((message) => message.startsWith("adopt")),
    ).toBe(true);

    deps.output.messages.length = 0;
    await expect(
      runCli(
        [
          "sync",
          "--destination",
          destination.name,
          "--adopt-existing",
          "--apply",
        ],
        deps,
      ),
    ).resolves.toBe(0);
    await expect(readFile(skillPath, "utf8")).resolves.toBe("# Team skill\n");

    deps.output.messages.length = 0;
    await expect(
      runCli(["sync", "--destination", destination.name, "--apply"], deps),
    ).resolves.toBe(0);
    expect(deps.output.messages).toContain("applied: 0 change(s)");
  });

  it("never adopts an existing skill whose content differs", async () => {
    const { deps, selectedConfig } = await setup();
    const destination = selectedConfig.destinations[0]!;
    const skillPath = join(destination.path!, ".agents/skills/team/SKILL.md");
    await mkdir(join(destination.path!, ".agents/skills/team"), {
      recursive: true,
    });
    await writeFile(skillPath, "# Local version\n", "utf8");

    await expect(
      runCli(
        [
          "sync",
          "--destination",
          destination.name,
          "--adopt-existing",
          "--apply",
        ],
        deps,
      ),
    ).resolves.toBe(1);
    expect(deps.output.errors.at(-1)).toContain("SYNC_CONFLICT");
    await expect(readFile(skillPath, "utf8")).resolves.toBe(
      "# Local version\n",
    );
  });

  it("applies idempotently and submits content-free best-effort receipts", async () => {
    const selectedApi = api();
    const { deps, selectedConfig } = await setup({ selectedApi });
    await expect(runCli(["sync", "--all", "--apply"], deps)).resolves.toBe(0);
    expect(deps.output.messages.slice(-2)).toEqual([
      "applied: 2 change(s)",
      "receipt: accepted",
    ]);
    expect(selectedApi.receipts[0]).toMatchObject({
      idempotencyKey: "receipt-id",
      releaseId: "release-1",
    });
    await expect(
      readFile(
        join(
          selectedConfig.destinations[0]!.path!,
          ".agents/skills/team/SKILL.md",
        ),
        "utf8",
      ),
    ).resolves.toBe("# Team skill\n");

    deps.output.messages.length = 0;
    await expect(runCli(["sync", "--all", "--apply"], deps)).resolves.toBe(0);
    expect(deps.output.messages).toContain("applied: 0 change(s)");

    const deferred = await setup({
      selectedApi: {
        ...api(),
        receipt: async () => Promise.reject(new Error("offline")),
      },
    });
    await expect(
      runCli(["sync", "--all", "--apply"], deferred.deps),
    ).resolves.toBe(0);
    expect(deferred.deps.output.messages.at(-1)).toBe(
      "receipt: deferred (SYNC_FAILED)",
    );
  });

  it("synchronizes selected destinations and supports multiple folders for the same agent", async () => {
    const temp = await temporaryDirectory();
    cleanups.push(temp.cleanup);
    const selectedConfig: HivemndConfig = {
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
    const { deps } = await setup({ selectedConfig });

    await expect(
      runCli(["sync", "--destination", "api", "--apply"], deps),
    ).resolves.toBe(0);
    await expect(
      readFile(join(temp.path, "api/.agents/skills/team/SKILL.md"), "utf8"),
    ).resolves.toBe("# Team skill\n");
    await expect(
      readFile(join(temp.path, "web/.agents/skills/team/SKILL.md"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });

    await expect(
      runCli(
        ["sync", "--destination", "api", "--destination", "web", "--apply"],
        deps,
      ),
    ).resolves.toBe(0);
    await expect(
      readFile(join(temp.path, "web/.agents/skills/team/SKILL.md"), "utf8"),
    ).resolves.toBe("# Team skill\n");
    await expect(
      runCli(["sync", "--destination", "missing"], deps),
    ).resolves.toBe(1);
    expect(deps.output.errors.at(-1)).toContain("Unknown destination");
  });
});

describe("source discovery commands", () => {
  const sourceId = "00000000-0000-4000-8000-000000000001";
  const repositorySourceId = "00000000-0000-4000-8000-000000000002";

  it("lists authorized sources and their effective actions", async () => {
    const listSources = vi.fn(async () => [
      {
        id: sourceId,
        name: "Engineering database",
        adapterKind: "postgresql_database" as const,
        status: "active" as const,
        actions: [
          { key: "inspect_schema" as const, status: "available" as const },
          {
            key: "execute_approved_read_query" as const,
            status: "disabled" as const,
          },
        ],
      },
      {
        id: repositorySourceId,
        name: "hivemnd-ai/cli",
        adapterKind: "github_repository" as const,
        status: "active" as const,
        actions: [
          { key: "list_tree" as const, status: "available" as const },
          { key: "read_file" as const, status: "available" as const },
        ],
      },
    ]);
    const { deps } = await setup({ selectedApi: { ...api(), listSources } });

    await expect(runCli(["sources", "list"], deps)).resolves.toBe(0);

    expect(listSources).toHaveBeenCalledWith("token");
    expect(deps.output.messages).toEqual([
      `${sourceId} | Engineering database | postgresql_database | active | inspect_schema:available, execute_approved_read_query:disabled`,
      `${repositorySourceId} | hivemnd-ai/cli | github_repository | active | list_tree:available, read_file:available`,
    ]);
  });

  it("reports an empty authorized source catalog clearly", async () => {
    const { deps } = await setup();

    await expect(runCli(["sources", "list"], deps)).resolves.toBe(0);

    expect(deps.output.messages).toEqual(["No authorized sources."]);
  });

  it("inspects schemas, tables, columns, and empty catalog levels", async () => {
    const inspectSourceSchema = vi.fn(async () => ({
      source: {
        id: sourceId,
        name: "Engineering database",
        adapterKind: "postgresql_database" as const,
      },
      schemas: [
        {
          name: "public",
          tables: [
            {
              name: "users",
              columns: [
                { name: "id", dataType: "uuid", nullable: false },
                {
                  name: "display_name",
                  dataType: "character varying",
                  nullable: true,
                },
              ],
            },
            { name: "audit_events", columns: [] },
          ],
        },
        { name: "empty_schema", tables: [] },
      ],
    }));
    const { deps } = await setup({
      selectedApi: { ...api(), inspectSourceSchema },
    });

    await expect(runCli(["sources", "inspect", sourceId], deps)).resolves.toBe(
      0,
    );

    expect(inspectSourceSchema).toHaveBeenCalledWith("token", sourceId);
    expect(deps.output.messages).toEqual([
      `source: Engineering database (${sourceId})`,
      "adapter: postgresql_database",
      "schema public",
      "  table users",
      "    id: uuid, required",
      "    display_name: character varying, nullable",
      "  table audit_events",
      "    No columns.",
      "schema empty_schema",
      "  No tables.",
    ]);
  });

  it("reports missing schema information and requires credentials", async () => {
    const empty = await setup();
    await expect(
      runCli(["sources", "inspect", sourceId], empty.deps),
    ).resolves.toBe(0);
    expect(empty.deps.output.messages).toContain(
      "No schema information is available.",
    );

    const missing = await setup({
      selectedStore: {
        get: async () => undefined,
        save: async () => undefined,
      },
    });
    await expect(runCli(["sources", "list"], missing.deps)).resolves.toBe(1);
    expect(missing.deps.output.errors).toEqual([
      "[AUTH_MISSING] No token found; use login or set HIVEMND_TOKEN",
    ]);
  });
});

describe("command shell", () => {
  it("does not start automatic update discovery for informational or commandless invocations", async () => {
    const check = vi.fn(async () =>
      Promise.reject(new Error("update discovery must not start")),
    );
    const { deps } = await setup({ updateService: { check } });
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    for (const args of [
      [] as string[],
      ["--version"],
      ["-V"],
      ["--help"],
      ["-h"],
      ["status", "--help"],
      ["--config", "status"],
      ["--config=status"],
    ]) {
      await runCli(args, deps);
    }

    expect(check).not.toHaveBeenCalled();
    expect(deps.output.messages).toEqual([]);
    expect(write).toHaveBeenCalled();
  });

  it("shows a non-silent update notice last and offers an explicit non-mutating update check", async () => {
    const check = vi.fn(
      async ({ force = false }: { readonly force?: boolean } = {}) => ({
        checked: force,
        currentVersion: "9.8.7-test",
        latestVersion: "10.0.0",
        updateAvailable: true,
        command: "npm install --global @hivemnd-ai/cli@latest",
      }),
    );
    const { deps } = await setup({ updateService: { check } });

    await expect(runCli(["status"], deps)).resolves.toBe(0);
    expect(deps.output.messages.at(-1)).toBe(
      "Update available: 9.8.7-test -> 10.0.0. Run: npm install --global @hivemnd-ai/cli@latest",
    );
    expect(check).toHaveBeenLastCalledWith({ force: false });

    deps.output.messages.length = 0;
    await expect(runCli(["update", "check"], deps)).resolves.toBe(0);
    expect(deps.output.messages).toEqual([
      "Update available: 9.8.7-test -> 10.0.0",
      "Update command: npm install --global @hivemnd-ai/cli@latest",
      "Hivemnd does not update itself silently.",
    ]);
    expect(check).toHaveBeenLastCalledWith({ force: true });
  });

  it("never changes command exit behavior when the background update check fails", async () => {
    const { deps } = await setup({
      updateService: {
        check: async () => Promise.reject(new Error("npm offline")),
      },
    });

    await expect(runCli(["status"], deps)).resolves.toBe(0);
    expect(deps.output.errors).toEqual([]);
    expect(deps.output.messages.at(-1)).toContain("release release-1");

    deps.output.messages.length = 0;
    await expect(runCli(["update", "check"], deps)).resolves.toBe(0);
    expect(deps.output.messages).toEqual([
      "Update check unavailable; no changes were made. Retry when npm is reachable.",
    ]);

    const current = await setup({
      updateService: {
        check: async () => ({
          checked: true,
          currentVersion: "9.8.7-test",
          latestVersion: "9.8.7",
          updateAvailable: false,
          command: "npm install --global @hivemnd-ai/cli@latest",
        }),
      },
    });
    await expect(runCli(["update", "check"], current.deps)).resolves.toBe(0);
    expect(current.deps.output.messages[0]).toBe(
      "Hivemnd CLI 9.8.7-test is up to date.",
    );
  });

  it("installs, reports, and removes the selected tenant schedule with an exact config path", async () => {
    const install = vi.fn(async (intervalMinutes: number) => ({
      identity: "tenant-id",
      installed: true,
      active: true,
      intervalMinutes,
      lastRunFailed: undefined,
      errorLogPath: "/tmp/tenant.error.log",
    }));
    const status = vi.fn(async () => ({
      identity: "tenant-id",
      installed: true,
      active: true,
      intervalMinutes: 15,
      lastRunFailed: true,
      errorLogPath: "/tmp/tenant.error.log",
    }));
    const remove = vi.fn(async () => ({
      identity: "tenant-id",
      installed: false,
      active: false,
      intervalMinutes: 15,
      lastRunFailed: false,
      errorLogPath: "/tmp/tenant.error.log",
    }));
    const scheduleManagerFactory = vi.fn(() => ({ install, status, remove }));
    const { temp, deps } = await setup({
      scheduleManagerFactory,
      selectedStore: {
        get: async () => ({ value: "stored", source: "keychain" }),
        save: async () => undefined,
        supportsPersistentStorage: () => true,
      },
    });
    const selectedPath = join(temp.path, "explicit-config.json");
    await writeJson(selectedPath, config(temp.path));

    await expect(
      runCli(
        ["--config", selectedPath, "schedule", "install", "--interval", "30"],
        deps,
      ),
    ).resolves.toBe(0);
    expect(scheduleManagerFactory).toHaveBeenCalledWith({
      apiUrl: "https://shared.hivemnd.cloud/eigen",
      configPath: selectedPath,
    });
    expect(install).toHaveBeenCalledWith(30);
    await expect(
      runCli(["--config", selectedPath, "schedule", "status"], deps),
    ).resolves.toBe(0);
    await expect(
      runCli(["--config", selectedPath, "schedule", "remove"], deps),
    ).resolves.toBe(0);
    expect(deps.output.messages).toContain(
      "schedule tenant-id: installed, active, every 30 minute(s)",
    );
    expect(deps.output.messages).toContain(
      "schedule tenant-id: installed, active, every 15 minute(s); last run failed; inspect: /tmp/tenant.error.log",
    );
    expect(deps.output.messages).toContain("schedule tenant-id: removed");

    for (const interval of ["0", "1.5", "1441", "invalid"]) {
      await expect(
        runCli(["schedule", "install", "--interval", interval], deps),
      ).resolves.toBe(1);
    }

    const relativeConfig = "relative-config.json";
    await writeJson(join(temp.path, relativeConfig), config(temp.path));
    await expect(
      runCli(["--config", relativeConfig, "schedule", "status"], deps),
    ).resolves.toBe(0);
    expect(scheduleManagerFactory).toHaveBeenLastCalledWith({
      apiUrl: "https://shared.hivemnd.cloud/eigen",
      configPath: join(temp.path, relativeConfig),
    });

    const notInstalled = await setup();
    await expect(
      runCli(["schedule", "status"], notInstalled.deps),
    ).resolves.toBe(0);
    expect(notInstalled.deps.output.messages).toContain(
      "schedule test: not installed, inactive, every 15 minute(s)",
    );
  });

  it("refuses automatic sync when credentials are not persistently secured", async () => {
    const { deps } = await setup();
    await expect(runCli(["schedule", "install"], deps)).resolves.toBe(1);
    expect(deps.output.errors.at(-1)).toContain("persistent secure storage");
  });

  it("prints the injected package version without loading configuration", async () => {
    const { deps } = await setup({
      configRepositoryFactory: () => {
        throw new Error("version must not load configuration");
      },
    });
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);

    await expect(runCli(["--version"], deps)).resolves.toBe(0);

    expect(write.mock.calls.map(([value]) => String(value)).join("")).toBe(
      "9.8.7-test\n",
    );
  });

  it("handles help and normalizes unknown failures", async () => {
    const { deps } = await setup();
    const write = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    await expect(runCli(["--help"], deps)).resolves.toBe(0);
    expect(write).toHaveBeenCalled();
    write.mockClear();
    await expect(runCli(["login", "--help"], deps)).resolves.toBe(0);
    const authenticationHelp = write.mock.calls
      .map(([value]) => String(value))
      .join("");
    expect(authenticationHelp).toContain("login");
    expect(authenticationHelp).toContain("--enrollment-url");
    expect(authenticationHelp).toContain("--token");
    write.mockClear();
    await expect(runCli(["config", "init", "--help"], deps)).resolves.toBe(0);
    const configurationHelp = write.mock.calls
      .map(([value]) => String(value))
      .join("");
    expect(configurationHelp).toContain("customer Hivemnd URL");
    const broken = {
      ...deps,
      configRepositoryFactory: () => ({
        load: async () => Promise.reject("unknown"),
        loadOptional: async () => Promise.reject("unknown"),
      }),
    };
    await expect(
      runCli(["status"], broken as unknown as RuntimeDependencies),
    ).resolves.toBe(1);
    expect(deps.output.errors.at(-1)).toContain("Unknown error");
  });

  it("defaults to ~/.hivemnd/config.json, honors HIVEMND_CONFIG, and wires production factories", async () => {
    const { temp, deps } = await setup();
    const custom = join(temp.path, "custom.json");
    await writeJson(custom, config(temp.path));
    deps.environment.HIVEMND_CONFIG = custom;
    await expect(runCli(["status"], deps)).resolves.toBe(0);

    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const error = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    defaultDependencies.output.write("message");
    defaultDependencies.output.error("problem");
    expect(
      defaultDependencies.configRepositoryFactory(temp.path),
    ).toBeDefined();
    expect(
      defaultDependencies.tokenStoreFactory(config(temp.path)),
    ).toBeDefined();
    expect(
      defaultDependencies.apiClientFactory(config(temp.path)),
    ).toBeDefined();
    expect(
      defaultDependencies.adapterFactory(config(temp.path), []),
    ).toHaveLength(2);
    await expect(
      defaultDependencies.targetAccess(temp.path),
    ).resolves.toBeUndefined();
    expect(defaultDependencies.id()).toMatch(/^[\da-f-]+$/);
    expect(defaultDependencies.clientPlatform).toBe(
      `${process.platform}-${process.arch}`,
    );
    expect(defaultDependencies.clientVersion).toBe("0.3.2");
    expect(
      defaultDependencies.scheduleManagerFactory({
        apiUrl: "https://shared.hivemnd.cloud/eigen",
        configPath: join(temp.path, "config.json"),
      }),
    ).toBeDefined();
    expect(resolveUserId(() => 501)).toBe(501);
    expect(resolveUserId(undefined)).toBe(0);
    expect(resolveCliScriptPath("/usr/local/lib/hivemnd/dist/index.js")).toBe(
      "/usr/local/lib/hivemnd/dist/index.js",
    );
    expect(resolveCliScriptPath(undefined)).toBe(
      join(process.cwd(), "hivemnd"),
    );
    const defaultPath = createProgram({ ...deps, environment: {} }).opts<{
      config: string;
    }>().config;
    expect(defaultPath).toBe(join(homedir(), ".hivemnd/config.json"));
    expect(log).toHaveBeenCalledWith("message");
    expect(error).toHaveBeenCalledWith("problem");
  });
});
