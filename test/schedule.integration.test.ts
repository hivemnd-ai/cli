import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HivemndError } from "../src/errors.js";
import {
  createScheduleManager,
  PeriodicSyncScheduler,
  runScheduleCommand,
  scheduleIdentity,
  type ScheduleCommandRunner,
  type ScheduleRequest,
} from "../src/schedule/periodic-sync-scheduler.js";
import { temporaryDirectory } from "./helpers.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  vi.restoreAllMocks();
});

function runner(): ScheduleCommandRunner & { calls: string[][] } {
  const calls: string[][] = [];
  return Object.assign(
    async (command: string, args: readonly string[]) => {
      calls.push([command, ...args]);
      return { stdout: "active\n" };
    },
    { calls },
  );
}

describe("periodic sync scheduler", () => {
  it("installs, reports, reinstalls, and removes an isolated macOS LaunchAgent", async () => {
    const temp = await temporaryDirectory();
    cleanups.push(temp.cleanup);
    const execute = runner();
    const configPath = join(temp.path, "tenant & config.json");
    const scheduler = new PeriodicSyncScheduler({
      platform: "darwin",
      homeDirectory: temp.path,
      stateDirectory: join(temp.path, ".hivemnd"),
      runtimeExecutablePath:
        "/Users/felipe/.nvm/versions/node/v24 & stable/bin/node",
      cliScriptPath: "/Applications/Hivemnd & tools/dist/index.js",
      userId: 501,
      execute,
    });
    const request = {
      apiUrl: "https://shared.hivemnd.cloud/eigen",
      configPath,
      intervalMinutes: 15,
    };
    const identity = scheduleIdentity(request.apiUrl, configPath);
    const plistPath = join(
      temp.path,
      "Library/LaunchAgents",
      `cloud.hivemnd.sync.${identity}.plist`,
    );

    await expect(scheduler.install(request)).resolves.toMatchObject({
      identity,
      intervalMinutes: 15,
    });
    await expect(scheduler.install(request)).resolves.toMatchObject({
      identity,
    });
    const plist = await readFile(plistPath, "utf8");
    expect(plist).toContain("<integer>900</integer>");
    expect(plist).toContain(
      "<string>/Users/felipe/.nvm/versions/node/v24 &amp; stable/bin/node</string>",
    );
    expect(plist).toContain(
      "<string>/Applications/Hivemnd &amp; tools/dist/index.js</string>",
    );
    expect(plist).toContain("tenant &amp; config.json");
    expect(plist).toContain("<string>--config</string>");
    expect(plist).toContain("<string>sync</string>");
    expect(plist).toContain("<string>--apply</string>");
    expect(plist).not.toContain("token");
    expect((await stat(plistPath)).mode & 0o777).toBe(0o600);
    await expect(scheduler.status(request)).resolves.toEqual({
      active: true,
      identity,
      installed: true,
      intervalMinutes: 15,
    });
    await expect(scheduler.remove(request)).resolves.toMatchObject({
      installed: false,
      active: false,
    });
    await expect(scheduler.remove(request)).resolves.toMatchObject({
      installed: false,
    });
    await expect(scheduler.status(request)).resolves.toMatchObject({
      installed: false,
      active: false,
    });
    expect(execute.calls).toContainEqual([
      "launchctl",
      "bootstrap",
      "gui/501",
      plistPath,
    ]);
  });

  it("installs an idempotent Linux systemd user timer with private logs and exact arguments", async () => {
    const temp = await temporaryDirectory();
    cleanups.push(temp.cleanup);
    const execute = runner();
    const configPath = join(temp.path, "tenant % config.json");
    const stateDirectory = join(temp.path, ".hivemnd");
    const scheduler = new PeriodicSyncScheduler({
      platform: "linux",
      homeDirectory: temp.path,
      stateDirectory,
      runtimeExecutablePath: "/home/felipe/.nvm/versions/node/v24/bin/node",
      cliScriptPath: "/opt/Hivemnd CLI/dist/index.js",
      userId: 1000,
      execute,
    });
    const request = {
      apiUrl: "https://shared.hivemnd.cloud/eigen",
      configPath,
      intervalMinutes: 30,
    };
    const identity = scheduleIdentity(request.apiUrl, configPath);
    const unitDirectory = join(temp.path, ".config/systemd/user");
    const serviceName = `hivemnd-sync-${identity}.service`;
    const timerName = `hivemnd-sync-${identity}.timer`;

    await scheduler.install(request);
    const service = await readFile(join(unitDirectory, serviceName), "utf8");
    const timer = await readFile(join(unitDirectory, timerName), "utf8");
    expect(service).toContain(
      'ExecStart="/home/felipe/.nvm/versions/node/v24/bin/node" "/opt/Hivemnd CLI/dist/index.js" "--config"',
    );
    expect(service).toContain('tenant %% config.json" "sync" "--apply"');
    expect(timer).toContain("OnUnitActiveSec=30min");
    expect(timer).toContain("Persistent=true");
    expect(service).not.toContain("token");
    expect((await stat(join(stateDirectory, "logs"))).mode & 0o777).toBe(0o700);
    expect(
      (await stat(join(stateDirectory, "logs", `sync-${identity}.log`))).mode &
        0o777,
    ).toBe(0o600);
    await expect(scheduler.status(request)).resolves.toMatchObject({
      installed: true,
      active: true,
    });
    await scheduler.remove(request);
    expect(execute.calls).toContainEqual([
      "systemctl",
      "--user",
      "enable",
      "--now",
      timerName,
    ]);
    expect(execute.calls).toContainEqual([
      "systemctl",
      "--user",
      "disable",
      "--now",
      timerName,
    ]);
  });

  it("fails closed on Windows, invalid intervals, relative paths, and command failures", async () => {
    const temp = await temporaryDirectory();
    cleanups.push(temp.cleanup);
    const unsupported = new PeriodicSyncScheduler({
      platform: "win32",
      homeDirectory: temp.path,
      stateDirectory: join(temp.path, ".hivemnd"),
      runtimeExecutablePath: "C:\\node.exe",
      cliScriptPath: "C:\\hivemnd.js",
      userId: 1,
      execute: runner(),
    });
    const request = {
      apiUrl: "https://shared.hivemnd.cloud/eigen",
      configPath: join(temp.path, "config.json"),
      intervalMinutes: 15,
    };
    for (const action of ["install", "status", "remove"] as const) {
      await expect(unsupported[action](request)).rejects.toMatchObject({
        code: "SCHEDULE_UNSUPPORTED",
      });
    }

    const linux = new PeriodicSyncScheduler({
      platform: "linux",
      homeDirectory: temp.path,
      stateDirectory: join(temp.path, ".hivemnd"),
      runtimeExecutablePath: "/usr/bin/node",
      cliScriptPath: "/usr/lib/hivemnd/dist/index.js",
      userId: 1,
      execute: async () => {
        throw new Error("system service unavailable");
      },
    });
    await expect(
      linux.install({ ...request, intervalMinutes: 0 }),
    ).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(
      linux.install({ ...request, intervalMinutes: 1.5 }),
    ).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(
      linux.install({ ...request, configPath: "relative.json" }),
    ).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(
      new PeriodicSyncScheduler({
        platform: "linux",
        homeDirectory: temp.path,
        stateDirectory: join(temp.path, ".hivemnd"),
        runtimeExecutablePath: "relative-node",
        cliScriptPath: "/usr/lib/hivemnd/dist/index.js",
        userId: 1,
        execute: runner(),
      }).install(request),
    ).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(
      new PeriodicSyncScheduler({
        platform: "linux",
        homeDirectory: temp.path,
        stateDirectory: join(temp.path, ".hivemnd"),
        runtimeExecutablePath: "/usr/bin/node",
        cliScriptPath: "relative-index.js",
        userId: 1,
        execute: runner(),
      }).install(request),
    ).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(
      linux.install({
        ...request,
        configPath: `${request.configPath}\nunsafe`,
      }),
    ).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(
      linux.install({
        ...request,
        configPath: `${request.configPath}\u007funsafe`,
      }),
    ).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(
      new PeriodicSyncScheduler({
        platform: "linux",
        homeDirectory: temp.path,
        stateDirectory: join(temp.path, ".hivemnd"),
        runtimeExecutablePath: "/usr/bin/node\nunsafe",
        cliScriptPath: "/usr/lib/hivemnd/dist/index.js",
        userId: 1,
        execute: runner(),
      }).install(request),
    ).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(
      new PeriodicSyncScheduler({
        platform: "linux",
        homeDirectory: temp.path,
        stateDirectory: join(temp.path, ".hivemnd"),
        runtimeExecutablePath: "/usr/bin/node",
        cliScriptPath: "/usr/lib/hivemnd/dist/index.js\nunsafe",
        userId: 1,
        execute: runner(),
      }).install(request),
    ).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(linux.install(request)).rejects.toThrow(
      "system service unavailable",
    );
    expect(new HivemndError("SCHEDULE_UNSUPPORTED", "x").code).toBe(
      "SCHEDULE_UNSUPPORTED",
    );
  });

  it("falls back safely for invalid metadata and unavailable service status", async () => {
    const temp = await temporaryDirectory();
    cleanups.push(temp.cleanup);
    const execute = vi
      .fn<ScheduleCommandRunner>()
      .mockRejectedValueOnce(new Error("not loaded"))
      .mockResolvedValue({ stdout: "" });
    const scheduler = new PeriodicSyncScheduler({
      platform: "darwin",
      homeDirectory: temp.path,
      stateDirectory: join(temp.path, ".hivemnd"),
      runtimeExecutablePath: "/usr/local/bin/node",
      cliScriptPath: "/usr/local/lib/hivemnd/dist/index.js",
      userId: 501,
      execute,
    });
    const request = {
      apiUrl: "https://shared.hivemnd.cloud/eigen",
      configPath: join(temp.path, "config.json"),
      intervalMinutes: 15,
    };
    await scheduler.install(request);
    execute.mockRejectedValueOnce(new Error("inactive"));
    await expect(scheduler.status(request)).resolves.toMatchObject({
      installed: true,
      active: false,
    });

    const identity = scheduleIdentity(request.apiUrl, request.configPath);
    await writeFile(
      join(temp.path, ".hivemnd/schedules", `${identity}.json`),
      JSON.stringify({
        apiUrl: "https://different.hivemnd.cloud/tenant",
        configPath: request.configPath,
        intervalMinutes: 30,
      }),
    );
    await expect(scheduler.status(request)).resolves.toMatchObject({
      intervalMinutes: 15,
    });
  });

  it("binds a default interval manager and executes commands without a shell", async () => {
    const scheduler = {
      install: vi.fn(async (request: ScheduleRequest) => ({
        ...request,
        identity: "x",
        installed: true,
        active: true,
      })),
      status: vi.fn(async (request: ScheduleRequest) => ({
        ...request,
        identity: "x",
        installed: true,
        active: true,
      })),
      remove: vi.fn(async (request: ScheduleRequest) => ({
        ...request,
        identity: "x",
        installed: false,
        active: false,
      })),
    };
    const manager = createScheduleManager(scheduler, {
      apiUrl: "https://shared.hivemnd.cloud/eigen",
      configPath: "/config.json",
    });
    await manager.install(22);
    await manager.status();
    await manager.remove();
    expect(scheduler.install).toHaveBeenCalledWith(
      expect.objectContaining({ intervalMinutes: 22 }),
    );
    expect(scheduler.status).toHaveBeenCalledWith(
      expect.objectContaining({ intervalMinutes: 15 }),
    );

    await expect(
      runScheduleCommand(process.execPath, [
        "-e",
        "process.stdout.write('scheduled')",
      ]),
    ).resolves.toEqual({ stdout: "scheduled" });
    await expect(
      runScheduleCommand(process.execPath, [
        "-e",
        "process.stderr.write('denied'); process.exit(2)",
      ]),
    ).rejects.toThrow("denied");
    await expect(
      runScheduleCommand(process.execPath, ["-e", "process.exit(3)"]),
    ).rejects.toThrow("exited with 3");
    await expect(
      runScheduleCommand("/definitely/missing/hivemnd", []),
    ).rejects.toThrow();
  });
});
