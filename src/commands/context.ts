import type { Command } from "commander";
import { isAbsolute } from "node:path";
import type { AgentKind } from "../domain.js";
import { HivemndError } from "../errors.js";
import type { RuntimeDependencies } from "../runtime/dependencies.js";
import { injectAlwaysContext } from "../context/injector.js";

interface ContextInjectOptions {
  readonly client: string;
  readonly stateDirectory: string;
  readonly scope: string;
  readonly workspace?: string;
  readonly hivemndManagedHook: string;
}

export function registerContextCommands(
  program: Command,
  dependencies: RuntimeDependencies,
): void {
  const context = program
    .command("context")
    .description("serve verified local session context")
    .helpOption(false);
  context
    .command("inject")
    .requiredOption("--client <name>", "Codex or Claude Code host")
    .requiredOption("--state-directory <path>", "Hivemnd state directory")
    .requiredOption("--scope <scope>", "global or workspace hook scope")
    .option("--workspace <path>", "canonical workspace path")
    .requiredOption("--hivemnd-managed-hook <version>")
    .action(async (options: ContextInjectOptions) => {
      if (options.hivemndManagedHook !== "1") {
        throw new HivemndError(
          "CONFIG_INVALID",
          "Unsupported Hivemnd SessionStart hook version",
        );
      }
      const client = parseClient(options.client);
      const scope = parseScope(options.scope);
      if (!isAbsolute(options.stateDirectory)) {
        throw new HivemndError(
          "CONFIG_INVALID",
          "--state-directory must be absolute",
        );
      }
      const result = await injectAlwaysContext({
        client,
        scope,
        ...(options.workspace ? { workspace: options.workspace } : {}),
        stateDirectory: options.stateDirectory,
        input: await dependencies.readHookInput(),
      });
      if (result) dependencies.output.write(result);
    });
}

function parseScope(value: string): "global" | "workspace" {
  if (value === "global" || value === "workspace") return value;
  throw new HivemndError("CONFIG_INVALID", `Unknown hook scope: ${value}`);
}

function parseClient(value: string): AgentKind {
  if (value === "codex" || value === "claude") return value;
  throw new HivemndError("CONFIG_INVALID", `Unknown AI tool: ${value}`);
}
