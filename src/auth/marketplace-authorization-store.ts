import { randomUUID } from "node:crypto";
import { lstat, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import type { HivemndConfig } from "../domain.js";
import { HivemndError } from "../errors.js";
import { readManagedFile } from "../marketplace/managed-state.js";
import { profileKey } from "../organizations/registry.js";
import { sha256 } from "../sync/hash.js";
import { ensureMarketplaceDirectory } from "../workflows/marketplace-targets.js";

const authorizationSchema = z
  .object({
    authorizationToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    expiresAt: z.iso.datetime(),
  })
  .strict();
export type MarketplaceAuthorization = z.infer<typeof authorizationSchema>;
const invalid = (): never => {
  throw new HivemndError(
    "INTEGRITY_FAILED",
    "Invalid temporary marketplace authorization",
  );
};
export class MarketplaceAuthorizationStore {
  readonly path: string;
  constructor(
    stateDirectory: string,
    configPath: string,
    config: HivemndConfig,
  ) {
    if (
      !config.installationId ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(config.installationId)
    )
      throw new HivemndError(
        "CONFIG_INVALID",
        "Private marketplace authorization requires an enrolled installation",
      );
    this.path = join(
      resolve(stateDirectory),
      "organizations",
      profileKey(config.apiUrl),
      "marketplace-authorizations",
      sha256(resolve(configPath)),
      config.installationId,
      "authorization.json",
    );
  }
  async load(): Promise<MarketplaceAuthorization | undefined> {
    let bytes: Buffer;
    try {
      await lstat(this.path);
      bytes = await readManagedFile(this.path, 4096);
    } catch (error: unknown) {
      if (missing(error)) return undefined;
      throw error;
    }
    let value: unknown;
    try {
      value = JSON.parse(bytes.toString()) as unknown;
    } catch {
      return invalid();
    }
    const result = authorizationSchema.safeParse(value);
    if (!result.success) return invalid();
    return Date.parse(result.data.expiresAt) > Date.now()
      ? result.data
      : undefined;
  }
  async save(authorization: MarketplaceAuthorization): Promise<void> {
    const result = authorizationSchema.safeParse(authorization);
    if (
      !result.success ||
      Date.parse(result.data.expiresAt) <= Date.now() ||
      Date.parse(result.data.expiresAt) > Date.now() + 600_000
    )
      return invalid();
    await ensureMarketplaceDirectory(dirname(this.path));
    // Existing grants must still belong to this private namespace before replacement.
    await this.load();
    const temporary = join(
      dirname(this.path),
      `.authorization-${randomUUID()}`,
    );
    try {
      await writeFile(temporary, JSON.stringify(result.data), {
        flag: "wx",
        mode: 0o600,
      });
      await rename(temporary, this.path);
    } finally {
      await rm(temporary, { force: true });
    }
  }
  async remove(): Promise<void> {
    try {
      await readManagedFile(this.path, 4096);
    } catch (error: unknown) {
      if (missing(error)) return;
      throw error;
    }
    await rm(this.path);
  }
}
function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
