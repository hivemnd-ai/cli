import type { Readable, Writable } from "node:stream";
import type {
  AgentKind,
  HivemndConfig,
  Output,
  TokenStore,
} from "../domain.js";
import { HivemndError } from "../errors.js";
import { McpHttpProxy, runStdioProxy } from "./proxy.js";
import type { RegistrationState } from "./registration.js";

export interface ResolvedMcpOrganization {
  readonly key: string;
  readonly name: string;
  readonly slug: string;
  readonly config: HivemndConfig;
  readonly configPath: string;
}

export interface McpOrganizationResolver {
  resolve(options: {
    readonly client: AgentKind;
    readonly cwd: string;
    readonly org?: string;
    readonly workspace?: string;
  }): Promise<ResolvedMcpOrganization>;
}

export interface McpServeOptions {
  readonly client: AgentKind;
  readonly org?: string;
  readonly workspace?: string;
}

export interface McpCommandDependencies {
  readonly cwd: string;
  readonly resolver: McpOrganizationResolver;
  readonly tokenStoreFactory: (config: HivemndConfig) => TokenStore;
  readonly input: Readable;
  readonly protocolOutput: Writable;
  readonly diagnostics: Writable;
  readonly fetcher?: typeof fetch;
}

export interface McpStatusDependencies extends Omit<
  McpCommandDependencies,
  "input" | "protocolOutput" | "diagnostics"
> {
  readonly output: Output;
  readonly registrationState?: (
    options: McpServeOptions,
  ) => Promise<RegistrationState>;
}

export async function serveMcp(
  options: McpServeOptions,
  dependencies: McpCommandDependencies,
): Promise<void> {
  const organization = await dependencies.resolver.resolve(
    resolutionOptions(options, dependencies.cwd),
  );
  const token = await dependencies.tokenStoreFactory(organization.config).get();
  if (!token) {
    throw new HivemndError(
      "AUTH_MISSING",
      `No credential found for ${organization.name}; run hivemnd init`,
    );
  }
  await runStdioProxy(
    new McpHttpProxy({
      apiUrl: organization.config.apiUrl,
      token: token.value,
      ...(dependencies.fetcher ? { fetcher: dependencies.fetcher } : {}),
    }),
    {
      input: dependencies.input,
      output: dependencies.protocolOutput,
      diagnostics: dependencies.diagnostics,
    },
  );
}

export async function mcpStatus(
  options: McpServeOptions,
  dependencies: McpStatusDependencies,
): Promise<void> {
  const organization = await dependencies.resolver.resolve(
    resolutionOptions(options, dependencies.cwd),
  );
  const registration = dependencies.registrationState
    ? await dependencies.registrationState(options)
    : undefined;
  if (registration) dependencies.output.write(`Registration: ${registration}`);
  const token = await dependencies.tokenStoreFactory(organization.config).get();
  if (!token) {
    dependencies.output.write(
      `Organization: ${organization.name} (${organization.key})`,
    );
    dependencies.output.write("Reachability: credential missing");
    return;
  }
  const proxy = new McpHttpProxy({
    apiUrl: organization.config.apiUrl,
    token: token.value,
    ...(dependencies.fetcher ? { fetcher: dependencies.fetcher } : {}),
  });
  await proxy.forward({
    jsonrpc: "2.0",
    id: "hivemnd-status",
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "hivemnd-cli", version: "status" },
    },
  });
  dependencies.output.write(
    `Organization: ${organization.name} (${organization.key})`,
  );
  dependencies.output.write("Reachability: available");
}

function resolutionOptions(
  options: McpServeOptions,
  cwd: string,
): {
  readonly client: AgentKind;
  readonly cwd: string;
  readonly org?: string;
  readonly workspace?: string;
} {
  return {
    client: options.client,
    cwd,
    ...(options.org ? { org: options.org } : {}),
    ...(options.workspace ? { workspace: options.workspace } : {}),
  };
}
