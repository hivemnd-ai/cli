import {
  execFile,
  type ExecFileOptionsWithBufferEncoding,
} from "node:child_process";
import { promisify } from "node:util";
import { realpath } from "node:fs/promises";

/** Shared read-only Git policy. Callers still bound process time and output. */
export async function localGitContext(root: string): Promise<{
  root: string;
  args: string[];
  environment: NodeJS.ProcessEnv;
}> {
  const canonical = await realpath(root);
  const environment = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")),
  );
  environment.GIT_NO_LAZY_FETCH = "1";
  environment.GIT_NO_REPLACE_OBJECTS = "1";
  environment.GIT_ALLOW_PROTOCOL = "";
  environment.GIT_TERMINAL_PROMPT = "0";
  environment.GIT_CONFIG_NOSYSTEM = "1";
  environment.GIT_CONFIG_GLOBAL = "/dev/null";
  return {
    root: canonical,
    environment,
    args: [
      "--no-optional-locks",
      "--no-replace-objects",
      "--literal-pathspecs",
      "-c",
      "core.fsmonitor=false",
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "protocol.allow=never",
      "-C",
      canonical,
    ],
  };
}

const git = promisify(execFile);
export async function executeLocalGit(
  file: string,
  args: readonly string[],
  options: ExecFileOptionsWithBufferEncoding,
): Promise<{ stdout: Buffer; stderr: Buffer }> {
  return git(file, args, options);
}
