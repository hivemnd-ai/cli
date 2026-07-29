import { isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";
import type { AgentKind } from "../domain.js";
import { HivemndError } from "../errors.js";
import { OrganizationRegistryRepository } from "../organizations/registry.js";
import type {
  OrganizationProfile,
  OrganizationRegistry,
} from "../organizations/types.js";
import { ConfigRepository } from "../config.js";
import { AlwaysContextCache } from "./always-context-cache.js";

const MAX_HOOK_INPUT_BYTES = 64 * 1024;
const hookInputSchema = z.object({
  hook_event_name: z.literal("SessionStart"),
  source: z.enum(["startup", "resume", "clear", "compact"]),
  cwd: z.string().min(1),
  agent_id: z.string().min(1).optional(),
});

export interface AlwaysContextInjectionOptions {
  readonly client: AgentKind;
  readonly scope: "global" | "workspace";
  readonly workspace?: string;
  readonly stateDirectory: string;
  readonly input: string;
}

export async function injectAlwaysContext(
  options: AlwaysContextInjectionOptions,
): Promise<string> {
  if (!isAbsolute(options.stateDirectory)) {
    throw new HivemndError(
      "CONFIG_INVALID",
      "Always-context hook requires an absolute Hivemnd state directory",
    );
  }
  if (options.scope === "workspace" && !options.workspace) {
    throw new HivemndError(
      "CONFIG_INVALID",
      "Workspace SessionStart injection requires a workspace path",
    );
  }
  if (
    options.workspace &&
    (!isAbsolute(options.workspace) ||
      resolve(options.workspace) !== options.workspace)
  ) {
    throw new HivemndError(
      "CONFIG_INVALID",
      "SessionStart workspace path must be absolute and canonical",
    );
  }
  if (options.scope === "global" && options.workspace) {
    throw new HivemndError(
      "CONFIG_INVALID",
      "Global SessionStart injection cannot declare a workspace path",
    );
  }
  if (Buffer.byteLength(options.input) > MAX_HOOK_INPUT_BYTES) {
    throw new HivemndError(
      "CONFIG_INVALID",
      "SessionStart hook input is too large",
    );
  }
  let input: z.infer<typeof hookInputSchema>;
  try {
    input = hookInputSchema.parse(JSON.parse(options.input) as unknown);
  } catch (error: unknown) {
    throw new HivemndError(
      "CONFIG_INVALID",
      "Always-context injection accepts only a valid SessionStart payload",
      { cause: error },
    );
  }
  if (options.client === "claude" && input.agent_id) return "";
  if (!isAbsolute(input.cwd)) {
    throw new HivemndError(
      "CONFIG_INVALID",
      "SessionStart cwd must be an absolute path",
    );
  }
  const registry = await new OrganizationRegistryRepository(
    options.stateDirectory,
    new ConfigRepository(input.cwd),
  ).load();
  const profile = selectProfile(registry, options, input.cwd);
  if (!profile) return "";
  return new AlwaysContextCache({
    stateDirectory: options.stateDirectory,
    apiUrl: profile.apiUrl,
  }).read(options.client);
}

function selectProfile(
  registry: OrganizationRegistry,
  options: Pick<
    AlwaysContextInjectionOptions,
    "client" | "scope" | "workspace"
  >,
  cwd: string,
): OrganizationProfile | undefined {
  const candidates = registry.workspaceBindings.filter((binding) =>
    within(binding.path, cwd),
  );
  const workspace = [...candidates].sort(
    (left, right) => resolve(right.path).length - resolve(left.path).length,
  )[0];
  if (options.scope === "workspace") {
    if (!workspace || resolve(workspace.path) !== options.workspace)
      return undefined;
    return registry.profiles.find(
      (profile) => profile.key === workspace.organizationKey,
    );
  }
  if (workspace) return undefined;
  const global = registry.globalBindings.find(
    (binding) => binding.client === options.client,
  );
  const key = global?.organizationKey;
  return registry.profiles.find((profile) => profile.key === key);
}

function within(parent: string, child: string): boolean {
  const fromParent = relative(resolve(parent), resolve(child));
  return (
    fromParent === "" ||
    (fromParent !== ".." && !fromParent.startsWith(`..${sep}`))
  );
}
