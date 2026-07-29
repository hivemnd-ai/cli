/* eslint-disable @typescript-eslint/unbound-method */
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigRepository } from "../src/config.js";
import type {
  ApiClient,
  ClientConfiguration,
  HivemndConfig,
  PromptPort,
  TokenStore,
} from "../src/domain.js";
import { initialize } from "../src/workflows/initialize.js";
import { HivemndError } from "../src/errors.js";
import { temporaryDirectory } from "./helpers.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

function prompt(answers: string[], confirmations: boolean[]): PromptPort {
  return {
    interactive: true,
    input: vi.fn(async () => answers.shift() ?? ""),
    confirm: vi.fn(async () => confirmations.shift() ?? false),
  };
}

function client(configuration: ClientConfiguration): ApiClient {
  return {
    previewEnrollment: vi.fn(async () => configuration),
    clientConfiguration: vi.fn(async () => configuration),
    exchangeEnrollment: vi.fn(async () => ({
      accessToken: "secret",
      installationId: "installation-1",
    })),
    manifest: vi.fn(async () => {
      throw new Error("init must not require a release");
    }),
    listSources: vi.fn(async () => []),
    inspectSourceSchema: vi.fn(async () => {
      throw new Error("unused");
    }),
    download: vi.fn(async () => new Uint8Array()),
    receipt: vi.fn(async () => undefined),
  };
}

describe("interactive onboarding", () => {
  it("previews activation, enabled AI tools, destinations, and automatic sync before persisting anything", async () => {
    const temp = await temporaryDirectory();
    cleanups.push(temp.cleanup);
    const workspace = join(temp.path, "workspace");
    await mkdir(workspace);
    const canonicalWorkspace = await realpath(workspace);
    const configPath = join(temp.path, ".hivemnd/config.json");
    const repository = new ConfigRepository(temp.path);
    const api = client({
      organization: { name: "Eigen", slug: "eigen" },
      enabledClients: ["codex", "claude"],
    });
    const store: TokenStore = {
      get: async () => undefined,
      save: vi.fn(async () => undefined),
      supportsPersistentStorage: () => true,
    };
    const schedule = {
      install: vi.fn(async (intervalMinutes: number) => ({
        identity: "eigen",
        installed: true,
        active: true,
        intervalMinutes,
        lastRunFailed: undefined,
        errorLogPath: "/private/error.log",
      })),
      status: vi.fn(async () => ({
        identity: "eigen",
        installed: false,
        active: false,
        intervalMinutes: 15,
        lastRunFailed: undefined,
        errorLogPath: "/private/error.log",
      })),
      remove: vi.fn(),
    };
    const messages: string[] = [];
    const initialSync = vi.fn(async () => undefined);
    const interactive = prompt(
      ["https://shared.hivemnd.cloud/eigen/enroll?token=one-time", workspace],
      [true, false, true, true, true],
    );

    const promise = initialize(
      { clients: [], scopes: [], workspaces: [], apply: false },
      {
        cwd: temp.path,
        configPath,
        configRepository: repository,
        tokenStoreFactory: () => store,
        apiClientFactory: () => api,
        scheduleManagerFactory: () => schedule,
        prompt: interactive,
        output: {
          write: (message) => messages.push(message),
          error: () => undefined,
        },
        clientPlatform: "darwin-arm64",
        clientVersion: "1.0.0",
        initialSync,
      },
    );

    await expect(promise).resolves.toBeUndefined();
    const saved = JSON.parse(
      await readFile(configPath, "utf8"),
    ) as HivemndConfig;
    expect(saved.apiUrl).toBe("https://shared.hivemnd.cloud/eigen");
    expect(saved.destinations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ agent: "codex", scope: "root" }),
        expect.objectContaining({
          agent: "claude",
          scope: "workspace",
          path: canonicalWorkspace,
        }),
      ]),
    );
    expect(messages.join("\n")).toContain("AI tools: codex, claude");
    expect(messages.join("\n")).toContain("Preview");
    expect(messages.join("\n")).toContain(
      "you can connect folders later with: hivemnd workspace add .",
    );
    expect(interactive.confirm).toHaveBeenCalledWith(
      "Install Hivemnd globally for Codex?",
      true,
    );
    expect(messages.join("\n")).not.toContain("one-time");
    expect(api.exchangeEnrollment).toHaveBeenCalledAfter(
      api.previewEnrollment as ReturnType<typeof vi.fn>,
    );
    expect(store.save).toHaveBeenCalledWith("secret");
    expect(initialSync).toHaveBeenCalledWith(saved);
    expect(schedule.install).toHaveBeenCalledWith(15);
  });

  it("reports a non-Error initial sync failure safely", async () => {
    const temp = await temporaryDirectory();
    cleanups.push(temp.cleanup);
    const output = { write: vi.fn(), error: vi.fn() };
    await expect(
      initialize(
        {
          activationUrl: "https://shared.hivemnd.cloud/eigen/enroll?token=x",
          clients: ["codex"],
          scopes: ["codex=global"],
          workspaces: [],
          automaticSync: "skip",
          apply: true,
        },
        {
          cwd: temp.path,
          configPath: join(temp.path, "config.json"),
          configRepository: new ConfigRepository(temp.path),
          tokenStoreFactory: () => ({
            get: async () => undefined,
            save: vi.fn(),
          }),
          apiClientFactory: () =>
            client({
              organization: { name: "Eigen", slug: "eigen" },
              enabledClients: ["codex"],
            }),
          scheduleManagerFactory: () => ({
            install: vi.fn(),
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
          prompt: { interactive: false, input: vi.fn(), confirm: vi.fn() },
          output,
          clientPlatform: "test",
          clientVersion: "1.0.0",
          initialSync: async () => Promise.reject("conflict"),
        },
      ),
    ).rejects.toMatchObject({ code: "SYNC_FAILED" });
    expect(output.error).toHaveBeenCalledWith(
      "Initial sync failed: Initial sync failed",
    );
  });

  it("does not mutate when preview confirmation is declined", async () => {
    const temp = await temporaryDirectory();
    cleanups.push(temp.cleanup);
    const configPath = join(temp.path, "config.json");
    const repository = new ConfigRepository(temp.path);
    const api = client({
      organization: { name: "Eigen", slug: "eigen" },
      enabledClients: ["codex"],
    });
    const store: TokenStore = {
      get: async () => undefined,
      save: vi.fn(),
      supportsPersistentStorage: () => true,
    };

    await initialize(
      {
        activationUrl: "https://shared.hivemnd.cloud/eigen/enroll?token=hidden",
        clients: ["codex"],
        scopes: ["codex=global"],
        workspaces: [],
        automaticSync: "skip",
        apply: false,
      },
      {
        cwd: temp.path,
        configPath,
        configRepository: repository,
        tokenStoreFactory: () => store,
        apiClientFactory: () => api,
        scheduleManagerFactory: () => ({
          install: vi.fn(),
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
        prompt: prompt([], [false]),
        output: { write: () => undefined, error: () => undefined },
        clientPlatform: "darwin-arm64",
        clientVersion: "1.0.0",
      },
    );

    await expect(readFile(configPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(api.exchangeEnrollment).not.toHaveBeenCalled();
    expect(store.save).not.toHaveBeenCalled();
  });

  it("resumes an authenticated tenant without removing omitted destinations and does not re-offer an installed schedule", async () => {
    const temp = await temporaryDirectory();
    cleanups.push(temp.cleanup);
    const configPath = join(temp.path, "config.json");
    const repository = new ConfigRepository(temp.path);
    const original: HivemndConfig = {
      apiUrl: "https://shared.hivemnd.cloud/eigen",
      destinations: [
        {
          name: "existing",
          agent: "codex",
          scope: "workspace",
          path: join(temp.path, "existing"),
        },
      ],
    };
    await repository.create(configPath, original);
    const api = client({
      organization: { name: "Eigen", slug: "eigen" },
      enabledClients: ["codex", "claude"],
    });
    const schedule = {
      install: vi.fn(),
      status: async () => ({
        identity: "x",
        installed: true,
        active: true,
        intervalMinutes: 30,
        lastRunFailed: false,
        errorLogPath: "/x",
      }),
      remove: vi.fn(),
    };
    const messages: string[] = [];

    await initialize(
      {
        clients: ["claude"],
        scopes: ["claude=workspace"],
        workspaces: [],
        apply: true,
      },
      {
        cwd: temp.path,
        configPath,
        configRepository: repository,
        tokenStoreFactory: () => ({
          get: async () => ({ value: "stored", source: "keychain" }),
          save: vi.fn(),
          supportsPersistentStorage: () => true,
        }),
        apiClientFactory: () => api,
        scheduleManagerFactory: () => schedule,
        prompt: { interactive: false, input: vi.fn(), confirm: vi.fn() },
        output: {
          write: (message) => messages.push(message),
          error: () => undefined,
        },
        clientPlatform: "darwin-arm64",
        clientVersion: "1.0.0",
      },
    );

    expect((await repository.load(configPath)).destinations).toContainEqual(
      original.destinations[0],
    );
    expect(schedule.install).not.toHaveBeenCalled();
    expect(messages.join("\n")).toContain("Automatic sync: installed, active");
  });

  it("requires explicit flags without a TTY and rejects disabled AI tools", async () => {
    const temp = await temporaryDirectory();
    cleanups.push(temp.cleanup);
    const base = {
      cwd: temp.path,
      configPath: join(temp.path, "config.json"),
      configRepository: new ConfigRepository(temp.path),
      tokenStoreFactory: () =>
        ({
          get: async () => undefined,
          save: vi.fn(),
          supportsPersistentStorage: () => true,
        }) satisfies TokenStore,
      apiClientFactory: () =>
        client({
          organization: { name: "Eigen", slug: "eigen" },
          enabledClients: ["codex"],
        }),
      scheduleManagerFactory: () => ({
        install: vi.fn(),
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
      prompt: {
        interactive: false,
        input: vi.fn(),
        confirm: vi.fn(),
      } satisfies PromptPort,
      output: { write: () => undefined, error: () => undefined },
      clientPlatform: "linux-x64",
      clientVersion: "1.0.0",
    };

    await expect(
      initialize(
        { clients: [], scopes: [], workspaces: [], apply: false },
        base,
      ),
    ).rejects.toMatchObject({ code: "INTERACTIVE_REQUIRED" });
    await expect(
      initialize(
        {
          activationUrl: "https://shared.hivemnd.cloud/eigen/enroll?token=x",
          clients: ["claude"],
          scopes: ["claude=global"],
          workspaces: [],
          automaticSync: "skip",
          apply: true,
        },
        base,
      ),
    ).rejects.toThrow("not enabled");
  });

  it("rejects corrupt existing configuration without previewing or replacing it", async () => {
    const temp = await temporaryDirectory();
    cleanups.push(temp.cleanup);
    const configPath = join(temp.path, "config.json");
    await writeFile(configPath, "not-json", "utf8");
    const api = client({
      organization: { name: "Eigen", slug: "eigen" },
      enabledClients: [],
    });

    await expect(
      initialize(
        {
          activationUrl: "https://shared.hivemnd.cloud/eigen/enroll?token=x",
          clients: [],
          scopes: [],
          workspaces: [],
          automaticSync: "skip",
          apply: true,
        },
        {
          cwd: temp.path,
          configPath,
          configRepository: new ConfigRepository(temp.path),
          tokenStoreFactory: () => ({
            get: async () => undefined,
            save: vi.fn(),
          }),
          apiClientFactory: () => api,
          scheduleManagerFactory: () => ({
            install: vi.fn(),
            status: vi.fn(),
            remove: vi.fn(),
          }),
          prompt: { interactive: false, input: vi.fn(), confirm: vi.fn() },
          output: { write: vi.fn(), error: vi.fn() },
          clientPlatform: "test",
          clientVersion: "1.0.0",
        },
      ),
    ).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    expect(await readFile(configPath, "utf8")).toBe("not-json");
    expect(api.previewEnrollment).not.toHaveBeenCalled();
  });

  it("installs accepted automatic sync even when the initial sync reports a fail-safe conflict", async () => {
    const temp = await temporaryDirectory();
    cleanups.push(temp.cleanup);
    const schedule = {
      install: vi.fn(async (intervalMinutes: number) => ({
        identity: "x",
        installed: true,
        active: true,
        intervalMinutes,
        lastRunFailed: undefined,
        errorLogPath: "/x",
      })),
      status: vi.fn(async () => ({
        identity: "x",
        installed: false,
        active: false,
        intervalMinutes: 15,
        lastRunFailed: undefined,
        errorLogPath: "/x",
      })),
      remove: vi.fn(),
    };
    const failure = new Error("unmanaged file conflict");

    await expect(
      initialize(
        {
          activationUrl: "https://shared.hivemnd.cloud/eigen/enroll?token=x",
          clients: ["codex"],
          scopes: ["codex=global"],
          workspaces: [],
          automaticSync: "install",
          apply: true,
        },
        {
          cwd: temp.path,
          configPath: join(temp.path, "config.json"),
          configRepository: new ConfigRepository(temp.path),
          tokenStoreFactory: () => ({
            get: async () => undefined,
            save: vi.fn(),
            supportsPersistentStorage: () => true,
          }),
          apiClientFactory: () =>
            client({
              organization: { name: "Eigen", slug: "eigen" },
              enabledClients: ["codex"],
            }),
          scheduleManagerFactory: () => schedule,
          prompt: { interactive: false, input: vi.fn(), confirm: vi.fn() },
          output: { write: vi.fn(), error: vi.fn() },
          clientPlatform: "test",
          clientVersion: "1.0.0",
          initialSync: vi.fn(async () => {
            throw failure;
          }),
        },
      ),
    ).rejects.toBe(failure);
    expect(schedule.install).toHaveBeenCalledWith(15);
  });

  it("only falls back to activation for revoked authentication", async () => {
    const temp = await temporaryDirectory();
    cleanups.push(temp.cleanup);
    const configPath = join(temp.path, "config.json");
    const repository = new ConfigRepository(temp.path);
    await repository.create(configPath, {
      apiUrl: "https://shared.hivemnd.cloud/eigen",
      destinations: [],
    });
    const configuration = {
      organization: { name: "Eigen", slug: "eigen" },
      enabledClients: [] as const,
    };
    const failed = client(configuration);
    vi.mocked(failed.clientConfiguration).mockRejectedValue(
      new HivemndError("HTTP_FAILED", "offline"),
    );
    const common = {
      cwd: temp.path,
      configPath,
      configRepository: repository,
      tokenStoreFactory: () => ({
        get: async () => ({ value: "old", source: "keychain" as const }),
        save: vi.fn(),
        supportsPersistentStorage: () => true,
      }),
      apiClientFactory: () => failed,
      scheduleManagerFactory: () => ({
        install: vi.fn(),
        status: vi.fn(),
        remove: vi.fn(),
      }),
      prompt: {
        interactive: false,
        input: vi.fn(),
        confirm: vi.fn(),
      } satisfies PromptPort,
      output: { write: vi.fn(), error: vi.fn() },
      clientPlatform: "test",
      clientVersion: "1.0.0",
    };
    await expect(
      initialize(
        {
          clients: [],
          scopes: [],
          workspaces: [],
          automaticSync: "skip",
          apply: true,
        },
        common,
      ),
    ).rejects.toMatchObject({ code: "HTTP_FAILED" });

    vi.mocked(failed.clientConfiguration).mockRejectedValue(
      new HivemndError("AUTH_MISSING", "revoked"),
    );
    await expect(
      initialize(
        {
          activationUrl: "https://shared.hivemnd.cloud/other/enroll?token=x",
          clients: [],
          scopes: [],
          workspaces: [],
          automaticSync: "skip",
          apply: true,
        },
        common,
      ),
    ).rejects.toThrow("different tenant");
  });

  it("validates headless scopes, clients, and secure automatic-sync prerequisites", async () => {
    const temp = await temporaryDirectory();
    cleanups.push(temp.cleanup);
    const api = client({
      organization: { name: "Eigen", slug: "eigen" },
      enabledClients: ["codex"],
    });
    const base = {
      cwd: temp.path,
      configPath: join(temp.path, "config.json"),
      configRepository: new ConfigRepository(temp.path),
      tokenStoreFactory: () => ({
        get: async () => undefined,
        save: vi.fn(),
        supportsPersistentStorage: () => false,
      }),
      apiClientFactory: () => api,
      scheduleManagerFactory: () => ({
        install: vi.fn(),
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
      prompt: {
        interactive: false,
        input: vi.fn(),
        confirm: vi.fn(),
      } satisfies PromptPort,
      output: { write: vi.fn(), error: vi.fn() },
      clientPlatform: "test",
      clientVersion: "1.0.0",
    };
    const activationUrl = "https://shared.hivemnd.cloud/eigen/enroll?token=x";
    await expect(
      initialize(
        {
          activationUrl,
          clients: ["codex"],
          scopes: ["codex=global=extra"],
          workspaces: [],
          automaticSync: "skip",
          apply: true,
        },
        base,
      ),
    ).rejects.toThrow("Invalid client scope");
    await expect(
      initialize(
        {
          activationUrl,
          clients: ["codex"],
          scopes: ["codex"],
          workspaces: [],
          automaticSync: "skip",
          apply: true,
        },
        base,
      ),
    ).rejects.toThrow("Invalid client scope");
    await expect(
      initialize(
        {
          activationUrl,
          clients: ["codex"],
          scopes: [],
          workspaces: [],
          automaticSync: "skip",
          apply: true,
        },
        base,
      ),
    ).rejects.toMatchObject({ code: "INTERACTIVE_REQUIRED" });
    await expect(
      initialize(
        {
          activationUrl,
          clients: ["cursor"],
          scopes: [],
          workspaces: [],
          automaticSync: "skip",
          apply: true,
        },
        base,
      ),
    ).rejects.toThrow("Unknown AI tool");
    await expect(
      initialize(
        {
          activationUrl,
          clients: ["codex"],
          scopes: ["codex=skip"],
          workspaces: [],
          automaticSync: "install",
          apply: true,
        },
        base,
      ),
    ).rejects.toMatchObject({ code: "KEYCHAIN_UNAVAILABLE" });
  });

  it("uses a secret activation prompt after token lookup failure and supports an empty organization", async () => {
    const temp = await temporaryDirectory();
    cleanups.push(temp.cleanup);
    const configPath = join(temp.path, "config.json");
    const repository = new ConfigRepository(temp.path);
    await repository.create(configPath, {
      apiUrl: "https://shared.hivemnd.cloud/eigen",
      destinations: [],
    });
    const secret = vi.fn(
      async () => "https://shared.hivemnd.cloud/eigen/enroll?token=x",
    );
    const messages: string[] = [];
    await initialize(
      {
        clients: [],
        scopes: [],
        workspaces: [],
        automaticSync: "skip",
        apply: true,
      },
      {
        cwd: temp.path,
        configPath,
        configRepository: repository,
        tokenStoreFactory: () => ({
          get: async () => {
            throw new Error("keychain unavailable");
          },
          save: vi.fn(),
        }),
        apiClientFactory: () =>
          client({
            organization: { name: "Eigen", slug: "eigen" },
            enabledClients: [],
          }),
        scheduleManagerFactory: () => ({
          install: vi.fn(),
          status: async () => ({
            identity: "x",
            installed: true,
            active: false,
            intervalMinutes: 15,
            lastRunFailed: true,
            errorLogPath: "/x",
          }),
          remove: vi.fn(),
        }),
        prompt: { interactive: true, secret, input: vi.fn(), confirm: vi.fn() },
        output: { write: (message) => messages.push(message), error: vi.fn() },
        clientPlatform: "test",
        clientVersion: "1.0.0",
      },
    );
    expect(secret).toHaveBeenCalledWith("Activation URL");
    expect(messages).toContain("AI tools: none enabled");
    expect(messages).toContain("Automatic sync: installed, inactive");
  });

  it("accepts the product-language skip scope", async () => {
    const temp = await temporaryDirectory();
    cleanups.push(temp.cleanup);
    await initialize(
      {
        activationUrl: "https://shared.hivemnd.cloud/eigen/enroll?token=x",
        clients: [],
        scopes: [],
        workspaces: [],
        automaticSync: "skip",
        apply: false,
      },
      {
        cwd: temp.path,
        configPath: join(temp.path, "config.json"),
        configRepository: new ConfigRepository(temp.path),
        tokenStoreFactory: () => ({
          get: async () => undefined,
          save: vi.fn(),
        }),
        apiClientFactory: () =>
          client({
            organization: { name: "Eigen", slug: "eigen" },
            enabledClients: ["codex"],
          }),
        scheduleManagerFactory: () => ({
          install: vi.fn(),
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
        prompt: prompt([], [false, false, true]),
        output: { write: vi.fn(), error: vi.fn() },
        clientPlatform: "test",
        clientVersion: "1.0.0",
      },
    );
  });

  it("installs automatic sync for a fresh empty organization without requesting a release", async () => {
    const temp = await temporaryDirectory();
    cleanups.push(temp.cleanup);
    const schedule = {
      install: vi.fn(async (intervalMinutes: number) => ({
        identity: "x",
        installed: true,
        active: true,
        intervalMinutes,
        lastRunFailed: undefined,
        errorLogPath: "/x",
      })),
      status: async () => ({
        identity: "x",
        installed: false,
        active: false,
        intervalMinutes: 15,
        lastRunFailed: undefined,
        errorLogPath: "/x",
      }),
      remove: vi.fn(),
    };
    const initialSync = vi.fn();
    await initialize(
      {
        activationUrl: "https://shared.hivemnd.cloud/eigen/enroll?token=x",
        clients: [],
        scopes: [],
        workspaces: [],
        apply: false,
      },
      {
        cwd: temp.path,
        configPath: join(temp.path, "config.json"),
        configRepository: new ConfigRepository(temp.path),
        tokenStoreFactory: () => ({
          get: async () => undefined,
          save: vi.fn(),
          supportsPersistentStorage: () => true,
        }),
        apiClientFactory: () =>
          client({
            organization: { name: "Eigen", slug: "eigen" },
            enabledClients: [],
          }),
        scheduleManagerFactory: () => schedule,
        prompt: prompt([], [true, true]),
        output: { write: vi.fn(), error: vi.fn() },
        clientPlatform: "test",
        clientVersion: "1.0.0",
        initialSync,
      },
    );
    expect(schedule.install).toHaveBeenCalledWith(15);
    expect(initialSync).not.toHaveBeenCalled();
  });
});
