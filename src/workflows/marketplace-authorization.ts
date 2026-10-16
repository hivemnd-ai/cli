import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  MarketplaceApiClient,
  defaultMarketplaceLimits,
} from "../api/marketplace-api-client.js";
import { MarketplaceAuthorizationStore } from "../auth/marketplace-authorization-store.js";
import { createMarketplacePkce } from "../auth/marketplace-pkce.js";
import type { CliContext } from "../cli/context.js";
import { HivemndError } from "../errors.js";

type Configuration = Awaited<ReturnType<CliContext["resolveConfigured"]>>;
export function marketplaceAuthorizationStore(
  context: CliContext,
  resolved: Configuration,
): MarketplaceAuthorizationStore {
  return new MarketplaceAuthorizationStore(
    context.dependencies.environment.HIVEMND_HOME ??
      join(context.dependencies.homeDirectory, ".hivemnd"),
    resolved.configPath,
    resolved.config,
  );
}
export async function marketplaceApiClient(
  context: CliContext,
  resolved: Configuration,
  maximumResponseBytes: number,
): Promise<MarketplaceApiClient> {
  const authorization = resolved.config.installationId
    ? await marketplaceAuthorizationStore(context, resolved).load()
    : undefined;
  return new MarketplaceApiClient(
    resolved.config.apiUrl,
    context.dependencies.clientVersion,
    fetch,
    maximumResponseBytes,
    authorization?.authorizationToken,
  );
}
interface AuthorizationRuntime {
  now: () => number;
  sleep: (milliseconds: number) => Promise<unknown>;
}
const invalidExpiry = (): never => {
  throw new HivemndError(
    "INTEGRITY_FAILED",
    "Marketplace authorization expiry exceeds its original handoff",
  );
};
export async function runMarketplaceAuthorization(
  context: CliContext,
  command: "authorize" | "revoke-authorization",
  options: { apply?: boolean; dryRun?: boolean },
  runtime: AuthorizationRuntime = { now: Date.now, sleep },
): Promise<void> {
  if (options.apply && options.dryRun)
    throw new HivemndError("CONFIG_INVALID", "Use either --dry-run or --apply");
  const output = context.dependencies.output;
  if (!options.apply) {
    output.write(
      JSON.stringify({
        status: "planned",
        operation: command,
        consent:
          "Temporary GitHub access remains on Hivemnd; this CLI stores only a private expiring opaque authorization after explicit browser approval.",
      }),
    );
    return;
  }
  const resolved = await context.resolveConfigured({ readOnly: true });
  const store = marketplaceAuthorizationStore(context, resolved);
  const session = await context.bootstrap(resolved.config);
  const client = await marketplaceApiClient(
    context,
    resolved,
    defaultMarketplaceLimits.response_bytes,
  );
  if (command === "revoke-authorization") {
    await client.revokeAuthorization(session.token.value);
    await store.remove();
    output.write(JSON.stringify({ status: "revoked" }));
    return;
  }
  const pkce = createMarketplacePkce();
  const started = runtime.now();
  const handoff = await client.startAuthorization(
    session.token.value,
    pkce.challenge,
  );
  const responseNow = runtime.now();
  let serverDeadline = Date.parse(handoff.expires_at);
  if (serverDeadline <= responseNow || serverDeadline > responseNow + 600_000)
    return invalidExpiry();
  let deadline = Math.min(serverDeadline, started + 600_000);
  output.write(
    JSON.stringify({
      status: "browser_approval_required",
      verification_uri: handoff.verification_uri,
      expires_at: new Date(deadline).toISOString(),
    }),
  );
  for (let attempts = 0; attempts < 300; attempts++) {
    if (runtime.now() >= deadline)
      throw new HivemndError(
        "HTTP_FAILED",
        "Marketplace authorization failed: authorization_expired",
      );
    const result = await client.exchangeAuthorization(
      session.token.value,
      handoff.authorization_id,
      pkce.verifier,
    );
    const expires = Date.parse(result.expires_at);
    if (expires > serverDeadline) return invalidExpiry();
    serverDeadline = expires;
    deadline = Math.min(deadline, serverDeadline);
    if (deadline <= runtime.now())
      throw new HivemndError(
        "HTTP_FAILED",
        "Marketplace authorization failed: authorization_expired",
      );
    if (result.status === "authorized") {
      await store.save({
        authorizationToken: result.authorization_token,
        expiresAt: new Date(deadline).toISOString(),
      });
      output.write(
        JSON.stringify({
          status: "temporary_authorization_linked",
          expires_at: new Date(deadline).toISOString(),
          repository_access: "checked_per_operation",
        }),
      );
      return;
    }
    await runtime.sleep(
      Math.min(result.poll_interval_seconds * 1000, deadline - runtime.now()),
    );
  }
  throw new HivemndError(
    "HTTP_FAILED",
    "Marketplace authorization polling capacity exhausted; restart authorization",
  );
}
