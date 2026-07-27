import type { CliContext } from "../cli/context.js";
import { asHivemndError, HivemndError } from "../errors.js";
import { SyncApplier } from "../sync/applier.js";
import { SyncPlanner } from "../sync/planner.js";
import { SyncPreparer } from "../sync/preparer.js";
import { compareSemver, parseSemver } from "../version/semver.js";
import { UPDATE_COMMAND } from "../update/daily-update-checker.js";

export interface SynchronizationOptions {
  readonly dryRun: boolean;
  readonly apply: boolean;
  readonly destination: readonly string[];
  readonly adoptExisting: boolean;
}

export async function synchronize(
  options: SynchronizationOptions,
  context: CliContext,
): Promise<void> {
  if (options.dryRun && options.apply) {
    throw new HivemndError(
      "CONFIG_INVALID",
      "Use either --dry-run or --apply, not both",
    );
  }
  const { dependencies } = context;
  const { config, token, client } = await context.bootstrap();
  const manifest = await client.manifest(token.value);
  assertCompatibleClient(
    dependencies.clientVersion,
    manifest.minimumClientVersion,
  );
  const prepared = await new SyncPreparer().prepare(
    manifest,
    token.value,
    client,
  );
  const adapters = dependencies.adapterFactory(config, options.destination);
  if (adapters.length === 0) {
    throw new HivemndError(
      "CONFIG_INVALID",
      "No synchronization destinations are configured",
    );
  }
  const changes = await new SyncPlanner().plan(prepared, adapters, {
    adoptExisting: options.adoptExisting,
  });
  for (const change of changes) {
    const conflict = change.conflictReason ? ` (${change.conflictReason})` : "";
    dependencies.output.write(
      `${change.kind.padEnd(9)} ${change.destinationName} (${change.agent}) ${change.destination}${conflict}`,
    );
  }
  if (!options.apply) {
    const actionable = changes.filter(
      (change) => change.kind !== "unchanged",
    ).length;
    const conflicts = changes.filter(
      (change) => change.kind === "conflict",
    ).length;
    dependencies.output.write(
      conflicts > 0
        ? `dry-run: ${actionable} change(s), ${conflicts} conflict(s); resolve conflicts before --apply`
        : `dry-run: ${actionable} change(s); pass --apply to write`,
    );
    return;
  }
  const result = await new SyncApplier().apply(prepared, changes, adapters);
  dependencies.output.write(`applied: ${result.applied} change(s)`);
  try {
    await client.receipt(token.value, {
      idempotencyKey: dependencies.id(),
      releaseId: manifest.release.id,
      status: "applied",
      operations: result.operations,
    });
    dependencies.output.write("receipt: accepted");
  } catch (error: unknown) {
    const failure = asHivemndError(error);
    dependencies.output.write(`receipt: deferred (${failure.code})`);
  }
}

function assertCompatibleClient(
  installedVersion: string,
  minimumVersion: string,
): void {
  if (
    !parseSemver(installedVersion) ||
    !parseSemver(minimumVersion) ||
    compareSemver(installedVersion, minimumVersion) < 0
  ) {
    throw new HivemndError(
      "CLIENT_UPDATE_REQUIRED",
      `Hivemnd CLI ${minimumVersion} or newer is required; installed: ${installedVersion}. Run: ${UPDATE_COMMAND}`,
    );
  }
}
