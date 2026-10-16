import type { Command } from "commander";
import type { CliContext } from "../cli/context.js";
import { runDoctor } from "../workflows/doctor.js";
import { runOfflineDoctor } from "../workflows/offline-doctor.js";

export function registerDoctorCommand(
  program: Command,
  context: CliContext,
): void {
  program
    .command("doctor")
    .description(
      "diagnose config, destination access, credentials, and API connectivity",
    )
    .option(
      "--offline",
      "inspect local configuration and queued-file metadata without network or credentials",
      false,
    )
    .action((options: { offline: boolean }) =>
      options.offline ? runOfflineDoctor(context) : runDoctor(context),
    );
}
