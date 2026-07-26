import type { ApiClient, HivemndConfig, ResolvedToken } from "../domain.js";
import { HivemndError } from "../errors.js";
import type { RuntimeDependencies } from "../runtime/dependencies.js";

export interface AuthenticatedContext {
  readonly config: HivemndConfig;
  readonly token: ResolvedToken;
  readonly client: ApiClient;
}

export interface CliContext {
  readonly dependencies: RuntimeDependencies;
  loadConfigured(): Promise<HivemndConfig>;
  bootstrap(existing?: HivemndConfig): Promise<AuthenticatedContext>;
}

export function createCliContext(
  dependencies: RuntimeDependencies,
  configPath: () => string,
): CliContext {
  async function loadConfigured(): Promise<HivemndConfig> {
    return dependencies
      .configRepositoryFactory(dependencies.cwd)
      .load(configPath());
  }

  async function bootstrap(
    existing?: HivemndConfig,
  ): Promise<AuthenticatedContext> {
    const loaded = existing ?? (await loadConfigured());
    const token = await dependencies.tokenStoreFactory(loaded).get();
    if (!token) {
      throw new HivemndError(
        "AUTH_MISSING",
        "No token found; use login or set HIVEMND_TOKEN",
      );
    }
    return {
      config: loaded,
      token,
      client: dependencies.apiClientFactory(loaded),
    };
  }

  return { dependencies, loadConfigured, bootstrap };
}
