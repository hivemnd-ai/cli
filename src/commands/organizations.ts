import type { Command } from "commander";
import type { CliContext } from "../cli/context.js";
import { organizationRegistry } from "../organizations/runtime.js";

export function registerOrganizationCommands(
  program: Command,
  context: CliContext,
): void {
  const organizations = program
    .command("org")
    .description("inspect connected Hivemnd organizations");

  organizations
    .command("list", { isDefault: true })
    .description("list connected organizations and local routing")
    .action(async () => {
      const { dependencies } = context;
      const selected = program.opts<{ config: string }>().config;
      const registry = await organizationRegistry(dependencies).loadOrMigrate(
        selected,
        false,
      );
      if (registry.profiles.length === 0) {
        dependencies.output.write("No Hivemnd organizations are configured.");
        return;
      }
      for (const profile of registry.profiles) {
        dependencies.output.write(
          `${profile.alias} | ${profile.name} | ${profile.apiUrl}`,
        );
        for (const binding of registry.globalBindings.filter(
          (candidate) => candidate.organizationKey === profile.key,
        )) {
          dependencies.output.write(`  global | ${binding.client}`);
        }
        for (const binding of registry.workspaceBindings.filter(
          (candidate) => candidate.organizationKey === profile.key,
        )) {
          dependencies.output.write(`  workspace | ${binding.path}`);
        }
      }
    });
}
