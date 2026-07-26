import type { Command } from "commander";
import type { CliContext } from "../cli/context.js";
import { runDoctor } from "../workflows/doctor.js";

export function registerDoctorCommand(
  program: Command,
  context: CliContext,
): void {
  program
    .command("doctor")
    .description(
      "diagnose config, destination access, credentials, and API connectivity",
    )
    .action(() => runDoctor(context));
}
