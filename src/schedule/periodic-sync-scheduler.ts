import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import {
  access,
  chmod,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { HivemndError } from "../errors.js";

export interface ScheduleRequest {
  readonly apiUrl: string;
  readonly configPath: string;
  readonly intervalMinutes: number;
}

export interface ScheduleState {
  readonly identity: string;
  readonly installed: boolean;
  readonly active: boolean;
  readonly intervalMinutes: number;
  readonly lastRunFailed: boolean | undefined;
  readonly errorLogPath: string;
}

export interface ScheduleManager {
  install(intervalMinutes: number): Promise<ScheduleState>;
  status(): Promise<ScheduleState>;
  remove(): Promise<ScheduleState>;
}

export type ScheduleCommandRunner = (
  command: string,
  args: readonly string[],
) => Promise<{ readonly stdout: string }>;

interface SchedulerOptions {
  readonly platform: NodeJS.Platform;
  readonly homeDirectory: string;
  readonly stateDirectory: string;
  readonly runtimeExecutablePath: string;
  readonly cliScriptPath: string;
  readonly userId: number;
  readonly execute?: ScheduleCommandRunner;
}

export class PeriodicSyncScheduler {
  private readonly execute: ScheduleCommandRunner;

  constructor(private readonly options: SchedulerOptions) {
    this.execute = options.execute ?? runScheduleCommand;
  }

  async install(request: ScheduleRequest): Promise<ScheduleState> {
    this.validate(request);
    await this.preparePrivateState(request);
    if (this.options.platform === "darwin") {
      await this.installLaunchAgent(request);
    } else {
      await this.installSystemdTimer(request);
    }
    await this.writeMetadata(request);
    return this.state(request, true, true, undefined);
  }

  async status(request: ScheduleRequest): Promise<ScheduleState> {
    this.validate(request);
    const effective = await this.effectiveRequest(request);
    if (this.options.platform === "darwin") {
      const installed = await exists(this.launchAgentPath(effective));
      const launchState = installed
        ? await this.commandOutput("launchctl", [
            "print",
            this.launchTarget(effective),
          ])
        : undefined;
      const active = launchState !== undefined;
      return this.state(
        effective,
        installed,
        active,
        macOsLastRunFailed(launchState),
      );
    }
    const installed =
      (await exists(this.systemdServicePath(effective))) &&
      (await exists(this.systemdTimerPath(effective)));
    const timer = this.systemdTimerName(effective);
    const enabled =
      installed &&
      (await this.commandSucceeds("systemctl", [
        "--user",
        "is-enabled",
        "--quiet",
        timer,
      ]));
    const active =
      enabled &&
      (await this.commandSucceeds("systemctl", [
        "--user",
        "is-active",
        "--quiet",
        timer,
      ]));
    const serviceResult = installed
      ? await this.commandOutput("systemctl", [
          "--user",
          "show",
          "--property=Result",
          "--value",
          this.systemdServiceName(effective),
        ])
      : undefined;
    return this.state(
      effective,
      installed,
      active,
      systemdLastRunFailed(serviceResult),
    );
  }

  async remove(request: ScheduleRequest): Promise<ScheduleState> {
    this.validate(request);
    const effective = await this.effectiveRequest(request);
    if (this.options.platform === "darwin") {
      await this.commandSucceeds("launchctl", [
        "bootout",
        this.launchTarget(effective),
      ]);
      await rm(this.launchAgentPath(effective), { force: true });
    } else {
      await this.commandSucceeds("systemctl", [
        "--user",
        "disable",
        "--now",
        this.systemdTimerName(effective),
      ]);
      await rm(this.systemdServicePath(effective), { force: true });
      await rm(this.systemdTimerPath(effective), { force: true });
      await this.execute("systemctl", ["--user", "daemon-reload"]);
    }
    await rm(this.metadataPath(effective), { force: true });
    return this.state(effective, false, false, false);
  }

  private validate(request: ScheduleRequest): void {
    if (
      this.options.platform !== "darwin" &&
      this.options.platform !== "linux"
    ) {
      throw new HivemndError(
        "SCHEDULE_UNSUPPORTED",
        "Periodic sync is supported on macOS LaunchAgents and Linux systemd user timers. On Windows, run `hivemnd --config <absolute-path> sync --all --apply` from Task Scheduler.",
      );
    }
    if (
      !Number.isInteger(request.intervalMinutes) ||
      request.intervalMinutes < 1 ||
      request.intervalMinutes > 1_440
    ) {
      throw new HivemndError(
        "CONFIG_INVALID",
        "Schedule interval must be an integer from 1 to 1440 minutes",
      );
    }
    if (!isAbsolute(request.configPath)) {
      throw new HivemndError(
        "CONFIG_INVALID",
        "Scheduled synchronization requires an absolute config path",
      );
    }
    if (!isAbsolute(this.options.runtimeExecutablePath)) {
      throw new HivemndError(
        "CONFIG_INVALID",
        "Scheduled synchronization requires an absolute Node runtime path",
      );
    }
    if (!isAbsolute(this.options.cliScriptPath)) {
      throw new HivemndError(
        "CONFIG_INVALID",
        "Scheduled synchronization requires an absolute Hivemnd CLI script path",
      );
    }
    if (
      hasControlCharacters(request.configPath) ||
      hasControlCharacters(this.options.runtimeExecutablePath) ||
      hasControlCharacters(this.options.cliScriptPath)
    ) {
      throw new HivemndError(
        "CONFIG_INVALID",
        "Schedule paths contain unsupported control characters",
      );
    }
  }

  private async preparePrivateState(request: ScheduleRequest): Promise<void> {
    const directories = [
      this.options.stateDirectory,
      this.logsDirectory(),
      this.schedulesDirectory(),
    ];
    for (const directory of directories) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await chmod(directory, 0o700);
    }
    for (const path of [this.stdoutPath(request), this.stderrPath(request)]) {
      await writeFile(path, "", { flag: "a", mode: 0o600 });
      await chmod(path, 0o600);
    }
  }

  private async installLaunchAgent(request: ScheduleRequest): Promise<void> {
    const directory = join(this.options.homeDirectory, "Library/LaunchAgents");
    const path = this.launchAgentPath(request);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writePrivate(path, this.launchAgent(request));
    await this.commandSucceeds("launchctl", [
      "bootout",
      this.launchTarget(request),
    ]);
    await this.execute("launchctl", [
      "bootstrap",
      `gui/${this.options.userId}`,
      path,
    ]);
  }

  private async installSystemdTimer(request: ScheduleRequest): Promise<void> {
    const directory = this.systemdDirectory();
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writePrivate(
      this.systemdServicePath(request),
      this.systemdService(request),
    );
    await writePrivate(
      this.systemdTimerPath(request),
      this.systemdTimer(request),
    );
    await this.execute("systemctl", ["--user", "daemon-reload"]);
    await this.execute("systemctl", [
      "--user",
      "enable",
      "--now",
      this.systemdTimerName(request),
    ]);
  }

  private launchAgent(request: ScheduleRequest): string {
    const argumentsList = this.syncArguments(request)
      .map((argument) => `      <string>${xmlEscape(argument)}</string>`)
      .join("\n");
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>${this.launchLabel(request)}</string>
    <key>ProgramArguments</key>
    <array>
${argumentsList}
    </array>
    <key>StartInterval</key>
    <integer>${request.intervalMinutes * 60}</integer>
    <key>RunAtLoad</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${xmlEscape(this.stdoutPath(request))}</string>
    <key>StandardErrorPath</key>
    <string>${xmlEscape(this.stderrPath(request))}</string>
  </dict>
</plist>
`;
  }

  private systemdService(request: ScheduleRequest): string {
    const command = this.syncArguments(request).map(systemdQuote).join(" ");
    return `[Unit]
Description=Synchronize Hivemnd artifacts (${scheduleIdentity(request.apiUrl, request.configPath)})

[Service]
Type=oneshot
ExecStart=${command}
NoNewPrivileges=true
PrivateTmp=true
StandardOutput=${systemdQuote(`append:${this.stdoutPath(request)}`)}
StandardError=${systemdQuote(`append:${this.stderrPath(request)}`)}
`;
  }

  private systemdTimer(request: ScheduleRequest): string {
    return `[Unit]
Description=Run Hivemnd synchronization periodically

[Timer]
OnBootSec=2min
OnUnitActiveSec=${request.intervalMinutes}min
Persistent=true
Unit=${this.systemdServiceName(request)}

[Install]
WantedBy=timers.target
`;
  }

  private syncArguments(request: ScheduleRequest): readonly string[] {
    return [
      this.options.runtimeExecutablePath,
      this.options.cliScriptPath,
      "--config",
      request.configPath,
      "sync",
      "--all",
      "--apply",
    ];
  }

  private async effectiveRequest(
    request: ScheduleRequest,
  ): Promise<ScheduleRequest> {
    try {
      const metadata = JSON.parse(
        await readFile(this.metadataPath(request), "utf8"),
      ) as unknown;
      if (
        isRecord(metadata) &&
        metadata.apiUrl === request.apiUrl &&
        metadata.configPath === request.configPath &&
        typeof metadata.intervalMinutes === "number"
      ) {
        return { ...request, intervalMinutes: metadata.intervalMinutes };
      }
    } catch {
      // Missing or invalid metadata means the caller's default interval is used.
    }
    return request;
  }

  private async writeMetadata(request: ScheduleRequest): Promise<void> {
    await writePrivate(
      this.metadataPath(request),
      `${JSON.stringify({
        apiUrl: request.apiUrl,
        configPath: request.configPath,
        intervalMinutes: request.intervalMinutes,
      })}\n`,
    );
  }

  private async commandSucceeds(
    command: string,
    args: readonly string[],
  ): Promise<boolean> {
    return (await this.commandOutput(command, args)) !== undefined;
  }

  private async commandOutput(
    command: string,
    args: readonly string[],
  ): Promise<string | undefined> {
    try {
      return (await this.execute(command, args)).stdout;
    } catch {
      return undefined;
    }
  }

  private state(
    request: ScheduleRequest,
    installed: boolean,
    active: boolean,
    lastRunFailed: boolean | undefined,
  ): ScheduleState {
    return {
      identity: scheduleIdentity(request.apiUrl, request.configPath),
      installed,
      active,
      intervalMinutes: request.intervalMinutes,
      lastRunFailed,
      errorLogPath: this.stderrPath(request),
    };
  }

  private launchLabel(request: ScheduleRequest): string {
    return `cloud.hivemnd.sync.${scheduleIdentity(request.apiUrl, request.configPath)}`;
  }

  private launchTarget(request: ScheduleRequest): string {
    return `gui/${this.options.userId}/${this.launchLabel(request)}`;
  }

  private launchAgentPath(request: ScheduleRequest): string {
    return join(
      this.options.homeDirectory,
      "Library/LaunchAgents",
      `${this.launchLabel(request)}.plist`,
    );
  }

  private systemdDirectory(): string {
    return join(this.options.homeDirectory, ".config/systemd/user");
  }

  private systemdServiceName(request: ScheduleRequest): string {
    return `hivemnd-sync-${scheduleIdentity(request.apiUrl, request.configPath)}.service`;
  }

  private systemdTimerName(request: ScheduleRequest): string {
    return `hivemnd-sync-${scheduleIdentity(request.apiUrl, request.configPath)}.timer`;
  }

  private systemdServicePath(request: ScheduleRequest): string {
    return join(this.systemdDirectory(), this.systemdServiceName(request));
  }

  private systemdTimerPath(request: ScheduleRequest): string {
    return join(this.systemdDirectory(), this.systemdTimerName(request));
  }

  private logsDirectory(): string {
    return join(this.options.stateDirectory, "logs");
  }

  private schedulesDirectory(): string {
    return join(this.options.stateDirectory, "schedules");
  }

  private stdoutPath(request: ScheduleRequest): string {
    return join(
      this.logsDirectory(),
      `sync-${scheduleIdentity(request.apiUrl, request.configPath)}.log`,
    );
  }

  private stderrPath(request: ScheduleRequest): string {
    return join(
      this.logsDirectory(),
      `sync-${scheduleIdentity(request.apiUrl, request.configPath)}.error.log`,
    );
  }

  private metadataPath(request: ScheduleRequest): string {
    return join(
      this.schedulesDirectory(),
      `${scheduleIdentity(request.apiUrl, request.configPath)}.json`,
    );
  }
}

export function scheduleIdentity(apiUrl: string, configPath: string): string {
  return createHash("sha256")
    .update(`${apiUrl}\0${configPath}`)
    .digest("hex")
    .slice(0, 16);
}

export function createScheduleManager(
  scheduler: Pick<PeriodicSyncScheduler, "install" | "status" | "remove">,
  request: Omit<ScheduleRequest, "intervalMinutes">,
): ScheduleManager {
  const defaultIntervalMinutes = 15;
  return {
    install: (intervalMinutes) =>
      scheduler.install({ ...request, intervalMinutes }),
    status: () =>
      scheduler.status({ ...request, intervalMinutes: defaultIntervalMinutes }),
    remove: () =>
      scheduler.remove({ ...request, intervalMinutes: defaultIntervalMinutes }),
  };
}

export function runScheduleCommand(
  command: string,
  args: readonly string[],
): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      env: process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += String(chunk)));
    child.stderr.on("data", (chunk) => (stderr += String(chunk)));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout });
      else reject(new Error(stderr.trim() || `${command} exited with ${code}`));
    });
  });
}

async function writePrivate(path: string, contents: string): Promise<void> {
  await writeFile(path, contents, { encoding: "utf8", mode: 0o600 });
  await chmod(path, 0o600);
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function systemdQuote(value: string): string {
  return `"${value.replaceAll("%", "%%").replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codePoint = value.charCodeAt(index);
    if (codePoint <= 31 || codePoint === 127) return true;
  }
  return false;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function macOsLastRunFailed(output: string | undefined): boolean | undefined {
  if (output === undefined) return undefined;
  const runs = capturedNumber(output, /\bruns\s*=\s*(\d+)/);
  if (runs === undefined || runs <= 0) return undefined;
  const exitCode = capturedNumber(output, /\blast exit code\s*=\s*(-?\d+)/);
  if (exitCode === undefined) return undefined;
  return exitCode !== 0;
}

function systemdLastRunFailed(output: string | undefined): boolean | undefined {
  if (output === undefined) return undefined;
  const result = output.trim();
  if (result.length === 0) return undefined;
  return result !== "success";
}

function capturedNumber(output: string, pattern: RegExp): number | undefined {
  const captured = pattern.exec(output)?.[1];
  return captured === undefined ? undefined : Number(captured);
}
