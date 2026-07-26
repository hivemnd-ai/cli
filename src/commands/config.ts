import type { Command } from "commander";
import { resolve } from "node:path";
import {
  agentKinds,
  destinationScopes,
  type AgentKind,
  type DestinationScope,
} from "../domain.js";
import { HivemndError } from "../errors.js";
import type { CliContext } from "../cli/context.js";

interface ConfigInitOptions {
  readonly apiUrl: string;
  readonly force: boolean;
}

interface AddDestinationOptions {
  readonly agent: string;
  readonly scope: string;
  readonly path?: string;
}

export function registerConfigCommands(
  program: Command,
  context: CliContext,
): void {
  const config = program
    .command("config")
    .description("manage local configuration");
  config
    .command("init")
    .requiredOption("--api-url <url>", "customer Hivemnd URL")
    .option("--force", "replace an existing config", false)
    .action(async (options: ConfigInitOptions) => {
      const { dependencies } = context;
      const path = program.opts<{ config: string }>().config;
      await dependencies
        .configRepositoryFactory(dependencies.cwd)
        .create(
          path,
          { apiUrl: options.apiUrl, destinations: [] },
          options.force,
        );
      dependencies.output.write(`configured: ${path}`);
    });

  const destinations = config
    .command("destination")
    .description("manage named Codex and Claude installation destinations");
  destinations
    .command("add <name>")
    .requiredOption("--agent <agent>", "codex or claude")
    .requiredOption("--scope <scope>", "root, workspace, or directory")
    .option(
      "--path <path>",
      "workspace path or exact agent configuration directory",
    )
    .action(async (name: string, options: AddDestinationOptions) => {
      const agent = parseAgent(options.agent);
      const scope = parseScope(options.scope);
      if (scope === "root" && options.path) {
        throw new HivemndError(
          "CONFIG_INVALID",
          "A root destination uses the current user home and does not accept --path",
        );
      }
      if (scope !== "root" && !options.path) {
        throw new HivemndError(
          "CONFIG_INVALID",
          `${scope} destinations require --path`,
        );
      }
      const { dependencies } = context;
      const path = program.opts<{ config: string }>().config;
      await dependencies
        .configRepositoryFactory(dependencies.cwd)
        .addDestination(path, {
          name,
          agent,
          scope,
          ...(options.path
            ? { path: resolve(dependencies.cwd, options.path) }
            : {}),
        });
      dependencies.output.write(`destination added: ${name}`);
    });
  destinations.command("remove <name>").action(async (name: string) => {
    const { dependencies } = context;
    const path = program.opts<{ config: string }>().config;
    await dependencies
      .configRepositoryFactory(dependencies.cwd)
      .removeDestination(path, name);
    dependencies.output.write(`destination removed: ${name}`);
  });

  config.command("show").action(async () => {
    const loaded = await context.loadConfigured();
    context.dependencies.output.write(`api: ${loaded.apiUrl}`);
    for (const destination of loaded.destinations) {
      context.dependencies.output.write(
        [
          destination.name,
          destination.agent,
          destination.scope,
          destination.path,
        ]
          .filter((part) => part !== undefined)
          .join(" | "),
      );
    }
  });
}

function parseAgent(value: string): AgentKind {
  const agent = agentKinds.find((candidate) => candidate === value);
  if (!agent)
    throw new HivemndError("CONFIG_INVALID", `Unknown agent: ${value}`);
  return agent;
}

function parseScope(value: string): DestinationScope {
  const scope = destinationScopes.find((candidate) => candidate === value);
  if (!scope)
    throw new HivemndError("CONFIG_INVALID", `Unknown scope: ${value}`);
  return scope;
}
