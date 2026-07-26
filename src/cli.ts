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
  const program = createProgram(dependencies);
  return runProgram(program, args, dependencies.output);
}
