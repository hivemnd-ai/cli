import { join, resolve } from "node:path";
import type { ApiClient, HivemndConfig, ResolvedToken } from "../domain.js";
import { HivemndError } from "../errors.js";
import { OrganizationRegistryRepository } from "../organizations/registry.js";
import { resolveOrganization } from "../organizations/resolver.js";
import type { OrganizationProfile } from "../organizations/types.js";
import type { RuntimeDependencies } from "../runtime/dependencies.js";

export interface AuthenticatedContext {
  readonly config: HivemndConfig;
  readonly configPath: string;
  readonly organization?: OrganizationProfile;
  readonly token: ResolvedToken;
  readonly client: ApiClient;
}

export interface ContextSelection {
  readonly workspace?: string;
}

export interface CliContext {
  readonly dependencies: RuntimeDependencies;
  loadConfigured(selection?: ContextSelection): Promise<HivemndConfig>;
  resolveConfigured(selection?: ContextSelection): Promise<{
    readonly config: HivemndConfig;
    readonly configPath: string;
    readonly organization?: OrganizationProfile;
  }>;
  bootstrap(
    existing?: HivemndConfig,
    selection?: ContextSelection,
  ): Promise<AuthenticatedContext>;
}

export function createCliContext(
  dependencies: RuntimeDependencies,
  selection: () => {
    readonly configPath: string;
    readonly explicitConfig: boolean;
    readonly org?: string;
  },
): CliContext {
  async function resolveConfigured(options: ContextSelection = {}): Promise<{
    readonly config: HivemndConfig;
    readonly configPath: string;
    readonly organization?: OrganizationProfile;
  }> {
    const selected = selection();
    const configs = dependencies.configRepositoryFactory(dependencies.cwd);
    if (selected.explicitConfig && selected.org) {
      throw new HivemndError(
        "CONFIG_INVALID",
        "Use either --config or --org, not both",
      );
    }
    if (selected.explicitConfig) {
      return {
        config: await configs.load(selected.configPath),
        configPath: resolve(dependencies.cwd, selected.configPath),
      };
    }
    const stateDirectory =
      dependencies.environment.HIVEMND_HOME ??
      join(dependencies.homeDirectory, ".hivemnd");
    const registry = new OrganizationRegistryRepository(
      stateDirectory,
      configs,
    );
    const discovered = await registry.loadOrMigrate(selected.configPath, false);
    const implicitSingle =
      !selected.org && discovered.profiles.length === 1
        ? discovered.profiles[0]?.alias
        : undefined;
    const organizationName = selected.org ?? implicitSingle;
    const organization = await resolveOrganization(
      {
        cwd: dependencies.cwd,
        ...(options.workspace ? { workspace: options.workspace } : {}),
        ...(organizationName ? { org: organizationName } : {}),
      },
      { registry: { load: () => Promise.resolve(discovered) }, configs },
    );
    return {
      config: organization.config,
      configPath: organization.configPath,
      organization,
    };
  }

  async function loadConfigured(
    options?: ContextSelection,
  ): Promise<HivemndConfig> {
    return (await resolveConfigured(options)).config;
  }

  async function bootstrap(
    existing?: HivemndConfig,
    options?: ContextSelection,
  ): Promise<AuthenticatedContext> {
    const selected = existing
      ? {
          config: existing,
          configPath: resolve(dependencies.cwd, selection().configPath),
        }
      : await resolveConfigured(options);
    const loaded = selected.config;
    const token = await dependencies.tokenStoreFactory(loaded).get();
    if (!token) {
      throw new HivemndError(
        "AUTH_MISSING",
        "No token found; use login or set HIVEMND_TOKEN",
      );
    }
    return {
      config: loaded,
      configPath: selected.configPath,
      ...(selected.organization ? { organization: selected.organization } : {}),
      token,
      client: dependencies.apiClientFactory(loaded),
    };
  }

  return { dependencies, loadConfigured, resolveConfigured, bootstrap };
}
