import type { Command } from "commander";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { createCliContext, type CliContext } from "../cli/context.js";
import type { AgentKind, HivemndConfig } from "../domain.js";
import { agentKinds } from "../domain.js";
import { assertDefined, HivemndError } from "../errors.js";
import { organizationRegistry } from "../organizations/runtime.js";
import type {
  OrganizationProfile,
  OrganizationRegistry,
} from "../organizations/types.js";
import {
  canonicalWorkspacePath,
  mergeWorkspaceDestinations,
} from "../workspaces/destinations.js";
import {
  hostRegistration,
  mcpServerDefinition,
  RegistrationTransaction,
  type CustomRegistrationInstallOperation,
  type RegistrationInstallOperation,
} from "../mcp/registration.js";
import { synchronize } from "../workflows/synchronize.js";
import {
  hookInstallOperation,
  hookLauncherDefinition,
  hostHookRegistration,
  managedHookStateDirectory,
} from "../hooks/registration.js";
import { AlwaysContextPlanner } from "../sync/always-context.js";

interface WorkspaceOptions {
  readonly client: readonly string[];
  readonly org?: string;
  readonly apply: boolean;
}

export function registerWorkspaceCommands(
  program: Command,
  context: CliContext,
): void {
  const workspace = program
    .command("workspace")
    .description("manage workspace AI tool destinations");
  workspace
    .command("add [path]", { isDefault: true })
    .description("connect the current or selected workspace")
    .option("--client <name>", "enabled AI tool (repeatable)", collect, [])
    .option("--org <name>", "local Hivemnd organization name")
    .option("--apply", "apply the workspace connection preview", false)
    .action((path: string | undefined, options: WorkspaceOptions) =>
      addWorkspace(program, context, path, options),
    );

  workspace
    .command("list")
    .description("list workspace-to-organization connections")
    .action(async () => {
      const { dependencies } = context;
      const registry = await organizationRegistry(dependencies).loadOrMigrate(
        program.opts<{ config: string }>().config,
        false,
      );
      if (registry.workspaceBindings.length === 0) {
        dependencies.output.write("No Hivemnd workspaces are configured.");
        return;
      }
      for (const binding of registry.workspaceBindings) {
        const profile = registry.profiles.find(
          (candidate) => candidate.key === binding.organizationKey,
        );
        assertDefined(profile, "Workspace binding has no organization profile");
        dependencies.output.write(`${binding.path} | ${profile.alias}`);
      }
    });

  workspace
    .command("remove [path]")
    .description("disconnect a workspace and remove Hivemnd-owned files")
    .option("--apply", "apply the workspace removal preview", false)
    .action((path: string | undefined, options: { apply: boolean }) =>
      removeWorkspace(program, context, path, options.apply),
    );

  workspace
    .command("reassign [path]")
    .description("move a workspace to another Hivemnd organization")
    .option("--org <name>", "new local Hivemnd organization name")
    .option("--client <name>", "enabled AI tool (repeatable)", collect, [])
    .option("--apply", "apply the reassignment preview", false)
    .action(
      async (
        path: string | undefined,
        options: WorkspaceOptions & { apply: boolean },
      ) => reassignWorkspace(program, context, path, options),
    );
}

async function removeWorkspace(
  program: Command,
  context: CliContext,
  path: string | undefined,
  apply: boolean,
): Promise<void> {
  const { dependencies } = context;
  const absolute = await canonicalWorkspacePath(
    resolve(dependencies.cwd, path ?? "."),
  );
  const configs = dependencies.configRepositoryFactory(dependencies.cwd);
  if (explicitConfig(program, dependencies.environment)) {
    const configured = await context.resolveConfigured({ workspace: absolute });
    const names = workspaceDestinationNames(configured.config, absolute);
    if (names.length === 0) {
      throw new HivemndError(
        "CONFIG_INVALID",
        `Workspace is not connected: ${absolute}`,
      );
    }
    const next = withoutWorkspace(configured.config, absolute);
    previewRemoval(absolute, undefined, dependencies);
    if (!(await confirmRemoval(apply, dependencies))) return;
    const rollbackOwned = await detachOwnedFiles(
      context,
      configured.config,
      names,
    );
    try {
      await configs.create(configured.configPath, next, true);
      await new RegistrationTransaction().install(
        workspaceRemovalRegistrations(
          configured.config,
          absolute,
          dependencies,
        ),
      );
    } catch (error: unknown) {
      await configs.create(configured.configPath, configured.config, true);
      await rollbackOwned();
      throw error;
    }
    dependencies.output.write(`Workspace disconnected: ${absolute}`);
    return;
  }

  const repository = organizationRegistry(dependencies);
  const registry = await repository.loadOrMigrate(
    program.opts<{ config: string }>().config,
    true,
  );
  const binding = registry.workspaceBindings.find(
    (candidate) => candidate.path === absolute,
  );
  if (!binding) {
    throw new HivemndError(
      "CONFIG_INVALID",
      `Workspace is not connected: ${absolute}`,
    );
  }
  const profile = registry.profiles.find(
    (candidate) => candidate.key === binding.organizationKey,
  );
  assertDefined(profile, "Workspace binding has no organization profile");
  const config = await configs.load(profile.configPath);
  const names = workspaceDestinationNames(config, absolute);
  const next = withoutWorkspace(config, absolute);
  const nextRegistry: OrganizationRegistry = {
    ...registry,
    workspaceBindings: registry.workspaceBindings.filter(
      (candidate) => candidate.path !== absolute,
    ),
  };
  previewRemoval(absolute, profile.alias, dependencies);
  if (!(await confirmRemoval(apply, dependencies))) return;
  await repository.withLock(async () => {
    const current = await repository.load();
    if (JSON.stringify(current) !== JSON.stringify(registry)) {
      throw new HivemndError(
        "CONFIG_INVALID",
        "Workspace connection changed while removal was being prepared; run the command again",
      );
    }
    const rollbackOwned = await detachOwnedFiles(context, config, names);
    try {
      await configs.create(profile.configPath, next, true);
      await repository.save(nextRegistry);
      await new RegistrationTransaction().install(
        workspaceRemovalRegistrations(config, absolute, dependencies),
      );
    } catch (error: unknown) {
      await configs.create(profile.configPath, config, true);
      await repository.save(registry);
      await rollbackOwned();
      throw error;
    }
  });
  dependencies.output.write(`Workspace disconnected: ${absolute}`);
}

async function addWorkspace(
  program: Command,
  context: CliContext,
  path: string | undefined,
  options: WorkspaceOptions,
): Promise<void> {
  const { dependencies } = context;
  const absolute = await canonicalWorkspacePath(
    resolve(dependencies.cwd, path ?? "."),
  );
  if (explicitConfig(program, dependencies.environment)) {
    if (options.org ?? program.opts<{ org?: string }>().org) {
      throw new HivemndError(
        "CONFIG_INVALID",
        "Use either --config or --org, not both",
      );
    }
    const { config, token, client, configPath } = await context.bootstrap();
    const configuration = await client.clientConfiguration(token.value);
    const next = configure(
      config,
      options.client,
      configuration.enabledClients,
      absolute,
    );
    const registrations = workspaceRegistrations(next, absolute, dependencies);
    for (const path of registrations.paths) {
      dependencies.output.write(`MCP registration: ${path}`);
    }
    if (!(await confirmWorkspacePlan(options.apply, dependencies))) return;
    try {
      await dependencies
        .configRepositoryFactory(dependencies.cwd)
        .create(configPath, next, true);
      await new RegistrationTransaction().install(registrations.operations);
    } catch (error: unknown) {
      await dependencies
        .configRepositoryFactory(dependencies.cwd)
        .create(configPath, config, true);
      throw error;
    }
    await synchronizeWorkspace(context, configPath, absolute);
    await reportSchedule(context, next, configPath, absolute);
    return;
  }
  const repository = organizationRegistry(dependencies);
  const registry = await repository.loadOrMigrate(
    program.opts<{ config: string }>().config,
    true,
  );
  const existing = registry.workspaceBindings.find(
    (binding) => binding.path === absolute,
  );
  const requestedOrg = options.org ?? program.opts<{ org?: string }>().org;
  const profile = await selectProfile(registry, requestedOrg, dependencies);
  if (existing && existing.organizationKey !== profile.key) {
    const current = registry.profiles.find(
      (candidate) => candidate.key === existing.organizationKey,
    );
    assertDefined(current, "Workspace binding has no organization profile");
    throw new HivemndError(
      "CONFIG_INVALID",
      `Workspace is already connected to ${current.alias}; use hivemnd workspace reassign ${shellQuote(absolute)} --org ${profile.alias}`,
    );
  }
  const configs = dependencies.configRepositoryFactory(dependencies.cwd);
  const config = await configs.load(profile.configPath);
  const token = await dependencies.tokenStoreFactory(config).get();
  if (!token)
    throw new HivemndError(
      "AUTH_MISSING",
      `No token found for ${profile.alias}; run hivemnd init`,
    );
  const configuration = await dependencies
    .apiClientFactory(config)
    .clientConfiguration(token.value);
  const next = configure(
    config,
    options.client,
    configuration.enabledClients,
    absolute,
  );
  const nextRegistry: OrganizationRegistry = existing
    ? registry
    : {
        ...registry,
        workspaceBindings: [
          ...registry.workspaceBindings,
          { path: absolute, organizationKey: profile.key },
        ],
      };
  const registrations = workspaceRegistrations(next, absolute, dependencies);
  for (const path of registrations.paths) {
    dependencies.output.write(`MCP registration: ${path}`);
  }
  if (!(await confirmWorkspacePlan(options.apply, dependencies))) return;
  await repository.withLock(async () => {
    try {
      await configs.create(profile.configPath, next, true);
      await repository.save(nextRegistry);
      await new RegistrationTransaction().install(registrations.operations);
    } catch (error: unknown) {
      await configs.create(profile.configPath, config, true);
      await repository.save(registry);
      throw error;
    }
  });
  dependencies.output.write(
    `Workspace connected: ${absolute} -> ${profile.alias}`,
  );
  await synchronizeWorkspace(context, profile.configPath, absolute);
  await reportSchedule(context, next, profile.configPath, absolute);
}

async function synchronizeWorkspace(
  context: CliContext,
  configPath: string,
  workspace: string,
): Promise<void> {
  const explicitContext = createCliContext(context.dependencies, () => ({
    configPath,
    explicitConfig: true,
  }));
  await synchronize(
    {
      dryRun: false,
      apply: true,
      destination: [],
      adoptExisting: false,
      path: workspace,
    },
    explicitContext,
  );
}

async function confirmWorkspacePlan(
  apply: boolean,
  dependencies: CliContext["dependencies"],
): Promise<boolean> {
  if (apply) return true;
  if (!dependencies.prompt.interactive) {
    throw new HivemndError(
      "INTERACTIVE_REQUIRED",
      "Pass --apply to connect this workspace",
    );
  }
  if (await dependencies.prompt.confirm("Apply this workspace plan?", true)) {
    return true;
  }
  dependencies.output.write("No changes applied.");
  return false;
}

function workspaceRegistrations(
  config: HivemndConfig,
  workspace: string,
  dependencies: CliContext["dependencies"],
): {
  readonly operations: readonly RegistrationInstallOperation[];
  readonly paths: readonly string[];
} {
  const clients = new Set(
    config.destinations
      .filter(
        (destination) =>
          destination.scope === "workspace" && destination.path === workspace,
      )
      .map((destination) => destination.agent),
  );
  const operations: RegistrationInstallOperation[] = [];
  const paths: string[] = [];
  for (const client of clients) {
    const target = hostRegistration({
      client,
      scope: "workspace",
      homeDirectory: dependencies.homeDirectory,
      workspace,
    });
    operations.push({
      registration: target.registration,
      definition: mcpServerDefinition({
        client,
        runtimeExecutablePath:
          dependencies.runtimeExecutablePath ?? process.execPath,
        cliScriptPath: dependencies.cliScriptPath ?? resolveCliScriptArgument(),
        stateDirectory: dependencies.environment.HIVEMND_HOME,
      }),
      ...(target.scope ? { scope: target.scope } : {}),
    });
    paths.push(target.path);
    const hook = hostHookRegistration({
      client,
      scope: "workspace",
      homeDirectory: dependencies.homeDirectory,
      workspace,
    });
    operations.push(
      hookInstallOperation(
        hook,
        hookLauncherDefinition({
          client,
          scope: "workspace",
          workspace,
          runtimeExecutablePath:
            dependencies.runtimeExecutablePath ?? process.execPath,
          cliScriptPath:
            dependencies.cliScriptPath ?? resolveCliScriptArgument(),
          stateDirectory: managedHookStateDirectory(
            dependencies.environment,
            dependencies.homeDirectory,
          ),
        }),
      ),
    );
    paths.push(hook.path);
  }
  return { operations, paths: [...new Set(paths)] };
}

async function reassignWorkspace(
  program: Command,
  context: CliContext,
  path: string | undefined,
  options: WorkspaceOptions & { apply: boolean },
): Promise<void> {
  const { dependencies } = context;
  const targetOrganization =
    options.org ?? program.opts<{ org?: string }>().org;
  if (!targetOrganization) {
    throw new HivemndError(
      "CONFIG_INVALID",
      "Workspace reassignment requires --org <name>",
    );
  }
  if (explicitConfig(program, dependencies.environment)) {
    throw new HivemndError(
      "CONFIG_INVALID",
      "Workspace reassignment requires the organization registry; remove --config and HIVEMND_CONFIG",
    );
  }
  const absolute = await canonicalWorkspacePath(
    resolve(dependencies.cwd, path ?? "."),
  );
  const repository = organizationRegistry(dependencies);
  const registry = await repository.loadOrMigrate(
    program.opts<{ config: string }>().config,
    true,
  );
  const binding = registry.workspaceBindings.find(
    (candidate) => candidate.path === absolute,
  );
  if (!binding) {
    throw new HivemndError(
      "CONFIG_INVALID",
      `Workspace is not connected: ${absolute}`,
    );
  }
  const source = registry.profiles.find(
    (candidate) => candidate.key === binding.organizationKey,
  );
  assertDefined(source, "Workspace binding has no organization profile");
  const target = await selectProfile(
    registry,
    targetOrganization,
    dependencies,
  );
  if (source.key === target.key) {
    dependencies.output.write(
      `Workspace is already connected to ${target.alias}: ${absolute}`,
    );
    return;
  }
  dependencies.output.write("Preview");
  dependencies.output.write(`Workspace: ${absolute}`);
  dependencies.output.write(`Organization: ${source.alias} -> ${target.alias}`);
  if (!options.apply) {
    if (!dependencies.prompt.interactive) {
      dependencies.output.write("No changes applied.");
      return;
    }
    if (
      !(await dependencies.prompt.confirm(
        "Apply this workspace reassignment?",
        false,
      ))
    ) {
      dependencies.output.write("No changes applied.");
      return;
    }
  }
  const configs = dependencies.configRepositoryFactory(dependencies.cwd);
  const sourceConfig = await configs.load(source.configPath);
  const sourceNames = sourceConfig.destinations
    .filter(
      (destination) =>
        destination.scope === "workspace" && destination.path === absolute,
    )
    .map((destination) => destination.name);
  const cleanedSource: HivemndConfig = {
    ...sourceConfig,
    destinations: sourceConfig.destinations.filter(
      (destination) =>
        !(destination.scope === "workspace" && destination.path === absolute),
    ),
  };
  const targetConfig = await configs.load(target.configPath);
  const token = await dependencies.tokenStoreFactory(targetConfig).get();
  if (!token)
    throw new HivemndError(
      "AUTH_MISSING",
      `No token found for ${target.alias}; run hivemnd init`,
    );
  const configuration = await dependencies
    .apiClientFactory(targetConfig)
    .clientConfiguration(token.value);
  const configuredTarget = configure(
    targetConfig,
    options.client,
    configuration.enabledClients,
    absolute,
  );
  const nextRegistry: OrganizationRegistry = {
    ...registry,
    workspaceBindings: registry.workspaceBindings.map((candidate) =>
      candidate.path === absolute
        ? { ...candidate, organizationKey: target.key }
        : candidate,
    ),
  };
  const removalRegistrations = workspaceRemovalRegistrations(
    sourceConfig,
    absolute,
    dependencies,
  );
  const targetRegistrations = workspaceRegistrations(
    configuredTarget,
    absolute,
    dependencies,
  );
  await repository.withLock(async () => {
    const currentRegistry = await repository.load();
    const currentBinding = currentRegistry.workspaceBindings.find(
      (candidate) => candidate.path === absolute,
    );
    if (currentBinding?.organizationKey !== source.key) {
      throw new HivemndError(
        "CONFIG_INVALID",
        "Workspace connection changed while reassignment was being prepared; run the command again",
      );
    }
    const currentSource = await configs.load(source.configPath);
    const currentTarget = await configs.load(target.configPath);
    if (
      JSON.stringify(currentSource) !== JSON.stringify(sourceConfig) ||
      JSON.stringify(currentTarget) !== JSON.stringify(targetConfig)
    ) {
      throw new HivemndError(
        "CONFIG_INVALID",
        "Organization configuration changed while reassignment was being prepared; run the command again",
      );
    }
    const rollbackOwnedFiles = await detachOwnedFiles(
      context,
      sourceConfig,
      sourceNames,
    );
    let rollbackRegistrations: (() => Promise<void>) | undefined;
    try {
      await configs.create(source.configPath, cleanedSource, true);
      await configs.create(target.configPath, configuredTarget, true);
      await repository.save(nextRegistry);
      rollbackRegistrations = (
        await new RegistrationTransaction().installReversible([
          ...removalRegistrations,
          ...targetRegistrations.operations,
        ])
      ).rollback;
      await synchronizeWorkspace(context, target.configPath, absolute);
    } catch (error: unknown) {
      await rollbackRegistrations?.();
      await configs.create(source.configPath, sourceConfig, true);
      await configs.create(target.configPath, targetConfig, true);
      await repository.save(registry);
      await rollbackOwnedFiles();
      throw error;
    }
  });
  dependencies.output.write(
    `Workspace reassigned: ${absolute} -> ${target.alias}`,
  );
}

function configure(
  config: HivemndConfig,
  requestedClients: readonly string[],
  enabledClients: readonly AgentKind[],
  absolute: string,
): HivemndConfig {
  const selected =
    requestedClients.length > 0
      ? requestedClients.map(parseClient)
      : [...enabledClients];
  if (enabledClients.length === 0) {
    throw new HivemndError(
      "CONFIG_INVALID",
      "This organization has no enabled AI tools",
    );
  }
  for (const candidate of selected) {
    if (!enabledClients.includes(candidate)) {
      throw new HivemndError(
        "CONFIG_INVALID",
        `AI tool is not enabled for this organization: ${candidate}`,
      );
    }
  }
  return mergeWorkspaceDestinations(config, absolute, selected);
}

async function selectProfile(
  registry: OrganizationRegistry,
  requested: string | undefined,
  dependencies: CliContext["dependencies"],
): Promise<OrganizationProfile> {
  if (requested) {
    const selected = registry.profiles.find(
      (profile) => profile.alias === requested || profile.key === requested,
    );
    if (!selected)
      throw new HivemndError(
        "CONFIG_INVALID",
        `Unknown organization: ${requested}`,
      );
    return selected;
  }
  const onlyProfile = registry.profiles[0];
  if (registry.profiles.length === 1 && onlyProfile) return onlyProfile;
  if (registry.profiles.length === 0)
    throw new HivemndError(
      "CONFIG_INVALID",
      "No Hivemnd organization is configured; run hivemnd init",
    );
  if (!dependencies.prompt.interactive) {
    throw new HivemndError(
      "INTERACTIVE_REQUIRED",
      "Multiple Hivemnd organizations are available; pass --org <name>",
    );
  }
  for (;;) {
    const answer = await dependencies.prompt.input(
      `Organization (${registry.profiles.map((profile) => profile.alias).join(" / ")})`,
    );
    const selected = registry.profiles.find(
      (profile) => profile.alias === answer.trim(),
    );
    if (selected) return selected;
  }
}

async function detachOwnedFiles(
  context: CliContext,
  config: HivemndConfig,
  names: readonly string[],
): Promise<() => Promise<void>> {
  const adapters = context.dependencies.adapterFactory(config, names);
  const planned = await Promise.all(
    adapters.map(async (adapter) => {
      const entries = await adapter.readOwnership();
      const contextOwnership =
        await adapter.readContextInstructionOwnership?.();
      const instruction = contextOwnership
        ? await adapter.readInstruction?.()
        : undefined;
      const contents = new Map<string, Uint8Array>();
      for (const entry of entries) {
        const bytes = await adapter.read(entry.relativePath);
        if (bytes) contents.set(entry.relativePath, bytes);
      }
      return { adapter, entries, contents, contextOwnership, instruction };
    }),
  );
  for (const { adapter, entries, contents } of planned) {
    for (const entry of entries) {
      const bytes = contents.get(entry.relativePath);
      const actual = bytes
        ? createHash("sha256").update(bytes).digest("hex")
        : undefined;
      if (actual !== entry.sha256) {
        throw new HivemndError(
          "SYNC_CONFLICT",
          `Cannot reassign a workspace with missing or modified Hivemnd-owned content: ${adapter.destination(entry.relativePath)}`,
        );
      }
    }
  }
  const legacyChanges = await new AlwaysContextPlanner().plan(adapters);
  if (legacyChanges.some((change) => change.kind === "conflict")) {
    throw new HivemndError(
      "SYNC_CONFLICT",
      "Cannot disconnect a workspace with modified legacy always-context instructions",
    );
  }
  const rollback = async () => {
    for (const {
      adapter,
      entries,
      contents,
      contextOwnership,
      instruction,
    } of planned) {
      for (const entry of entries) {
        const content = contents.get(entry.relativePath);
        assertDefined(content, "Owned content disappeared during rollback");
        await adapter.write(entry.relativePath, content);
      }
      if (contextOwnership) {
        /* v8 ignore next -- ownership-capable adapters are validated to provide this writer */
        if (!adapter.writeInstruction) {
          throw new HivemndError(
            "SYNC_FAILED",
            "Legacy instruction writer disappeared during rollback",
          );
        }
        assertDefined(
          instruction,
          "Legacy instruction content disappeared during rollback",
        );
        await adapter.writeInstruction(instruction);
      }
      await adapter.replaceOwnership(entries, contextOwnership ?? null);
    }
  };
  try {
    for (const { adapter, entries } of planned) {
      for (const entry of entries) await adapter.remove(entry.relativePath);
    }
    const adaptersByName = new Map(
      adapters.map((adapter) => [adapter.name, adapter]),
    );
    for (const change of legacyChanges) {
      const adapter = adaptersByName.get(change.destinationName);
      assertDefined(adapter, "Legacy instruction adapter disappeared");
      if (change.content) await adapter.writeInstruction?.(change.content);
      else await adapter.removeInstruction?.();
    }
    for (const { adapter } of planned) await adapter.replaceOwnership([], null);
  } catch (error: unknown) {
    /* v8 ignore start -- injected filesystem failures are rolled back by this defensive boundary */
    await rollback();
    throw error;
    /* v8 ignore stop */
  }
  return rollback;
}

function workspaceDestinationNames(
  config: HivemndConfig,
  workspace: string,
): string[] {
  return config.destinations
    .filter(
      (destination) =>
        destination.scope === "workspace" && destination.path === workspace,
    )
    .map((destination) => destination.name);
}

function withoutWorkspace(
  config: HivemndConfig,
  workspace: string,
): HivemndConfig {
  return {
    ...config,
    destinations: config.destinations.filter(
      (destination) =>
        !(destination.scope === "workspace" && destination.path === workspace),
    ),
  };
}

function workspaceRemovalRegistrations(
  config: HivemndConfig,
  workspace: string,
  dependencies: CliContext["dependencies"],
): readonly CustomRegistrationInstallOperation[] {
  const operations: CustomRegistrationInstallOperation[] = [];
  const clients = new Set(
    config.destinations
      .filter(
        (destination) =>
          destination.scope === "workspace" && destination.path === workspace,
      )
      .map((destination) => destination.agent),
  );
  for (const client of clients) {
    const definition = mcpServerDefinition({
      client,
      runtimeExecutablePath:
        dependencies.runtimeExecutablePath ?? process.execPath,
      cliScriptPath: dependencies.cliScriptPath ?? resolveCliScriptArgument(),
      stateDirectory: dependencies.environment.HIVEMND_HOME,
    });
    const target = hostRegistration({
      client,
      scope: "workspace",
      homeDirectory: dependencies.homeDirectory,
      workspace,
    });
    operations.push({
      snapshot: () => target.registration.snapshot(),
      install: () => target.registration.remove(target.scope, definition),
      restore: (snapshot) => target.registration.restore(snapshot as never),
    });
    const hookDefinition = hookLauncherDefinition({
      client,
      scope: "workspace",
      workspace,
      runtimeExecutablePath:
        dependencies.runtimeExecutablePath ?? process.execPath,
      cliScriptPath: dependencies.cliScriptPath ?? resolveCliScriptArgument(),
      stateDirectory: managedHookStateDirectory(
        dependencies.environment,
        dependencies.homeDirectory,
      ),
    });
    const hook = hostHookRegistration({
      client,
      scope: "workspace",
      homeDirectory: dependencies.homeDirectory,
      workspace,
    });
    operations.push({
      snapshot: () => hook.snapshot(),
      install: () => hook.remove(hookDefinition),
      restore: (snapshot) => hook.restore(snapshot as never),
    });
  }
  return operations;
}

function previewRemoval(
  workspace: string,
  organization: string | undefined,
  dependencies: CliContext["dependencies"],
): void {
  dependencies.output.write("Preview");
  dependencies.output.write(`Workspace: ${workspace}`);
  if (organization) dependencies.output.write(`Organization: ${organization}`);
  dependencies.output.write(
    "Hivemnd-owned files and host registrations: remove",
  );
}

async function confirmRemoval(
  apply: boolean,
  dependencies: CliContext["dependencies"],
): Promise<boolean> {
  if (apply) return true;
  if (!dependencies.prompt.interactive) {
    throw new HivemndError(
      "INTERACTIVE_REQUIRED",
      "Pass --apply to disconnect this workspace",
    );
  }
  if (await dependencies.prompt.confirm("Disconnect this workspace?", false)) {
    return true;
  }
  dependencies.output.write("No changes applied.");
  return false;
}

function resolveCliScriptArgument(): string {
  const value = process.argv[1];
  assertDefined(value, "Cannot resolve the installed Hivemnd CLI script");
  return resolve(value);
}

async function reportSchedule(
  context: CliContext,
  config: HivemndConfig,
  configPath: string,
  workspace: string,
): Promise<void> {
  context.dependencies.output.write(`Workspace configured: ${workspace}`);
  const schedule = context.dependencies.scheduleManagerFactory({
    apiUrl: config.apiUrl,
    configPath,
  });
  const state = await schedule.status();
  context.dependencies.output.write(
    state.installed && state.active
      ? "Automatic sync will include this workspace."
      : `Run hivemnd sync --apply ${shellQuote(workspace)}`,
  );
}

function parseClient(value: string): AgentKind {
  const client = agentKinds.find((candidate) => candidate === value);
  if (!client)
    throw new HivemndError("CONFIG_INVALID", `Unknown AI tool: ${value}`);
  return client;
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function explicitConfig(
  program: Command,
  environment: NodeJS.ProcessEnv,
): boolean {
  return (
    program.getOptionValueSource("config") === "cli" ||
    environment.HIVEMND_CONFIG !== undefined
  );
}
