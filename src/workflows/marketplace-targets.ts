import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import type { HivemndConfig } from "../domain.js";
import { HivemndError } from "../errors.js";
import { profileKey } from "../organizations/registry.js";
import { sha256 } from "../sync/hash.js";
import {
  managedAncestry,
  readManagedFile,
} from "../marketplace/managed-state.js";
import type { MarketplaceTarget } from "../api/marketplace-api-client.js";

const optInSchema = z
  .object({
    id: z.uuid(),
    harness_kind: z.enum(["codex", "claude"]),
    install_scope: z.enum(["user", "workspace"]),
    workspace_binding_id: z.uuid().nullable(),
  })
  .strict()
  .refine(
    (target) =>
      (target.install_scope === "user") ===
      (target.workspace_binding_id === null),
  );
export type MarketplaceOptIn = z.infer<typeof optInSchema>;

export class MarketplaceTargets {
  readonly directory: string;

  constructor(
    stateDirectory: string,
    configPath: string,
    config: HivemndConfig,
  ) {
    if (
      !config.installationId ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(config.installationId)
    ) {
      throw new HivemndError(
        "CONFIG_INVALID",
        "Marketplace management requires an enrolled installation",
      );
    }
    this.directory = join(
      resolve(stateDirectory),
      "organizations",
      profileKey(config.apiUrl),
      "marketplace-targets",
      sha256(resolve(configPath)),
      config.installationId,
    );
  }

  async list(): Promise<MarketplaceOptIn[]> {
    let names: string[];
    try {
      await lstat(this.directory);
      await managedAncestry(this.directory);
      names = await readdir(this.directory);
    } catch (error: unknown) {
      if (missing(error)) return [];
      throw error;
    }
    return await Promise.all(
      names
        .filter((name) => name.endsWith(".json"))
        .sort()
        .map(async (name) => {
          const value = parseConsent(
            (
              await readManagedFile(join(this.directory, name), 4096)
            ).toString(),
          );
          if (!value.success || name !== `${value.data.id}.json`)
            throw new HivemndError(
              "INTEGRITY_FAILED",
              "Invalid marketplace target consent",
            );
          return value.data;
        }),
    );
  }

  async remember(target: MarketplaceTarget): Promise<void> {
    const consent = optInSchema.parse({
      id: target.id,
      harness_kind: target.harness_kind,
      install_scope: target.install_scope,
      workspace_binding_id: target.workspace_binding_id,
    });
    await ensureMarketplaceDirectory(this.directory);
    const current = (await this.list()).find(
      (candidate) => candidate.id === consent.id,
    );
    if (current) {
      if (JSON.stringify(current) !== JSON.stringify(consent))
        throw new HivemndError(
          "INTEGRITY_FAILED",
          "Marketplace target identity changed",
        );
      return;
    }
    const temporary = join(this.directory, `.target-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, `${JSON.stringify(consent)}\n`, {
        flag: "wx",
        mode: 0o600,
      });
      await rename(temporary, join(this.directory, `${consent.id}.json`));
    } finally {
      await rm(temporary, { force: true });
    }
  }
}

export async function ensureMarketplaceDirectory(path: string): Promise<void> {
  try {
    const state = await lstat(path);
    if (
      state.uid !== userInfo().uid ||
      !state.isDirectory() ||
      state.isSymbolicLink() ||
      (state.mode & 0o777) !== 0o700
    ) {
      throw new HivemndError(
        "PATH_UNSAFE",
        "Marketplace consent directory must be private",
      );
    }
    await managedAncestry(path);
  } catch (error: unknown) {
    if (!missing(error)) throw error;
    const parent = dirname(path);
    try {
      await managedAncestry(parent);
    } catch (parentError: unknown) {
      if (!missing(parentError)) throw parentError;
      await ensureMarketplaceDirectory(parent);
    }
    await mkdir(path, { mode: 0o700, recursive: true });
    await managedAncestry(path);
  }
}

function parseConsent(text: string) {
  try {
    return optInSchema.safeParse(JSON.parse(text) as unknown);
  } catch {
    throw new HivemndError(
      "INTEGRITY_FAILED",
      "Invalid marketplace target consent",
    );
  }
}

function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
