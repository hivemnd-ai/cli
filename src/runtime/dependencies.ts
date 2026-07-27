import type {
  AgentAdapter,
  ApiClient,
  DestinationConfig,
  HivemndConfig,
  Output,
  TokenStore,
} from "../domain.js";
import type { ScheduleManager } from "../schedule/periodic-sync-scheduler.js";
import type { UpdateService } from "../update/daily-update-checker.js";

export interface ConfigRepositoryPort {
  load(path: string): Promise<HivemndConfig>;
  create(
    path: string,
    config: HivemndConfig,
    overwrite?: boolean,
  ): Promise<void>;
  addDestination(
    path: string,
    destination: DestinationConfig,
  ): Promise<HivemndConfig>;
  removeDestination(path: string, name: string): Promise<HivemndConfig>;
}

export interface RuntimeDependencies {
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly output: Output;
  readonly configRepositoryFactory: (cwd: string) => ConfigRepositoryPort;
  readonly tokenStoreFactory: (config: HivemndConfig) => TokenStore;
  readonly apiClientFactory: (config: HivemndConfig) => ApiClient;
  readonly adapterFactory: (
    config: HivemndConfig,
    destinationNames: readonly string[],
  ) => readonly AgentAdapter[];
  readonly targetAccess: (path: string) => Promise<void>;
  readonly id: () => string;
  readonly clientPlatform: string;
  readonly clientVersion: string;
  readonly updateService: UpdateService;
  readonly scheduleManagerFactory: (options: {
    readonly apiUrl: string;
    readonly configPath: string;
  }) => ScheduleManager;
}
