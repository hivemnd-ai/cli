import { mkdir, readFile, writeFile } from "node:fs/promises";
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
import type { ApiClient, HivemndConfig, TokenStore } from "../src/domain.js";
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
    await expect(runCli(["sync"], empty.deps)).resolves.toBe(1);
    expect(empty.deps.output.errors.at(-1)).toContain(
      "No synchronization destinations",
    );
  });
});

describe("sync command", () => {
  it("is a dry run by default and recognizes explicit --dry-run", async () => {
    const first = await setup();
    await expect(runCli(["sync"], first.deps)).resolves.toBe(0);
    expect(first.deps.output.messages.at(-1)).toBe(
      "dry-run: 2 change(s); pass --apply to write",
    );
    const second = await setup();
    await expect(runCli(["sync", "--dry-run"], second.deps)).resolves.toBe(0);
    expect(second.deps.output.messages.at(-1)).toContain("dry-run");
    await expect(
      runCli(["sync", "--dry-run", "--apply"], second.deps),
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
    await expect(runCli(["sync"], deps)).resolves.toBe(0);
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
    await expect(runCli(["sync", "--apply"], deps)).resolves.toBe(0);
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
    await expect(runCli(["sync", "--apply"], deps)).resolves.toBe(0);
    expect(deps.output.messages).toContain("applied: 0 change(s)");

    const deferred = await setup({
      selectedApi: {
        ...api(),
        receipt: async () => Promise.reject(new Error("offline")),
      },
    });
    await expect(runCli(["sync", "--apply"], deferred.deps)).resolves.toBe(0);
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
    ]);
    const { deps } = await setup({ selectedApi: { ...api(), listSources } });

    await expect(runCli(["sources", "list"], deps)).resolves.toBe(0);

    expect(listSources).toHaveBeenCalledWith("token");
    expect(deps.output.messages).toEqual([
      `${sourceId} | Engineering database | postgresql_database | active | inspect_schema:available, execute_approved_read_query:disabled`,
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
    expect(defaultDependencies.clientVersion).toBe("0.1.2");
    const defaultPath = createProgram({ ...deps, environment: {} }).opts<{
      config: string;
    }>().config;
    expect(defaultPath).toBe(join(homedir(), ".hivemnd/config.json"));
    expect(log).toHaveBeenCalledWith("message");
    expect(error).toHaveBeenCalledWith("problem");
  });
});
