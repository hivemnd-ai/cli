import { z } from "zod";
import { invalid, LocalSource } from "./local-source.js";
import type { MarketplacePreview, PreviewLimits } from "./types.js";

const fields = [
  "$schema",
  "name",
  "version",
  "description",
  "author",
  "homepage",
  "repository",
  "license",
  "keywords",
  "extensions",
];
const manifestSchema = z.object({
  $schema: z.literal(
    "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
  ),
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/)
    .refine((name) => !name.includes("--") && !name.includes("..")),
  version: z.string().optional(),
  description: z.string().optional(),
  author: z
    .object({
      name: z.string().optional(),
      email: z.string().optional(),
      url: z.string().optional(),
    })
    .strict()
    .optional(),
  homepage: z.string().optional(),
  repository: z.string().optional(),
  license: z.string().optional(),
  keywords: z.array(z.string()).optional(),
});

/** Inventory a v1 package, never a Claude marketplace or installer. */
export async function previewAgentPlugin(
  root: string,
  limits: Partial<PreviewLimits> = {},
): Promise<MarketplacePreview> {
  const local = await LocalSource.create(root, limits);
  const raw = await local.json("plugin.json");
  const manifest = manifestSchema.safeParse(raw);
  if (!manifest.success)
    invalid("Invalid or unsupported Agent Plugins v1 manifest");
  for (const key of Object.keys(raw))
    if (!fields.includes(key))
      local.warnings.push("Ignored unknown Agent Plugins manifest field.");
  const declarations: Record<string, unknown> = {};
  if (raw.extensions !== undefined) {
    if (
      raw.extensions !== null &&
      typeof raw.extensions === "object" &&
      !Array.isArray(raw.extensions)
    )
      declarations.extensions = raw.extensions;
    else local.warnings.push("Ignored invalid Agent Plugins extensions field.");
  }
  const skills = await local.skills(".");
  const capabilities: string[] = skills.length ? ["skills"] : [];
  const mcpKind = await local.kind("mcp.json");
  if (mcpKind === "file") {
    await local.json("mcp.json");
    capabilities.push("mcp-configuration");
  } else if (mcpKind !== "missing")
    local.warnings.push("Ignored MCP location: expected a regular file.");
  await local.verifyInventory(["plugin.json", "mcp.json"], ["skills"]);
  return {
    format: "agent-plugins-v1",
    source: local.source,
    manifests: local.manifests,
    plugins: [
      {
        name: manifest.data.name,
        source: ".",
        status: "local-inventory",
        skills,
        capabilities,
        declarations,
      },
    ],
    warnings: local.warnings,
  };
}
