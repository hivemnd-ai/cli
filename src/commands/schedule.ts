import type { Command } from "commander";
import { isAbsolute, resolve } from "node:path";
import type { CliContext } from "../cli/context.js";
import { HivemndError } from "../errors.js";
import type {
  ScheduleManager,
  ScheduleState,
} from "../schedule/periodic-sync-scheduler.js";

interface InstallOptions {
  readonly interval: number;
}

export function registerScheduleCommands(
  program: Command,
  context: CliContext,
): void {
  const schedule = program
    .command("schedule")
    .description("manage periodic synchronization for the current user");

  schedule
    .command("install")
    .description("install a macOS LaunchAgent or Linux systemd user timer")
    .option(
      "--interval <minutes>",
      "sync interval in minutes",
      parseInterval,
      15,
    )
    .action(async (options: InstallOptions) => {
      const { config, token } = await context.bootstrap();
      const store = context.dependencies.tokenStoreFactory(config);
      if (
        token.source !== "keychain" ||
        store.supportsPersistentStorage?.() !== true
      ) {
        throw new HivemndError(
          "KEYCHAIN_UNAVAILABLE",
          "Automatic sync requires a credential in persistent secure storage",
        );
      }
      const state = await (
        await manager(program, context)
      ).install(options.interval);
      context.dependencies.output.write(formatState(state));
    });

  schedule
    .command("status")
    .description(
      "show whether periodic synchronization is installed and active",
    )
    .action(async () => {
      const state = await (await manager(program, context)).status();
      context.dependencies.output.write(formatState(state));
    });

  schedule
    .command("remove")
    .description("remove periodic synchronization for this tenant and config")
    .action(async () => {
      const state = await (await manager(program, context)).remove();
      context.dependencies.output.write(`schedule ${state.identity}: removed`);
    });
}

async function manager(
  program: Command,
  context: CliContext,
): Promise<ScheduleManager> {
  const config = await context.loadConfigured();
  const selected = program.opts<{ config: string }>().config;
  const configPath = isAbsolute(selected)
    ? selected
    : resolve(context.dependencies.cwd, selected);
  return context.dependencies.scheduleManagerFactory({
    apiUrl: config.apiUrl,
    configPath,
  });
}

function parseInterval(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 1_440) {
    throw new HivemndError(
      "CONFIG_INVALID",
      "Schedule interval must be an integer from 1 to 1440 minutes",
    );
  }
  return parsed;
}

function formatState(state: ScheduleState): string {
  const installed = state.installed ? "installed" : "not installed";
  const active = state.active ? "active" : "inactive";
  const failure = state.lastRunFailed
    ? `; last run failed; inspect: ${state.errorLogPath}`
    : "";
  return `schedule ${state.identity}: ${installed}, ${active}, every ${state.intervalMinutes} minute(s)${failure}`;
}
