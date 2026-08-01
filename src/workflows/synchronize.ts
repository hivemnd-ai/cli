import type { AuthenticatedContext, CliContext } from "../cli/context.js";
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
import type { AlwaysContextCacheChange } from "../context/always-context-cache.js";
import {
  ReceiptOutbox,
  type ObservationBootstrap,
} from "../sync/receipt-outbox.js";
import { buildDeliveryObservationReceipt } from "../sync/receipt.js";
import type {
  AgentAdapter,
  ClientConfiguration,
  ContextInstructionChange,
  DeliveryObservationReceipt,
  DeliveryObservationStatus,
  PreparedManifest,
  SyncChange,
} from "../domain.js";

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
  const authenticated = await context.bootstrap(undefined, {
    ...(options.path ? { workspace: options.path } : {}),
  });
  const stateDirectory =
    dependencies.environment.HIVEMND_HOME ??
    join(dependencies.homeDirectory, ".hivemnd");
  const outbox = new ReceiptOutbox({
    stateDirectory,
    apiUrl: authenticated.config.apiUrl,
  });
  await outbox.withLock(() =>
    synchronizeAuthenticated(options, context, authenticated, outbox),
  );
}

async function synchronizeAuthenticated(
  options: SynchronizationOptions,
  context: CliContext,
  authenticated: AuthenticatedContext,
  outbox: ReceiptOutbox,
): Promise<void> {
  const { dependencies } = context;
  const { config, token, client } = authenticated;
  const retried = await outbox.deliverPending(client, token.value);
  if (retried.accepted > 0) {
    dependencies.output.write(`receipt retry: accepted ${retried.accepted}`);
  }
  if (retried.deferredCode) {
    dependencies.output.write(
      `receipt retry: deferred (${retried.deferredCode})`,
    );
  }
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
  const configuration = await client.clientConfiguration(token.value);
  const bootstrap = observationBootstrap(configuration.installation);
  if (!bootstrap) {
    await applyWithLegacyReceipt({
      prepared,
      changes,
      adapters,
      contextChanges,
      cache,
      cacheChange,
      context,
      authenticated,
    });
    return;
  }
  const clientSequence = await outbox.allocate(bootstrap);
  const idempotencyKey = dependencies.id();
  const selectedDestinationNames = adapters.map(({ name }) => name);
  const conflicts = [
    ...changes.filter(({ kind }) => kind === "conflict"),
    ...contextChanges.filter(({ kind }) => kind === "conflict"),
  ];
  if (conflicts.length > 0) {
    const receipt = receiptFor("blocked");
    await outbox.assertCapacity(receipt);
    await outbox.stage(receipt);
    await deliverCurrent(outbox, client, token.value, (message) => {
      dependencies.output.write(message);
    });
    throw new HivemndError(
      "SYNC_CONFLICT",
      `Cannot apply synchronization with ${conflicts.length} conflict(s)`,
    );
  }
  const successfulReceipt = receiptFor("applied");
  await outbox.assertCapacity(successfulReceipt);
  try {
    const result = await new SyncApplier().apply(
      prepared,
      changes,
      adapters,
      contextChanges,
      { cache, change: cacheChange },
      { stage: () => outbox.stage(successfulReceipt) },
    );
    dependencies.output.write(`applied: ${result.applied} change(s)`);
  } catch (error: unknown) {
    const failedReceipt = receiptFor("failed");
    try {
      await outbox.assertCapacity(failedReceipt);
      await outbox.stage(failedReceipt);
      await deliverCurrent(outbox, client, token.value, (message) => {
        dependencies.output.write(message);
      });
    } catch {
      // The original synchronization error remains the primary failure. A failed
      // stage has no partial entry and the applier has already restored local state.
    }
    throw error;
  }
  await deliverCurrent(outbox, client, token.value, (message) => {
    dependencies.output.write(message);
  });

  function receiptFor(
    status: DeliveryObservationStatus,
  ): DeliveryObservationReceipt {
    return buildDeliveryObservationReceipt({
      idempotencyKey,
      clientSequence,
      releaseId: manifest.release.id,
      status,
      config,
      selectedDestinationNames,
      changes,
      alwaysContextArtifacts: prepared.artifacts.filter(
        isAlwaysContextArtifact,
      ),
      ...(status === "blocked"
        ? {}
        : {
            alwaysContextResult:
              status === "failed"
                ? ("failed" as const)
                : cacheChange.kind === "unchanged"
                  ? ("unchanged" as const)
                  : ("applied" as const),
          }),
    });
  }
}

function observationBootstrap(
  installation: ClientConfiguration["installation"],
): ObservationBootstrap | undefined {
  if (installation?.sequenceExhausted === undefined) return undefined;
  return {
    lastClientSequence: installation.lastClientSequence ?? null,
    nextObservationSequence: installation.nextObservationSequence ?? null,
    sequenceExhausted: installation.sequenceExhausted,
  };
}

async function applyWithLegacyReceipt(options: {
  readonly prepared: PreparedManifest;
  readonly changes: readonly SyncChange[];
  readonly adapters: readonly AgentAdapter[];
  readonly contextChanges: readonly ContextInstructionChange[];
  readonly cache: AlwaysContextCache;
  readonly cacheChange: AlwaysContextCacheChange;
  readonly context: CliContext;
  readonly authenticated: AuthenticatedContext;
}): Promise<void> {
  const { dependencies } = options.context;
  const result = await new SyncApplier().apply(
    options.prepared,
    options.changes,
    options.adapters,
    options.contextChanges,
    { cache: options.cache, change: options.cacheChange },
  );
  dependencies.output.write(`applied: ${result.applied} change(s)`);
  try {
    await options.authenticated.client.receipt(
      options.authenticated.token.value,
      {
        idempotencyKey: dependencies.id(),
        releaseId: options.prepared.release.id,
        status: "applied",
        operations: result.operations,
      },
    );
    dependencies.output.write("receipt: accepted");
  } catch (error: unknown) {
    dependencies.output.write(
      `receipt: deferred (${asHivemndError(error).code})`,
    );
  }
}

async function deliverCurrent(
  outbox: ReceiptOutbox,
  client: AuthenticatedContext["client"],
  token: string,
  write: (message: string) => void,
): Promise<void> {
  const delivered = await outbox.deliverPending(client, token);
  if (delivered.deferredCode) {
    write(`receipt: deferred (${delivered.deferredCode})`);
  } else {
    write("receipt: accepted");
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
