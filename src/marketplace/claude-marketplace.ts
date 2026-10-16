import { join } from "node:path";
import { z } from "zod";
import { invalid, LocalSource } from "./local-source.js";
import type {
  MarketplacePreview,
  PluginPreview,
  PreviewLimits,
} from "./types.js";

const name = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
  .max(64);
const entrySchema = z
  .object({
    name,
    source: z.union([
      z.string(),
      z
        .object({
          source: z.enum([
            "github",
            "url",
            "git-subdir",
            "archive",
            "npm",
            "command",
          ]),
        })
        .loose(),
    ]),
  })
  .loose();
const catalogSchema = z.object({
  name,
  owner: z.object({ name: z.string().min(1) }),
  plugins: z.array(entrySchema),
});

/** Parse a catalog separately; remote/command sources remain opaque and unresolved. */
export async function previewClaudeMarketplace(
  root: string,
  limits: Partial<PreviewLimits> = {},
): Promise<MarketplacePreview> {
  const local = await LocalSource.create(root, limits);
  const raw = await local.json(".claude-plugin/marketplace.json");
  const catalog = catalogSchema.safeParse(raw);
  if (!catalog.success) invalid("Invalid Claude marketplace manifest");
  if (catalog.data.plugins.length > local.limits.maxPlugins)
    invalid("Plugin entry limit exceeded");
  const ids = new Set<string>();
  const plugins: PluginPreview[] = [];
  const files = [".claude-plugin/marketplace.json"];
  const skillRoots: string[] = [];
  for (const entry of catalog.data.plugins) {
    if (ids.has(entry.name))
      invalid("Duplicate Claude marketplace plugin name");
    ids.add(entry.name);
    if (typeof entry.source !== "string") {
      plugins.push({
        name: entry.name,
        source: entry.source,
        status: "unresolved",
        capabilities: [],
        declarations: {},
        skills: [],
      });
      continue;
    }
    if (!entry.source.startsWith("./"))
      invalid("Local plugin source must be a ./ path");
    const directory = local.relativePath(entry.source);
    if ((await local.kind(entry.source)) !== "directory")
      invalid("Local plugin source path must exist as a directory");
    const manifestPath = join(directory, ".claude-plugin/plugin.json");
    files.push(
      manifestPath,
      join(directory, "hooks/hooks.json"),
      join(directory, ".mcp.json"),
    );
    skillRoots.push(join(directory, "skills"));
    let packageManifest: Record<string, unknown> = {};
    if ((await local.kind(manifestPath)) !== "missing")
      packageManifest = await local.json(manifestPath);
    if (
      packageManifest.name !== undefined &&
      packageManifest.name !== entry.name
    )
      invalid("Claude entry and package manifest names differ");
    const declarations: Record<string, unknown> = {};
    for (const field of ["permissions", "allowedTools"]) {
      if (field in entry || field in packageManifest)
        declarations[field] = {
          ...(field in entry ? { catalog: entry[field] } : {}),
          ...(field in packageManifest
            ? { plugin: packageManifest[field] }
            : {}),
        };
    }
    const skills = await local.skills(directory || ".");
    const capabilities: string[] = skills.length ? ["skills"] : [];
    for (const [field, path, capability] of [
      ["hooks", "hooks/hooks.json", "hooks-configuration"],
      ["mcpServers", ".mcp.json", "mcp-configuration"],
    ] as const) {
      const componentPath = join(directory, path);
      if ((await local.kind(componentPath)) === "file") {
        await local.json(componentPath);
        capabilities.push(capability);
      } else if (field in entry || field in packageManifest)
        capabilities.push(capability);
    }
    plugins.push({
      name: entry.name,
      source: entry.source,
      status: "local-inventory",
      skills,
      capabilities,
      declarations,
    });
  }
  await local.verifyInventory(files, skillRoots);
  return {
    format: "claude-marketplace",
    source: local.source,
    manifests: local.manifests,
    plugins,
    warnings: local.warnings,
  };
}
