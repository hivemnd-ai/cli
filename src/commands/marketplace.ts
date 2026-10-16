import { resolve } from "node:path";
import type { Command } from "commander";
import type { CliContext } from "../cli/context.js";
import {
  runMarketplaceCommand,
  type MarketplaceCommandOptions,
} from "../workflows/marketplace-commands.js";
import { previewAgentPlugin } from "../marketplace/agent-plugins.js";
import { previewClaudeMarketplace } from "../marketplace/claude-marketplace.js";
import { invalid } from "../marketplace/local-source.js";

export function registerMarketplaceCommands(
  program: Command,
  context: CliContext,
): void {
  const dependencies = context.dependencies;
  const marketplace = program
    .command("marketplace")
    .description(
      "manage authorized marketplaces and explicitly enrolled targets",
    );
  marketplace
    .command("preview")
    .argument("<directory>", "local Git checkout or package directory")
    .requiredOption("--format <format>", "agent-plugins or claude-marketplace")
    .action(async (directory: string, options: { format: string }) => {
      const importer =
        options.format === "agent-plugins"
          ? previewAgentPlugin
          : options.format === "claude-marketplace"
            ? previewClaudeMarketplace
            : undefined;
      if (!importer)
        invalid("Choose format agent-plugins or claude-marketplace");
      const result = await importer(resolve(dependencies.cwd, directory));
      // Raw manifests and declarations may contain private material; never print them.
      dependencies.output.write(
        JSON.stringify(
          {
            format: result.format,
            commitSha: result.source.commitSha,
            dirty: result.source.dirty,
            manifests: result.manifests.map(({ path, sha256 }) => ({
              path,
              sha256,
            })),
            plugins: result.plugins.map(
              ({ name, status, capabilities, skills }) => ({
                name,
                status,
                capabilities,
                skillCount: skills.length,
              }),
            ),
            warnings: result.warnings,
          },
          null,
          2,
        ),
      );
    });
  marketplace
    .command("authorize")
    .description(
      "link temporary private GitHub access through explicit browser approval",
    )
    .option("--dry-run")
    .option(
      "--apply",
      "store only an expiring opaque authorization after browser approval",
    )
    .action((options: MarketplaceCommandOptions) =>
      runMarketplaceCommand(context, "authorize", undefined, options),
    );
  marketplace
    .command("revoke-authorization")
    .description(
      "revoke the temporary private authorization and remove its owned local handle",
    )
    .option("--dry-run")
    .option("--apply")
    .action((options: MarketplaceCommandOptions) =>
      runMarketplaceCommand(
        context,
        "revoke-authorization",
        undefined,
        options,
      ),
    );
  marketplace
    .command("list")
    .description("list authorized marketplace registrations")
    .action(() => runMarketplaceCommand(context, "list", undefined, {}));
  marketplace
    .command("register")
    .description("register a GitHub repository; writes require --apply")
    .requiredOption(
      "--repository-id <id>",
      "canonical numeric GitHub repository ID",
    )
    .option(
      "--private-source <uuid>",
      "existing authorized private Source UUID",
    )
    .requiredOption("--name <name>", "workspace registration name")
    .requiredOption("--format <format>", "agent-plugins or claude-marketplace")
    .requiredOption(
      "--manifest-path <path>",
      "repository-relative catalog path",
    )
    .requiredOption("--ref <ref>", "explicit source ref")
    .option("--managed", "synchronize complete inert bundles with Hivemnd")
    .option(
      "--native",
      "delegate lifecycle to the harness; support is reported separately",
    )
    .option("--dry-run", "plan without server or local writes")
    .option("--apply", "create the server registration")
    .action((options: MarketplaceCommandOptions) =>
      runMarketplaceCommand(context, "register", undefined, options),
    );
  marketplace
    .command("update <id>")
    .description("change registration configuration with CAS")
    .option("--name <name>")
    .option("--ref <ref>")
    .option("--managed")
    .option("--native")
    .requiredOption("--expected-lock-version <version>")
    .option("--dry-run")
    .option("--apply")
    .action((id: string, options: MarketplaceCommandOptions) =>
      runMarketplaceCommand(context, "update", id, options),
    );
  marketplace
    .command("refresh <id>")
    .description("refresh an inert current source checkpoint")
    .requiredOption("--expected-lock-version <version>")
    .option(
      "--limits <json>",
      "explicit runtime capacity: response_bytes,file_bytes,total_bytes,file_count,tree_entries",
    )
    .option("--dry-run")
    .option("--apply")
    .action((id: string, options: MarketplaceCommandOptions) =>
      runMarketplaceCommand(context, "refresh", id, options),
    );
  marketplace
    .command("catalog <id>")
    .description("list current entry metadata without raw manifests")
    .action((id: string) => runMarketplaceCommand(context, "catalog", id, {}));
  marketplace
    .command("declare [id]")
    .description(
      "explicitly enroll a local target for automatic owned reconciliation; update status by ID",
    )
    .option("--client <client>", "codex or claude")
    .option("--scope <scope>", "user or workspace")
    .option(
      "--binding <uuid>",
      "opaque local workspace binding UUID; no path is sent",
    )
    .option("--status <status>", "active or inactive", "active")
    .option("--expected-lock-version <version>")
    .option("--dry-run")
    .option(
      "--apply",
      "consent to automatic owned cloud updates with recovery; activation remains separate",
    )
    .action((id: string | undefined, options: MarketplaceCommandOptions) =>
      runMarketplaceCommand(context, "declare", id, options),
    );
  marketplace
    .command("select [id]")
    .description(
      "create desired package intent or change enabled state by ID with CAS",
    )
    .option("--registration <uuid>")
    .option("--plugin <key>")
    .option(
      "--audience <audience>",
      "workspace or installation",
      "installation",
    )
    .option("--client <client>")
    .option("--scope <scope>")
    .option("--target <uuid>")
    .option("--enabled")
    .option("--disabled")
    .option("--expected-lock-version <version>")
    .option("--dry-run")
    .option("--apply")
    .action((id: string | undefined, options: MarketplaceCommandOptions) =>
      runMarketplaceCommand(context, "select", id, options),
    );
  marketplace
    .command("status")
    .description(
      "show declarations, desired selections and honest unknown session state",
    )
    .option("--target <uuid>", "inspect one target reconciliation inventory")
    .action((options: MarketplaceCommandOptions) =>
      runMarketplaceCommand(context, "status", undefined, options),
    );
  marketplace
    .command("sync")
    .description(
      "plan or apply complete inert bundles for locally opted-in targets",
    )
    .option("--target <uuid>")
    .option("--limits <json>")
    .option("--dry-run")
    .option("--apply")
    .action((options: MarketplaceCommandOptions) =>
      runMarketplaceCommand(context, "sync", undefined, options),
    );
}
