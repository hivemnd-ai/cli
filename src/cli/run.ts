import { CommanderError, type Command } from "commander";
import type { Output } from "../domain.js";
import { asHivemndError } from "../errors.js";

export async function runProgram(
  program: Command,
  args: readonly string[],
  output: Output,
): Promise<number> {
  try {
    await program.parseAsync([...args], { from: "user" });
    return 0;
  } catch (error: unknown) {
    if (
      error instanceof CommanderError &&
      (error.code === "commander.helpDisplayed" ||
        error.code === "commander.version")
    ) {
      return 0;
    }
    const failure = asHivemndError(error);
    output.error(`[${failure.code}] ${failure.message}`);
    return 1;
  }
}
