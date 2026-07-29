import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser";
import type { AgentKind } from "../domain.js";
import { HivemndError } from "../errors.js";
import type {
  CustomRegistrationInstallOperation,
  RegistrationResult,
  RegistrationState,
} from "../mcp/registration.js";

const MANAGED_ARGUMENT = "--hivemnd-managed-hook";
const MANAGED_VERSION = "1";
const STATUS_MESSAGE = "Loading verified Hivemnd context";

interface Snapshot {
  readonly existed: boolean;
  readonly content: string;
  readonly mode?: number;
}

export interface HookLauncherDefinition {
  readonly client: AgentKind;
  readonly scope: "global" | "workspace";
  readonly workspace?: string;
  readonly command: string;
  readonly stateDirectory: string;
}

export interface HookLauncherOptions {
  readonly client: AgentKind;
  readonly scope: "global" | "workspace";
  readonly workspace?: string;
  readonly runtimeExecutablePath: string;
  readonly cliScriptPath: string;
  readonly stateDirectory: string;
}

export interface HookRegistrationTarget {
  readonly client: AgentKind;
  readonly scope: "global" | "workspace";
  readonly homeDirectory: string;
  readonly workspace?: string;
}

export function managedHookStateDirectory(
  environment: Readonly<Record<string, string | undefined>>,
  homeDirectory: string,
): string {
  return environment.HIVEMND_HOME ?? join(homeDirectory, ".hivemnd");
}

export class SessionStartHookRegistration {
  constructor(
    readonly path: string,
    private readonly client: AgentKind,
  ) {}

  async install(
    definition: HookLauncherDefinition,
  ): Promise<RegistrationResult> {
    validateDefinition(definition, this.client);
    const current = await readConfig(this.path);
    const document = parseConfig(current.content);
    const groups = sessionStartGroups(document);
    const managed = groups
      .map((group, index) => ({ group, index }))
      .filter(({ group }) => isManagedGroup(group, this.client));
    if (managed.length > 1) {
      throw conflict("Host has multiple Hivemnd-owned SessionStart hooks");
    }
    const [managedEntry] = managed;
    const expected = hookGroup(definition);
    if (managedEntry && sameValue(managedEntry.group, expected)) {
      return { changed: false, state: "installed" };
    }
    const nextGroups = managedEntry
      ? groups.map((group, index) =>
          index === managedEntry.index ? expected : group,
        )
      : [...groups, expected];
    const next = editSessionStart(current.content, nextGroups);
    await atomicWrite(this.path, next, current.mode);
    return { changed: true, state: "installed" };
  }

  async remove(expected: HookLauncherDefinition): Promise<RegistrationResult> {
    validateDefinition(expected, this.client);
    const current = await readConfig(this.path);
    const document = parseConfig(current.content);
    const groups = sessionStartGroups(document);
    const managed = groups
      .map((group, index) => ({ group, index }))
      .filter(({ group }) => isManagedGroup(group, this.client));
    const [managedEntry] = managed;
    if (!managedEntry) return { changed: false, state: "missing" };
    if (
      managed.length > 1 ||
      !sameValue(managedEntry.group, hookGroup(expected))
    ) {
      throw conflict("Hivemnd's SessionStart hook was modified");
    }
    const next = editSessionStart(
      current.content,
      groups.filter((_group, index) => index !== managedEntry.index),
    );
    await atomicWrite(this.path, next, current.mode);
    return { changed: true, state: "missing" };
  }

  async status(expected: HookLauncherDefinition): Promise<RegistrationState> {
    try {
      const document = parseConfig((await readConfig(this.path)).content);
      const managed = sessionStartGroups(document).filter((group) =>
        isManagedGroup(group, this.client),
      );
      if (managed.length === 0) return "missing";
      return managed.length === 1 && sameValue(managed[0], hookGroup(expected))
        ? "installed"
        : "conflict";
    } catch {
      return "conflict";
    }
  }

  snapshot(): Promise<Snapshot> {
    return snapshot(this.path);
  }

  restore(value: Snapshot): Promise<void> {
    return restore(this.path, value);
  }
}

export function hookLauncherDefinition(
  options: HookLauncherOptions,
): HookLauncherDefinition {
  for (const path of [
    options.runtimeExecutablePath,
    options.cliScriptPath,
    options.stateDirectory,
  ]) {
    if (!isAbsolute(path) || /[\0\r\n]/.test(path)) {
      throw new HivemndError(
        "MCP_REGISTRATION_INVALID",
        "SessionStart hook requires absolute safe runtime, CLI and state paths",
      );
    }
  }
  if (options.scope === "global" && options.workspace) {
    throw new HivemndError(
      "MCP_REGISTRATION_INVALID",
      "Global SessionStart hook cannot declare a workspace path",
    );
  }
  if (
    options.workspace &&
    (!isAbsolute(options.workspace) ||
      resolve(options.workspace) !== options.workspace ||
      /[\0\r\n]/.test(options.workspace))
  ) {
    throw new HivemndError(
      "MCP_REGISTRATION_INVALID",
      "SessionStart hook requires an absolute safe workspace path",
    );
  }
  const scopeArguments: string[] = ["--scope", options.scope];
  if (options.scope === "workspace") {
    scopeArguments.push(
      "--workspace",
      shellQuote(requiredWorkspace(options.workspace)),
    );
  }
  return {
    client: options.client,
    scope: options.scope,
    ...(options.workspace ? { workspace: options.workspace } : {}),
    stateDirectory: options.stateDirectory,
    command: [
      shellQuote(options.runtimeExecutablePath),
      shellQuote(options.cliScriptPath),
      "context",
      "inject",
      "--client",
      options.client,
      "--state-directory",
      shellQuote(options.stateDirectory),
      ...scopeArguments,
      MANAGED_ARGUMENT,
      MANAGED_VERSION,
    ].join(" "),
  };
}

function requiredWorkspace(value: string | undefined): string {
  if (value) return value;
  throw new HivemndError(
    "MCP_REGISTRATION_INVALID",
    "Workspace SessionStart hook requires an absolute workspace path",
  );
}

export function hostHookRegistration(
  target: HookRegistrationTarget,
): SessionStartHookRegistration {
  if (target.scope === "workspace" && !target.workspace) {
    throw new HivemndError(
      "MCP_REGISTRATION_INVALID",
      "Workspace SessionStart hook registration requires a workspace path",
    );
  }
  const path =
    target.client === "codex"
      ? target.scope === "global"
        ? join(target.homeDirectory, ".codex", "hooks.json")
        : join(String(target.workspace), ".codex", "hooks.json")
      : target.scope === "global"
        ? join(target.homeDirectory, ".claude", "settings.json")
        : join(String(target.workspace), ".claude", "settings.local.json");
  return new SessionStartHookRegistration(path, target.client);
}

export function hookInstallOperation(
  registration: SessionStartHookRegistration,
  definition: HookLauncherDefinition,
): CustomRegistrationInstallOperation {
  return {
    snapshot: () => registration.snapshot(),
    install: () => registration.install(definition),
    restore: (value) => registration.restore(value as Snapshot),
  };
}

function hookGroup(
  definition: HookLauncherDefinition,
): Record<string, unknown> {
  return {
    matcher: "^(startup|resume|clear|compact)$",
    hooks: [
      {
        type: "command",
        command: definition.command,
        timeout: 5,
        statusMessage: STATUS_MESSAGE,
        ...(definition.client === "codex"
          ? { additionalContextLimit: 12_000 }
          : {}),
      },
    ],
  };
}

function isManagedGroup(value: unknown, client: AgentKind): boolean {
  if (!isRecord(value) || !Array.isArray(value.hooks)) return false;
  return value.hooks.some(
    (handler) =>
      isRecord(handler) &&
      handler.type === "command" &&
      handler.statusMessage === STATUS_MESSAGE &&
      typeof handler.command === "string" &&
      handler.command.includes(`context inject --client ${client} `) &&
      handler.command.endsWith(`${MANAGED_ARGUMENT} ${MANAGED_VERSION}`),
  );
}

function validateDefinition(
  definition: HookLauncherDefinition,
  client: AgentKind,
): void {
  if (
    definition.client !== client ||
    !isAbsolute(definition.stateDirectory) ||
    (definition.scope === "workspace" && !definition.workspace) ||
    (definition.scope === "global" && definition.workspace !== undefined) ||
    !definition.command.endsWith(`${MANAGED_ARGUMENT} ${MANAGED_VERSION}`) ||
    /[\0\r\n]/.test(definition.command)
  ) {
    throw new HivemndError(
      "MCP_REGISTRATION_INVALID",
      "Invalid Hivemnd SessionStart hook definition",
    );
  }
}

function sessionStartGroups(document: unknown): unknown[] {
  if (!isRecord(document)) {
    throw new HivemndError(
      "MCP_REGISTRATION_INVALID",
      "Host hook configuration must be a JSON object",
    );
  }
  const hooks = document.hooks;
  if (hooks === undefined) return [];
  if (!isRecord(hooks)) {
    throw new HivemndError(
      "MCP_REGISTRATION_INVALID",
      "Host hooks configuration must be an object",
    );
  }
  const groups = hooks.SessionStart;
  if (groups === undefined) return [];
  if (!Array.isArray(groups)) {
    throw new HivemndError(
      "MCP_REGISTRATION_INVALID",
      "Host SessionStart hooks must be an array",
    );
  }
  return groups;
}

function editSessionStart(content: string, groups: readonly unknown[]): string {
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  return applyEdits(
    content,
    modify(content, ["hooks", "SessionStart"], groups, {
      formattingOptions: { insertSpaces: true, tabSize: 2, eol },
    }),
  );
}

function parseConfig(content: string): unknown {
  const errors: ParseError[] = [];
  const value: unknown = parse(content, errors, {
    allowTrailingComma: false,
    disallowComments: true,
  });
  if (errors.length > 0) {
    throw new HivemndError(
      "MCP_REGISTRATION_INVALID",
      "Host hook configuration is not valid JSON",
    );
  }
  return value;
}

async function readConfig(
  path: string,
): Promise<{ readonly content: string; readonly mode?: number }> {
  try {
    const stats = await lstat(path);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new HivemndError(
        "MCP_REGISTRATION_UNSAFE",
        `Host hook configuration must be a regular file: ${path}`,
      );
    }
    return { content: await readFile(path, "utf8"), mode: stats.mode & 0o777 };
  } catch (error: unknown) {
    if (isMissing(error)) return { content: "{}\n" };
    throw error;
  }
}

async function atomicWrite(
  path: string,
  content: string,
  mode = 0o600,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.hivemnd-${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { encoding: "utf8", mode, flag: "wx" });
    await chmod(temporary, mode);
    await rename(temporary, path);
    await chmod(path, mode);
  } catch (error: unknown) {
    /* v8 ignore start -- cleanup path for an injected filesystem failure */
    await rm(temporary, { force: true });
    throw error;
    /* v8 ignore stop */
  }
}

async function snapshot(path: string): Promise<Snapshot> {
  try {
    const stats = await lstat(path);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new HivemndError(
        "MCP_REGISTRATION_UNSAFE",
        `Host hook configuration must be a regular file: ${path}`,
      );
    }
    return {
      existed: true,
      content: await readFile(path, "utf8"),
      mode: stats.mode & 0o777,
    };
  } catch (error: unknown) {
    if (isMissing(error)) return { existed: false, content: "" };
    throw error;
  }
}

async function restore(path: string, value: Snapshot): Promise<void> {
  if (!value.existed) {
    await rm(path, { force: true });
    return;
  }
  await atomicWrite(path, value.content, value.mode);
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function conflict(message: string): HivemndError {
  return new HivemndError("MCP_REGISTRATION_CONFLICT", message);
}

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
