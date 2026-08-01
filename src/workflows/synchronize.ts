import type { CliContext } from "../cli/context.js";
import { asHivemndError, HivemndError } from "../errors.js";
import { SyncApplier } from "../sync/applier.js";
import { SyncPlanner } from "../sync/planner.js";
import { SyncPreparer } from "../sync/preparer.js";
import { AlwaysContextPlanner } from "../sync/always-context.js";
import { withoutAlwaysContext } from "../sync/always-context.js";
import { AlwaysContextCache } from "../context/always-context-cache.js";
import { compareSemver, parseSemver } from "../version/semver.js";
import { UPDATE_COMMAND } from "../update/daily-update-checker.js";
import { resolve } from "node:path";
import { join } from "node:path";
import { selectContextualDestinationNames } from "../workspaces/destinations.js";
import { assertCompatibleDeliveryTargets } from "../sync/delivery-targets.js";
import { isAlwaysContextArtifact } from "../context/always-context-cache.js";

export interface SynchronizationOptions {
  readonly dryRun: boolean;
  readonly apply: boolean;
  readonly destination: readonly string[];
  readonly adoptExisting: boolean;
  readonly all?: boolean;
  readonly path?: string;
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
  if (options.all && (options.path || options.destination.length > 0)) {
    throw new HivemndError(
      "CONFIG_INVALID",
      "Use --all without a path or --destination",
    );
  }
  const { config, token, client } = await context.bootstrap(undefined, {
    ...(options.path ? { workspace: options.path } : {}),
  });
  if (options.all && config.destinations.length === 0) {
    dependencies.output.write(
      options.apply
        ? "applied: 0 change(s)"
        : "dry-run: 0 change(s); no destinations are configured",
    );
    return;
  }
  const manifest = await client.manifest(token.value);
  assertCompatibleClient(
    dependencies.clientVersion,
    manifest.minimumClientVersion,
  );
  const destinationNames =
    options.destination.length > 0
      ? options.destination
      : selectContextualDestinationNames(
          config,
          resolve(dependencies.cwd, options.path ?? dependencies.cwd),
          options.all === true,
        );
  const adapters = dependencies.adapterFactory(config, destinationNames);
  if (adapters.length === 0) {
    throw new HivemndError(
      "CONFIG_INVALID",
      "No synchronization destinations are configured",
    );
  }
  assertCompatibleDeliveryTargets(
    manifest.artifacts.filter((artifact) => !isAlwaysContextArtifact(artifact)),
    adapters,
    dependencies.clientVersion,
  );
  assertCompatibleDeliveryTargets(
    manifest.artifacts.filter(isAlwaysContextArtifact),
    config.destinations
      .filter((destination) => destination.scope !== "directory")
      .map((destination) => ({
        kind: destination.agent,
        scope: destination.scope,
      })),
    dependencies.clientVersion,
  );
  const prepared = await new SyncPreparer().prepare(
    manifest,
    token.value,
    client,
  );
  const destinationManifest = withoutAlwaysContext(prepared);
  const changes = await new SyncPlanner().plan(destinationManifest, adapters, {
    adoptExisting: options.adoptExisting,
    clientVersion: dependencies.clientVersion,
  });
  const contextChanges = await new AlwaysContextPlanner().plan(adapters);
  const cache = new AlwaysContextCache({
    stateDirectory:
      dependencies.environment.HIVEMND_HOME ??
      join(dependencies.homeDirectory, ".hivemnd"),
    apiUrl: config.apiUrl,
  });
  const cacheChange = await cache.plan(prepared);
  for (const change of changes) {
    const conflict = change.conflictReason ? ` (${change.conflictReason})` : "";
    dependencies.output.write(
      `${change.kind.padEnd(9)} ${change.destinationName} (${change.agent}) ${change.destination}${conflict}`,
    );
  }
  for (const change of contextChanges) {
    const conflict = change.conflictReason ? ` (${change.conflictReason})` : "";
    dependencies.output.write(
      `${change.kind.padEnd(9)} ${change.destinationName} (${change.agent}) ${change.destination}${conflict}`,
    );
  }
  dependencies.output.write(
    `${cacheChange.kind.padEnd(9)} always-context (cache) ${join(cache.root, "current.json")}`,
  );
  if (!options.apply) {
    const allChanges = [...changes, ...contextChanges, cacheChange];
    const actionable = allChanges.filter(
      (change) => change.kind !== "unchanged",
    ).length;
    const conflicts = allChanges.filter(
      (change) => change.kind === "conflict",
    ).length;
    dependencies.output.write(
      conflicts > 0
        ? `dry-run: ${actionable} change(s), ${conflicts} conflict(s); resolve conflicts before --apply`
        : `dry-run: ${actionable} change(s); pass --apply to write`,
    );
    return;
  }
  const result = await new SyncApplier().apply(
    prepared,
    changes,
    adapters,
    contextChanges,
    { cache, change: cacheChange },
  );
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
