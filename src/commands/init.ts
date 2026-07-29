import type { Command } from "commander";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import type { CliContext } from "../cli/context.js";
import { createCliContext } from "../cli/context.js";
import type { AgentAdapter, AgentKind, HivemndConfig } from "../domain.js";
import { createHash } from "node:crypto";
import { assertDefined, HivemndError } from "../errors.js";
import { parseActivationUrl } from "../auth/activation-url.js";
import { organizationAlias, profileKey } from "../organizations/registry.js";
import { organizationRegistry } from "../organizations/runtime.js";
import type {
  OrganizationProfile,
  OrganizationRegistry,
} from "../organizations/types.js";
import { tenantBaseUrl } from "../tenant-url.js";
import {
  hostRegistration,
  mcpServerDefinition,
  RegistrationTransaction,
  type RegistrationInstallOperation,
} from "../mcp/registration.js";
import { initialize } from "../workflows/initialize.js";
import { synchronize } from "../workflows/synchronize.js";
import {
  hookInstallOperation,
  hookLauncherDefinition,
  hostHookRegistration,
  managedHookStateDirectory,
} from "../hooks/registration.js";

interface InitCommandOptions {
  readonly activationUrl?: string;
  readonly client: readonly string[];
  readonly scope: readonly string[];
  readonly workspace: readonly string[];
  readonly automaticSync?: "install" | "skip";
  readonly adoptExisting: boolean;
  readonly apply: boolean;
  readonly org?: string;
  readonly replaceGlobal: boolean;
}

export function registerInitCommand(
  program: Command,
  context: CliContext,
): void {
  program
    .command("init")
    .description("interactively connect Hivemnd and configure AI tools")
    .option("--activation-url <url>", "portal activation URL")
    .option("--org <name>", "local organization name")
    .option(
      "--replace-global",
      "replace an existing global organization for the selected AI tool",
      false,
    )
    .option(
      "--client <name>",
      "enabled AI tool to configure (repeatable)",
      collect,
      [],
    )
    .option(
      "--scope <client=scope>",
      "global, workspace, or skip (repeatable)",
      collect,
      [],
    )
    .option("--workspace <path>", "workspace folder (repeatable)", collect, [])
    .option("--automatic-sync <choice>", "install or skip", automaticSync)
    .option(
      "--adopt-existing",
      "adopt identical unmanaged files on first sync",
      false,
    )
    .option("--apply", "apply the complete onboarding preview", false)
    .action(async (options: InitCommandOptions) => {
      const { dependencies } = context;
      const configPath = program.opts<{ config: string }>().config;
      const activationUrl =
        options.activationUrl ??
        dependencies.environment.HIVEMND_ACTIVATION_URL;
      const suppliedActivation =
        activationUrl ??
        (dependencies.prompt.interactive
          ? dependencies.prompt.secret
            ? await dependencies.prompt.secret("Activation URL")
            : await dependencies.prompt.input("Activation URL")
          : undefined);
      const explicit =
        program.getOptionValueSource("config") === "cli" ||
        dependencies.environment.HIVEMND_CONFIG !== undefined;
      if (explicit && (options.org ?? program.opts<{ org?: string }>().org)) {
        throw new HivemndError(
          "CONFIG_INVALID",
          "Use either --config or --org, not both",
        );
      }
      if (!explicit && suppliedActivation) {
        await initializeOrganization(
          program,
          context,
          options,
          suppliedActivation,
        );
        return;
      }
      await initialize(
        {
          ...(suppliedActivation ? { activationUrl: suppliedActivation } : {}),
          clients: options.client,
          scopes: options.scope,
          workspaces: options.workspace,
          ...(options.automaticSync
            ? { automaticSync: options.automaticSync }
            : {}),
          apply: options.apply,
        },
        {
          cwd: dependencies.cwd,
          configPath,
          configRepository: dependencies.configRepositoryFactory(
            dependencies.cwd,
          ),
          tokenStoreFactory: dependencies.tokenStoreFactory,
          apiClientFactory: dependencies.apiClientFactory,
          scheduleManagerFactory: dependencies.scheduleManagerFactory,
          prompt: dependencies.prompt,
          output: dependencies.output,
          clientPlatform: dependencies.clientPlatform,
          clientVersion: dependencies.clientVersion,
          initialSync: () =>
            synchronize(
              {
                dryRun: false,
                apply: true,
                destination: [],
                adoptExisting: options.adoptExisting,
                all: true,
              },
              context,
            ),
        },
      );
    });
}

async function initializeOrganization(
  program: Command,
  context: CliContext,
  options: InitCommandOptions,
  activationUrl: string,
): Promise<void> {
  const { dependencies } = context;
  const activation = parseActivationUrl(activationUrl);
  const configs = dependencies.configRepositoryFactory(dependencies.cwd);
  const repository = organizationRegistry(dependencies);
  const legacyPath = program.opts<{ config: string }>().config;
  const registry = await repository.loadOrMigrate(legacyPath, true);
  const canonicalApiUrl = tenantBaseUrl(activation.apiUrl).href.replace(
    /\/$/,
    "",
  );
  const existing = registry.profiles.find(
    (profile) =>
      tenantBaseUrl(profile.apiUrl).href ===
      tenantBaseUrl(canonicalApiUrl).href,
  );
  const requestedAlias = options.org ?? program.opts<{ org?: string }>().org;
  const initialAlias = requestedAlias ?? organizationAlias("", canonicalApiUrl);
  const aliasOwner = registry.profiles.find(
    (profile) =>
      profile.alias === initialAlias && profile.key !== existing?.key,
  );
  if (aliasOwner) {
    throw new HivemndError(
      "CONFIG_INVALID",
      `Organization name is already used: ${initialAlias}; pass --org <unique-name>`,
    );
  }
  const candidate: OrganizationProfile = existing ?? {
    key: profileKey(canonicalApiUrl),
    alias: initialAlias,
    name: initialAlias,
    slug: initialAlias,
    apiUrl: canonicalApiUrl,
    configPath: repository.profileConfigPath(canonicalApiUrl),
  };
  let plannedRegistry: OrganizationRegistry = registry;
  let plannedRegistrations: readonly RegistrationInstallOperation[] = [];
  let displacedGlobals: readonly {
    readonly profile: OrganizationProfile;
    readonly client: AgentKind;
  }[] = [];
  const previousConfig = await configs.loadOptional(candidate.configPath);
  const explicitContext = createCliContext(dependencies, () => ({
    configPath: candidate.configPath,
    explicitConfig: true,
  }));

  await initialize(
    {
      activationUrl,
      clients: options.client,
      scopes: options.scope,
      workspaces: options.workspace,
      ...(options.automaticSync
        ? { automaticSync: options.automaticSync }
        : {}),
      apply: options.apply,
    },
    {
      cwd: dependencies.cwd,
      configPath: candidate.configPath,
      configRepository: configs,
      tokenStoreFactory: dependencies.tokenStoreFactory,
      apiClientFactory: dependencies.apiClientFactory,
      scheduleManagerFactory: dependencies.scheduleManagerFactory,
      prompt: dependencies.prompt,
      output: dependencies.output,
      clientPlatform: dependencies.clientPlatform,
      clientVersion: dependencies.clientVersion,
      validatePlan: async (next, configuration) => {
        const alias =
          requestedAlias ??
          organizationAlias(configuration.organization.slug, canonicalApiUrl);
        const conflict = registry.profiles.find(
          (profile) => profile.alias === alias && profile.key !== candidate.key,
        );
        if (conflict) {
          throw new HivemndError(
            "CONFIG_INVALID",
            `Organization name is already used: ${alias}; pass --org <unique-name>`,
          );
        }
        const profile: OrganizationProfile = {
          ...candidate,
          alias,
          name: configuration.organization.name,
          slug: configuration.organization.slug,
        };
        displacedGlobals = await globalReplacements(
          registry,
          profile,
          next,
          options.replaceGlobal,
          dependencies,
        );
        plannedRegistry = registryWithPlan(registry, profile, next);
      },
      previewDetails: (next) => {
        const plan = registrationPlan(next, dependencies);
        plannedRegistrations = plan.operations;
        for (const path of plan.paths) {
          dependencies.output.write(`MCP registration: ${path}`);
        }
        return Promise.resolve();
      },
      commitConfiguration: async (next) => {
        const registryPlan = plannedRegistry;
        await repository.withLock(async () => {
          const rollbackOwned: (() => Promise<void>)[] = [];
          const displacedConfigs: {
            profile: OrganizationProfile;
            before: HivemndConfig;
          }[] = [];
          try {
            const currentRegistry = await repository.load();
            if (JSON.stringify(currentRegistry) !== JSON.stringify(registry)) {
              throw new HivemndError(
                "CONFIG_INVALID",
                "Organization configuration changed while onboarding was being prepared; run hivemnd init again",
              );
            }
            for (const displaced of displacedGlobals) {
              const before = await configs.load(displaced.profile.configPath);
              const names = before.destinations
                .filter(
                  (destination) =>
                    destination.scope === "root" &&
                    destination.agent === displaced.client,
                )
                .map(({ name }) => name);
              rollbackOwned.push(
                await detachDestinations(dependencies, before, names),
              );
              displacedConfigs.push({ profile: displaced.profile, before });
              await configs.create(
                displaced.profile.configPath,
                {
                  ...before,
                  destinations: before.destinations.filter(
                    (destination) =>
                      !(
                        destination.scope === "root" &&
                        destination.agent === displaced.client
                      ),
                  ),
                },
                true,
              );
            }
            await configs.create(
              candidate.configPath,
              next,
              previousConfig !== undefined,
            );
            await repository.save(registryPlan);
            await new RegistrationTransaction().install(plannedRegistrations);
          } catch (error: unknown) {
            if (previousConfig) {
              await configs.create(candidate.configPath, previousConfig, true);
            } else {
              await rm(candidate.configPath, { force: true });
            }
            for (const displaced of displacedConfigs) {
              await configs.create(
                displaced.profile.configPath,
                displaced.before,
                true,
              );
            }
            for (const rollback of rollbackOwned.reverse()) await rollback();
            await repository.save(registry);
            throw error;
          }
        });
      },
      initialSync: () =>
        synchronize(
          {
            dryRun: false,
            apply: true,
            destination: [],
            adoptExisting: options.adoptExisting,
            all: true,
          },
          explicitContext,
        ),
    },
  );
}

function registrationPlan(
  config: import("../domain.js").HivemndConfig,
  dependencies: CliContext["dependencies"],
): {
  readonly operations: readonly RegistrationInstallOperation[];
  readonly paths: readonly string[];
} {
  const homeDirectory = dependencies.homeDirectory;
  const seen = new Set<string>();
  const operations: RegistrationInstallOperation[] = [];
  const paths: string[] = [];
  for (const destination of config.destinations) {
    if (destination.scope === "directory") continue;
    const identity = `${destination.agent}\0${destination.scope}\0${destination.path ?? ""}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    const target = hostRegistration({
      client: destination.agent,
      scope: destination.scope === "root" ? "global" : "workspace",
      homeDirectory,
      ...(destination.path ? { workspace: destination.path } : {}),
    });
    operations.push({
      registration: target.registration,
      definition: mcpServerDefinition({
        client: destination.agent,
        runtimeExecutablePath:
          dependencies.runtimeExecutablePath ?? process.execPath,
        cliScriptPath: dependencies.cliScriptPath ?? resolveCliScriptArgument(),
        stateDirectory: dependencies.environment.HIVEMND_HOME,
      }),
      ...(target.scope ? { scope: target.scope } : {}),
    });
    paths.push(target.path);
    const hook = hostHookRegistration({
      client: destination.agent,
      scope: destination.scope === "root" ? "global" : "workspace",
      homeDirectory,
      ...(destination.path ? { workspace: destination.path } : {}),
    });
    operations.push(
      hookInstallOperation(
        hook,
        hookLauncherDefinition({
          client: destination.agent,
          scope: destination.scope === "root" ? "global" : "workspace",
          ...(destination.path ? { workspace: destination.path } : {}),
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

function registryWithPlan(
  registry: OrganizationRegistry,
  profile: OrganizationProfile,
  config: HivemndConfig,
): OrganizationRegistry {
  const profiles = registry.profiles.some(
    (candidate) => candidate.key === profile.key,
  )
    ? registry.profiles.map((candidate) =>
        candidate.key === profile.key ? profile : candidate,
      )
    : [...registry.profiles, profile];
  let globalBindings = [...registry.globalBindings];
  const workspaceBindings = [...registry.workspaceBindings];
  for (const destination of config.destinations) {
    if (destination.scope === "root") {
      const occupied = globalBindings.find(
        (binding) =>
          binding.client === destination.agent &&
          binding.organizationKey !== profile.key,
      );
      if (occupied) {
        globalBindings = globalBindings.map((binding) =>
          binding.client === destination.agent
            ? { ...binding, organizationKey: profile.key }
            : binding,
        );
      }
      if (
        !globalBindings.some((binding) => binding.client === destination.agent)
      ) {
        globalBindings.push({
          client: destination.agent,
          organizationKey: profile.key,
        });
      }
    }
    if (destination.scope === "workspace" && destination.path) {
      const path = resolve(destination.path);
      const occupied = workspaceBindings.find(
        (binding) =>
          binding.path === path && binding.organizationKey !== profile.key,
      );
      if (occupied) {
        const owner = registry.profiles.find(
          (candidate) => candidate.key === occupied.organizationKey,
        );
        assertDefined(owner, "Workspace binding has no organization profile");
        throw new HivemndError(
          "CONFIG_INVALID",
          `Workspace is already connected to ${owner.alias}: ${path}`,
        );
      }
      if (!workspaceBindings.some((binding) => binding.path === path)) {
        workspaceBindings.push({ path, organizationKey: profile.key });
      }
    }
  }
  return {
    version: 1,
    profiles,
    workspaceBindings,
    globalBindings,
  };
}

async function globalReplacements(
  registry: OrganizationRegistry,
  profile: OrganizationProfile,
  config: HivemndConfig,
  replaceGlobal: boolean,
  dependencies: CliContext["dependencies"],
): Promise<readonly { profile: OrganizationProfile; client: AgentKind }[]> {
  const replacements: {
    profile: OrganizationProfile;
    client: AgentKind;
  }[] = [];
  const requested = new Set(
    config.destinations
      .filter((destination) => destination.scope === "root")
      .map((destination) => destination.agent),
  );
  for (const client of requested) {
    const binding = registry.globalBindings.find(
      (candidate) =>
        candidate.client === client &&
        candidate.organizationKey !== profile.key,
    );
    if (!binding) continue;
    const owner = registry.profiles.find(
      (candidate) => candidate.key === binding.organizationKey,
    );
    assertDefined(owner, "Global binding has no organization profile");
    if (!replaceGlobal) {
      if (!dependencies.prompt.interactive) {
        throw new HivemndError(
          "INTERACTIVE_REQUIRED",
          `Pass --replace-global to replace ${client === "codex" ? "Codex" : "Claude Code"}'s global organization`,
        );
      }
      if (
        !(await dependencies.prompt.confirm(
          `${client === "codex" ? "Codex" : "Claude Code"} is globally connected to ${owner.name}. Switch its global organization to ${profile.name}?`,
          false,
        ))
      ) {
        throw new HivemndError(
          "CONFIG_INVALID",
          `Pass --replace-global to replace ${client === "codex" ? "Codex" : "Claude Code"}'s global organization`,
        );
      }
    }
    replacements.push({ profile: owner, client });
  }
  return replacements;
}

async function detachDestinations(
  dependencies: CliContext["dependencies"],
  config: HivemndConfig,
  names: readonly string[],
): Promise<() => Promise<void>> {
  const adapters = dependencies.adapterFactory(config, names);
  const planned = await Promise.all(
    adapters.map(async (adapter: AgentAdapter) => {
      const entries = await adapter.readOwnership();
      const contents = new Map<string, Uint8Array>();
      for (const entry of entries) {
        const bytes = await adapter.read(entry.relativePath);
        if (bytes) contents.set(entry.relativePath, bytes);
      }
      return { adapter, entries, contents };
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
          `Cannot replace a global organization with missing or modified Hivemnd-owned content: ${adapter.destination(entry.relativePath)}`,
        );
      }
    }
  }
  for (const { adapter, entries } of planned) {
    for (const entry of entries) await adapter.remove(entry.relativePath);
    await adapter.replaceOwnership([]);
  }
  return async () => {
    for (const { adapter, entries, contents } of planned) {
      for (const entry of entries) {
        const content = contents.get(entry.relativePath);
        assertDefined(content, "Owned content disappeared during rollback");
        await adapter.write(entry.relativePath, content);
      }
      await adapter.replaceOwnership(entries);
    }
  };
}

function resolveCliScriptArgument(): string {
  const value = process.argv[1];
  assertDefined(value, "Cannot resolve the installed Hivemnd CLI script");
  return resolve(value);
}

function automaticSync(value: string): "install" | "skip" {
  if (value === "install" || value === "skip") return value;
  throw new HivemndError(
    "CONFIG_INVALID",
    "--automatic-sync must be install or skip",
  );
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}
