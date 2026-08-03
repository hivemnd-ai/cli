import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { compareSemver, isStableSemver } from "../version/semver.js";

export const UPDATE_COMMAND = "npm install --global @hivemnd-ai/cli@latest";
const registryUrl = "https://registry.npmjs.org/@hivemnd-ai%2fcli/latest";
const oneDayMilliseconds = 24 * 60 * 60 * 1000;
const maxCacheBytes = 16 * 1024;

export interface UpdateCheckResult {
  readonly checked: boolean;
  readonly currentVersion: string;
  readonly latestVersion?: string;
  readonly updateAvailable: boolean;
  readonly command: string;
}

export interface UpdateService {
  check(options?: { readonly force?: boolean }): Promise<UpdateCheckResult>;
  readonly cached?: () => Promise<UpdateCheckResult>;
}

interface UpdateCache {
  readonly checkedAt: string;
  readonly latestStableVersion?: string;
}

interface DailyUpdateCheckerOptions {
  readonly currentVersion: string;
  readonly stateDirectory: string;
  readonly fetcher?: typeof fetch;
  readonly now?: () => Date;
  readonly timeoutMilliseconds?: number;
}

export class DailyUpdateChecker implements UpdateService {
  private readonly cachePath: string;
  private readonly fetcher: typeof fetch;
  private readonly now: () => Date;
  private readonly timeoutMilliseconds: number;

  constructor(private readonly options: DailyUpdateCheckerOptions) {
    this.cachePath = join(options.stateDirectory, "update-check.json");
    this.fetcher = options.fetcher ?? fetch;
    this.now = options.now ?? (() => new Date());
    this.timeoutMilliseconds = options.timeoutMilliseconds ?? 1_000;
  }

  async check({
    force = false,
  }: { readonly force?: boolean } = {}): Promise<UpdateCheckResult> {
    const cache = await this.readCache();
    if (!force && cache && this.isFresh(cache)) {
      return this.result(false, cache.latestStableVersion);
    }

    let latestVersion = cache?.latestStableVersion;
    try {
      latestVersion = await this.fetchLatestStable();
    } catch {
      // Update discovery is advisory and must never affect the requested command.
    }
    await this.writeCache({
      checkedAt: this.now().toISOString(),
      ...(latestVersion ? { latestStableVersion: latestVersion } : {}),
    });
    return this.result(true, latestVersion);
  }

  async cached(): Promise<UpdateCheckResult> {
    const cache = await this.readCache();
    return this.result(
      false,
      cache && this.isFresh(cache) ? cache.latestStableVersion : undefined,
    );
  }

  private result(
    checked: boolean,
    latestVersion: string | undefined,
  ): UpdateCheckResult {
    const updateAvailable =
      latestVersion !== undefined &&
      compareSemver(latestVersion, this.options.currentVersion) > 0;
    return {
      checked,
      currentVersion: this.options.currentVersion,
      ...(latestVersion ? { latestVersion } : {}),
      updateAvailable,
      command: UPDATE_COMMAND,
    };
  }

  private isFresh(cache: UpdateCache): boolean {
    const elapsed = this.now().getTime() - new Date(cache.checkedAt).getTime();
    return (
      Number.isFinite(elapsed) && elapsed >= 0 && elapsed < oneDayMilliseconds
    );
  }

  private async fetchLatestStable(): Promise<string | undefined> {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, this.timeoutMilliseconds);
    timeout.unref();
    try {
      const response = await this.fetcher(registryUrl, {
        headers: { accept: "application/json" },
        signal: controller.signal,
      });
      if (!response.ok) return undefined;
      const body = (await response.json()) as unknown;
      if (!isRecord(body) || typeof body.version !== "string") return undefined;
      return isStableSemver(body.version) ? body.version : undefined;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async readCache(): Promise<UpdateCache | undefined> {
    try {
      const handle = await open(
        this.cachePath,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      let text: string;
      try {
        const stats = await handle.stat();
        if (!stats.isFile() || stats.size > maxCacheBytes) return undefined;
        text = await handle.readFile("utf8");
      } finally {
        await handle.close();
      }
      const parsed = JSON.parse(text) as unknown;
      if (!isRecord(parsed) || typeof parsed.checkedAt !== "string")
        return undefined;
      if (
        parsed.latestStableVersion !== undefined &&
        (typeof parsed.latestStableVersion !== "string" ||
          !isStableSemver(parsed.latestStableVersion))
      ) {
        return undefined;
      }
      return {
        checkedAt: parsed.checkedAt,
        ...(typeof parsed.latestStableVersion === "string"
          ? { latestStableVersion: parsed.latestStableVersion }
          : {}),
      };
    } catch {
      return undefined;
    }
  }

  private async writeCache(cache: UpdateCache): Promise<void> {
    const temporaryPath = `${this.cachePath}.hivemnd-${randomUUID()}.tmp`;
    try {
      await mkdir(this.options.stateDirectory, {
        recursive: true,
        mode: 0o700,
      });
      await chmod(this.options.stateDirectory, 0o700);
      await writeFile(temporaryPath, `${JSON.stringify(cache)}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      await chmod(temporaryPath, 0o600);
      await rename(temporaryPath, this.cachePath);
      await chmod(this.cachePath, 0o600);
    } catch {
      /* v8 ignore next -- best-effort cleanup after an injected filesystem failure */
      await rm(temporaryPath, { force: true }).catch(() => undefined);
      // A read-only home directory cannot make ordinary CLI commands fail.
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
