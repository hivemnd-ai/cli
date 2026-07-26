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
    .command("sync")
    .description("plan synchronization; writing requires --apply")
    .option(
      "--destination <name>",
      "named destination to synchronize (repeatable; all by default)",
      collect,
      [],
    )
    .option(
      "--adopt-existing",
      "claim identical unmanaged files after exact hash verification",
      false,
    )
    .option("--dry-run", "show plan without writing", false)
    .option("--apply", "apply the planned changes", false)
    .action((options: SynchronizationOptions) => synchronize(options, context));
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}
