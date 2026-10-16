import { resolve } from "node:path";
import type { Command } from "commander";
import type { RuntimeDependencies } from "../runtime/dependencies.js";
import { previewAgentPlugin } from "../marketplace/agent-plugins.js";
import { previewClaudeMarketplace } from "../marketplace/claude-marketplace.js";
import { invalid } from "../marketplace/local-source.js";

export function registerMarketplaceCommands(
  program: Command,
  dependencies: RuntimeDependencies,
): void {
  program
    .command("marketplace")
    .description(
      "inspect local plugin sources without installing or executing them",
    )
    .command("preview")
    .argument("<directory>", "local Git checkout or package directory")
    .requiredOption("--format <format>", "agent-plugins or claude-marketplace")
    .action(async (directory: string, options: { format: string }) => {
      const importer =
        options.format === "agent-plugins"
          ? previewAgentPlugin
          : options.format === "claude-marketplace"
            ? previewClaudeMarketplace
            : undefined;
      if (!importer)
        invalid("Choose format agent-plugins or claude-marketplace");
      const result = await importer(resolve(dependencies.cwd, directory));
      // Raw manifests and declarations may contain private material; never print them.
      dependencies.output.write(
        JSON.stringify(
          {
            format: result.format,
            commitSha: result.source.commitSha,
            dirty: result.source.dirty,
            manifests: result.manifests.map(({ path, sha256 }) => ({
              path,
              sha256,
            })),
            plugins: result.plugins.map(
              ({ name, status, capabilities, skills }) => ({
                name,
                status,
                capabilities,
                skillCount: skills.length,
              }),
            ),
            warnings: result.warnings,
          },
          null,
          2,
        ),
      );
    });
}
