import { join } from "node:path";
import { z } from "zod";
import type { CliContext } from "../cli/context.js";
import {
  MarketplaceApiClient,
  defaultMarketplaceLimits,
  type MarketplaceLimits,
} from "../api/marketplace-api-client.js";
import { HivemndError } from "../errors.js";
import { MarketplaceTargets } from "./marketplace-targets.js";
import { synchronizeMarketplaces } from "./marketplace-reconcile.js";

export type MarketplaceCommand =
  | "list"
  | "register"
  | "update"
  | "refresh"
  | "catalog"
  | "declare"
  | "select"
  | "status"
  | "sync";
export interface MarketplaceCommandOptions {
  apply?: boolean;
  dryRun?: boolean;
  managed?: boolean;
  native?: boolean;
  enabled?: boolean;
  disabled?: boolean;
  repositoryId?: string;
  name?: string;
  format?: string;
  manifestPath?: string;
  ref?: string;
  expectedLockVersion?: string;
  client?: string;
  scope?: string;
  binding?: string;
  status?: string;
  registration?: string;
  plugin?: string;
  audience?: string;
  target?: string;
  limits?: string;
}

const invalid = (message: string): never => {
  throw new HivemndError("CONFIG_INVALID", message);
};
const limitsSchema = z
  .object({
    response_bytes: z.number().int().positive(),
    file_bytes: z.number().int().positive(),
    total_bytes: z.number().int().positive(),
    file_count: z.number().int().positive(),
    tree_entries: z.number().int().positive(),
  })
  .strict();

export function marketplaceLimits(
  input: string | undefined,
): MarketplaceLimits {
  if (input === undefined) return defaultMarketplaceLimits;
  try {
    const parsed = limitsSchema.safeParse(JSON.parse(input) as unknown);
    if (parsed.success) return parsed.data;
  } catch {
    /* Invalid operator input is reported without echoing it. */
  }
  return invalid(
    "Marketplace limits require positive integer response_bytes, file_bytes, total_bytes, file_count and tree_entries",
  );
}

function integer(value: string | undefined, positive = false): number {
  if (
    !value?.match(/^\d+$/) ||
    !Number.isSafeInteger(Number(value)) ||
    (positive && Number(value) === 0)
  ) {
    return invalid(
      "Provide a valid nonnegative integer version or positive repository ID",
    );
  }
  return Number(value);
}

function required(value: string | undefined): string {
  if (!value?.length || value.trim() !== value)
    return invalid("Provide all required marketplace identity fields");
  return value;
}

function mode(
  options: MarketplaceCommandOptions,
  mandatory: boolean,
): boolean | undefined {
  if (options.managed && options.native)
    return invalid("Use exactly one of --managed or --native");
  if (options.managed) return true;
  if (options.native) return false;
  if (mandatory) return invalid("Choose --managed or --native explicitly");
  return undefined;
}

function targetFields(
  options: MarketplaceCommandOptions,
): Readonly<Record<string, unknown>> {
  if (
    !z.enum(["codex", "claude"]).safeParse(options.client).success ||
    !z.enum(["user", "workspace"]).safeParse(options.scope).success ||
    (options.scope === "workspace"
      ? !z.uuid().safeParse(options.binding).success
      : options.binding !== undefined)
  ) {
    return invalid(
      "Declare --client codex|claude and --scope user|workspace; workspace requires an opaque UUID --binding",
    );
  }
  return {
    harness_kind: options.client,
    install_scope: options.scope,
    workspace_binding_id: options.binding?.toLowerCase() ?? null,
  };
}

function selectionEnabled(options: MarketplaceCommandOptions): boolean {
  if (Boolean(options.enabled) === Boolean(options.disabled))
    return invalid("Choose exactly one of --enabled or --disabled");
  return options.enabled === true;
}

export async function runMarketplaceCommand(
  context: CliContext,
  command: MarketplaceCommand,
  id: string | undefined,
  options: MarketplaceCommandOptions,
): Promise<void> {
  const limits = marketplaceLimits(options.limits);
  if (options.apply && options.dryRun)
    return invalid("Use either --dry-run or --apply");
  if (id !== undefined && !z.uuid().safeParse(id).success)
    return invalid("Marketplace identifier must be a UUID");
  const output = context.dependencies.output;
  if (command === "sync") {
    await synchronizeMarketplaces(context, {
      apply: options.apply === true,
      limits,
      ...(options.target ? { targetId: options.target } : {}),
    });
    return;
  }
  let body: Record<string, unknown> = {};
  if (command === "register") {
    const formats: Readonly<Record<string, string>> = {
      "agent-plugins": "agent_plugins_v1",
      "claude-marketplace": "claude_marketplace",
    };
    const format = formats[required(options.format)];
    if (!format)
      return invalid("Choose format agent-plugins or claude-marketplace");
    body = {
      provider_repository_id: integer(options.repositoryId, true),
      name: required(options.name),
      format,
      manifest_path: required(options.manifestPath),
      configured_ref: required(options.ref),
      sync_with_hivemnd: mode(options, true),
    };
  }
  if (command === "update" || command === "refresh") {
    body.expected_lock_version = integer(options.expectedLockVersion);
    const selectedMode = mode(options, false);
    if (options.name !== undefined) body.name = required(options.name);
    if (options.ref !== undefined) body.configured_ref = required(options.ref);
    if (selectedMode !== undefined) body.sync_with_hivemnd = selectedMode;
    if (command === "refresh") body.limits = limits;
    if (!id) return invalid("Marketplace registration UUID is required");
  }
  if (command === "declare") {
    if (id) {
      if (options.client || options.scope || options.binding)
        return invalid(
          "Target identity is immutable; declare a new target for a new scope or binding",
        );
      body.expected_lock_version = integer(options.expectedLockVersion);
    } else {
      body = { ...targetFields(options) };
      if (options.expectedLockVersion !== undefined)
        body.expected_lock_version = integer(options.expectedLockVersion);
    }
    const status = options.status ?? "active";
    if (!z.enum(["active", "inactive"]).safeParse(status).success)
      return invalid("Target status must be active or inactive");
    body.status = status;
  }
  if (command === "select") {
    body.enabled = selectionEnabled(options);
    if (id) body.expected_lock_version = integer(options.expectedLockVersion);
    else {
      const audience = options.audience ?? "installation";
      if (
        !z.enum(["workspace", "installation"]).safeParse(audience).success ||
        (audience === "installation"
          ? !z.uuid().safeParse(options.target).success
          : options.target !== undefined)
      ) {
        return invalid(
          "Installation selection requires --target UUID; workspace audience has no target",
        );
      }
      // Selection targets reuse the same harness and scope tuple, not a new binding.
      if (
        !z.enum(["codex", "claude"]).safeParse(options.client).success ||
        !z.enum(["user", "workspace"]).safeParse(options.scope).success ||
        !z.uuid().safeParse(options.registration).success
      )
        return invalid(
          "Selection requires registration UUID, client and scope",
        );
      body = {
        ...body,
        registration_id: options.registration,
        plugin_key: required(options.plugin),
        audience,
        harness_kind: options.client,
        install_scope: options.scope,
        target_id: options.target ?? null,
      };
      if (options.expectedLockVersion !== undefined)
        body.expected_lock_version = integer(options.expectedLockVersion);
    }
  }
  const mutation = [
    "register",
    "update",
    "refresh",
    "declare",
    "select",
  ].includes(command);
  if (mutation && !options.apply) {
    output.write(
      JSON.stringify({
        status: "planned",
        operation: command,
        id,
        input: body,
        ...(command === "declare"
          ? {
              consent:
                "Applying enrolls this target for automatic replacement of owned cloud bundles, preserving recovery and runtime data; no new per-version approval. Harness activation remains separate.",
            }
          : {}),
      }),
    );
    return;
  }
  const resolved = await context.resolveConfigured({ readOnly: true });
  const session = await context.bootstrap(resolved.config);
  const client = new MarketplaceApiClient(
    resolved.config.apiUrl,
    context.dependencies.clientVersion,
    fetch,
    limits.response_bytes,
  );
  switch (command) {
    case "list":
      output.write(
        JSON.stringify({
          registrations: await client.registrations(session.token.value),
        }),
      );
      break;
    case "catalog":
      output.write(
        JSON.stringify(await client.catalog(session.token.value, required(id))),
      );
      break;
    case "register":
      output.write(
        JSON.stringify({
          registration: await client.saveRegistration(
            session.token.value,
            undefined,
            body,
          ),
        }),
      );
      break;
    case "update": {
      const current = (await client.registrations(session.token.value)).find(
        (entry) => entry.id === id,
      );
      if (!current) return invalid("Marketplace registration is unavailable");
      output.write(
        JSON.stringify({
          registration: await client.saveRegistration(session.token.value, id, {
            ...body,
            name: options.name ?? current.name,
            configured_ref: options.ref ?? current.configured_ref,
            sync_with_hivemnd:
              mode(options, false) ?? current.sync_with_hivemnd,
          }),
        }),
      );
      break;
    }
    case "refresh": {
      const current = (await client.registrations(session.token.value)).find(
        (entry) => entry.id === id,
      );
      if (!current) return invalid("Marketplace registration is unavailable");
      output.write(
        JSON.stringify({
          registration: await client.refresh(
            session.token.value,
            required(id),
            {
              ...body,
              expected_ref: current.configured_ref,
              expected_sync_with_hivemnd: current.sync_with_hivemnd,
              limits,
            },
          ),
        }),
      );
      break;
    }
    case "declare": {
      const targets = new MarketplaceTargets(
        context.dependencies.environment.HIVEMND_HOME ??
          join(context.dependencies.homeDirectory, ".hivemnd"),
        resolved.configPath,
        resolved.config,
      );
      const target = await client.saveTarget(session.token.value, id, body);
      if (
        (id !== undefined && target.id !== id) ||
        target.status !== body.status ||
        (id === undefined &&
          (target.harness_kind !== body.harness_kind ||
            target.install_scope !== body.install_scope ||
            target.workspace_binding_id !== body.workspace_binding_id))
      ) {
        throw new HivemndError(
          "INTEGRITY_FAILED",
          "Marketplace declaration differs from explicit local consent",
        );
      }
      await targets.remember(target);
      output.write(
        JSON.stringify({
          target,
          automatic_owned_reconciliation: true,
          native_configuration: "unknown",
          session_availability: "unknown",
          execution: "unknown",
        }),
      );
      break;
    }
    case "select":
      output.write(
        JSON.stringify({
          selection: await client.saveSelection(session.token.value, id, body),
        }),
      );
      break;
    case "status":
      if (options.target)
        output.write(
          JSON.stringify(
            await client.reconciliation(session.token.value, options.target),
          ),
        );
      else
        output.write(
          JSON.stringify({
            targets: await client.targets(session.token.value),
            selections: await client.selections(session.token.value),
            session_availability: "unknown",
            execution: "unknown",
          }),
        );
      break;
  }
}
