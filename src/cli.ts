import { createProgram } from "./cli/program.js";
import { runProgram } from "./cli/run.js";
import { defaultDependencies } from "./runtime/defaults.js";
import type { RuntimeDependencies } from "./runtime/dependencies.js";

export { defaultDependencies } from "./runtime/defaults.js";
export { parseEnrollmentUrl } from "./auth/enrollment-url.js";
export type { RuntimeDependencies } from "./runtime/dependencies.js";

export async function runCli(
  args: readonly string[],
  dependencies: RuntimeDependencies = defaultDependencies,
): Promise<number> {
  const automaticUpdate = isAutomaticUpdateEligible(args)
    ? dependencies.updateService.check({ force: false }).catch(() => undefined)
    : undefined;
  const program = createProgram(dependencies);
  const exitCode = await runProgram(program, args, dependencies.output);
  if (exitCode === 0 && automaticUpdate) {
    const update = await automaticUpdate;
    if (update?.updateAvailable && update.latestVersion) {
      dependencies.output.write(
        `Update available: ${update.currentVersion} -> ${update.latestVersion}. Run: ${update.command}`,
      );
    }
  }
  return exitCode;
}

function isAutomaticUpdateEligible(args: readonly string[]): boolean {
  if (
    args.length === 0 ||
    args.some((argument) =>
      ["--version", "-V", "--help", "-h"].includes(argument),
    )
  ) {
    return false;
  }

  const ordinaryCommands = new Set([
    "config",
    "login",
    "status",
    "doctor",
    "sync",
    "sources",
    "schedule",
  ]);
  let skipConfigValue = false;
  for (const argument of args) {
    if (skipConfigValue) {
      skipConfigValue = false;
      continue;
    }
    if (argument === "--config" || argument === "-c") {
      skipConfigValue = true;
      continue;
    }
    if (argument.startsWith("--config=")) {
      continue;
    }
    return ordinaryCommands.has(argument);
  }
  return false;
}
