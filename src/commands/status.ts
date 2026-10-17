import type { Command } from "commander";
import type { CliContext } from "../cli/context.js";
import { HttpApiError } from "../errors.js";

export function registerStatusCommand(
  program: Command,
  context: CliContext,
): void {
  program
    .command("status")
    .description("show authentication and currently authorized release")
    .action(async () => {
      const { config, token, client } = await context.bootstrap();
      await client.clientConfiguration(token.value);
      let manifest;
      try {
        manifest = await client.manifest(token.value);
      } catch (error: unknown) {
        if (!(error instanceof HttpApiError) || error.status !== 404)
          throw error;
        context.dependencies.output.write(
          `authenticated: release unavailable; no artifacts synchronized; token source: ${token.source}; ${config.destinations.length} destination(s)`,
        );
        return;
      }
      context.dependencies.output.write(
        `ready: release ${manifest.release.id} (${manifest.artifacts.length} artifact(s)); token source: ${token.source}; ${config.destinations.length} destination(s)`,
      );
    });
}
