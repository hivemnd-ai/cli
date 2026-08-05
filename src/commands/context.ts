import type { Command } from "commander";
import { isAbsolute } from "node:path";
import type { AgentKind } from "../domain.js";
import { HivemndError } from "../errors.js";
import type { RuntimeDependencies } from "../runtime/dependencies.js";
import { injectAlwaysContext } from "../context/injector.js";
import { cachedUpdateNotice } from "../context/update-notice.js";
import { stageClaudeSkillActivation } from "../context/skill-activation.js";

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
      /* v8 ignore next -- registration emits only supported owned markers */
      if (!["1", "2"].includes(options.hivemndManagedHook)) {
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
  context
    .command("update-notice")
    .requiredOption("--client <name>", "Codex or Claude Code host")
    .requiredOption("--state-directory <path>", "Hivemnd state directory")
    .requiredOption("--scope <scope>", "global or workspace hook scope")
    .option("--workspace <path>", "canonical workspace path")
    .requiredOption("--hivemnd-managed-hook <version>")
    .action(async (options: ContextInjectOptions) => {
      try {
        if (!["1", "2"].includes(options.hivemndManagedHook)) return;
        const result = await cachedUpdateNotice({
          client: parseClient(options.client),
          scope: parseScope(options.scope),
          ...(options.workspace ? { workspace: options.workspace } : {}),
          stateDirectory: options.stateDirectory,
          input: await dependencies.readHookInput(),
          updateService: dependencies.updateService,
        });
        if (result) dependencies.output.write(result);
      } catch {
        // Advisory hook failures must never change prompt submission.
      }
    });
  context
    .command("skill-activated")
    .requiredOption("--client <name>")
    .requiredOption("--state-directory <path>")
    .requiredOption("--scope <scope>")
    .option("--workspace <path>")
    .requiredOption("--hivemnd-managed-hook <version>")
    /* v8 ignore start -- thin Commander adapter; domain behavior is covered by integration tests */
    .action(async (options: ContextInjectOptions) => {
      if (
        options.client !== "claude" ||
        options.hivemndManagedHook !== "2" ||
        !isAbsolute(options.stateDirectory)
      ) {
        return;
      }
      const result = await stageClaudeSkillActivation({
        scope: parseScope(options.scope),
        ...(options.workspace ? { workspace: options.workspace } : {}),
        stateDirectory: options.stateDirectory,
        homeDirectory: dependencies.homeDirectory,
        input: await dependencies.readHookInput(),
      });
      if (result === "staging_failed") {
        throw new HivemndError(
          "SKILL_RECEIPT_REQUIRED",
          "Claude Skill receipt staging failed",
        );
      }
      if (result !== "staged") {
        dependencies.output.error(
          `Claude Skill receipt unavailable: ${result}`,
        );
      }
    });
  /* v8 ignore stop */
}

function parseScope(value: string): "global" | "workspace" {
  if (value === "global" || value === "workspace") return value;
  throw new HivemndError("CONFIG_INVALID", `Unknown hook scope: ${value}`);
}

function parseClient(value: string): AgentKind {
  if (value === "codex" || value === "claude") return value;
  throw new HivemndError("CONFIG_INVALID", `Unknown AI tool: ${value}`);
}
