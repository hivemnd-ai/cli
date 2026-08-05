import { randomUUID } from "node:crypto";
import { lstat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { ConfigRepository } from "../config.js";
import { createFilesystemAdapters } from "../agents/destinations.js";
import { OrganizationRegistryRepository } from "../organizations/registry.js";
import { sha256 } from "../sync/hash.js";
import { UsageReceiptOutbox } from "../usage/receipt-outbox.js";
import { selectEffectiveProfile } from "./injector.js";

const MAX_INPUT_BYTES = 64 * 1024;
const inputSchema = z.object({
  hook_event_name: z.literal("UserPromptExpansion"),
  session_id: z.string().min(1).max(512),
  transcript_path: z.string().min(1).max(4096),
  cwd: z.string().min(1).max(4096),
  permission_mode: z.string().min(1).max(128),
  expansion_type: z.string().max(64),
  command_name: z.string().min(1).max(128),
  command_args: z.string().max(MAX_INPUT_BYTES),
  command_source: z.string().min(1).max(128),
  prompt: z.string().max(MAX_INPUT_BYTES),
});
type SkillActivationInput = z.infer<typeof inputSchema>;

interface ResolvedManagedSkill {
  readonly apiUrl: string;
  readonly installationId: string;
  readonly item: {
    readonly artifactId: string;
    readonly artifactVersionId: string;
    readonly artifactKind: "skill";
  };
}

type SkillResolutionFailure = "unmanaged" | "ambiguous" | "modified";

export interface SkillActivationOptions {
  readonly scope: "global" | "workspace";
  readonly workspace?: string;
  readonly stateDirectory: string;
  readonly homeDirectory: string;
  readonly enterprisePolicyPaths?: readonly string[];
  readonly input: string;
}

export type SkillActivationResult =
  | "staged"
  | "unsupported"
  | "unmanaged"
  | "ambiguous"
  | "modified"
  | "plugin_override"
  | "enterprise_override"
  | "staging_failed";

export async function stageClaudeSkillActivation(
  options: SkillActivationOptions,
): Promise<SkillActivationResult> {
  if (Buffer.byteLength(options.input) > MAX_INPUT_BYTES) return "unsupported";
  let input: SkillActivationInput;
  try {
    input = inputSchema.parse(JSON.parse(options.input) as unknown);
  } catch {
    return "unsupported";
  }
  if (input.expansion_type !== "slash_command") return "unsupported";
  if (input.command_source === "plugin") return "plugin_override";
  if (input.command_source !== "custom") return "unsupported";
  if (!isAbsolute(input.cwd)) return "unsupported";
  const slug = input.command_name.replace(/^\//, "");
  if (slug.includes(":")) return "plugin_override";
  if (!/^[a-z0-9][a-z0-9._-]{0,62}$/.test(slug)) return "unmanaged";
  if (
    await enterprisePolicyPresent(
      options.enterprisePolicyPaths ??
        claudeEnterprisePolicyPaths(process.platform, process.env),
    )
  ) {
    return "enterprise_override";
  }
  let resolvedSkill: ResolvedManagedSkill | SkillResolutionFailure;
  try {
    resolvedSkill = await resolveManagedSkill(input, slug, options);
  } catch {
    return "ambiguous";
  }
  if (typeof resolvedSkill === "string") return resolvedSkill;
  const { apiUrl, installationId, item } = resolvedSkill;
  try {
    await new UsageReceiptOutbox({
      stateDirectory: options.stateDirectory,
      apiUrl,
      installationId,
    }).stage({
      eventId: randomUUID(),
      eventKind: "skill_activated",
      agentHost: "claude",
      observedAt: new Date().toISOString(),
      items: [item],
    });
  } catch {
    return "staging_failed";
  }
  return "staged";
}

async function resolveManagedSkill(
  input: SkillActivationInput,
  slug: string,
  options: SkillActivationOptions,
): Promise<ResolvedManagedSkill | SkillResolutionFailure> {
  const configs = new ConfigRepository(input.cwd);
  const registry = await new OrganizationRegistryRepository(
    options.stateDirectory,
    configs,
  ).load();
  const profile = selectEffectiveProfile(
    registry,
    {
      client: "claude",
      scope: options.scope,
      ...(options.workspace ? { workspace: options.workspace } : {}),
    },
    input.cwd,
  );
  /* v8 ignore next -- no effective binding is an unavailable-coverage result */
  if (!profile) return "unmanaged";
  const config = await configs.load(profile.configPath);
  /* v8 ignore next -- pre-receipt installations cannot stage Skill evidence */
  if (!config.installationId) return "unmanaged";
  const destinations = config.destinations.filter(
    (destination) =>
      destination.agent === "claude" && destination.scope !== "directory",
  );
  const root = destinations.filter(
    (destination) => destination.scope === "root",
  );
  const workspaceCandidates = destinations.filter(
    (destination) =>
      destination.scope === "workspace" &&
      destination.path &&
      within(destination.path, input.cwd),
  );
  const maximumWorkspaceLength = Math.max(
    0,
    ...workspaceCandidates.map(
      (destination) => resolve(String(destination.path)).length,
    ),
  );
  const workspace = workspaceCandidates.filter(
    (destination) =>
      resolve(String(destination.path)).length === maximumWorkspaceLength,
  );
  let item:
    | {
        artifactId: string;
        artifactVersionId: string;
        artifactKind: "skill";
      }
    | undefined;
  for (const level of [root, workspace]) {
    if (level.length === 0) continue;
    const adapters = createFilesystemAdapters(
      { ...config, destinations: level },
      [],
      resolve(options.homeDirectory),
      resolve(options.stateDirectory),
    );
    const candidates: {
      artifactId: string;
      artifactVersionId: string;
      artifactKind: "skill";
    }[] = [];
    for (const adapter of adapters) {
      const relativePath = `skills/${slug}/SKILL.md`;
      const owned = (await adapter.readOwnership()).find(
        (entry) => entry.relativePath === relativePath,
      );
      let content: Uint8Array | undefined;
      try {
        content = await adapter.read(relativePath);
      } catch {
        return "modified";
      }
      if (!owned && content) return "unmanaged";
      if (!owned) continue;
      if (!content || sha256(content) !== owned.sha256) return "modified";
      candidates.push({
        artifactId: owned.logicalId,
        artifactVersionId: owned.artifactVersionId,
        artifactKind: "skill",
      });
    }
    const unique = new Map(
      candidates.map((candidate) => [
        `${candidate.artifactId}:${candidate.artifactVersionId}`,
        candidate,
      ]),
    );
    /* v8 ignore next -- multiple exact candidates at one precedence fail closed */
    if (unique.size > 1) return "ambiguous";
    item = unique.values().next().value;
    if (item) break;
  }
  if (!item) return "unmanaged";
  return {
    apiUrl: profile.apiUrl,
    installationId: config.installationId,
    item,
  };
}

function within(parent: string, child: string): boolean {
  const fromParent = relative(resolve(parent), resolve(child));
  return (
    fromParent === "" ||
    (fromParent !== ".." && !fromParent.startsWith(`..${sep}`))
  );
}

async function enterprisePolicyPresent(
  paths: readonly string[],
): Promise<boolean> {
  for (const path of paths) {
    try {
      await lstat(path);
      return true;
    } catch (error: unknown) {
      if (!isMissing(error)) return true;
    }
  }
  return false;
}

export function claudeEnterprisePolicyPaths(
  platform: NodeJS.Platform,
  environment: Readonly<NodeJS.ProcessEnv>,
): readonly string[] {
  if (platform === "darwin") {
    const root = "/Library/Application Support/ClaudeCode";
    return [
      join(root, "managed-settings.json"),
      join(root, "managed-settings.d"),
    ];
  }
  if (platform === "win32") {
    const programFiles = environment.ProgramFiles;
    if (!programFiles) return [];
    const root = join(programFiles, "ClaudeCode");
    return [
      join(root, "managed-settings.json"),
      join(root, "managed-settings.d"),
    ];
  }
  return [
    "/etc/claude-code/managed-settings.json",
    "/etc/claude-code/managed-settings.d",
  ];
}

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
