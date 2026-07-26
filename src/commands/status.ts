import type { Command } from "commander";
import type { CliContext } from "../cli/context.js";

export function registerStatusCommand(
  program: Command,
  context: CliContext,
): void {
  program
    .command("status")
    .description("show authentication and currently authorized release")
    .action(async () => {
      const { config, token, client } = await context.bootstrap();
      const manifest = await client.manifest(token.value);
      context.dependencies.output.write(
        `ready: release ${manifest.release.id} (${manifest.artifacts.length} artifact(s)); token source: ${token.source}; ${config.destinations.length} destination(s)`,
      );
    });
}
