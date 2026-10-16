import { z } from "zod";
import { HivemndError } from "../errors.js";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";

const uuid = z.string().regex(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i);
const targetSchema = z
  .object({
    id: uuid,
    harness: z.enum(["codex", "claude"]),
    scope: z.enum(["user", "workspace"]),
    bindingId: uuid.nullable(),
  })
  .strict()
  .refine((value) => (value.scope === "user") === (value.bindingId === null));
export type DeclaredHarnessTarget = z.infer<typeof targetSchema>;
export function validateDeclaredTarget(
  target: DeclaredHarnessTarget,
): DeclaredHarnessTarget {
  const parsed = targetSchema.safeParse(target);
  if (!parsed.success)
    throw new HivemndError(
      "CLIENT_CONFIGURATION_INVALID",
      "A valid explicit harness target is required.",
    );
  return parsed.data;
}
export interface HarnessProbe {
  harness: "codex" | "claude";
  version: string;
  pluginHelp: string;
  marketplaceHelp: string;
  rootHelp?: string;
}
export interface HarnessCapabilities {
  cli: "observed" | "unknown";
  registration: "unsupported" | "launch-parameter";
  reason: "native-registration-may-activate-components";
  commands: readonly string[];
  installed: "unknown";
  enabled: "unknown";
  availableInSession: "unknown";
  observedUse: "unknown";
  execution: "unknown";
}
/** Pure allowlisted interpretation of caller-supplied --version/--help evidence; never runs a host.
 * Claude: https://code.claude.com/docs/en/plugins/cli-reference
 * Codex: https://developers.openai.com/plugins/build/plugins
 * Availability requires a new native session; materialization alone provides no such evidence.
 */
export function inspectHarnessCapabilities(
  target: DeclaredHarnessTarget,
  probe?: HarnessProbe,
): HarnessCapabilities {
  validateDeclaredTarget(target);
  const observed =
    probe?.harness === target.harness &&
    [
      probe.version,
      probe.pluginHelp,
      probe.marketplaceHelp,
      probe.rootHelp ?? "",
    ].every((value) => value.length <= 16384) &&
    /\b\d+\.\d+\.\d+\b/.test(probe.version);
  const lifecycle =
    observed &&
    /\blist\b/.test(probe.pluginHelp) &&
    new RegExp(
      target.harness === "claude" ? "\\binstall\\b" : "\\badd\\b",
    ).test(probe.pluginHelp) &&
    /\badd\b/.test(probe.marketplaceHelp);
  const commands =
    target.harness === "claude"
      ? [
          "claude plugin marketplace add SOURCE --scope user|project|local",
          "claude plugin install NAME@MARKET --scope user|project|local",
        ]
      : [
          "codex plugin marketplace add SOURCE --ref REF --json",
          "codex plugin add NAME@MARKET --json",
        ];
  return {
    cli: observed ? "observed" : "unknown",
    registration:
      observed &&
      target.harness === "claude" &&
      /(?:^|\s)--plugin-dir(?=[\s=]|$)/.test(probe.rootHelp ?? "")
        ? "launch-parameter"
        : "unsupported",
    reason: "native-registration-may-activate-components",
    commands: lifecycle ? commands : [],
    installed: "unknown",
    enabled: "unknown",
    availableInSession: "unknown",
    observedUse: "unknown",
    execution: "unknown",
  };
}
export type HarnessLaunchPlan =
  | {
      status: "unsupported";
      reason: "native-registration-may-activate-components";
    }
  | {
      status: "launch-parameter";
      reason: "explicit-manual-session-start";
      argv: readonly ["claude", "--plugin-dir", string];
      scope: "session";
      activation: "manual-start-may-run-hooks-and-mcp";
      executableModes: "intent-only";
      currentSession: "unknown";
    };
/** Describes an explicitly started future session; never launches a model or changes native settings. */
export function prepareHarnessLaunch(
  target: DeclaredHarnessTarget,
  directory: string | undefined,
  compatibleLayout: boolean,
  probe?: HarnessProbe,
): HarnessLaunchPlan {
  const capabilities = inspectHarnessCapabilities(target, probe);
  if (
    directory !== undefined &&
    isAbsolute(directory) &&
    compatibleLayout &&
    capabilities.registration === "launch-parameter"
  )
    return {
      status: "launch-parameter",
      reason: "explicit-manual-session-start",
      argv: ["claude", "--plugin-dir", directory],
      scope: "session",
      activation: "manual-start-may-run-hooks-and-mcp",
      executableModes: "intent-only",
      currentSession: "unknown",
    };
  return {
    status: "unsupported",
    reason: "native-registration-may-activate-components",
  };
}
const execute = promisify(execFile);
/** Invoke only after explicit declared-target apply enrollment. Only vendor help/version, no plugin lifecycle. */
export async function probeDeclaredHarness(
  target: DeclaredHarnessTarget,
): Promise<HarnessProbe | undefined> {
  validateDeclaredTarget(target);
  if (target.harness === "codex") return undefined;
  let directory: string | undefined;
  try {
    directory = await mkdtemp(join(tmpdir(), "hivemnd-harness-probe-"));
    const env = {
      PATH: process.env.PATH,
      CLAUDE_CONFIG_DIR: directory,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_AUTOUPDATER: "1",
      DISABLE_TELEMETRY: "1",
      DISABLE_ERROR_REPORTING: "1",
    };
    const options = {
      cwd: directory,
      env,
      timeout: 2000,
      maxBuffer: 65536,
      killSignal: "SIGKILL" as const,
      encoding: "utf8" as const,
    };
    const version = await execute(target.harness, ["--version"], options);
    const help = await execute(target.harness, ["--help"], options);
    const observedVersion = /\b\d+\.\d+\.\d+\b/.exec(version.stdout)?.[0];
    if (observedVersion === undefined) return undefined;
    return {
      harness: target.harness,
      version: observedVersion,
      rootHelp: /(?:^|\s)--plugin-dir(?=[\s=]|$)/.test(help.stdout)
        ? "--plugin-dir"
        : "",
      pluginHelp: "",
      marketplaceHelp: "",
    };
  } catch {
    return undefined;
  } finally {
    if (directory)
      await rm(directory, { recursive: true, force: true }).catch(
        () => undefined,
      );
  }
}
