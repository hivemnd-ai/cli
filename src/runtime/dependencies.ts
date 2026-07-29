import type {
  AgentAdapter,
  ApiClient,
  DestinationConfig,
  HivemndConfig,
  Output,
  PromptPort,
  TokenStore,
} from "../domain.js";
import type { ScheduleManager } from "../schedule/periodic-sync-scheduler.js";
import type { UpdateService } from "../update/daily-update-checker.js";

export interface ConfigRepositoryPort {
  load(path: string): Promise<HivemndConfig>;
  loadOptional(path: string): Promise<HivemndConfig | undefined>;
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
  readonly homeDirectory: string;
  readonly runtimeExecutablePath?: string;
  readonly cliScriptPath?: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly output: Output;
  readonly prompt: PromptPort;
  readonly readHookInput: () => Promise<string>;
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
