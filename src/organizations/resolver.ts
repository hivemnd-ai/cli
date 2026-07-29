import { relative, resolve, sep } from "node:path";
import type { AgentKind } from "../domain.js";
import { HivemndError } from "../errors.js";
import type { ConfigRepositoryPort } from "../runtime/dependencies.js";
import { tenantBaseUrl } from "../tenant-url.js";
import type {
  OrganizationProfile,
  OrganizationRegistryReader,
  ResolvedOrganization,
} from "./types.js";

export interface OrganizationResolutionOptions {
  readonly client?: AgentKind;
  readonly cwd: string;
  readonly workspace?: string;
  readonly org?: string;
}

export interface OrganizationResolutionDependencies {
  readonly registry: OrganizationRegistryReader;
  readonly configs: Pick<ConfigRepositoryPort, "load">;
}

export class OrganizationResolver {
  constructor(
    private readonly dependencies: OrganizationResolutionDependencies,
  ) {}

  resolve(
    options: OrganizationResolutionOptions,
  ): Promise<ResolvedOrganization> {
    return resolveOrganization(options, this.dependencies);
  }
}

export async function resolveOrganization(
  options: OrganizationResolutionOptions,
  dependencies: OrganizationResolutionDependencies,
): Promise<ResolvedOrganization> {
  const registry = await dependencies.registry.load();
  let profile: OrganizationProfile | undefined;
  if (options.org) {
    profile = registry.profiles.find(
      (candidate) =>
        candidate.alias === options.org || candidate.key === options.org,
    );
    if (!profile)
      throw new HivemndError(
        "CONFIG_INVALID",
        `Unknown organization: ${options.org}`,
      );
  } else {
    const selectedPath = resolve(options.workspace ?? options.cwd);
    const candidates = registry.workspaceBindings.filter((binding) =>
      within(binding.path, selectedPath),
    );
    if (candidates.length > 0) {
      const length = Math.max(
        ...candidates.map((binding) => resolve(binding.path).length),
      );
      const binding = candidates.find(
        (candidate) => resolve(candidate.path).length === length,
      );
      profile = registry.profiles.find(
        (candidate) => candidate.key === binding?.organizationKey,
      );
    }
    if (!profile && options.client) {
      const binding = registry.globalBindings.find(
        (candidate) => candidate.client === options.client,
      );
      profile = registry.profiles.find(
        (candidate) => candidate.key === binding?.organizationKey,
      );
    }
  }
  if (!profile) {
    throw new HivemndError(
      "CONFIG_INVALID",
      registry.profiles.length === 0
        ? "No Hivemnd organization is configured; run hivemnd init"
        : "No Hivemnd organization is connected to this workspace or AI tool; pass --org <name> or connect the workspace",
    );
  }
  const config = await dependencies.configs.load(profile.configPath);
  if (
    tenantBaseUrl(config.apiUrl).href !== tenantBaseUrl(profile.apiUrl).href
  ) {
    throw new HivemndError(
      "CONFIG_INVALID",
      `Organization profile ${profile.alias} does not match its tenant config`,
    );
  }
  return { ...profile, config };
}

function within(parent: string, child: string): boolean {
  const fromParent = relative(resolve(parent), resolve(child));
  return (
    fromParent === "" ||
    (fromParent !== ".." && !fromParent.startsWith(`..${sep}`))
  );
}
