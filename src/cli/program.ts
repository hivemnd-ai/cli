import { Command } from "commander";
import { homedir } from "node:os";
import { join } from "node:path";
import { registerLoginCommand } from "../commands/login.js";
import { registerConfigCommands } from "../commands/config.js";
import { registerDoctorCommand } from "../commands/doctor.js";
import { registerSourceCommands } from "../commands/sources.js";
import { registerStatusCommand } from "../commands/status.js";
import { registerSyncCommand } from "../commands/sync.js";
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
    .description("Synchronize governed Hivemnd artifacts with local AI agents")
    .option("-c, --config <path>", "configuration file", defaultConfig)
    .showHelpAfterError()
    .exitOverride();
  const context = createCliContext(
    dependencies,
    () => program.opts<{ config: string }>().config,
  );

  registerConfigCommands(program, context);
  registerLoginCommand(program, context);
  registerStatusCommand(program, context);
  registerDoctorCommand(program, context);
  registerSyncCommand(program, context);
  registerSourceCommands(program, context);

  return program;
}
