import type { Command } from "commander";
import { homedir } from "node:os";
import { resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import type { AgentKind } from "../domain.js";
import { HivemndError } from "../errors.js";
import type { RuntimeDependencies } from "../runtime/dependencies.js";
import {
  mcpStatus,
  serveMcp,
  type McpOrganizationResolver,
  type McpServeOptions,
} from "../mcp/command.js";
import { hostRegistration, mcpServerDefinition } from "../mcp/registration.js";

export interface McpCommandRuntime {
  readonly resolver: McpOrganizationResolver;
  readonly input?: Readable;
  readonly protocolOutput?: Writable;
  readonly diagnostics?: Writable;
  readonly homeDirectory?: string;
  readonly fetcher?: typeof fetch;
  readonly runtimeExecutablePath?: string;
  readonly cliScriptPath?: string;
}

type McpCliDependencies = Pick<
  RuntimeDependencies,
  "cwd" | "output" | "tokenStoreFactory"
> &
  Partial<Pick<RuntimeDependencies, "clientVersion" | "clientFeatures">> & {
    readonly environment?: NodeJS.ProcessEnv;
  };

export function registerMcpCommands(
  program: Command,
  dependencies: McpCliDependencies,
  runtime: McpCommandRuntime,
): void {
  const mcp = program
    .command("mcp")
    .description("connect local AI tools to the Hivemnd MCP server");

  mcp
    .command("serve")
    .description("run the stdio proxy used by Codex and Claude Code")
    .requiredOption("--client <name>", "AI tool: codex or claude")
    .option("--org <name>", "local organization key")
    .option("--workspace <path>", "workspace used to resolve the organization")
    .action(async (values: RawMcpOptions) => {
      await serveMcp(parseOptions(values, dependencies.cwd), {
        cwd: dependencies.cwd,
        resolver: runtime.resolver,
        tokenStoreFactory: dependencies.tokenStoreFactory,
        input: runtime.input ?? process.stdin,
        protocolOutput: runtime.protocolOutput ?? process.stdout,
        diagnostics: runtime.diagnostics ?? process.stderr,
        ...(dependencies.clientVersion
          ? { clientVersion: dependencies.clientVersion }
          : {}),
        ...(dependencies.clientFeatures
          ? { clientFeatures: dependencies.clientFeatures }
          : {}),
        ...(runtime.fetcher ? { fetcher: runtime.fetcher } : {}),
      });
    });

  mcp
    .command("status")
    .description("check registration and tenant MCP reachability")
    .requiredOption("--client <name>", "AI tool: codex or claude")
    .option("--org <name>", "local organization key")
    .option("--workspace <path>", "workspace used to resolve the organization")
    .option(
      "--scope <scope>",
      "registration scope: global, workspace, or project",
    )
    .action(async (values: RawMcpOptions & { scope?: string }) => {
      const options = parseOptions(values, dependencies.cwd);
      const scope = parseScope(values.scope, options.workspace);
      const target = hostRegistration({
        client: options.client,
        scope,
        homeDirectory: runtime.homeDirectory ?? homedir(),
        ...(options.workspace ? { workspace: options.workspace } : {}),
      });
      const definition = mcpServerDefinition({
        client: options.client,
        runtimeExecutablePath:
          runtime.runtimeExecutablePath ?? process.execPath,
        cliScriptPath:
          runtime.cliScriptPath ?? resolve(process.argv[1] ?? "hivemnd"),
        ...(dependencies.environment?.HIVEMND_HOME
          ? { stateDirectory: dependencies.environment.HIVEMND_HOME }
          : {}),
      });
      await mcpStatus(options, {
        cwd: dependencies.cwd,
        resolver: runtime.resolver,
        tokenStoreFactory: dependencies.tokenStoreFactory,
        output: dependencies.output,
        ...(dependencies.clientVersion
          ? { clientVersion: dependencies.clientVersion }
          : {}),
        ...(dependencies.clientFeatures
          ? { clientFeatures: dependencies.clientFeatures }
          : {}),
        registrationState: () =>
          target.registration.status(target.scope, definition),
        ...(runtime.fetcher ? { fetcher: runtime.fetcher } : {}),
      });
    });
}

interface RawMcpOptions {
  readonly client: string;
  readonly org?: string;
  readonly workspace?: string;
}

function parseOptions(values: RawMcpOptions, cwd: string): McpServeOptions {
  const client = parseClient(values.client);
  return {
    client,
    ...(values.org ? { org: values.org } : {}),
    ...(values.workspace ? { workspace: resolve(cwd, values.workspace) } : {}),
  };
}

function parseClient(value: string): AgentKind {
  if (value === "codex" || value === "claude") return value;
  throw new HivemndError(
    "CONFIG_INVALID",
    `Unknown AI tool: ${value}; expected codex or claude`,
  );
}

function parseScope(
  value: string | undefined,
  workspace: string | undefined,
): "global" | "workspace" | "project" {
  const scope = value ?? (workspace ? "workspace" : "global");
  if (scope === "global" || scope === "workspace" || scope === "project") {
    if (scope !== "global" && !workspace) {
      throw new HivemndError(
        "CONFIG_INVALID",
        `MCP scope ${scope} requires --workspace <path>`,
      );
    }
    return scope;
  }
  throw new HivemndError("CONFIG_INVALID", `Unknown MCP scope: ${scope}`);
}
