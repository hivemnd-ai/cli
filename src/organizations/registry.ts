import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { agentKinds, type HivemndConfig } from "../domain.js";
import { assertDefined, HivemndError } from "../errors.js";
import type { ConfigRepositoryPort } from "../runtime/dependencies.js";
import { tenantBaseUrl } from "../tenant-url.js";
import type { OrganizationRegistry } from "./types.js";

const aliasPattern = /^[a-z0-9][a-z0-9-]{0,62}$/;
const profileSchema = z.object({
  key: z.string().regex(/^[a-f\d]{16}$/),
  alias: z.string().regex(aliasPattern),
  name: z.string().min(1),
  slug: z.string().min(1),
  apiUrl: z.url(),
  configPath: z.string().refine(isAbsolute, "configPath must be absolute"),
});
const registrySchema = z
  .object({
    version: z.literal(1),
    profiles: z.array(profileSchema),
    workspaceBindings: z.array(
      z.object({
        path: z.string().refine(isAbsolute, "workspace path must be absolute"),
        organizationKey: z.string(),
      }),
    ),
    globalBindings: z.array(
      z.object({
        client: z.enum(agentKinds),
        organizationKey: z.string(),
      }),
    ),
  })
  .superRefine((registry, context) => {
    unique(registry.profiles, (profile) => profile.key, "profile key", context);
    unique(
      registry.profiles,
      (profile) => profile.alias,
      "organization alias",
      context,
    );
    unique(
      registry.profiles,
      (profile) => tenantBaseUrl(profile.apiUrl).href,
      "tenant URL",
      context,
    );
    unique(
      registry.profiles,
      (profile) => profile.configPath,
      "profile config path",
      context,
    );
    unique(
      registry.workspaceBindings,
      (binding) => binding.path,
      "workspace binding",
      context,
    );
    unique(
      registry.globalBindings,
      (binding) => binding.client,
      "global AI tool binding",
      context,
    );
    const keys = new Set(registry.profiles.map((profile) => profile.key));
    for (const [index, binding] of registry.workspaceBindings.entries()) {
      if (!keys.has(binding.organizationKey)) {
        context.addIssue({
          code: "custom",
          message: "Workspace binding references an unknown organization",
          path: ["workspaceBindings", index],
        });
      }
    }
    for (const [index, binding] of registry.globalBindings.entries()) {
      if (!keys.has(binding.organizationKey)) {
        context.addIssue({
          code: "custom",
          message: "Global binding references an unknown organization",
          path: ["globalBindings", index],
        });
      }
    }
  });

export class OrganizationRegistryRepository {
  readonly path: string;

  constructor(
    private readonly stateDirectory: string,
    private readonly configs: ConfigRepositoryPort,
  ) {
    this.path = join(stateDirectory, "registry.json");
  }

  async load(): Promise<OrganizationRegistry> {
    try {
      return parseRegistry(JSON.parse(await readFile(this.path, "utf8")));
    } catch (error: unknown) {
      throw new HivemndError(
        "CONFIG_INVALID",
        `Cannot load organization registry: ${this.path}`,
        { cause: error },
      );
    }
  }

  async loadOptional(): Promise<OrganizationRegistry | undefined> {
    try {
      return parseRegistry(JSON.parse(await readFile(this.path, "utf8")));
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === "ENOENT") return undefined;
      throw new HivemndError(
        "CONFIG_INVALID",
        `Cannot load organization registry: ${this.path}`,
        { cause: error },
      );
    }
  }

  async loadOrMigrate(
    legacyConfigPath: string,
    persist: boolean,
  ): Promise<OrganizationRegistry> {
    const existing = await this.loadOptional();
    if (existing) return existing;
    const absoluteConfigPath = resolve(legacyConfigPath);
    const legacy = await this.configs.loadOptional(absoluteConfigPath);
    const registry = legacy
      ? await legacyRegistry(legacy, absoluteConfigPath)
      : emptyRegistry();
    if (persist) await this.save(registry);
    return registry;
  }

  async save(registry: OrganizationRegistry): Promise<void> {
    const parsed = parseRegistry(registry);
    await mkdir(this.stateDirectory, { recursive: true, mode: 0o700 });
    await chmod(this.stateDirectory, 0o700);
    const temporary = `${this.path}.hivemnd-${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(parsed, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      await chmod(temporary, 0o600);
      await rename(temporary, this.path);
      await chmod(this.path, 0o600);
    } catch (error: unknown) {
      await rm(temporary, { force: true });
      throw error;
    }
  }

  async withLock<T>(operation: () => Promise<T>): Promise<T> {
    await mkdir(this.stateDirectory, { recursive: true, mode: 0o700 });
    const lockPath = join(this.stateDirectory, ".registry.lock");
    try {
      await mkdir(lockPath, { mode: 0o700 });
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === "EEXIST") {
        throw new HivemndError(
          "CONFIG_INVALID",
          "Another Hivemnd configuration change is in progress",
          { cause: error },
        );
      }
      throw error;
    }
    try {
      return await operation();
    } finally {
      await rm(lockPath, { recursive: true, force: true });
    }
  }

  profileConfigPath(apiUrl: string): string {
    return join(
      this.stateDirectory,
      "organizations",
      profileKey(apiUrl),
      "config.json",
    );
  }
}

export function profileKey(apiUrl: string): string {
  return createHash("sha256")
    .update(tenantBaseUrl(apiUrl).href)
    .digest("hex")
    .slice(0, 16);
}

export function organizationAlias(slug: string, apiUrl: string): string {
  const normalized = slug
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
  if (aliasPattern.test(normalized)) return normalized;
  const url = tenantBaseUrl(apiUrl);
  const pathName = basename(url.pathname);
  const hostnameLabel = url.hostname.split(".")[0];
  assertDefined(hostnameLabel, "Tenant URL has no hostname label");
  const fallback = pathName.length > 0 ? pathName : hostnameLabel;
  const safe = fallback
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return aliasPattern.test(safe)
    ? safe
    : `org-${profileKey(apiUrl).slice(0, 8)}`;
}

async function legacyRegistry(
  config: HivemndConfig,
  configPath: string,
): Promise<OrganizationRegistry> {
  const apiUrl = tenantBaseUrl(config.apiUrl).href.replace(/\/$/, "");
  const alias = organizationAlias("", apiUrl);
  const key = profileKey(apiUrl);
  const workspaces = new Set(
    config.destinations
      .filter(
        (destination) => destination.scope === "workspace" && destination.path,
      )
      .map((destination) => resolve(String(destination.path))),
  );
  const canonicalWorkspaces = await Promise.all(
    [...workspaces].map(async (path) => realpath(path).catch(() => path)),
  );
  return parseRegistry({
    version: 1,
    profiles: [{ key, alias, name: alias, slug: alias, apiUrl, configPath }],
    workspaceBindings: canonicalWorkspaces.map((path) => ({
      path,
      organizationKey: key,
    })),
    globalBindings: agentKinds
      .filter((client) =>
        config.destinations.some(
          (destination) =>
            destination.agent === client && destination.scope === "root",
        ),
      )
      .map((client) => ({ client, organizationKey: key })),
  });
}

function emptyRegistry(): OrganizationRegistry {
  return {
    version: 1,
    profiles: [],
    workspaceBindings: [],
    globalBindings: [],
  };
}

function parseRegistry(value: unknown): OrganizationRegistry {
  try {
    return registrySchema.parse(value);
  } catch (error: unknown) {
    throw new HivemndError("CONFIG_INVALID", "Invalid organization registry", {
      cause: error,
    });
  }
}

function unique<T>(
  values: readonly T[],
  key: (value: T) => string,
  label: string,
  context: z.core.$RefinementCtx,
): void {
  const seen = new Set<string>();
  for (const [index, value] of values.entries()) {
    const identity = key(value);
    if (seen.has(identity))
      context.addIssue({
        code: "custom",
        message: `Duplicate ${label}: ${identity}`,
        path: [index],
      });
    seen.add(identity);
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
