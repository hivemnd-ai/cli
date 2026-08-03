import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readdir, rm } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { ConfigRepository } from "../config.js";
import type { AgentKind } from "../domain.js";
import { OrganizationRegistryRepository } from "../organizations/registry.js";
import type { UpdateService } from "../update/daily-update-checker.js";
import { selectEffectiveProfile } from "./injector.js";

const MAX_HOOK_INPUT_BYTES = 64 * 1024;
const CLAIM_EXPIRY_MILLISECONDS = 30 * 24 * 60 * 60 * 1000;
const MAX_CLAIMS = 256;
const CLAIM_NAME = /^[0-9a-f]{64}\.json$/;

const promptInputSchema = z.object({
  hook_event_name: z.literal("UserPromptSubmit"),
  session_id: z.string().min(1).max(1_024),
  cwd: z.string().min(1).max(16_384),
  agent_id: z.string().min(1).max(1_024).optional(),
});

export interface UpdateNoticeOptions {
  readonly client: AgentKind;
  readonly scope: "global" | "workspace";
  readonly workspace?: string;
  readonly stateDirectory: string;
  readonly input: string;
  readonly updateService: UpdateService;
  readonly now?: () => Date;
}

export async function cachedUpdateNotice(
  options: UpdateNoticeOptions,
): Promise<string> {
  try {
    if (!safeAbsolutePath(options.stateDirectory)) return "";
    if (
      (options.scope === "workspace" &&
        (!options.workspace || !safeAbsolutePath(options.workspace))) ||
      (options.scope === "global" && options.workspace !== undefined)
    ) {
      return "";
    }
    if (Buffer.byteLength(options.input) > MAX_HOOK_INPUT_BYTES) return "";
    const input = promptInputSchema.parse(JSON.parse(options.input) as unknown);
    if (input.agent_id || !safeAbsolutePath(input.cwd)) return "";

    const registry = await new OrganizationRegistryRepository(
      options.stateDirectory,
      new ConfigRepository(input.cwd),
    ).load();
    if (!selectEffectiveProfile(registry, options, input.cwd)) return "";

    const update = await options.updateService.cached?.();
    if (!update?.updateAvailable || !update.latestVersion) return "";

    const claims = new UpdateNoticeClaims(options.stateDirectory, options.now);
    if (!(await claims.claim(input.session_id, update.latestVersion)))
      return "";

    return JSON.stringify({
      systemMessage: `Hivemnd CLI update available: ${update.currentVersion} -> ${update.latestVersion}. Run: ${update.command}`,
    });
  } catch {
    return "";
  }
}

class UpdateNoticeClaims {
  private readonly directory: string;
  private readonly now: () => Date;

  constructor(stateDirectory: string, now: (() => Date) | undefined) {
    this.directory = join(stateDirectory, "update-notices");
    this.now = now ?? (() => new Date());
  }

  async claim(sessionId: string, latestVersion: string): Promise<boolean> {
    await ensurePrivateDirectory(this.directory);
    await this.cleanup();
    const digest = createHash("sha256")
      .update(sessionId)
      .update("\0")
      .update(latestVersion)
      .digest("hex");
    const path = join(this.directory, `${digest}.json`);
    let handle;
    try {
      handle = await open(
        path,
        constants.O_WRONLY |
          constants.O_CREAT |
          constants.O_EXCL |
          constants.O_NOFOLLOW,
        0o600,
      );
    } catch (error: unknown) {
      /* v8 ignore else -- only EEXIST is an expected exclusive-create outcome */
      if (isCode(error, "EEXIST")) return false;
      /* v8 ignore next */
      throw error;
    }

    try {
      await handle.writeFile(
        `${JSON.stringify({
          latestVersion,
          announcedAt: this.now().toISOString(),
        })}\n`,
        "utf8",
      );
      await handle.chmod(0o600);
    } catch (error: unknown) {
      /* v8 ignore start -- cleanup path for an injected open-file write failure */
      await handle.close().catch(() => undefined);
      await rm(path, { force: true });
      throw error;
      /* v8 ignore stop */
    }
    await handle.close();
    await this.cleanup();
    return true;
  }

  private async cleanup(): Promise<void> {
    const now = this.now().getTime();
    const retained: {
      readonly path: string;
      readonly modified: number;
    }[] = [];
    for (const entry of await readdir(this.directory, {
      withFileTypes: true,
    })) {
      if (!entry.isFile()) continue;
      const path = join(this.directory, entry.name);
      const stats = await lstat(path);
      /* v8 ignore next -- a filesystem race must still fail closed */
      if (stats.isSymbolicLink() || !stats.isFile()) continue;
      if (
        !CLAIM_NAME.test(entry.name) ||
        now - stats.mtimeMs >= CLAIM_EXPIRY_MILLISECONDS
      ) {
        await rm(path, { force: true });
        continue;
      }
      retained.push({ path, modified: stats.mtimeMs });
    }
    retained.sort((left, right) => left.modified - right.modified);
    for (const entry of retained.slice(
      0,
      Math.max(0, retained.length - MAX_CLAIMS),
    )) {
      await rm(entry.path, { force: true });
    }
  }
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  try {
    const stats = await lstat(path);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error("Unsafe update notice directory");
    }
  } catch (error: unknown) {
    if (!isCode(error, "ENOENT")) throw error;
    await mkdir(path, { recursive: true, mode: 0o700 });
    const stats = await lstat(path);
    /* v8 ignore next -- defends a symlink swap during directory creation */
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error("Unsafe update notice directory", { cause: error });
    }
  }
  await chmod(path, 0o700);
}

function safeAbsolutePath(value: string): boolean {
  return (
    isAbsolute(value) && resolve(value) === value && !/[\0\r\n]/.test(value)
  );
}

function isCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === code
  );
}
