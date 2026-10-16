import { dirname, join } from "node:path";
import type { AuthenticatedContext, CliContext } from "../cli/context.js";
import {
  MarketplaceApiClient,
  defaultMarketplaceLimits,
  type MarketplaceLimits,
} from "../api/marketplace-api-client.js";
import { HivemndError } from "../errors.js";
import {
  reconcileManagedBundle,
  type ManagedBundleInput,
} from "../marketplace/reconcile.js";
import { profileKey } from "../organizations/registry.js";
import { sha256 } from "../sync/hash.js";
import { tenantBaseUrl } from "../tenant-url.js";
import {
  MarketplaceTargets,
  ensureMarketplaceDirectory,
} from "./marketplace-targets.js";
import { probeDeclaredHarness } from "../marketplace/harness-adapters.js";

export interface MarketplaceSyncOptions {
  apply: boolean;
  targetId?: string;
  limits?: MarketplaceLimits;
  automatic?: boolean;
}

export async function synchronizeMarketplaces(
  context: CliContext,
  options: MarketplaceSyncOptions,
  authenticated?: AuthenticatedContext,
): Promise<void> {
  const resolved =
    authenticated ?? (await context.resolveConfigured({ readOnly: true }));
  await synchronizeResolvedMarketplaces(
    context,
    options,
    resolved,
    authenticated,
  );
}

async function synchronizeResolvedMarketplaces(
  context: CliContext,
  options: MarketplaceSyncOptions,
  resolved: Awaited<ReturnType<CliContext["resolveConfigured"]>>,
  authenticated?: AuthenticatedContext,
): Promise<void> {
  if (!resolved.config.installationId && options.automatic) {
    return;
  }
  if (!resolved.config.installationId) {
    throw new HivemndError(
      "CONFIG_INVALID",
      "Marketplace management requires an enrolled installation",
    );
  }
  const state =
    context.dependencies.environment.HIVEMND_HOME ??
    join(context.dependencies.homeDirectory, ".hivemnd");
  const targets = await new MarketplaceTargets(
    state,
    resolved.configPath,
    resolved.config,
  ).list();
  const selected = options.targetId
    ? targets.filter((target) => target.id === options.targetId)
    : targets;
  if (selected.length === 0) {
    if (options.automatic) return;
    throw new HivemndError(
      "CONFIG_INVALID",
      "Declare a local target with marketplace declare --apply before synchronization",
    );
  }
  const session = authenticated ?? (await context.bootstrap(resolved.config));
  const limits = options.limits ?? defaultMarketplaceLimits;
  const client = new MarketplaceApiClient(
    resolved.config.apiUrl,
    context.dependencies.clientVersion,
    fetch,
    limits.response_bytes,
  );
  const base = tenantBaseUrl(resolved.config.apiUrl);
  for (const target of selected) {
    let actions: (() => Promise<void>)[];
    let retries = 0;
    for (;;) {
      try {
        actions = await prepareTarget();
        break;
      } catch (error: unknown) {
        if (
          !(error instanceof HivemndError) ||
          error.code !== "SYNC_CONFLICT" ||
          retries >= 2
        )
          throw error;
        retries += 1;
      }
    }
    // No pointer is published until all managed bundles of this target verified.
    for (const action of actions) await action();

    async function prepareTarget(): Promise<(() => Promise<void>)[]> {
      const pending: (() => Promise<void>)[] = [];
      const response = await client.reconciliation(
        session.token.value,
        target.id,
      );
      if (
        response.target.id !== target.id ||
        response.target.harness_kind !== target.harness_kind ||
        response.target.install_scope !== target.install_scope ||
        response.target.workspace_binding_id !== target.workspace_binding_id
      ) {
        throw new HivemndError(
          "INTEGRITY_FAILED",
          "Marketplace target identity differs from local consent",
        );
      }
      if (response.target.status !== "active") {
        return [
          () => {
            context.dependencies.output.write(
              JSON.stringify({
                target_id: target.id,
                status: "inactive",
                execution: "unknown",
              }),
            );
            return Promise.resolve();
          },
        ];
      }
      for (const item of response.items) {
        if (item.status !== "ready" || item.mode !== "managed") {
          pending.push(() => {
            context.dependencies.output.write(
              JSON.stringify({
                ...item,
                package: undefined,
                status:
                  item.status === "ready"
                    ? "native_activation_unsupported"
                    : item.status,
                session_availability: "unknown",
                execution: "unknown",
              }),
            );
            return Promise.resolve();
          });
          continue;
        }
        const expected = new URL(
          `api/v1/marketplace/packages/${item.package.id}/bundle`,
          base,
        );
        const advertised = new URL(item.bundle_path, base);
        if (advertised.href !== expected.href)
          throw new HivemndError(
            "PATH_UNSAFE",
            "Marketplace bundle path left the selected package and tenant",
          );
        const bundle = await client.bundle(
          session.token.value,
          item.package.id,
          limits,
        );
        const fileMetadata = bundle.files.map((file) => ({
          relative_path: file.relative_path,
          git_blob_oid: file.git_blob_oid,
          sha256: file.sha256,
          byte_size: file.byte_size,
          executable: file.executable,
        }));
        if (
          bundle.registration_id !== item.registration_id ||
          bundle.package.plugin_key !== item.plugin_key ||
          JSON.stringify(bundle.package) !== JSON.stringify(item.package) ||
          JSON.stringify(bundle.package.files) !==
            JSON.stringify(fileMetadata) ||
          bundle.files.length !== bundle.package.file_count ||
          bundle.files.reduce((sum, file) => sum + file.byte_size, 0) !==
            bundle.package.package_bytes
        ) {
          throw new HivemndError(
            "INTEGRITY_FAILED",
            "Marketplace bundle differs from the authorized current inventory",
          );
        }
        const files = bundle.files.map((file) => {
          const content = Buffer.from(file.content_base64, "base64");
          if (
            content.toString("base64") !== file.content_base64 ||
            content.byteLength !== file.byte_size
          ) {
            throw new HivemndError(
              "INTEGRITY_FAILED",
              "Marketplace bundle contains invalid binary encoding or size",
            );
          }
          return {
            path: file.relative_path,
            size: file.byte_size,
            sha256: file.sha256,
            executable: file.executable,
            blobOid: file.git_blob_oid,
            mode: file.executable ? ("100755" as const) : ("100644" as const),
            content,
          };
        });
        const ownerId = sha256(
          [base.href, target.id, item.registration_id, item.plugin_key].join(
            "\0",
          ),
        );
        const input: ManagedBundleInput = {
          apply: options.apply,
          declaredTarget: {
            id: target.id,
            harness: target.harness_kind,
            scope: target.install_scope,
            bindingId: target.workspace_binding_id,
          },
          stateDirectory: join(
            state,
            "organizations",
            profileKey(resolved.config.apiUrl),
            "marketplace-bundles",
            ownerId,
          ),
          ownerId,
          commitSha: bundle.package.provenance.commit_sha,
          packageRoot: bundle.package.package_root,
          files,
          packageSha256: bundle.package.package_sha256,
          limits: {
            maxFiles: limits.file_count,
            maxFileBytes: limits.file_bytes,
            maxTotalBytes: limits.total_bytes,
            maxDepth: 128,
            maxEntries: limits.tree_entries,
            maxStateBytes: limits.response_bytes,
          },
        };
        await reconcileManagedBundle({ ...input, apply: false });
        pending.push(async () => {
          if (input.apply)
            await ensureMarketplaceDirectory(dirname(input.stateDirectory));
          const harnessProbe = input.apply
            ? await probeDeclaredHarness(input.declaredTarget)
            : undefined;
          const result = await reconcileManagedBundle({
            ...input,
            ...(harnessProbe ? { harnessProbe } : {}),
          });
          context.dependencies.output.write(
            JSON.stringify({
              target_id: target.id,
              selection_id: item.selection_id,
              registration_id: item.registration_id,
              plugin_key: item.plugin_key,
              status: result.status,
              commit_sha: bundle.package.provenance.commit_sha,
              package_sha256: result.packageSha256,
              native_configuration: result.native.status,
              ...(result.native.status === "launch-parameter"
                ? { launch_plan: result.native }
                : {}),
              refresh_requested: response.refresh_requested,
              session_availability: "unknown",
              execution: result.execution,
            }),
          );
        });
      }
      return pending;
    }
  }
}
