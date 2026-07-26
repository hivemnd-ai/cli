import type { Command } from "commander";
import type { CliContext } from "../cli/context.js";
import {
  authenticate,
  type AuthenticationOptions,
} from "../workflows/authenticate.js";

export function registerLoginCommand(
  program: Command,
  context: CliContext,
): void {
  program
    .command("login")
    .description("authenticate with a bearer token or one-time enrollment URL")
    .option("--token <token>", "bearer token (prefer HIVEMND_TOKEN)")
    .option("--enrollment-url <url>", "one-time enrollment URL")
    .action((options: AuthenticationOptions) => authenticate(options, context));
}
