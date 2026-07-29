import type { Command } from "commander";
import type { CliContext } from "../cli/context.js";
import {
  synchronize,
  type SynchronizationOptions,
} from "../workflows/synchronize.js";

export function registerSyncCommand(
  program: Command,
  context: CliContext,
): void {
  program
    .command("sync [path]")
    .description("plan synchronization; writing requires --apply")
    .option(
      "--destination <name>",
      "named destination to synchronize (repeatable)",
      collect,
      [],
    )
    .option("--all", "synchronize every configured destination", false)
    .option(
      "--adopt-existing",
      "claim identical unmanaged files after exact hash verification",
      false,
    )
    .option("--dry-run", "show plan without writing", false)
    .option("--apply", "apply the planned changes", false)
    .action((path: string | undefined, options: SynchronizationOptions) => {
      const explicitConfig = program.getOptionValueSource("config") === "cli";
      return synchronize(
        {
          ...options,
          ...(path ? { path } : {}),
          all:
            options.all === true ||
            (explicitConfig && !path && options.destination.length === 0),
        },
        context,
      );
    });
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}
