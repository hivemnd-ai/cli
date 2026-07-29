import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname } from "node:path";
import { isAbsolute, join, win32 } from "node:path";
import type { AgentKind } from "../domain.js";
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser";
import { HivemndError } from "../errors.js";

const CODEX_BEGIN = "# BEGIN HIVEMND MANAGED MCP";
const CODEX_END = "# END HIVEMND MANAGED MCP";
const CLAUDE_MANAGED_ENV = { HIVEMND_MANAGED_MCP: "1" } as const;

export interface McpServerDefinition {
  readonly command: string;
  readonly args: readonly string[];
  readonly stateDirectory?: string | undefined;
}

export interface McpLauncherOptions {
  readonly client: AgentKind;
  readonly runtimeExecutablePath: string;
  readonly cliScriptPath: string;
  readonly stateDirectory?: string | undefined;
}

export interface RegistrationResult {
  readonly changed: boolean;
  readonly state: "installed" | "missing";
}

export type RegistrationState = "installed" | "missing" | "conflict";

export type RegistrationScope =
  | { readonly scope: "global" }
  | { readonly scope: "workspace"; readonly workspace: string };

export interface HostRegistrationTarget {
  readonly client: AgentKind;
  readonly scope: "global" | "workspace" | "project";
  readonly homeDirectory: string;
  readonly workspace?: string;
}

export interface ResolvedHostRegistration {
  readonly registration: McpRegistration;
  readonly scope?: RegistrationScope;
  readonly path: string;
}

interface Snapshot {
  readonly existed: boolean;
  readonly content: string;
}

export interface McpRegistration {
  install(
    definition: McpServerDefinition,
    scope?: RegistrationScope,
  ): Promise<RegistrationResult>;
  remove(
    scope?: RegistrationScope,
    expected?: McpServerDefinition,
  ): Promise<RegistrationResult>;
  status(
    scope?: RegistrationScope,
    expected?: McpServerDefinition,
  ): Promise<RegistrationState>;
  snapshot(): Promise<Snapshot>;
  restore(snapshot: Snapshot): Promise<void>;
}

export interface McpRegistrationInstallOperation {
  readonly registration: McpRegistration;
  readonly definition: McpServerDefinition;
  readonly scope?: RegistrationScope;
}

export interface CustomRegistrationInstallOperation {
  readonly snapshot: () => Promise<unknown>;
  readonly install: () => Promise<RegistrationResult>;
  readonly restore: (snapshot: unknown) => Promise<void>;
}

export type RegistrationInstallOperation =
  McpRegistrationInstallOperation | CustomRegistrationInstallOperation;

export class CodexMcpRegistration implements McpRegistration {
  constructor(private readonly path: string) {}

  async install(definition: McpServerDefinition): Promise<RegistrationResult> {
    validateDefinition(definition);
    const current = await readConfig(this.path);
    const range = codexOwnedRange(current.content);
    if (!range && hasCodexHivemndTable(current.content)) {
      throw registrationConflict(
        "Codex already has an unowned mcp_servers.hivemnd entry",
      );
    }
    const eol = current.content.includes("\r\n") ? "\r\n" : "\n";
    const block = codexBlock(definition, eol);
    const separator =
      current.content && !current.content.endsWith("\n") ? eol : "";
    const next = range
      ? `${current.content.slice(0, range.start)}${block}${current.content.slice(range.end)}`
      : `${current.content}${separator}${block}`;
    if (next === current.content) return { changed: false, state: "installed" };
    await atomicWrite(this.path, next, current.mode);
    return { changed: true, state: "installed" };
  }

  async remove(
    scope?: RegistrationScope,
    expected?: McpServerDefinition,
  ): Promise<RegistrationResult> {
    void scope;
    void expected;
    const current = await readConfig(this.path);
    const range = codexOwnedRange(current.content);
    if (!range) return { changed: false, state: "missing" };
    const next = `${current.content.slice(0, range.start)}${current.content.slice(range.end)}`;
    await atomicWrite(this.path, next, current.mode);
    return { changed: true, state: "missing" };
  }

  async status(
    scope?: RegistrationScope,
    expected?: McpServerDefinition,
  ): Promise<RegistrationState> {
    void scope;
    const current = await readConfig(this.path);
    try {
      const range = codexOwnedRange(current.content);
      if (range) {
        if (!expected) return "installed";
        const eol = current.content.includes("\r\n") ? "\r\n" : "\n";
        return current.content.slice(range.start, range.end) ===
          codexBlock(expected, eol)
          ? "installed"
          : "conflict";
      }
    } catch {
      return "conflict";
    }
    return hasCodexHivemndTable(current.content) ? "conflict" : "missing";
  }

  snapshot(): Promise<Snapshot> {
    return readSnapshot(this.path);
  }

  restore(snapshot: Snapshot): Promise<void> {
    return restoreSnapshot(this.path, snapshot);
  }
}

export class ClaudeMcpRegistration implements McpRegistration {
  constructor(private readonly path: string) {}

  async install(
    definition: McpServerDefinition,
    scope: RegistrationScope = { scope: "global" },
  ): Promise<RegistrationResult> {
    validateDefinition(definition);
    const current = await readConfig(this.path, "{}\n");
    parseJsonConfig(current.content);
    const path = claudeJsonPath(scope);
    const existing = readJsonPath(parse(current.content) as unknown, path);
    const value = claudeDefinition(definition);
    if (existing !== undefined && !sameDefinition(existing, value)) {
      throw registrationConflict(
        "Claude Code already has an unowned hivemnd MCP entry in this scope",
      );
    }
    if (sameDefinition(existing, value)) {
      return { changed: false, state: "installed" };
    }
    const next = editJson(current.content, path, value);
    await atomicWrite(this.path, next, current.mode);
    return { changed: true, state: "installed" };
  }

  async remove(
    scope: RegistrationScope = { scope: "global" },
    expected?: McpServerDefinition,
  ): Promise<RegistrationResult> {
    const current = await readConfig(this.path, "{}\n");
    parseJsonConfig(current.content);
    const path = claudeJsonPath(scope);
    const existing = readJsonPath(parse(current.content) as unknown, path);
    if (existing === undefined) return { changed: false, state: "missing" };
    if (!expected || !sameDefinition(existing, claudeDefinition(expected))) {
      throw registrationConflict(
        "Claude Code's hivemnd MCP entry was modified and will not be removed",
      );
    }
    const next = editJson(current.content, path, undefined);
    await atomicWrite(this.path, next, current.mode);
    return { changed: true, state: "missing" };
  }

  async status(
    scope: RegistrationScope = { scope: "global" },
    expected?: McpServerDefinition,
  ): Promise<RegistrationState> {
    const current = await readConfig(this.path, "{}\n");
    try {
      parseJsonConfig(current.content);
    } catch {
      return "conflict";
    }
    const existing = readJsonPath(
      parse(current.content) as unknown,
      claudeJsonPath(scope),
    );
    if (existing === undefined) return "missing";
    if (expected) {
      return sameDefinition(existing, claudeDefinition(expected))
        ? "installed"
        : "conflict";
    }
    return looksLikeHivemndDefinition(existing) ? "installed" : "conflict";
  }

  snapshot(): Promise<Snapshot> {
    return readSnapshot(this.path);
  }

  restore(snapshot: Snapshot): Promise<void> {
    return restoreSnapshot(this.path, snapshot);
  }
}

export class RegistrationTransaction {
  async install(
    operations: readonly RegistrationInstallOperation[],
  ): Promise<readonly RegistrationResult[]> {
    return (await this.installReversible(operations)).results;
  }

  async installReversible(
    operations: readonly RegistrationInstallOperation[],
  ): Promise<{
    readonly results: readonly RegistrationResult[];
    readonly rollback: () => Promise<void>;
  }> {
    const applied: {
      restore: (snapshot: unknown) => Promise<void>;
      snapshot: unknown;
    }[] = [];
    const results: RegistrationResult[] = [];
    try {
      for (const operation of operations) {
        if ("install" in operation) {
          const snapshot = await operation.snapshot();
          applied.push({ restore: operation.restore, snapshot });
          results.push(await operation.install());
        } else {
          const snapshot = await operation.registration.snapshot();
          applied.push({
            restore: (value) =>
              operation.registration.restore(value as Snapshot),
            snapshot,
          });
          results.push(
            await operation.registration.install(
              operation.definition,
              operation.scope,
            ),
          );
        }
      }
      return {
        results,
        rollback: async () => rollbackRegistrations(applied),
      };
    } catch (error: unknown) {
      await rollbackRegistrations(applied);
      throw error;
    }
  }
}

async function rollbackRegistrations(
  applied: readonly {
    readonly restore: (snapshot: unknown) => Promise<void>;
    readonly snapshot: unknown;
  }[],
): Promise<void> {
  for (const operation of [...applied].reverse()) {
    await operation.restore(operation.snapshot);
  }
}

export function hostRegistration(
  target: HostRegistrationTarget,
): ResolvedHostRegistration {
  if (target.scope !== "global" && !target.workspace) {
    throw new HivemndError(
      "MCP_REGISTRATION_INVALID",
      "Workspace MCP registration requires a workspace path",
    );
  }
  if (target.client === "codex") {
    if (target.scope === "project") {
      throw new HivemndError(
        "MCP_REGISTRATION_INVALID",
        "Codex project registration uses the workspace scope",
      );
    }
    const path =
      target.scope === "global"
        ? join(target.homeDirectory, ".codex", "config.toml")
        : join(String(target.workspace), ".codex", "config.toml");
    return { registration: new CodexMcpRegistration(path), path };
  }
  if (target.scope === "project") {
    const path = join(String(target.workspace), ".mcp.json");
    return { registration: new ClaudeMcpRegistration(path), path };
  }
  const path = join(target.homeDirectory, ".claude.json");
  return {
    registration: new ClaudeMcpRegistration(path),
    scope:
      target.scope === "global"
        ? { scope: "global" }
        : { scope: "workspace", workspace: String(target.workspace) },
    path,
  };
}

export function mcpServerDefinition(
  options: McpLauncherOptions,
): McpServerDefinition {
  if (
    !absoluteSafePath(options.runtimeExecutablePath) ||
    !absoluteSafePath(options.cliScriptPath)
  ) {
    throw new HivemndError(
      "MCP_REGISTRATION_INVALID",
      "MCP registration requires absolute runtime and CLI paths",
    );
  }
  if (
    options.stateDirectory !== undefined &&
    !absoluteSafePath(options.stateDirectory)
  ) {
    throw new HivemndError(
      "MCP_REGISTRATION_INVALID",
      "MCP registration requires an absolute state directory",
    );
  }
  return {
    command: options.runtimeExecutablePath,
    args: [options.cliScriptPath, "mcp", "serve", "--client", options.client],
    stateDirectory: options.stateDirectory,
  };
}

function absoluteSafePath(value: string): boolean {
  return (
    !/[\0\r\n]/.test(value) && (isAbsolute(value) || win32.isAbsolute(value))
  );
}

function validateDefinition(definition: McpServerDefinition): void {
  if (!definition.command.trim()) {
    throw new HivemndError(
      "MCP_REGISTRATION_INVALID",
      "MCP command cannot be empty",
    );
  }
  if (
    definition.args.some((value) =>
      /^(?:--?(?:bearer-)?token|--activation-url|--enrollment-token)(?:=|$)/i.test(
        value,
      ),
    ) ||
    definition.args.some((value) => /^Bearer\s/i.test(value))
  ) {
    throw new HivemndError(
      "MCP_REGISTRATION_INVALID",
      "MCP registration cannot contain credentials or activation data",
    );
  }
  if (
    definition.stateDirectory !== undefined &&
    !absoluteSafePath(definition.stateDirectory)
  ) {
    throw new HivemndError(
      "MCP_REGISTRATION_INVALID",
      "MCP registration requires an absolute state directory",
    );
  }
}

function codexBlock(definition: McpServerDefinition, eol: string): string {
  const args = definition.args.map(tomlString).join(", ");
  const lines = [
    CODEX_BEGIN,
    "[mcp_servers.hivemnd]",
    `command = ${tomlString(definition.command)}`,
    `args = [${args}]`,
  ];
  if (definition.stateDirectory) {
    lines.push(
      "[mcp_servers.hivemnd.env]",
      `HIVEMND_HOME = ${tomlString(definition.stateDirectory)}`,
    );
  }
  lines.push(CODEX_END);
  return lines.join(eol);
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function codexOwnedRange(
  content: string,
): { readonly start: number; readonly end: number } | undefined {
  const start = content.indexOf(CODEX_BEGIN);
  const endMarker = content.indexOf(CODEX_END);
  if (start === -1 && endMarker === -1) return undefined;
  if (start === -1 || endMarker < start) {
    throw registrationConflict(
      "Codex has an incomplete Hivemnd-owned MCP block",
    );
  }
  if (content.slice(start + CODEX_BEGIN.length).includes(CODEX_BEGIN)) {
    throw registrationConflict("Codex has multiple Hivemnd-owned MCP blocks");
  }
  if (
    (start > 0 && content[start - 1] !== "\n") ||
    (content[endMarker + CODEX_END.length] &&
      content[endMarker + CODEX_END.length] !== "\r" &&
      content[endMarker + CODEX_END.length] !== "\n")
  ) {
    throw registrationConflict(
      "Codex's Hivemnd-owned MCP markers are not line-delimited",
    );
  }
  const end = endMarker + CODEX_END.length;
  const block = content.slice(start, end);
  if (!block.includes("[mcp_servers.hivemnd]")) {
    throw registrationConflict("Codex's Hivemnd-owned MCP block is malformed");
  }
  return { start, end };
}

function hasCodexHivemndTable(content: string): boolean {
  return /^\s*\[mcp_servers\.hivemnd\]\s*$/m.test(content);
}

function claudeJsonPath(scope: RegistrationScope): readonly string[] {
  return scope.scope === "global"
    ? ["mcpServers", "hivemnd"]
    : ["projects", scope.workspace, "mcpServers", "hivemnd"];
}

function parseJsonConfig(content: string): void {
  const errors: ParseError[] = [];
  parse(content, errors, { allowTrailingComma: false, disallowComments: true });
  if (errors.length > 0) {
    throw new HivemndError(
      "MCP_REGISTRATION_INVALID",
      "Claude Code configuration is not valid JSON",
    );
  }
}

function editJson(
  content: string,
  path: readonly string[],
  value: unknown,
): string {
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  return applyEdits(
    content,
    modify(content, [...path], value, {
      formattingOptions: { insertSpaces: true, tabSize: 2, eol },
    }),
  );
}

function readJsonPath(value: unknown, path: readonly string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

function sameDefinition(left: unknown, right: unknown): boolean {
  if (!isRecord(left) || !isRecord(right)) return false;
  if (left.command !== right.command) return false;
  if (!Array.isArray(left.args) || !Array.isArray(right.args)) return false;
  const rightArgs = right.args;
  const argsMatch =
    left.args.length === rightArgs.length &&
    left.args.every((value, index) => value === rightArgs[index]);
  if (!argsMatch) return false;
  return JSON.stringify(left.env) === JSON.stringify(right.env);
}

function looksLikeHivemndDefinition(value: unknown): boolean {
  if (!isRecord(value) || typeof value.command !== "string") return false;
  if (!Array.isArray(value.args) || !value.args.every(isString)) return false;
  const mcp = value.args.indexOf("mcp");
  if (mcp === -1 || value.args[mcp + 1] !== "serve") return false;
  const client = value.args.indexOf("--client", mcp + 2);
  if (client !== -1 && value.args[client + 1] !== "claude") return false;
  return JSON.stringify(value.env) === JSON.stringify(CLAUDE_MANAGED_ENV);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function claudeDefinition(
  definition: McpServerDefinition,
): Record<string, unknown> {
  return {
    command: definition.command,
    args: [...definition.args],
    env: {
      ...CLAUDE_MANAGED_ENV,
      ...(definition.stateDirectory
        ? { HIVEMND_HOME: definition.stateDirectory }
        : {}),
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function registrationConflict(message: string): HivemndError {
  return new HivemndError("MCP_REGISTRATION_CONFLICT", message);
}

async function readConfig(
  path: string,
  missingContent = "",
): Promise<{ readonly content: string; readonly mode?: number }> {
  try {
    const stats = await lstat(path);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new HivemndError(
        "MCP_REGISTRATION_UNSAFE",
        `MCP configuration must be a regular file: ${path}`,
      );
    }
    return { content: await readFile(path, "utf8"), mode: stats.mode & 0o777 };
  } catch (error: unknown) {
    if (isMissing(error)) return { content: missingContent };
    throw error;
  }
}

async function atomicWrite(
  path: string,
  content: string,
  mode?: number,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.hivemnd-${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, {
      encoding: "utf8",
      mode: mode ?? 0o600,
    });
    if (mode !== undefined) await chmod(temporary, mode);
    await rename(temporary, path);
  } catch (error: unknown) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

async function readSnapshot(path: string): Promise<Snapshot> {
  try {
    return { existed: true, content: await readFile(path, "utf8") };
  } catch (error: unknown) {
    if (isMissing(error)) return { existed: false, content: "" };
    throw error;
  }
}

async function restoreSnapshot(
  path: string,
  snapshot: Snapshot,
): Promise<void> {
  if (!snapshot.existed) {
    await unlink(path).catch((error: unknown) => {
      if (!isMissing(error)) throw error;
    });
    return;
  }
  const current = await readConfig(path);
  await atomicWrite(path, snapshot.content, current.mode);
}

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
