import { resolve } from "node:path";
import { parseActivationUrl, type Activation } from "../auth/activation-url.js";
import type {
  AgentKind,
  ApiClient,
  ClientConfiguration,
  HivemndConfig,
  Output,
  PromptPort,
  ResolvedToken,
  TokenStore,
} from "../domain.js";
import { agentKinds } from "../domain.js";
import { HivemndError } from "../errors.js";
import type { ConfigRepositoryPort } from "../runtime/dependencies.js";
import type {
  ScheduleManager,
  ScheduleState,
} from "../schedule/periodic-sync-scheduler.js";
import {
  canonicalWorkspacePath,
  mergeRootDestinations,
  mergeWorkspaceDestinations,
} from "../workspaces/destinations.js";

export interface InitializeOptions {
  readonly activationUrl?: string;
  readonly clients: readonly string[];
  readonly scopes: readonly string[];
  readonly workspaces: readonly string[];
  readonly automaticSync?: "install" | "skip";
  readonly apply: boolean;
}

export interface InitializeDependencies {
  readonly cwd: string;
  readonly configPath: string;
  readonly configRepository: ConfigRepositoryPort;
  readonly tokenStoreFactory: (config: HivemndConfig) => TokenStore;
  readonly apiClientFactory: (config: HivemndConfig) => ApiClient;
  readonly scheduleManagerFactory: (options: {
    readonly apiUrl: string;
    readonly configPath: string;
  }) => ScheduleManager;
  readonly prompt: PromptPort;
  readonly output: Output;
  readonly clientPlatform: string;
  readonly clientVersion: string;
  readonly initialSync?: (config: HivemndConfig) => Promise<void>;
  readonly validatePlan?: (
    config: HivemndConfig,
    configuration: ClientConfiguration,
  ) => Promise<void>;
  readonly onConfigured?: (
    config: HivemndConfig,
    configuration: ClientConfiguration,
  ) => Promise<void>;
  readonly commitConfiguration?: (
    config: HivemndConfig,
    configuration: ClientConfiguration,
    overwrite: boolean,
  ) => Promise<void>;
  readonly previewDetails?: (
    config: HivemndConfig,
    configuration: ClientConfiguration,
  ) => Promise<void>;
}

interface AccessContext {
  readonly config: HivemndConfig;
  readonly configuration: ClientConfiguration;
  readonly client: ApiClient;
  readonly store: TokenStore;
  readonly activation?: Activation;
  readonly token?: ResolvedToken;
}

export async function initialize(
  options: InitializeOptions,
  dependencies: InitializeDependencies,
): Promise<void> {
  const existing = await optionalConfig(dependencies);
  const access = await resolveAccess(existing, options, dependencies);
  const clients = selectedClients(
    options.clients,
    access.configuration.enabledClients,
  );
  const scopeByClient = await selectedScopes(
    clients,
    options.scopes,
    dependencies.prompt,
    dependencies.output,
  );
  const workspaceClients = clients.filter(
    (client) => scopeByClient.get(client) === "workspace",
  );
  const workspacePaths = await selectedWorkspacePaths(
    workspaceClients,
    options.workspaces,
    dependencies,
  );
  const next = buildConfig(
    access.config,
    clients,
    scopeByClient,
    workspacePaths,
  );
  const schedule = dependencies.scheduleManagerFactory({
    apiUrl: next.apiUrl,
    configPath: resolve(dependencies.cwd, dependencies.configPath),
  });
  const scheduleState = await schedule.status();
  const installSchedule = await chooseAutomaticSync(
    options,
    scheduleState,
    access,
    dependencies,
  );

  preview(
    next,
    access.configuration,
    scheduleState,
    installSchedule,
    dependencies.output,
  );
  await dependencies.previewDetails?.(next, access.configuration);
  const confirmed =
    options.apply ||
    (dependencies.prompt.interactive &&
      (await dependencies.prompt.confirm("Apply this onboarding plan?", true)));
  if (!confirmed) {
    dependencies.output.write("No changes applied.");
    return;
  }
  await dependencies.validatePlan?.(next, access.configuration);
  if (access.activation) {
    const enrollment = await access.client.exchangeEnrollment(
      access.activation.token,
      {
        clientKind: "hivemnd_cli",
        platform: dependencies.clientPlatform,
        clientVersion: dependencies.clientVersion,
      },
    );
    await access.store.save(enrollment.accessToken);
  }
  if (dependencies.commitConfiguration) {
    await dependencies.commitConfiguration(
      next,
      access.configuration,
      existing !== undefined,
    );
  } else {
    await dependencies.configRepository.create(
      dependencies.configPath,
      next,
      existing !== undefined,
    );
    await dependencies.onConfigured?.(next, access.configuration);
  }
  let initialSyncError: Error | undefined;
  if (next.destinations.length > 0 && dependencies.initialSync) {
    try {
      await dependencies.initialSync(next);
    } catch (error: unknown) {
      initialSyncError =
        error instanceof Error
          ? error
          : new HivemndError("SYNC_FAILED", "Initial sync failed");
      dependencies.output.error(
        `Initial sync failed: ${initialSyncError.message}`,
      );
    }
  }
  if (installSchedule) await schedule.install(15);
  if (initialSyncError) throw initialSyncError;
  dependencies.output.write(
    `Connected to ${access.configuration.organization.name}.`,
  );
}

async function optionalConfig(
  dependencies: InitializeDependencies,
): Promise<HivemndConfig | undefined> {
  return dependencies.configRepository.loadOptional(dependencies.configPath);
}

async function resolveAccess(
  existing: HivemndConfig | undefined,
  options: InitializeOptions,
  dependencies: InitializeDependencies,
): Promise<AccessContext> {
  if (existing) {
    const store = dependencies.tokenStoreFactory(existing);
    const token = await store.get().catch(() => undefined);
    if (token) {
      const client = dependencies.apiClientFactory(existing);
      try {
        const configuration = await client.clientConfiguration(token.value);
        return { config: existing, configuration, client, store, token };
      } catch (error: unknown) {
        if (!(error instanceof HivemndError) || error.code !== "AUTH_MISSING") {
          throw error;
        }
        // Invalid or expired authentication resumes through a fresh activation URL.
      }
    }
  }

  let activationUrl = options.activationUrl;
  if (!activationUrl && dependencies.prompt.interactive) {
    activationUrl = dependencies.prompt.secret
      ? await dependencies.prompt.secret("Activation URL")
      : await dependencies.prompt.input("Activation URL");
  }
  if (!activationUrl) {
    throw interactiveRequired(
      "Provide --activation-url or HIVEMND_ACTIVATION_URL",
    );
  }
  const activation = parseActivationUrl(activationUrl);
  if (existing && existing.apiUrl !== activation.apiUrl) {
    throw new HivemndError(
      "CONFIG_INVALID",
      "Activation URL belongs to a different tenant than the existing config",
    );
  }
  const config = existing ?? { apiUrl: activation.apiUrl, destinations: [] };
  const client = dependencies.apiClientFactory(config);
  const configuration = await client.previewEnrollment(activation.token);
  return {
    config,
    configuration,
    client,
    store: dependencies.tokenStoreFactory(config),
    activation,
  };
}

function selectedClients(
  requested: readonly string[],
  enabled: readonly AgentKind[],
): readonly AgentKind[] {
  const values = requested.length > 0 ? requested : enabled;
  return [...new Set(values.map(parseClient))].map((client) => {
    if (!enabled.includes(client)) {
      throw new HivemndError(
        "CONFIG_INVALID",
        `AI tool is not enabled for this organization: ${client}`,
      );
    }
    return client;
  });
}

async function selectedScopes(
  clients: readonly AgentKind[],
  values: readonly string[],
  prompt: PromptPort,
  output: Output,
): Promise<ReadonlyMap<AgentKind, "global" | "workspace" | "skip">> {
  const parsed = new Map<AgentKind, "global" | "workspace" | "skip">();
  for (const value of values) {
    const parts = value.split("=");
    const [, rawScope, extra] = parts;
    const client = parseClient(String(parts[0]));
    if (
      extra !== undefined ||
      !["global", "workspace", "skip"].includes(rawScope ?? "")
    ) {
      throw new HivemndError(
        "CONFIG_INVALID",
        `Invalid client scope: ${value}`,
      );
    }
    parsed.set(client, rawScope as "global" | "workspace" | "skip");
  }
  for (const client of clients) {
    if (parsed.has(client)) continue;
    if (!prompt.interactive) {
      throw interactiveRequired(
        `Pass --scope ${client}=global, ${client}=workspace, or ${client}=skip`,
      );
    }
    if (
      await prompt.confirm(
        `Install Hivemnd globally for ${clientName(client)}?`,
        true,
      )
    ) {
      parsed.set(client, "global");
      continue;
    }
    output.write(
      "If you choose not to install globally, you can connect folders later with: hivemnd workspace add .",
    );
    parsed.set(
      client,
      (await prompt.confirm(
        `Connect selected workspace folders for ${clientName(client)}?`,
        true,
      ))
        ? "workspace"
        : "skip",
    );
  }
  return parsed;
}

async function selectedWorkspacePaths(
  workspaceClients: readonly AgentKind[],
  supplied: readonly string[],
  dependencies: InitializeDependencies,
): Promise<readonly string[]> {
  let values = supplied;
  if (
    workspaceClients.length > 0 &&
    values.length === 0 &&
    dependencies.prompt.interactive
  ) {
    values = splitList(
      await dependencies.prompt.input(
        "Workspace folders (comma-separated; blank to finish without folders)",
      ),
    );
  }
  if (workspaceClients.length > 0 && values.length === 0) {
    dependencies.output.write(
      "You can add one later with: hivemnd workspace add .",
    );
  }
  return Promise.all(
    [...new Set(values.map((path) => resolve(dependencies.cwd, path)))].map(
      canonicalWorkspacePath,
    ),
  );
}

function buildConfig(
  config: HivemndConfig,
  clients: readonly AgentKind[],
  scopeByClient: ReadonlyMap<AgentKind, "global" | "workspace" | "skip">,
  workspaces: readonly string[],
): HivemndConfig {
  const globalClients = clients.filter(
    (client) => scopeByClient.get(client) === "global",
  );
  const workspaceClients = clients.filter(
    (client) => scopeByClient.get(client) === "workspace",
  );
  let next = mergeRootDestinations(config, globalClients);
  for (const workspace of workspaces) {
    next = mergeWorkspaceDestinations(next, workspace, workspaceClients);
  }
  return next;
}

async function chooseAutomaticSync(
  options: InitializeOptions,
  state: ScheduleState,
  access: AccessContext,
  dependencies: InitializeDependencies,
): Promise<boolean> {
  if (state.installed) return false;
  const persistent =
    access.store.supportsPersistentStorage?.() === true &&
    (access.activation !== undefined || access.token?.source === "keychain");
  if (!persistent) {
    if (options.automaticSync === "install") {
      throw new HivemndError(
        "KEYCHAIN_UNAVAILABLE",
        "Automatic sync requires persistent secure credential storage",
      );
    }
    dependencies.output.write(
      "Automatic sync is unavailable until persistent secure credential storage is configured.",
    );
    return false;
  }
  if (options.automaticSync) return options.automaticSync === "install";
  if (!dependencies.prompt.interactive) {
    throw interactiveRequired(
      "Pass --automatic-sync install or --automatic-sync skip",
    );
  }
  return dependencies.prompt.confirm(
    "Install automatic sync every 15 minutes? (recommended)",
    true,
  );
}

function preview(
  config: HivemndConfig,
  configuration: ClientConfiguration,
  scheduleState: ScheduleState,
  installSchedule: boolean,
  output: Output,
): void {
  output.write("Preview");
  output.write(`Organization: ${configuration.organization.name}`);
  output.write(
    `AI tools: ${configuration.enabledClients.join(", ") || "none enabled"}`,
  );
  for (const destination of config.destinations) {
    output.write(
      `Destination: ${destination.agent} | ${destination.scope}${destination.path ? ` | ${destination.path}` : ""}`,
    );
  }
  output.write(
    scheduleState.installed
      ? `Automatic sync: installed, ${scheduleState.active ? "active" : "inactive"}`
      : `Automatic sync: ${installSchedule ? "install" : "skip"}`,
  );
  if (!scheduleState.installed && !installSchedule) {
    output.write(
      "Automatic sync skipped. Run hivemnd sync --apply to synchronize manually.",
    );
  }
}

function parseClient(value: string): AgentKind {
  const client = agentKinds.find((candidate) => candidate === value.trim());
  if (!client) {
    throw new HivemndError("CONFIG_INVALID", `Unknown AI tool: ${value}`);
  }
  return client;
}

function splitList(value: string): string[] {
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function clientName(client: AgentKind): string {
  return client === "codex" ? "Codex" : "Claude Code";
}

function interactiveRequired(message: string): HivemndError {
  return new HivemndError("INTERACTIVE_REQUIRED", message);
}
