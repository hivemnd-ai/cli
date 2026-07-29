import {
  chmod,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigRepository } from "../src/config.js";
import { runCli, type RuntimeDependencies } from "../src/cli.js";
import { createFilesystemAdapters } from "../src/agents/destinations.js";
import type { ApiClient, HivemndConfig, TokenStore } from "../src/domain.js";
import { captureOutput } from "./helpers.js";
import {
  OrganizationRegistryRepository,
  organizationAlias,
  profileKey,
} from "../src/organizations/registry.js";
import {
  OrganizationResolver,
  resolveOrganization,
  type OrganizationResolutionDependencies,
} from "../src/organizations/resolver.js";
import { temporaryDirectory } from "./helpers.js";
import { organizationRegistry as runtimeOrganizationRegistry } from "../src/organizations/runtime.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

describe("organization registry", () => {
  it("migrates the legacy config without rewriting it and preserves tenant routing", async () => {
    const temp = await temporaryDirectory();
    cleanups.push(temp.cleanup);
    const state = join(temp.path, ".hivemnd");
    const legacyPath = join(state, "config.json");
    const workspace = join(temp.path, "repo");
    await mkdir(workspace, { recursive: true });
    const configs = new ConfigRepository(temp.path);
    await configs.create(legacyPath, {
      apiUrl: "https://shared.hivemnd.cloud/eigen",
      destinations: [
        { name: "codex-global", agent: "codex", scope: "root" },
        {
          name: "claude-repo",
          agent: "claude",
          scope: "workspace",
          path: workspace,
        },
      ],
    });
    const before = await readFile(legacyPath, "utf8");
    const repository = new OrganizationRegistryRepository(state, configs);

    const registry = await repository.loadOrMigrate(legacyPath, true);

    expect(await readFile(legacyPath, "utf8")).toBe(before);
    expect(registry.profiles).toHaveLength(1);
    expect(registry.profiles[0]).toMatchObject({
      alias: "eigen",
      apiUrl: "https://shared.hivemnd.cloud/eigen",
      configPath: legacyPath,
    });
    expect(registry.globalBindings).toEqual([
      { client: "codex", organizationKey: registry.profiles[0]?.key },
    ]);
    expect(registry.workspaceBindings).toEqual([
      {
        path: await realpath(workspace),
        organizationKey: registry.profiles[0]?.key,
      },
    ]);
    expect(
      JSON.parse(await readFile(join(state, "registry.json"), "utf8")),
    ).toEqual(registry);
  });

  it("keeps read-only legacy discovery in memory", async () => {
    const temp = await temporaryDirectory();
    cleanups.push(temp.cleanup);
    const state = join(temp.path, ".hivemnd");
    const legacyPath = join(state, "config.json");
    const configs = new ConfigRepository(temp.path);
    await configs.create(legacyPath, {
      apiUrl: "https://eigen.hivemnd.cloud",
      destinations: [],
    });
    const repository = new OrganizationRegistryRepository(state, configs);

    await expect(
      repository.loadOrMigrate(legacyPath, false),
    ).resolves.toMatchObject({
      profiles: [{ alias: "eigen" }],
    });
    await expect(
      readFile(join(state, "registry.json"), "utf8"),
    ).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("fails closed for duplicate aliases, tenant URLs, workspaces, and global clients", async () => {
    const temp = await temporaryDirectory();
    cleanups.push(temp.cleanup);
    const configs = new ConfigRepository(temp.path);
    const repository = new OrganizationRegistryRepository(temp.path, configs);
    const key = profileKey("https://shared.hivemnd.cloud/eigen");
    const profile = {
      key,
      alias: "eigen",
      name: "Eigen",
      slug: "eigen",
      apiUrl: "https://shared.hivemnd.cloud/eigen",
      configPath: join(temp.path, "eigen.json"),
    };
    const base = {
      version: 1 as const,
      profiles: [profile],
      workspaceBindings: [],
      globalBindings: [],
    };
    await expect(
      repository.save({
        ...base,
        profiles: [profile, { ...profile, key: "other" }],
      }),
    ).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(
      repository.save({
        ...base,
        workspaceBindings: [
          { path: "/repo", organizationKey: key },
          { path: "/repo", organizationKey: key },
        ],
      }),
    ).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(
      repository.save({
        ...base,
        globalBindings: [
          { client: "codex", organizationKey: key },
          { client: "codex", organizationKey: key },
        ],
      }),
    ).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(
      repository.save({
        ...base,
        workspaceBindings: [{ path: "/unknown", organizationKey: "unknown" }],
      }),
    ).rejects.toThrow("Invalid organization registry");
    await expect(
      repository.save({
        ...base,
        globalBindings: [{ client: "claude", organizationKey: "unknown" }],
      }),
    ).rejects.toThrow("Invalid organization registry");
  });

  it("fails closed when a stored registry is corrupt", async () => {
    const temp = await temporaryDirectory();
    cleanups.push(temp.cleanup);
    const configs = new ConfigRepository(temp.path);
    const repository = new OrganizationRegistryRepository(temp.path, configs);
    await writeFile(join(temp.path, "registry.json"), "not-json", "utf8");
    await expect(repository.load()).rejects.toThrow(
      "Cannot load organization registry",
    );
    await expect(repository.loadOptional()).rejects.toThrow(
      "Cannot load organization registry",
    );
  });

  it("normalizes organization aliases with URL and hash fallbacks", () => {
    expect(organizationAlias("Team Name", "https://example.test")).toBe(
      "team-name",
    );
    expect(organizationAlias("", "https://acme.example.test")).toBe("acme");
    expect(organizationAlias("!!!", "https://---.test/!!!")).toMatch(
      /^org-[a-f\d]{8}$/,
    );
  });

  it("serializes registry mutations with an exclusive lock", async () => {
    const temp = await temporaryDirectory();
    cleanups.push(temp.cleanup);
    const repository = new OrganizationRegistryRepository(
      temp.path,
      new ConfigRepository(temp.path),
    );
    let release!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => (entered = resolve));
    const held = repository.withLock(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
          entered();
        }),
    );
    await ready;
    await expect(repository.withLock(async () => undefined)).rejects.toThrow(
      "Another Hivemnd configuration change is in progress",
    );
    release();
    await expect(held).resolves.toBeUndefined();
    await expect(repository.withLock(async () => "done")).resolves.toBe("done");
  });

  it("cleans failed registry writes and propagates non-contention lock errors", async () => {
    const temp = await temporaryDirectory();
    cleanups.push(temp.cleanup);
    const configs = new ConfigRepository(temp.path);
    const repository = new OrganizationRegistryRepository(temp.path, configs);
    await mkdir(repository.path);
    await expect(
      repository.save({
        version: 1,
        profiles: [],
        workspaceBindings: [],
        globalBindings: [],
      }),
    ).rejects.toBeDefined();

    const lockedState = join(temp.path, "locked-state");
    await mkdir(lockedState, { mode: 0o500 });
    const locked = new OrganizationRegistryRepository(lockedState, configs);
    try {
      await expect(
        locked.withLock(async () => undefined),
      ).rejects.toBeDefined();
    } finally {
      await chmod(lockedState, 0o700);
    }
  });
});

describe("organization resolution", () => {
  it("resolves explicit aliases, the most-specific workspace, and client globals", async () => {
    const temp = await temporaryDirectory();
    cleanups.push(temp.cleanup);
    const parent = join(temp.path, "work");
    const child = join(parent, "services/api");
    await mkdir(child, { recursive: true });
    const configs = new ConfigRepository(temp.path);
    const eigenConfig = join(temp.path, "eigen.json");
    const acmeConfig = join(temp.path, "acme.json");
    await configs.create(eigenConfig, {
      apiUrl: "https://example.test/eigen",
      destinations: [],
    });
    await configs.create(acmeConfig, {
      apiUrl: "https://example.test/acme",
      destinations: [],
    });
    const registry = {
      version: 1 as const,
      profiles: [
        profile("eigen", "https://example.test/eigen", eigenConfig),
        profile("acme", "https://example.test/acme", acmeConfig),
      ],
      workspaceBindings: [
        {
          path: parent,
          organizationKey: profileKey("https://example.test/eigen"),
        },
        {
          path: child,
          organizationKey: profileKey("https://example.test/acme"),
        },
      ],
      globalBindings: [
        {
          client: "codex" as const,
          organizationKey: profileKey("https://example.test/eigen"),
        },
      ],
    };
    const dependencies: OrganizationResolutionDependencies = {
      registry: { load: async () => registry },
      configs,
    };

    await expect(
      resolveOrganization({ cwd: child, org: "eigen" }, dependencies),
    ).resolves.toMatchObject({ alias: "eigen" });
    await expect(
      resolveOrganization({ cwd: join(child, "lib") }, dependencies),
    ).resolves.toMatchObject({ alias: "acme" });
    await expect(
      resolveOrganization({ cwd: temp.path, client: "codex" }, dependencies),
    ).resolves.toMatchObject({ alias: "eigen" });
  });

  it("fails closed outside explicit workspace or global scope", async () => {
    const temp = await temporaryDirectory();
    cleanups.push(temp.cleanup);
    const configs = new ConfigRepository(temp.path);
    const path = join(temp.path, "eigen.json");
    await configs.create(path, {
      apiUrl: "https://example.test/eigen",
      destinations: [],
    });
    const only = profile("eigen", "https://example.test/eigen", path);
    const dependency = (
      profiles: (typeof only)[],
    ): OrganizationResolutionDependencies => ({
      registry: {
        load: async () => ({
          version: 1,
          profiles,
          workspaceBindings: [],
          globalBindings: [],
        }),
      },
      configs,
    });
    await expect(
      resolveOrganization({ cwd: temp.path }, dependency([only])),
    ).rejects.toThrow("No Hivemnd organization is connected");
    await expect(
      resolveOrganization({ cwd: temp.path }, dependency([])),
    ).rejects.toThrow("No Hivemnd organization is configured");
    await expect(
      resolveOrganization(
        { cwd: temp.path },
        dependency([only, { ...only, key: "other", alias: "other" }]),
      ),
    ).rejects.toThrow("No Hivemnd organization is connected");
    await expect(
      resolveOrganization(
        { cwd: temp.path, org: "missing" },
        dependency([only]),
      ),
    ).rejects.toThrow("Unknown organization");
  });

  it("accepts canonically equivalent tenant URLs", async () => {
    const temp = await temporaryDirectory();
    cleanups.push(temp.cleanup);
    const configs = new ConfigRepository(temp.path);
    const path = join(temp.path, "eigen.json");
    await configs.create(path, {
      apiUrl: "https://example.test/eigen/",
      destinations: [],
    });
    const selected = profile("eigen", "https://example.test/eigen", path);
    await expect(
      resolveOrganization(
        { cwd: temp.path, org: "eigen" },
        {
          registry: {
            load: async () => ({
              version: 1,
              profiles: [selected],
              workspaceBindings: [],
              globalBindings: [],
            }),
          },
          configs,
        },
      ),
    ).resolves.toMatchObject({ alias: "eigen" });
  });

  it("uses the resolver object and rejects a mismatched profile config", async () => {
    const temp = await temporaryDirectory();
    cleanups.push(temp.cleanup);
    const configs = new ConfigRepository(temp.path);
    const path = join(temp.path, "profile.json");
    await configs.create(path, {
      apiUrl: "https://example.test/other",
      destinations: [],
    });
    const selected = profile("eigen", "https://example.test/eigen", path);
    const resolver = new OrganizationResolver({
      registry: {
        load: async () => ({
          version: 1,
          profiles: [selected],
          workspaceBindings: [],
          globalBindings: [],
        }),
      },
      configs,
    });
    await expect(
      resolver.resolve({ cwd: temp.path, org: "eigen" }),
    ).rejects.toThrow("does not match its tenant config");
  });
});

describe("multi-organization CLI onboarding", () => {
  it("adds two tenant profiles and connects a workspace with --org", async () => {
    const temp = await temporaryDirectory();
    cleanups.push(temp.cleanup);
    const state = join(temp.path, ".hivemnd");
    const workspace = join(temp.path, "acme-repo");
    await mkdir(workspace, { recursive: true });
    const tokens = new Map<string, string>();
    const output = captureOutput();
    const dependencies: RuntimeDependencies = {
      cwd: temp.path,
      homeDirectory: join(temp.path, "home"),
      runtimeExecutablePath: "/usr/local/bin/node",
      cliScriptPath: "/opt/hivemnd/dist/index.js",
      environment: { HIVEMND_HOME: state },
      output,
      prompt: {
        interactive: false,
        input: async () => "",
        confirm: async () => false,
      },
      readHookInput: async () => "",
      configRepositoryFactory: (cwd) => new ConfigRepository(cwd),
      tokenStoreFactory: (config): TokenStore => ({
        get: async () => {
          const value = tokens.get(config.apiUrl);
          return value ? { value, source: "keychain" } : undefined;
        },
        save: async (value) => {
          tokens.set(config.apiUrl, value);
        },
        supportsPersistentStorage: () => true,
      }),
      apiClientFactory: (config) => organizationApi(config.apiUrl),
      adapterFactory: (config, names) =>
        createFilesystemAdapters(config, names, join(temp.path, "home"), state),
      targetAccess: async () => undefined,
      id: () => "receipt",
      clientPlatform: "test",
      clientVersion: "1.0.0",
      updateService: {
        check: async () => ({
          checked: false,
          currentVersion: "1.0.0",
          updateAvailable: false,
          command: "npm install --global @hivemnd-ai/cli@latest",
        }),
      },
      scheduleManagerFactory: () => ({
        install: async (intervalMinutes) => ({
          identity: "schedule",
          installed: true,
          active: true,
          intervalMinutes,
          lastRunFailed: undefined,
          errorLogPath: "/private/error.log",
        }),
        status: async () => ({
          identity: "schedule",
          installed: false,
          active: false,
          intervalMinutes: 15,
          lastRunFailed: undefined,
          errorLogPath: "/private/error.log",
        }),
        remove: async () => ({
          identity: "schedule",
          installed: false,
          active: false,
          intervalMinutes: 15,
          lastRunFailed: undefined,
          errorLogPath: "/private/error.log",
        }),
      }),
    };

    for (const org of ["eigen", "acme"]) {
      const exitCode = await runCli(
        [
          "init",
          "--activation-url",
          `https://shared.hivemnd.cloud/${org}/enroll?token=one-time`,
          "--scope",
          "codex=skip",
          "--client",
          "codex",
          "--automatic-sync",
          "skip",
          "--apply",
        ],
        dependencies,
      );
      expect(exitCode, output.errors.join("\n")).toBe(0);
    }
    await expect(
      runCli(
        ["workspace", "add", workspace, "--org", "acme", "--apply"],
        dependencies,
      ),
    ).resolves.toBe(0);

    const registry = await new OrganizationRegistryRepository(
      state,
      new ConfigRepository(temp.path),
    ).load();
    expect(registry.profiles.map(({ alias }) => alias)).toEqual([
      "eigen",
      "acme",
    ]);
    expect(registry.workspaceBindings).toEqual([
      {
        path: await realpath(workspace),
        organizationKey: profileKey("https://shared.hivemnd.cloud/acme"),
      },
    ]);
    expect(output.messages).toContain(
      `Workspace connected: ${await realpath(workspace)} -> acme`,
    );
    const codexRegistration = await readFile(
      join(await realpath(workspace), ".codex/config.toml"),
      "utf8",
    );
    const claudeRegistration = await readFile(
      join(temp.path, "home/.claude.json"),
      "utf8",
    );
    for (const registration of [codexRegistration, claudeRegistration]) {
      expect(registration).toContain("/usr/local/bin/node");
      expect(registration).toContain("/opt/hivemnd/dist/index.js");
      expect(registration).not.toContain("one-time");
      expect(registration).not.toContain("acme-token");
    }

    const collisionArgs = [
      "init",
      "--activation-url",
      "https://other.test/acme/enroll?token=one-time",
      "--client",
      "codex",
      "--scope",
      "codex=skip",
      "--automatic-sync",
      "skip",
      "--apply",
    ];
    await expect(runCli(collisionArgs, dependencies)).resolves.toBe(1);
    expect(output.errors.at(-1)).toContain("pass --org <unique-name>");
    await expect(
      runCli([...collisionArgs, "--org", "other-acme"], dependencies),
    ).resolves.toBe(0);

    const serverSlugConflict = {
      ...dependencies,
      apiClientFactory: (config: HivemndConfig) => {
        const client = organizationApi(config.apiUrl);
        return config.apiUrl === "https://other.test/unique"
          ? {
              ...client,
              previewEnrollment: async () => ({
                organization: { name: "Acme Duplicate", slug: "acme" },
                enabledClients: ["codex", "claude"] as const,
              }),
            }
          : client;
      },
    };
    await expect(
      runCli(
        [
          "init",
          "--activation-url",
          "https://other.test/unique/enroll?token=one-time",
          "--client",
          "codex",
          "--scope",
          "codex=skip",
          "--automatic-sync",
          "skip",
          "--apply",
        ],
        serverSlugConflict,
      ),
    ).resolves.toBe(1);
    expect(output.errors.at(-1)).toContain("pass --org <unique-name>");

    const globalArgs = (org: string, replace = false) => [
      "init",
      "--activation-url",
      `https://shared.hivemnd.cloud/${org}/enroll?token=one-time`,
      "--client",
      "codex",
      "--scope",
      "codex=global",
      "--automatic-sync",
      "skip",
      "--apply",
      ...(replace ? ["--replace-global"] : []),
    ];
    await expect(runCli(globalArgs("eigen"), dependencies)).resolves.toBe(0);
    await expect(runCli(globalArgs("acme"), dependencies)).resolves.toBe(1);
    expect(output.errors.at(-1)).toContain("--replace-global");
    await expect(
      runCli(globalArgs("acme"), {
        ...dependencies,
        prompt: {
          interactive: true,
          input: async () => "",
          confirm: async () => false,
        },
      }),
    ).resolves.toBe(1);
    expect(output.errors.at(-1)).toContain("--replace-global");
    const acceptGlobalReplacement = vi.fn(async () => true);
    await expect(
      runCli(globalArgs("acme"), {
        ...dependencies,
        prompt: {
          interactive: true,
          input: async () => "",
          confirm: acceptGlobalReplacement,
        },
      }),
    ).resolves.toBe(0);
    expect(acceptGlobalReplacement).toHaveBeenCalled();
    await expect(runCli(globalArgs("eigen", true), dependencies)).resolves.toBe(
      0,
    );
    const ownershipRepository = new OrganizationRegistryRepository(
      state,
      new ConfigRepository(temp.path),
    );
    const beforeOwnedReplacement = await ownershipRepository.load();
    const eigenGlobalProfile = beforeOwnedReplacement.profiles.find(
      ({ alias }) => alias === "eigen",
    )!;
    const eigenGlobalConfig = await new ConfigRepository(temp.path).load(
      eigenGlobalProfile.configPath,
    );
    const eigenGlobalName = eigenGlobalConfig.destinations.find(
      (destination) =>
        destination.scope === "root" && destination.agent === "codex",
    )!.name;
    const [globalAdapter] = dependencies.adapterFactory(eigenGlobalConfig, [
      eigenGlobalName,
    ]);
    const globalContent = new TextEncoder().encode("# Global owned\n");
    const globalEntry = {
      relativePath: "skills/global/SKILL.md",
      logicalId: "global-owned",
      artifactVersionId: "global-v1",
      sha256: createHash("sha256").update(globalContent).digest("hex"),
      releaseId: "release-global",
    };
    await globalAdapter?.replaceOwnership([globalEntry]);
    await expect(runCli(globalArgs("acme", true), dependencies)).resolves.toBe(
      1,
    );
    expect(output.errors.at(-1)).toContain("missing or modified");
    await globalAdapter?.write(globalEntry.relativePath, globalContent);
    await expect(
      runCli(
        [
          "init",
          "--activation-url",
          "https://shared.hivemnd.cloud/eigen/enroll?token=one-time",
          "--client",
          "claude",
          "--scope",
          "claude=global",
          "--automatic-sync",
          "skip",
          "--apply",
        ],
        dependencies,
      ),
    ).resolves.toBe(0);
    await expect(
      runCli(
        [
          "init",
          "--activation-url",
          "https://shared.hivemnd.cloud/acme/enroll?token=one-time",
          "--client",
          "claude",
          "--scope",
          "claude=global",
          "--automatic-sync",
          "skip",
          "--apply",
        ],
        dependencies,
      ),
    ).resolves.toBe(1);
    expect(output.errors.at(-1)).toContain("replace Claude Code");
    await expect(
      runCli(
        [
          "init",
          "--activation-url",
          "https://shared.hivemnd.cloud/acme/enroll?token=one-time",
          "--client",
          "claude",
          "--scope",
          "claude=global",
          "--automatic-sync",
          "skip",
          "--apply",
        ],
        {
          ...dependencies,
          prompt: {
            interactive: true,
            input: async () => "",
            confirm: async () => false,
          },
        },
      ),
    ).resolves.toBe(1);
    expect(output.errors.at(-1)).toContain("replace Claude Code");
    await globalAdapter?.write(globalEntry.relativePath, globalContent);
    await globalAdapter?.replaceOwnership([globalEntry]);
    const beforeRegistrationRollback = await ownershipRepository.load();

    const codexGlobalRegistration = join(temp.path, "home/.codex/config.toml");
    await writeFile(
      codexGlobalRegistration,
      '[mcp_servers.hivemnd]\ncommand = "other"\n',
      "utf8",
    );
    await expect(runCli(globalArgs("acme", true), dependencies)).resolves.toBe(
      1,
    );
    expect(
      Array.from((await globalAdapter?.read(globalEntry.relativePath)) ?? []),
    ).toEqual(Array.from(globalContent));
    await expect(globalAdapter?.readOwnership()).resolves.toEqual([
      globalEntry,
    ]);
    await expect(ownershipRepository.load()).resolves.toEqual(
      beforeRegistrationRollback,
    );
    await rm(codexGlobalRegistration, { force: true });
    await expect(runCli(globalArgs("acme", true), dependencies)).resolves.toBe(
      0,
    );
    await expect(
      runCli(globalArgs("eigen"), {
        ...dependencies,
        prompt: {
          interactive: true,
          input: async () => "",
          confirm: async () => false,
        },
      }),
    ).resolves.toBe(1);
    await expect(
      runCli(globalArgs("eigen"), {
        ...dependencies,
        prompt: {
          interactive: true,
          input: async () => "",
          confirm: async () => true,
        },
      }),
    ).resolves.toBe(0);
    await expect(runCli(globalArgs("acme", true), dependencies)).resolves.toBe(
      0,
    );
    const switched = await new OrganizationRegistryRepository(
      state,
      new ConfigRepository(temp.path),
    ).load();
    expect(switched.globalBindings).toEqual(
      expect.arrayContaining([
        {
          client: "codex",
          organizationKey: profileKey("https://shared.hivemnd.cloud/acme"),
        },
        {
          client: "claude",
          organizationKey: profileKey("https://shared.hivemnd.cloud/eigen"),
        },
      ]),
    );
    await expect(
      runCli(["mcp", "status", "--client", "codex"], {
        ...dependencies,
        tokenStoreFactory: () => ({
          get: async () => undefined,
          save: async () => undefined,
        }),
      }),
    ).resolves.toBe(0);
    expect(output.messages).toContain("Reachability: credential missing");

    await expect(runCli(["org", "list"], dependencies)).resolves.toBe(0);
    await expect(runCli(["workspace", "list"], dependencies)).resolves.toBe(0);
    expect(output.messages).toContain(`${await realpath(workspace)} | acme`);

    await expect(
      runCli(
        ["workspace", "reassign", workspace, "--org", "acme", "--apply"],
        dependencies,
      ),
    ).resolves.toBe(0);
    await expect(
      runCli(
        ["workspace", "reassign", workspace, "--org", "eigen", "--apply"],
        dependencies,
      ),
    ).resolves.toBe(0);
    const reassigned = await new OrganizationRegistryRepository(
      state,
      new ConfigRepository(temp.path),
    ).load();
    expect(reassigned.workspaceBindings[0]?.organizationKey).toBe(
      profileKey("https://shared.hivemnd.cloud/eigen"),
    );
    await expect(
      runCli(
        [
          "init",
          "--activation-url",
          "https://shared.hivemnd.cloud/acme/enroll?token=one-time",
          "--client",
          "codex",
          "--scope",
          "codex=workspace",
          "--workspace",
          workspace,
          "--automatic-sync",
          "skip",
          "--apply",
        ],
        dependencies,
      ),
    ).resolves.toBe(1);
    expect(output.errors.at(-1)).toContain(
      "Workspace is already connected to eigen",
    );

    await expect(
      runCli(["workspace", "reassign", workspace, "--org", "acme", "--apply"], {
        ...dependencies,
        tokenStoreFactory: () => ({
          get: async () => undefined,
          save: async () => undefined,
        }),
      }),
    ).resolves.toBe(1);
    expect(output.errors.at(-1)).toContain("No token found for acme");

    const registryRepository = new OrganizationRegistryRepository(
      state,
      new ConfigRepository(temp.path),
    );
    let mutateRegistry = true;
    await expect(
      runCli(["workspace", "reassign", workspace, "--org", "acme", "--apply"], {
        ...dependencies,
        tokenStoreFactory: (config) => ({
          get: async () => {
            if (mutateRegistry && config.apiUrl.endsWith("/acme")) {
              mutateRegistry = false;
              await registryRepository.save({
                ...reassigned,
                workspaceBindings: reassigned.workspaceBindings.map(
                  (binding) => ({
                    ...binding,
                    organizationKey: profileKey(
                      "https://shared.hivemnd.cloud/acme",
                    ),
                  }),
                ),
              });
            }
            const value = tokens.get(config.apiUrl);
            return value ? { value, source: "keychain" as const } : undefined;
          },
          save: async () => undefined,
        }),
      }),
    ).resolves.toBe(1);
    expect(output.errors.at(-1)).toContain("Workspace connection changed");
    await registryRepository.save(reassigned);

    const acmeProfile = reassigned.profiles.find(
      ({ alias }) => alias === "acme",
    );
    expect(acmeProfile).toBeDefined();
    const acmeConfigPath = acmeProfile?.configPath ?? "";
    const configRepository = new ConfigRepository(temp.path);
    const acmeConfig = await configRepository.load(acmeConfigPath);
    let mutateConfig = true;
    await expect(
      runCli(["workspace", "reassign", workspace, "--org", "acme", "--apply"], {
        ...dependencies,
        apiClientFactory: (config) => {
          const client = organizationApi(config.apiUrl);
          return {
            ...client,
            clientConfiguration: async () => {
              if (mutateConfig) {
                mutateConfig = false;
                await configRepository.create(
                  acmeConfigPath,
                  {
                    ...acmeConfig,
                    destinations: [
                      ...acmeConfig.destinations,
                      {
                        name: "concurrent-change",
                        agent: "claude",
                        scope: "root",
                      },
                    ],
                  },
                  true,
                );
              }
              return client.clientConfiguration("token");
            },
          };
        },
      }),
    ).resolves.toBe(1);
    expect(output.errors.at(-1)).toContain(
      "Organization configuration changed",
    );
    await configRepository.create(acmeConfigPath, acmeConfig, true);

    let failTargetWrite = true;
    class FailingConfigRepository extends ConfigRepository {
      override async create(
        path: string,
        config: HivemndConfig,
        overwrite = false,
      ): Promise<void> {
        if (
          failTargetWrite &&
          path === acmeConfigPath &&
          config.destinations.length > acmeConfig.destinations.length
        ) {
          failTargetWrite = false;
          throw new Error("injected target write failure");
        }
        await super.create(path, config, overwrite);
      }
    }
    const eigenProfile = reassigned.profiles.find(
      ({ alias }) => alias === "eigen",
    );
    expect(eigenProfile).toBeDefined();
    const eigenBefore = await configRepository.load(
      eigenProfile?.configPath ?? "",
    );
    const canonicalWorkspace = await realpath(workspace);
    const eigenWorkspaceName = eigenBefore.destinations.find(
      (destination) =>
        destination.scope === "workspace" &&
        destination.path === canonicalWorkspace,
    )?.name;
    expect(eigenWorkspaceName).toBeDefined();
    const [ownedAdapter] = dependencies.adapterFactory(eigenBefore, [
      eigenWorkspaceName ?? "",
    ]);
    expect(ownedAdapter).toBeDefined();
    const ownedContent = new TextEncoder().encode("# Owned by Hivemnd\n");
    const ownedEntry = {
      relativePath: "skills/owned/SKILL.md",
      logicalId: "owned",
      artifactVersionId: "owned-v1",
      sha256: createHash("sha256").update(ownedContent).digest("hex"),
      releaseId: "release-1",
    };
    await ownedAdapter?.replaceOwnership([ownedEntry]);
    await expect(
      runCli(
        ["workspace", "reassign", workspace, "--org", "acme", "--apply"],
        dependencies,
      ),
    ).resolves.toBe(1);
    expect(output.errors.at(-1)).toContain("missing or modified");
    await ownedAdapter?.write(ownedEntry.relativePath, ownedContent);
    await expect(
      runCli(["workspace", "reassign", workspace, "--org", "acme", "--apply"], {
        ...dependencies,
        configRepositoryFactory: (cwd) => new FailingConfigRepository(cwd),
      }),
    ).resolves.toBe(1);
    expect(output.errors.at(-1)).toContain("injected target write failure");
    await expect(
      configRepository.load(eigenProfile?.configPath ?? ""),
    ).resolves.toEqual(eigenBefore);
    await expect(configRepository.load(acmeConfigPath)).resolves.toEqual(
      acmeConfig,
    );
    await expect(registryRepository.load()).resolves.toEqual(reassigned);
    expect(
      Array.from((await ownedAdapter?.read(ownedEntry.relativePath)) ?? []),
    ).toEqual(Array.from(ownedContent));
    await expect(ownedAdapter?.readOwnership()).resolves.toEqual([ownedEntry]);
    const contextualSyncExit = await runCli(
      ["sync", canonicalWorkspace],
      dependencies,
    );
    expect(contextualSyncExit, output.errors.at(-1)).toBe(0);

    await expect(
      runCli(
        ["workspace", "reassign", workspace, "--org", "acme"],
        dependencies,
      ),
    ).resolves.toBe(0);
    expect(output.messages).toContain("No changes applied.");

    const declined = {
      ...dependencies,
      prompt: {
        interactive: true,
        input: async () => "",
        confirm: async () => false,
      },
    };
    await expect(
      runCli(["workspace", "reassign", workspace, "--org", "acme"], declined),
    ).resolves.toBe(0);
    expect(output.messages).toContain("No changes applied.");
    const acceptReassignment = vi.fn(async () => true);
    await expect(
      runCli(["workspace", "reassign", workspace, "--org", "acme"], {
        ...dependencies,
        prompt: {
          interactive: true,
          input: async () => "",
          confirm: acceptReassignment,
        },
      }),
    ).resolves.toBe(0);
    expect(acceptReassignment).toHaveBeenCalledWith(
      "Apply this workspace reassignment?",
      false,
    );
    await expect(
      runCli(
        ["workspace", "reassign", workspace, "--org", "eigen", "--apply"],
        dependencies,
      ),
    ).resolves.toBe(0);
    await expect(
      runCli(["workspace", "reassign", "--org", "acme"], {
        ...dependencies,
        cwd: workspace,
      }),
    ).resolves.toBe(0);

    const unbound = join(temp.path, "unbound");
    await mkdir(unbound);
    await expect(
      runCli(["workspace", "add", unbound, "--apply"], dependencies),
    ).resolves.toBe(1);
    expect(output.errors.at(-1)).toContain("--org");
    await expect(
      runCli(["workspace", "add", unbound, "--org", "acme"], dependencies),
    ).resolves.toBe(1);
    expect(output.errors.at(-1)).toContain("Pass --apply");
    await expect(
      runCli(
        ["workspace", "add", unbound, "--org", "missing", "--apply"],
        dependencies,
      ),
    ).resolves.toBe(1);
    expect(output.errors.at(-1)).toContain("Unknown organization");

    const interactiveWorkspace = join(temp.path, "interactive-workspace");
    await mkdir(interactiveWorkspace);
    const organizationAnswers = ["invalid", "acme"];
    const interactiveAdd = {
      ...dependencies,
      prompt: {
        interactive: true,
        input: async () => organizationAnswers.shift() ?? "acme",
        confirm: async () => true,
      },
    };
    await expect(
      runCli(["workspace", "add", interactiveWorkspace], interactiveAdd),
    ).resolves.toBe(0);
    await expect(
      runCli(
        [
          "workspace",
          "reassign",
          interactiveWorkspace,
          "--org",
          "eigen",
          "--apply",
        ],
        dependencies,
      ),
    ).resolves.toBe(0);

    const fallbackWorkspace = join(temp.path, "fallback-workspace");
    await mkdir(fallbackWorkspace);
    const fallbackDependencies = { ...dependencies };
    delete fallbackDependencies.runtimeExecutablePath;
    delete fallbackDependencies.cliScriptPath;
    await expect(
      runCli(
        [
          "workspace",
          "add",
          fallbackWorkspace,
          "--org",
          "acme",
          "--client",
          "codex",
          "--client",
          "claude",
          "--apply",
        ],
        fallbackDependencies,
      ),
    ).resolves.toBe(0);

    const declinedWorkspace = join(temp.path, "declined-workspace");
    await mkdir(declinedWorkspace);
    await expect(
      runCli(
        ["workspace", "add", declinedWorkspace, "--org", "acme"],
        declined,
      ),
    ).resolves.toBe(0);
    const afterDecline = await new OrganizationRegistryRepository(
      state,
      new ConfigRepository(temp.path),
    ).load();
    const canonicalDeclinedWorkspace = await realpath(declinedWorkspace);
    expect(
      afterDecline.workspaceBindings.some(
        ({ path }) => path === canonicalDeclinedWorkspace,
      ),
    ).toBe(false);

    const unauthenticatedWorkspace = join(temp.path, "unauthenticated");
    await mkdir(unauthenticatedWorkspace);
    await expect(
      runCli(
        [
          "workspace",
          "add",
          unauthenticatedWorkspace,
          "--org",
          "acme",
          "--apply",
        ],
        {
          ...dependencies,
          tokenStoreFactory: () => ({
            get: async () => undefined,
            save: async () => undefined,
          }),
        },
      ),
    ).resolves.toBe(1);
    expect(output.errors.at(-1)).toContain("No token found for acme");
    await expect(
      runCli(
        ["workspace", "add", workspace, "--org", "acme", "--apply"],
        dependencies,
      ),
    ).resolves.toBe(1);
    expect(output.errors.at(-1)).toContain("workspace reassign");

    const missingBinding = join(temp.path, "missing-binding");
    await mkdir(missingBinding);
    await expect(
      runCli(
        ["workspace", "reassign", missingBinding, "--org", "acme", "--apply"],
        dependencies,
      ),
    ).resolves.toBe(1);
    expect(output.errors.at(-1)).toContain("Workspace is not connected");

    const explicitPath = join(temp.path, "explicit.json");
    await new ConfigRepository(temp.path).create(explicitPath, {
      apiUrl: "https://shared.hivemnd.cloud/acme",
      destinations: [],
    });
    const explicitWorkspace = join(temp.path, "explicit-workspace");
    await mkdir(explicitWorkspace);
    const declinedExplicitWorkspace = join(
      temp.path,
      "declined-explicit-workspace",
    );
    await mkdir(declinedExplicitWorkspace);
    await expect(
      runCli(
        [
          "--config",
          explicitPath,
          "workspace",
          "add",
          declinedExplicitWorkspace,
        ],
        {
          ...dependencies,
          prompt: {
            interactive: true,
            input: async () => "",
            confirm: async () => false,
          },
        },
      ),
    ).resolves.toBe(0);
    await expect(
      runCli(
        [
          "--config",
          explicitPath,
          "workspace",
          "add",
          explicitWorkspace,
          "--client",
          "codex",
          "--client",
          "claude",
          "--apply",
        ],
        dependencies,
      ),
    ).resolves.toBe(0);
    const canonicalExplicitWorkspace = await realpath(explicitWorkspace);
    const explicitConfigured = await configRepository.load(explicitPath);
    const explicitNames = explicitConfigured.destinations
      .filter(({ path }) => path === canonicalExplicitWorkspace)
      .map(({ name }) => name);
    const explicitAdapters = dependencies.adapterFactory(
      explicitConfigured,
      explicitNames,
    );
    const legacyBlock =
      "<!-- BEGIN HIVEMND MANAGED ALWAYS CONTEXT -->\n# Legacy\n<!-- END HIVEMND MANAGED ALWAYS CONTEXT -->";
    for (const adapter of explicitAdapters) {
      const instructionPath =
        adapter.kind === "codex"
          ? join(explicitWorkspace, "AGENTS.md")
          : join(explicitWorkspace, "CLAUDE.md");
      const prefix = adapter.kind === "codex" ? "\n\n" : "";
      await writeFile(
        instructionPath,
        `${adapter.kind === "codex" ? "# User rules" : ""}${prefix}${legacyBlock}`,
      );
      await adapter.replaceOwnership([], {
        blockSha256: createHash("sha256").update(legacyBlock).digest("hex"),
        prefix,
        createdFile: adapter.kind === "claude",
      });
    }

    await expect(
      runCli(
        ["--config", explicitPath, "workspace", "remove", explicitWorkspace],
        dependencies,
      ),
    ).resolves.toBe(1);
    expect(output.errors.at(-1)).toContain("Pass --apply");
    await expect(
      runCli(
        ["--config", explicitPath, "workspace", "remove", explicitWorkspace],
        {
          ...dependencies,
          prompt: {
            interactive: true,
            input: async () => "",
            confirm: async () => false,
          },
        },
      ),
    ).resolves.toBe(0);
    await expect(
      runCli(
        [
          "--config",
          explicitPath,
          "workspace",
          "remove",
          explicitWorkspace,
          "--apply",
        ],
        dependencies,
      ),
    ).resolves.toBe(0);
    expect(
      (await configRepository.load(explicitPath)).destinations.some(
        ({ path }) => path === canonicalExplicitWorkspace,
      ),
    ).toBe(false);
    expect(await readFile(join(explicitWorkspace, "AGENTS.md"), "utf8")).toBe(
      "# User rules",
    );
    await expect(
      readFile(join(explicitWorkspace, "CLAUDE.md")),
    ).rejects.toMatchObject({ code: "ENOENT" });

    const defaultStateWorkspace = join(
      temp.path,
      "default-state-explicit-workspace",
    );
    await mkdir(defaultStateWorkspace);
    const defaultStateDependencies = { ...dependencies, environment: {} };
    await expect(
      runCli(
        [
          "--config",
          explicitPath,
          "workspace",
          "add",
          defaultStateWorkspace,
          "--client",
          "codex",
          "--apply",
        ],
        defaultStateDependencies,
      ),
    ).resolves.toBe(0);
    await expect(
      runCli(
        [
          "--config",
          explicitPath,
          "workspace",
          "remove",
          defaultStateWorkspace,
          "--apply",
        ],
        defaultStateDependencies,
      ),
    ).resolves.toBe(0);
    await expect(
      runCli(
        [
          "--config",
          explicitPath,
          "workspace",
          "remove",
          explicitWorkspace,
          "--apply",
        ],
        dependencies,
      ),
    ).resolves.toBe(1);
    expect(output.errors.at(-1)).toContain("Workspace is not connected");

    const rollbackWorkspace = join(temp.path, "removal-rollback-workspace");
    await mkdir(rollbackWorkspace);
    await expect(
      runCli(
        [
          "--config",
          explicitPath,
          "workspace",
          "add",
          rollbackWorkspace,
          "--client",
          "codex",
          "--client",
          "claude",
          "--apply",
        ],
        dependencies,
      ),
    ).resolves.toBe(0);
    const canonicalRollbackWorkspace = await realpath(rollbackWorkspace);
    const rollbackConfig = await configRepository.load(explicitPath);
    const [rollbackAdapter] = dependencies.adapterFactory(
      rollbackConfig,
      rollbackConfig.destinations
        .filter(
          ({ agent, path }) =>
            agent === "codex" && path === canonicalRollbackWorkspace,
        )
        .map(({ name }) => name),
    );
    const rollbackLegacyBlock =
      "<!-- BEGIN HIVEMND MANAGED ALWAYS CONTEXT -->\n# Rollback\n<!-- END HIVEMND MANAGED ALWAYS CONTEXT -->";
    await writeFile(join(rollbackWorkspace, "AGENTS.md"), rollbackLegacyBlock);
    await rollbackAdapter?.replaceOwnership([], {
      blockSha256: createHash("sha256")
        .update(rollbackLegacyBlock)
        .digest("hex"),
      prefix: "",
      createdFile: true,
    });
    const claudeConfigPath = join(dependencies.homeDirectory, ".claude.json");
    const claudeConfig = JSON.parse(
      await readFile(claudeConfigPath, "utf8"),
    ) as {
      projects: Record<
        string,
        { mcpServers: { hivemnd: { command: string } } }
      >;
    };
    const originalClaudeCommand =
      claudeConfig.projects[canonicalRollbackWorkspace]!.mcpServers.hivemnd
        .command;
    claudeConfig.projects[
      canonicalRollbackWorkspace
    ]!.mcpServers.hivemnd.command = "modified-command";
    await writeFile(claudeConfigPath, JSON.stringify(claudeConfig));
    await expect(
      runCli(
        [
          "--config",
          explicitPath,
          "workspace",
          "remove",
          rollbackWorkspace,
          "--apply",
        ],
        dependencies,
      ),
    ).resolves.toBe(1);
    expect(
      (await configRepository.load(explicitPath)).destinations.some(
        ({ path }) => path === canonicalRollbackWorkspace,
      ),
    ).toBe(true);
    expect(
      await readFile(join(rollbackWorkspace, ".codex", "config.toml"), "utf8"),
    ).toContain("BEGIN HIVEMND MANAGED MCP");
    expect(
      await readFile(join(rollbackWorkspace, ".codex", "hooks.json"), "utf8"),
    ).toContain("Loading verified Hivemnd context");
    expect(await readFile(join(rollbackWorkspace, "AGENTS.md"), "utf8")).toBe(
      rollbackLegacyBlock,
    );
    if (!rollbackAdapter?.readContextInstructionOwnership) {
      throw new Error("Expected a legacy-instruction-aware adapter");
    }
    expect(
      await rollbackAdapter.readContextInstructionOwnership(),
    ).toBeDefined();
    const repairedClaudeConfig = JSON.parse(
      await readFile(claudeConfigPath, "utf8"),
    ) as {
      projects: Record<
        string,
        { mcpServers: { hivemnd: { command: string } } }
      >;
    };
    repairedClaudeConfig.projects[
      canonicalRollbackWorkspace
    ]!.mcpServers.hivemnd.command = originalClaudeCommand;
    await writeFile(claudeConfigPath, JSON.stringify(repairedClaudeConfig));
    await writeFile(
      join(rollbackWorkspace, "AGENTS.md"),
      rollbackLegacyBlock.replace("# Rollback", "# Locally edited"),
    );
    await expect(
      runCli(
        [
          "--config",
          explicitPath,
          "workspace",
          "remove",
          rollbackWorkspace,
          "--apply",
        ],
        dependencies,
      ),
    ).resolves.toBe(1);
    expect(output.errors.at(-1)).toContain("modified legacy");

    await expect(
      runCli(["workspace", "remove"], {
        ...fallbackDependencies,
        cwd: fallbackWorkspace,
        prompt: {
          interactive: true,
          input: async () => "",
          confirm: async () => false,
        },
      }),
    ).resolves.toBe(0);
    await expect(
      runCli(["workspace", "remove", fallbackWorkspace], dependencies),
    ).resolves.toBe(1);
    const registryBeforeRemoval = await registryRepository.load();
    await expect(
      runCli(["workspace", "remove", fallbackWorkspace], {
        ...fallbackDependencies,
        prompt: {
          interactive: true,
          input: async () => "",
          confirm: async () => {
            await registryRepository.save({
              ...registryBeforeRemoval,
              profiles: [...registryBeforeRemoval.profiles].reverse(),
            });
            return true;
          },
        },
      }),
    ).resolves.toBe(1);
    expect(output.errors.at(-1)).toContain("changed while removal");
    await registryRepository.save(registryBeforeRemoval);
    const removalExit = await runCli(
      ["workspace", "remove", fallbackWorkspace],
      {
        ...fallbackDependencies,
        prompt: {
          interactive: true,
          input: async () => "",
          confirm: async () => true,
        },
      },
    );
    expect(removalExit, output.errors.at(-1)).toBe(0);
    const canonicalFallbackWorkspace = await realpath(fallbackWorkspace);
    expect(output.messages).toContain(
      `Workspace disconnected: ${canonicalFallbackWorkspace}`,
    );
    expect(
      (await registryRepository.load()).workspaceBindings.some(
        ({ path }) => path === canonicalFallbackWorkspace,
      ),
    ).toBe(false);
    await expect(
      runCli(
        ["workspace", "remove", fallbackWorkspace, "--apply"],
        fallbackDependencies,
      ),
    ).resolves.toBe(1);

    const registryRollbackWorkspace = join(
      temp.path,
      "registry-removal-rollback",
    );
    await mkdir(registryRollbackWorkspace);
    await expect(
      runCli(
        [
          "workspace",
          "add",
          registryRollbackWorkspace,
          "--org",
          "acme",
          "--client",
          "codex",
          "--apply",
        ],
        dependencies,
      ),
    ).resolves.toBe(0);
    const registryHookPath = join(
      registryRollbackWorkspace,
      ".codex",
      "hooks.json",
    );
    const registryHook = JSON.parse(
      await readFile(registryHookPath, "utf8"),
    ) as {
      hooks: { SessionStart: Array<{ hooks: Array<{ command: string }> }> };
    };
    registryHook.hooks.SessionStart[0]!.hooks[0]!.command =
      registryHook.hooks.SessionStart[0]!.hooks[0]!.command.replace(
        "dist/index.js",
        "dist/changed.js",
      );
    await writeFile(registryHookPath, JSON.stringify(registryHook));
    const beforeRegistryRemovalRollback = await registryRepository.load();
    await expect(
      runCli(
        ["workspace", "remove", registryRollbackWorkspace, "--apply"],
        dependencies,
      ),
    ).resolves.toBe(1);
    await expect(registryRepository.load()).resolves.toEqual(
      beforeRegistryRemovalRollback,
    );

    const conflictingExplicitWorkspace = join(temp.path, "explicit-conflict");
    await mkdir(join(conflictingExplicitWorkspace, ".codex"), {
      recursive: true,
    });
    await writeFile(
      join(conflictingExplicitWorkspace, ".codex/config.toml"),
      '[mcp_servers.hivemnd]\ncommand = "other"\n',
      "utf8",
    );
    const beforeExplicit = await readFile(explicitPath, "utf8");
    await expect(
      runCli(
        [
          "--config",
          explicitPath,
          "workspace",
          "add",
          conflictingExplicitWorkspace,
          "--client",
          "codex",
          "--apply",
        ],
        dependencies,
      ),
    ).resolves.toBe(1);
    expect(await readFile(explicitPath, "utf8")).toBe(beforeExplicit);

    const registeredConflict = join(temp.path, "registered-conflict");
    await mkdir(join(registeredConflict, ".codex"), { recursive: true });
    await writeFile(
      join(registeredConflict, ".codex/config.toml"),
      '[mcp_servers.hivemnd]\ncommand = "other"\n',
      "utf8",
    );
    const registryBeforeConflict = await registryRepository.load();
    const configBeforeConflict = await configRepository.load(acmeConfigPath);
    await expect(
      runCli(
        [
          "workspace",
          "add",
          registeredConflict,
          "--org",
          "acme",
          "--client",
          "codex",
          "--apply",
        ],
        dependencies,
      ),
    ).resolves.toBe(1);
    await expect(registryRepository.load()).resolves.toEqual(
      registryBeforeConflict,
    );
    await expect(configRepository.load(acmeConfigPath)).resolves.toEqual(
      configBeforeConflict,
    );

    const beforeConcurrentInit = await registryRepository.load();
    let mutateDuringTokenSave = true;
    await expect(
      runCli(
        [
          "init",
          "--activation-url",
          "https://shared.hivemnd.cloud/concurrent/enroll?token=one-time",
          "--client",
          "codex",
          "--scope",
          "codex=skip",
          "--automatic-sync",
          "skip",
          "--apply",
        ],
        {
          ...dependencies,
          tokenStoreFactory: (config) => ({
            get: async () => {
              const value = tokens.get(config.apiUrl);
              return value ? { value, source: "keychain" as const } : undefined;
            },
            save: async (value) => {
              tokens.set(config.apiUrl, value);
              if (mutateDuringTokenSave) {
                mutateDuringTokenSave = false;
                const current = await registryRepository.load();
                await registryRepository.save({
                  ...current,
                  profiles: [...current.profiles].reverse(),
                });
              }
            },
            supportsPersistentStorage: () => true,
          }),
        },
      ),
    ).resolves.toBe(1);
    expect(output.errors.at(-1)).toContain(
      "Organization configuration changed while onboarding",
    );
    await expect(registryRepository.load()).resolves.toEqual(
      beforeConcurrentInit,
    );

    const acmeBeforeRegistrationVariants =
      await configRepository.load(acmeConfigPath);
    const directoryPath = join(temp.path, "managed-directory");
    await mkdir(directoryPath);
    await configRepository.create(
      acmeConfigPath,
      {
        ...acmeBeforeRegistrationVariants,
        destinations: [
          ...acmeBeforeRegistrationVariants.destinations,
          {
            name: "codex-duplicate-root",
            agent: "codex",
            scope: "root",
          },
          {
            name: "codex-managed-directory",
            agent: "codex",
            scope: "directory",
            path: directoryPath,
          },
        ],
      },
      true,
    );
    await expect(
      runCli(
        [
          "init",
          "--activation-url",
          "https://shared.hivemnd.cloud/acme/enroll?token=one-time",
          "--client",
          "codex",
          "--scope",
          "codex=skip",
          "--automatic-sync",
          "skip",
          "--apply",
        ],
        {
          ...dependencies,
          adapterFactory: (config, names) => {
            const filtered = {
              ...config,
              destinations: config.destinations.filter(
                ({ name }) => name !== "codex-duplicate-root",
              ),
            };
            return createFilesystemAdapters(
              filtered,
              names.filter((name) => name !== "codex-duplicate-root"),
              dependencies.homeDirectory,
              state,
            );
          },
        },
      ),
    ).resolves.toBe(0);

    await expect(
      runCli(
        [
          "init",
          "--activation-url",
          "https://shared.hivemnd.cloud/missing-sync-choice/enroll?token=one-time",
          "--client",
          "codex",
          "--scope",
          "codex=skip",
          "--apply",
        ],
        dependencies,
      ),
    ).resolves.toBe(1);
    expect(output.errors.at(-1)).toContain("--automatic-sync");

    const initWorkspace = join(temp.path, "init-workspace");
    await mkdir(initWorkspace);
    await expect(
      runCli(
        [
          "init",
          "--activation-url",
          "https://shared.hivemnd.cloud/workspace-init/enroll?token=one-time",
          "--client",
          "codex",
          "--scope",
          "codex=workspace",
          "--workspace",
          initWorkspace,
          "--automatic-sync",
          "skip",
          "--apply",
        ],
        dependencies,
      ),
    ).resolves.toBe(0);
  });

  it("rejects --config with --org", async () => {
    const temp = await temporaryDirectory();
    cleanups.push(temp.cleanup);
    const configPath = join(temp.path, "config.json");
    const configs = new ConfigRepository(temp.path);
    await configs.create(configPath, {
      apiUrl: "https://example.test/eigen",
      destinations: [],
    });
    const output = captureOutput();
    const dependencies = minimalRuntime(temp.path, output);
    await expect(
      runCli(
        ["--config", configPath, "--org", "eigen", "status"],
        dependencies,
      ),
    ).resolves.toBe(1);
    expect(output.errors.at(-1)).toContain("Use either --config or --org");
    await expect(
      runCli(
        [
          "--config",
          configPath,
          "init",
          "--org",
          "eigen",
          "--activation-url",
          "https://example.test/eigen/enroll?token=x",
          "--apply",
        ],
        dependencies,
      ),
    ).resolves.toBe(1);
    expect(output.errors.at(-1)).toContain("Use either --config or --org");
    await expect(
      runCli(
        [
          "--config",
          configPath,
          "workspace",
          "add",
          temp.path,
          "--org",
          "eigen",
          "--apply",
        ],
        dependencies,
      ),
    ).resolves.toBe(1);
    expect(output.errors.at(-1)).toContain("Use either --config or --org");
    await expect(
      runCli(
        [
          "--config",
          configPath,
          "workspace",
          "reassign",
          temp.path,
          "--org",
          "eigen",
          "--apply",
        ],
        dependencies,
      ),
    ).resolves.toBe(1);
    expect(output.errors.at(-1)).toContain(
      "Workspace reassignment requires the organization registry",
    );
  });

  it("reports empty organization and workspace registries", async () => {
    const temp = await temporaryDirectory();
    cleanups.push(temp.cleanup);
    const output = captureOutput();
    const dependencies = {
      ...minimalRuntime(temp.path, output),
      environment: { HIVEMND_HOME: join(temp.path, ".hivemnd") },
    };
    expect(
      runtimeOrganizationRegistry({ ...dependencies, environment: {} }).path,
    ).toContain(".hivemnd/registry.json");
    await expect(runCli(["org", "list"], dependencies)).resolves.toBe(0);
    await expect(runCli(["workspace", "list"], dependencies)).resolves.toBe(0);
    expect(output.messages).toContain(
      "No Hivemnd organizations are configured.",
    );
    expect(output.messages).toContain("No Hivemnd workspaces are configured.");
    await expect(
      runCli(["workspace", "add", temp.path, "--apply"], dependencies),
    ).resolves.toBe(1);
    expect(output.errors.at(-1)).toContain(
      "No Hivemnd organization is configured",
    );
    await expect(
      runCli(["workspace", "reassign", temp.path, "--apply"], dependencies),
    ).resolves.toBe(1);
    expect(output.errors.at(-1)).toContain("requires --org");

    const fallbackState = join(dependencies.homeDirectory, ".hivemnd");
    await new OrganizationRegistryRepository(
      fallbackState,
      new ConfigRepository(temp.path),
    ).save({
      version: 1,
      profiles: [],
      workspaceBindings: [],
      globalBindings: [],
    });
    await expect(
      runCli(["status"], { ...dependencies, environment: {} }),
    ).resolves.toBe(1);
  });

  it("captures activation interactively with secret and input prompts", async () => {
    const temp = await temporaryDirectory();
    cleanups.push(temp.cleanup);
    const state = join(temp.path, ".hivemnd");
    const output = captureOutput();
    const stored = new Map<string, string>();
    const base: RuntimeDependencies = {
      ...minimalRuntime(temp.path, output),
      environment: { HIVEMND_HOME: state },
      tokenStoreFactory: (config) => ({
        get: async () => {
          const value = stored.get(config.apiUrl);
          return value ? { value, source: "keychain" as const } : undefined;
        },
        save: async (value) => {
          stored.set(config.apiUrl, value);
        },
        supportsPersistentStorage: () => true,
      }),
      apiClientFactory: (config) => organizationApi(config.apiUrl),
    };
    const confirmations = [false, false, true];
    await expect(
      runCli(["init", "--client", "codex", "--automatic-sync", "skip"], {
        ...base,
        prompt: {
          interactive: true,
          secret: async () =>
            "https://shared.hivemnd.cloud/secret/enroll?token=hidden",
          input: async () => "",
          confirm: async () => confirmations.shift() ?? false,
        },
      }),
    ).resolves.toBe(0);
    expect(output.messages.join("\n")).not.toContain("hidden");

    await expect(
      runCli(
        [
          "init",
          "--org",
          "input-org",
          "--client",
          "codex",
          "--scope",
          "codex=skip",
          "--automatic-sync",
          "skip",
          "--apply",
        ],
        {
          ...base,
          prompt: {
            interactive: true,
            input: async () =>
              "https://shared.hivemnd.cloud/input/enroll?token=hidden-input",
            confirm: async () => false,
          },
        },
      ),
    ).resolves.toBe(0);
    expect(output.messages.join("\n")).not.toContain("hidden-input");
  });

  it("rolls back tenant config and registry when MCP registration conflicts", async () => {
    const temp = await temporaryDirectory();
    cleanups.push(temp.cleanup);
    const state = join(temp.path, ".hivemnd");
    const home = join(temp.path, "home");
    await mkdir(join(home, ".codex"), { recursive: true });
    await writeFile(
      join(home, ".codex/config.toml"),
      '[mcp_servers.hivemnd]\ncommand = "other"\n',
      "utf8",
    );
    const output = captureOutput();
    const stored = new Map<string, string>();
    const dependencies: RuntimeDependencies = {
      ...minimalRuntime(temp.path, output),
      homeDirectory: home,
      environment: { HIVEMND_HOME: state },
      tokenStoreFactory: (config) => ({
        get: async () => {
          const value = stored.get(config.apiUrl);
          return value ? { value, source: "keychain" as const } : undefined;
        },
        save: async (value) => {
          stored.set(config.apiUrl, value);
        },
        supportsPersistentStorage: () => true,
      }),
      apiClientFactory: (config) => organizationApi(config.apiUrl),
      adapterFactory: (config, names) =>
        createFilesystemAdapters(config, names, home, state),
    };
    const args = [
      "init",
      "--activation-url",
      "https://shared.hivemnd.cloud/rollback/enroll?token=one-time",
      "--client",
      "codex",
      "--scope",
      "codex=global",
      "--automatic-sync",
      "skip",
      "--apply",
    ];
    await expect(runCli(args, dependencies)).resolves.toBe(1);
    const repository = new OrganizationRegistryRepository(
      state,
      new ConfigRepository(temp.path),
    );
    await expect(repository.load()).resolves.toEqual({
      version: 1,
      profiles: [],
      workspaceBindings: [],
      globalBindings: [],
    });
    await expect(
      readFile(
        repository.profileConfigPath("https://shared.hivemnd.cloud/rollback"),
        "utf8",
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});

function profile(alias: string, apiUrl: string, configPath: string) {
  return {
    key: profileKey(apiUrl),
    alias,
    name: alias,
    slug: alias,
    apiUrl,
    configPath,
  };
}

function organizationApi(apiUrl: string): ApiClient {
  const slug =
    new URL(apiUrl).pathname.split("/").filter(Boolean).at(-1) ??
    "organization";
  return {
    previewEnrollment: async () => ({
      organization: { name: slug.toUpperCase(), slug },
      enabledClients: ["codex", "claude"],
    }),
    clientConfiguration: async () => ({
      organization: { name: slug.toUpperCase(), slug },
      enabledClients: ["codex", "claude"],
    }),
    exchangeEnrollment: async () => ({
      accessToken: `${slug}-token`,
      installationId: `${slug}-install`,
    }),
    manifest: async () => ({
      schemaVersion: 1,
      minimumClientVersion: "0.1.0",
      release: { id: `${slug}-release`, sequence: 1 },
      generatedAt: new Date("2026-01-01T00:00:00.000Z"),
      expiresAt: new Date("2099-01-01T00:00:00.000Z"),
      policyRevision: "policy",
      artifacts: [],
    }),
    listSources: async () => [],
    inspectSourceSchema: async () => {
      throw new Error("unused");
    },
    download: async () => new Uint8Array(),
    receipt: async () => undefined,
  };
}

function minimalRuntime(
  cwd: string,
  output: ReturnType<typeof captureOutput>,
): RuntimeDependencies {
  return {
    cwd,
    homeDirectory: join(cwd, "home"),
    environment: {},
    output,
    prompt: {
      interactive: false,
      input: async () => "",
      confirm: async () => false,
    },
    readHookInput: async () => "",
    configRepositoryFactory: (path) => new ConfigRepository(path),
    tokenStoreFactory: () => ({
      get: async () => undefined,
      save: async () => undefined,
    }),
    apiClientFactory: () => organizationApi("https://example.test/eigen"),
    adapterFactory: () => [],
    targetAccess: async () => undefined,
    id: () => "id",
    clientPlatform: "test",
    clientVersion: "1.0.0",
    updateService: {
      check: async () => ({
        checked: false,
        currentVersion: "1.0.0",
        updateAvailable: false,
        command: "update",
      }),
    },
    scheduleManagerFactory: () => ({
      install: async (intervalMinutes) => ({
        identity: "x",
        installed: true,
        active: true,
        intervalMinutes,
        lastRunFailed: undefined,
        errorLogPath: "/x",
      }),
      status: async () => ({
        identity: "x",
        installed: false,
        active: false,
        intervalMinutes: 15,
        lastRunFailed: undefined,
        errorLogPath: "/x",
      }),
      remove: async () => ({
        identity: "x",
        installed: false,
        active: false,
        intervalMinutes: 15,
        lastRunFailed: undefined,
        errorLogPath: "/x",
      }),
    }),
  };
}
