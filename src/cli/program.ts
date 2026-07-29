import { Command } from "commander";
import { homedir } from "node:os";
import { join } from "node:path";
import { registerLoginCommand } from "../commands/login.js";
import { registerInitCommand } from "../commands/init.js";
import { registerConfigCommands } from "../commands/config.js";
import { registerDoctorCommand } from "../commands/doctor.js";
import { registerSourceCommands } from "../commands/sources.js";
import { registerStatusCommand } from "../commands/status.js";
import { registerSyncCommand } from "../commands/sync.js";
import { registerScheduleCommands } from "../commands/schedule.js";
import { registerUpdateCommand } from "../commands/update.js";
import { registerWorkspaceCommands } from "../commands/workspace.js";
import { registerOrganizationCommands } from "../commands/organizations.js";
import { registerMcpCommands } from "../commands/mcp.js";
import { registerContextCommands } from "../commands/context.js";
import { OrganizationRegistryRepository } from "../organizations/registry.js";
import { OrganizationResolver } from "../organizations/resolver.js";
import type { RuntimeDependencies } from "../runtime/dependencies.js";
import { createCliContext } from "./context.js";

export function createProgram(dependencies: RuntimeDependencies): Command {
  const stateDirectory =
    dependencies.environment.HIVEMND_HOME ?? join(homedir(), ".hivemnd");
  const defaultConfig =
    dependencies.environment.HIVEMND_CONFIG ??
    join(stateDirectory, "config.json");
  const program = new Command()
    .name("hivemnd")
    .description("Synchronize governed Hivemnd artifacts with local AI tools")
    .version(dependencies.clientVersion)
    .option("-c, --config <path>", "configuration file", defaultConfig)
    .option("--org <name>", "local Hivemnd organization name")
    .showHelpAfterError()
    .exitOverride();
  const context = createCliContext(dependencies, () => {
    const options = program.opts<{ config: string; org?: string }>();
    return {
      configPath: options.config,
      explicitConfig:
        program.getOptionValueSource("config") === "cli" ||
        dependencies.environment.HIVEMND_CONFIG !== undefined,
      ...(options.org ? { org: options.org } : {}),
    };
  });
  const organizationResolver = new OrganizationResolver({
    registry: {
      load: () => {
        const configs = dependencies.configRepositoryFactory(dependencies.cwd);
        return new OrganizationRegistryRepository(
          stateDirectory,
          configs,
        ).loadOrMigrate(defaultConfig, false);
      },
    },
    configs: {
      load: (path) =>
        dependencies.configRepositoryFactory(dependencies.cwd).load(path),
    },
  });

  registerInitCommand(program, context);
  registerConfigCommands(program, context);
  registerLoginCommand(program, context);
  registerStatusCommand(program, context);
  registerDoctorCommand(program, context);
  registerSyncCommand(program, context);
  registerSourceCommands(program, context);
  registerScheduleCommands(program, context);
  registerUpdateCommand(program, context);
  registerWorkspaceCommands(program, context);
  registerOrganizationCommands(program, context);
  registerMcpCommands(program, dependencies, {
    resolver: organizationResolver,
  });
  registerContextCommands(program, dependencies);

  return program;
}
