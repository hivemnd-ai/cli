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
const MANAGED_VERSION = "2";
const LEGACY_MANAGED_VERSION = "1";
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
  readonly updateNoticeCommand: string;
  readonly skillActivationCommand?: string;
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

export class HostHookRegistration {
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
    const session = managedEvent(document, "SessionStart", this.client);
    const prompt = managedEvent(document, "UserPromptSubmit", this.client);
    const skill = optionalClaudeSkillEvent(document, this.client);
    const expectedSession = sessionStartHookGroup(definition);
    const expectedPrompt = updateNoticeHookGroup(definition);
    const expectedSkill = skillActivationHookGroup(definition);
    if (
      session.entry &&
      prompt.entry &&
      sameValue(session.entry.group, expectedSession) &&
      sameValue(prompt.entry.group, expectedPrompt) &&
      (this.client === "codex" ||
        (skill.entry && sameValue(skill.entry.group, expectedSkill)))
    ) {
      return { changed: false, state: "installed" };
    }
    const hasManagedEntry = Boolean(
      session.entry ?? prompt.entry ?? skill.entry,
    );
    const currentPairCanUpgrade =
      session.entry &&
      prompt.entry &&
      sameShapeExceptCommand(session.entry.group, expectedSession) &&
      sameShapeExceptCommand(prompt.entry.group, expectedPrompt);
    const exactLegacyClaudeCanUpgrade =
      this.client === "claude" &&
      !skill.entry &&
      currentPairCanUpgrade &&
      managedGroupVersion(session.entry.group) === LEGACY_MANAGED_VERSION &&
      managedGroupVersion(prompt.entry.group) === LEGACY_MANAGED_VERSION;
    const currentShapeCanUpgrade =
      currentPairCanUpgrade &&
      (this.client === "codex" ||
        Boolean(
          skill.entry &&
          sameShapeExceptCommand(skill.entry.group, expectedSkill),
        ));
    const exactOldCodexCanUpgrade =
      this.client === "codex" &&
      session.entry &&
      !prompt.entry &&
      sameShapeExceptCommand(
        session.entry.group,
        oldCodexSessionStartHookGroup(definition),
      ) &&
      managedGroupVersion(session.entry.group) === LEGACY_MANAGED_VERSION;
    if (
      hasManagedEntry &&
      !currentShapeCanUpgrade &&
      !exactLegacyClaudeCanUpgrade &&
      !exactOldCodexCanUpgrade
    ) {
      throw conflict("Hivemnd's managed hooks were modified");
    }
    const nextSession = replaceManaged(
      session.groups,
      session.entry,
      expectedSession,
    );
    const nextPrompt = replaceManaged(
      prompt.groups,
      prompt.entry,
      expectedPrompt,
    );
    const nextSkill =
      this.client === "claude"
        ? replaceManaged(skill.groups, skill.entry, expectedSkill)
        : skill.groups;
    const next = editHookEvents(
      current.content,
      nextSession,
      nextPrompt,
      this.client === "claude" ? nextSkill : undefined,
    );
    await atomicWrite(this.path, next, current.mode);
    return { changed: true, state: "installed" };
  }

  async remove(expected: HookLauncherDefinition): Promise<RegistrationResult> {
    validateDefinition(expected, this.client);
    const current = await readConfig(this.path);
    const document = parseConfig(current.content);
    const session = managedEvent(document, "SessionStart", this.client);
    const prompt = managedEvent(document, "UserPromptSubmit", this.client);
    const skill = optionalClaudeSkillEvent(document, this.client);
    if (!session.entry && !prompt.entry && !skill.entry) {
      return { changed: false, state: "missing" };
    }
    const legacy = withManagedVersion(expected, LEGACY_MANAGED_VERSION);
    const currentPair =
      session.entry &&
      prompt.entry &&
      sameValue(session.entry.group, sessionStartHookGroup(expected)) &&
      sameValue(prompt.entry.group, updateNoticeHookGroup(expected));
    const legacyPair =
      !skill.entry &&
      session.entry &&
      prompt.entry &&
      sameValue(session.entry.group, sessionStartHookGroup(legacy)) &&
      sameValue(prompt.entry.group, updateNoticeHookGroup(legacy));
    if (
      (!currentPair && !legacyPair) ||
      (skill.entry &&
        !sameValue(skill.entry.group, skillActivationHookGroup(expected)))
    ) {
      throw conflict("Hivemnd's managed hooks were modified");
    }
    const next = editHookEvents(
      current.content,
      withoutManaged(session.groups, session.entry.index),
      withoutManaged(prompt.groups, prompt.entry.index),
      this.client === "claude"
        ? skill.entry
          ? withoutManaged(skill.groups, skill.entry.index)
          : skill.groups
        : undefined,
    );
    await atomicWrite(this.path, next, current.mode);
    return { changed: true, state: "missing" };
  }

  async status(expected: HookLauncherDefinition): Promise<RegistrationState> {
    try {
      const document = parseConfig((await readConfig(this.path)).content);
      const session = managedEvent(document, "SessionStart", this.client);
      const prompt = managedEvent(document, "UserPromptSubmit", this.client);
      const skill = optionalClaudeSkillEvent(document, this.client);
      if (!session.entry && !prompt.entry && !skill.entry) return "missing";
      /* v8 ignore next -- every partial owned shape is the same bounded conflict state */
      return session.entry &&
        prompt.entry &&
        sameValue(session.entry.group, sessionStartHookGroup(expected)) &&
        sameValue(prompt.entry.group, updateNoticeHookGroup(expected)) &&
        (this.client === "codex" ||
          (skill.entry &&
            sameValue(skill.entry.group, skillActivationHookGroup(expected))))
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
  const launcher = [
    shellQuote(options.runtimeExecutablePath),
    shellQuote(options.cliScriptPath),
    "context",
  ];
  const invocation = [
    "--client",
    options.client,
    "--state-directory",
    shellQuote(options.stateDirectory),
    ...scopeArguments,
    MANAGED_ARGUMENT,
    MANAGED_VERSION,
  ];
  return {
    client: options.client,
    scope: options.scope,
    ...(options.workspace ? { workspace: options.workspace } : {}),
    stateDirectory: options.stateDirectory,
    command: [...launcher, "inject", ...invocation].join(" "),
    updateNoticeCommand: [...launcher, "update-notice", ...invocation].join(
      " ",
    ),
    ...(options.client === "claude"
      ? {
          skillActivationCommand: [
            ...launcher,
            "skill-activated",
            ...invocation,
          ].join(" "),
        }
      : {}),
  };
}

function requiredWorkspace(value: string | undefined): string {
  if (value) return value;
  throw new HivemndError(
    "MCP_REGISTRATION_INVALID",
    "Workspace SessionStart hook requires an absolute workspace path",
  );
}

function withManagedVersion(
  definition: HookLauncherDefinition,
  version: string,
): HookLauncherDefinition {
  const replace = (command: string): string =>
    command.replace(
      new RegExp(`${MANAGED_ARGUMENT} \\d+$`),
      `${MANAGED_ARGUMENT} ${version}`,
    );
  return {
    ...definition,
    command: replace(definition.command),
    updateNoticeCommand: replace(definition.updateNoticeCommand),
    ...(definition.skillActivationCommand
      ? { skillActivationCommand: replace(definition.skillActivationCommand) }
      : {}),
  };
}

export function hostHookRegistration(
  target: HookRegistrationTarget,
): HostHookRegistration {
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
  return new HostHookRegistration(path, target.client);
}

export function hookInstallOperation(
  registration: HostHookRegistration,
  definition: HookLauncherDefinition,
): CustomRegistrationInstallOperation {
  return {
    snapshot: () => registration.snapshot(),
    install: () => registration.install(definition),
    restore: (value) => registration.restore(value as Snapshot),
  };
}

export { HostHookRegistration as SessionStartHookRegistration };

type HookEvent = "SessionStart" | "UserPromptSubmit" | "UserPromptExpansion";

interface ManagedEvent {
  readonly groups: readonly unknown[];
  readonly entry?: { readonly group: unknown; readonly index: number };
}

function optionalClaudeSkillEvent(
  document: unknown,
  client: AgentKind,
): ManagedEvent {
  return client === "claude"
    ? managedEvent(document, "UserPromptExpansion", client)
    : { groups: [] };
}

function sessionStartHookGroup(
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

function updateNoticeHookGroup(
  definition: HookLauncherDefinition,
): Record<string, unknown> {
  return {
    matcher: "",
    hooks: [
      {
        type: "command",
        command: definition.updateNoticeCommand,
        timeout: 5,
      },
    ],
  };
}

function skillActivationHookGroup(
  definition: HookLauncherDefinition,
): Record<string, unknown> {
  if (!definition.skillActivationCommand) {
    return { matcher: "", hooks: [] };
  }
  return {
    matcher: "",
    hooks: [
      {
        type: "command",
        command: definition.skillActivationCommand,
        timeout: 5,
      },
    ],
  };
}

function oldCodexSessionStartHookGroup(
  definition: HookLauncherDefinition,
): Record<string, unknown> {
  const legacy = sessionStartHookGroup(
    withManagedVersion(definition, LEGACY_MANAGED_VERSION),
  );
  const handler = (legacy.hooks as Record<string, unknown>[])[0];
  return {
    ...legacy,
    hooks: [{ ...handler, additionalContextLimit: 2500 }],
  };
}

function isManagedGroup(
  value: unknown,
  event: HookEvent,
  client: AgentKind,
): boolean {
  if (!isRecord(value) || !Array.isArray(value.hooks)) return false;
  const command =
    event === "SessionStart"
      ? "context inject"
      : event === "UserPromptSubmit"
        ? "context update-notice"
        : "context skill-activated";
  return value.hooks.some(
    (handler) =>
      isRecord(handler) &&
      handler.type === "command" &&
      (event !== "SessionStart" || handler.statusMessage === STATUS_MESSAGE) &&
      typeof handler.command === "string" &&
      handler.command.includes(`${command} --client ${client} `) &&
      [MANAGED_VERSION, LEGACY_MANAGED_VERSION].some((version) =>
        String(handler.command).endsWith(`${MANAGED_ARGUMENT} ${version}`),
      ),
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
    !definition.updateNoticeCommand.endsWith(
      `${MANAGED_ARGUMENT} ${MANAGED_VERSION}`,
    ) ||
    (client === "claude" &&
      !definition.skillActivationCommand?.endsWith(
        `${MANAGED_ARGUMENT} ${MANAGED_VERSION}`,
      )) ||
    /[\0\r\n]/.test(definition.command) ||
    /[\0\r\n]/.test(definition.updateNoticeCommand) ||
    (definition.skillActivationCommand !== undefined &&
      /[\0\r\n]/.test(definition.skillActivationCommand))
  ) {
    throw new HivemndError(
      "MCP_REGISTRATION_INVALID",
      "Invalid Hivemnd SessionStart hook definition",
    );
  }
}

function hookGroups(document: unknown, event: HookEvent): unknown[] {
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
  const groups = hooks[event];
  if (groups === undefined) return [];
  if (!Array.isArray(groups)) {
    throw new HivemndError(
      "MCP_REGISTRATION_INVALID",
      `Host ${event} hooks must be an array`,
    );
  }
  return groups;
}

function managedEvent(
  document: unknown,
  event: HookEvent,
  client: AgentKind,
): ManagedEvent {
  const groups = hookGroups(document, event);
  const managed = groups
    .map((group, index) => ({ group, index }))
    .filter(({ group }) => isManagedGroup(group, event, client));
  if (managed.length > 1) {
    throw conflict(`Host has multiple Hivemnd-owned ${event} hooks`);
  }
  return { groups, ...(managed[0] ? { entry: managed[0] } : {}) };
}

function replaceManaged(
  groups: readonly unknown[],
  entry: ManagedEvent["entry"],
  expected: unknown,
): readonly unknown[] {
  return entry
    ? groups.map((group, index) => (index === entry.index ? expected : group))
    : [...groups, expected];
}

function withoutManaged(
  groups: readonly unknown[],
  index: number,
): readonly unknown[] {
  return groups.filter((_group, current) => current !== index);
}

function editHookEvents(
  content: string,
  sessionStart: readonly unknown[],
  userPromptSubmit: readonly unknown[],
  userPromptExpansion?: readonly unknown[],
): string {
  const base = editHookEvent(
    editHookEvent(content, "SessionStart", sessionStart),
    "UserPromptSubmit",
    userPromptSubmit,
  );
  return userPromptExpansion
    ? editHookEvent(base, "UserPromptExpansion", userPromptExpansion)
    : base;
}

function editHookEvent(
  content: string,
  event: HookEvent,
  groups: readonly unknown[],
): string {
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  return applyEdits(
    content,
    modify(content, ["hooks", event], groups, {
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

function sameShapeExceptCommand(left: unknown, right: unknown): boolean {
  const withoutCommand = (key: string, value: unknown): unknown =>
    key === "command" && typeof value === "string" ? "<managed>" : value;
  return (
    JSON.stringify(left, withoutCommand) ===
    JSON.stringify(right, withoutCommand)
  );
}

function managedGroupVersion(value: unknown): string | undefined {
  /* v8 ignore next -- callers pass groups already proven to contain managed hooks */
  if (!isRecord(value) || !Array.isArray(value.hooks)) return undefined;
  for (const handler of value.hooks) {
    /* v8 ignore next -- an exact upgradable shape contains one command handler */
    if (!isRecord(handler) || typeof handler.command !== "string") continue;
    for (const version of [MANAGED_VERSION, LEGACY_MANAGED_VERSION]) {
      if (handler.command.endsWith(`${MANAGED_ARGUMENT} ${version}`)) {
        return version;
      }
    }
  }
  /* v8 ignore next -- callers pass only groups already proven to own a managed marker */
  return undefined;
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
