import type { Command } from "commander";
import type { CliContext } from "../cli/context.js";

export function registerUpdateCommand(
  program: Command,
  context: CliContext,
): void {
  program
    .command("update")
    .description("inspect CLI update options without changing the installation")
    .command("check")
    .description("check npm for a newer stable CLI release")
    .action(async () => {
      const { output, updateService } = context.dependencies;
      try {
        const result = await updateService.check({ force: true });
        if (result.updateAvailable && result.latestVersion) {
          output.write(
            `Update available: ${result.currentVersion} -> ${result.latestVersion}`,
          );
        } else {
          output.write(`Hivemnd CLI ${result.currentVersion} is up to date.`);
        }
        output.write(`Update command: ${result.command}`);
        output.write("Hivemnd does not update itself silently.");
      } catch {
        output.write(
          "Update check unavailable; no changes were made. Retry when npm is reachable.",
        );
      }
    });
}
