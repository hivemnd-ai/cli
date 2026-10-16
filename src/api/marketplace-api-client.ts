import { z } from "zod";
import { HivemndError } from "../errors.js";
import { compareSemver, isBoundedSemver } from "../version/semver.js";
import { isWithinTenant, tenantBaseUrl } from "../tenant-url.js";
import { clientRuntimeHeaders } from "../client/runtime-contract.js";
import { clientTechnicalFeatures } from "../client/runtime-contract.js";

const opaqueAuthorization = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const authorizationError = z.enum([
  "invalid_request",
  "forbidden",
  "authorization_invalid",
  "authorization_expired",
  "authorization_denied",
  "authorization_unavailable",
]);
const uuid = z.uuid();
const count = z.number().int().nonnegative();
const text = z.string().max(4096);
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const gitOid = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const timestamp = z.iso.datetime().nullable();
const envelope = {
  schema_version: z.literal(1),
  minimum_client_version: z.string().refine(isBoundedSemver),
};
const snapshot = z
  .object({
    id: uuid,
    commit_sha: gitOid,
    manifest_sha256: sha256,
    manifest_bytes: count,
    indexed_at: z.iso.datetime(),
  })
  .strict();
export const marketplaceRegistrationSchema = z
  .object({
    id: uuid,
    name: text,
    provider_repository_id: count.positive(),
    repository_owner: text,
    repository_name: text,
    format: z.enum([
      "agent_plugins_v1",
      "claude_marketplace",
      "codex_marketplace",
    ]),
    manifest_path: text,
    configured_ref: text,
    sync_with_hivemnd: z.boolean(),
    status: z.enum(["pending", "active", "paused", "unavailable"]),
    source_visibility: z.enum(["public", "private", "internal"]),
    lock_version: count,
    current_catalog_snapshot: snapshot.nullable(),
    head_observed_at: timestamp,
    last_checked_at: timestamp,
    last_error_code: z.string().max(128).nullable(),
  })
  .strict();
export const marketplaceTargetSchema = z
  .object({
    id: uuid,
    harness_kind: z.enum(["codex", "claude"]),
    install_scope: z.enum(["user", "workspace"]),
    workspace_binding_id: uuid.nullable(),
    status: z.enum(["active", "inactive"]),
    lock_version: count,
  })
  .strict()
  .refine(
    (target) =>
      (target.install_scope === "user") ===
      (target.workspace_binding_id === null),
  );
export const marketplaceSelectionSchema = z
  .object({
    id: uuid,
    registration_id: uuid,
    plugin_key: text,
    audience: z.enum(["workspace", "installation"]),
    harness_kind: z.enum(["codex", "claude"]),
    install_scope: z.enum(["user", "workspace"]),
    target_id: uuid.nullable(),
    enabled: z.boolean(),
    lock_version: count,
  })
  .strict()
  .refine(
    (selection) =>
      (selection.audience === "workspace") === (selection.target_id === null),
  );
const fileSchema = z
  .object({
    relative_path: text,
    git_blob_oid: gitOid,
    sha256,
    byte_size: count,
    executable: z.boolean(),
  })
  .strict();
const packageSchema = z
  .object({
    id: uuid,
    plugin_key: text,
    package_root: text,
    declared_version: text.nullable(),
    inventory_encoding: z.literal("tree_sha256_v1"),
    package_sha256: sha256,
    package_bytes: count,
    file_count: count.positive(),
    provenance: z
      .object({
        provider_repository_id: count.positive(),
        repository_owner: text,
        repository_name: text,
        commit_sha: gitOid,
        catalog_snapshot_id: uuid,
        manifest_sha256: sha256,
      })
      .strict(),
  })
  .strict();
const catalogSchema = z
  .object({
    ...envelope,
    registration: marketplaceRegistrationSchema,
    entries: z.array(
      z
        .object({
          plugin_key: text,
          package_root: text.nullable(),
          declared_version: text.nullable(),
          status: z.enum(["complete_local", "unresolved"]),
          package_version_id: uuid.nullable(),
          package_sha256: sha256.nullable(),
          file_count: count.nullable(),
          package_bytes: count.nullable(),
        })
        .strict(),
    ),
  })
  .strict();
const itemIdentity = {
  selection_id: uuid,
  registration_id: uuid,
  plugin_key: text,
  enabled: z.boolean(),
  mode: z.enum(["managed", "native"]),
};
const reconciliationSchema = z
  .object({
    ...envelope,
    refresh_requested: z.boolean(),
    target: marketplaceTargetSchema,
    items: z.array(
      z.discriminatedUnion("status", [
        z
          .object({
            ...itemIdentity,
            status: z.literal("ready"),
            package: packageSchema
              .extend({ files: z.array(fileSchema).min(1) })
              .strict(),
            bundle_path: text,
          })
          .strict(),
        z
          .object({
            ...itemIdentity,
            status: z.enum(["disabled", "unavailable", "collision"]),
          })
          .strict(),
        z
          .object({
            selection_id: uuid,
            status: z.literal("authorization_required"),
          })
          .strict(),
      ]),
    ),
  })
  .strict();
const bundleSchema = z
  .object({
    ...envelope,
    registration_id: uuid,
    package: packageSchema
      .extend({ files: z.array(fileSchema).min(1) })
      .strict(),
    files: z
      .array(fileSchema.extend({ content_base64: z.string() }).strict())
      .min(1),
  })
  .strict();

export type MarketplaceRegistration = z.infer<
  typeof marketplaceRegistrationSchema
>;
export type MarketplaceTarget = z.infer<typeof marketplaceTargetSchema>;
export type MarketplaceSelection = z.infer<typeof marketplaceSelectionSchema>;
export type MarketplaceReconciliation = z.infer<typeof reconciliationSchema>;
export type MarketplaceBundle = z.infer<typeof bundleSchema>;
export interface MarketplaceLimits {
  response_bytes: number;
  file_bytes: number;
  total_bytes: number;
  file_count: number;
  tree_entries: number;
}
export const defaultMarketplaceLimits: MarketplaceLimits = {
  response_bytes: 128 * 1024 * 1024,
  file_bytes: 32 * 1024 * 1024,
  total_bytes: 64 * 1024 * 1024,
  file_count: 5000,
  tree_entries: 20_000,
};

export class MarketplaceApiClient {
  private readonly baseUrl: URL;

  constructor(
    apiUrl: string,
    private readonly clientVersion: string,
    private readonly fetcher: typeof fetch = fetch,
    private readonly maximumResponseBytes = defaultMarketplaceLimits.response_bytes,
    private readonly authorizationToken?: string,
  ) {
    this.baseUrl = tenantBaseUrl(apiUrl);
    if (
      authorizationToken !== undefined &&
      !opaqueAuthorization.safeParse(authorizationToken).success
    )
      throw new HivemndError(
        "CONFIG_INVALID",
        "Invalid temporary marketplace authorization",
      );
    if (
      !Number.isSafeInteger(maximumResponseBytes) ||
      maximumResponseBytes < 1
    ) {
      throw new HivemndError(
        "CONFIG_INVALID",
        "Marketplace response capacity must be positive",
      );
    }
  }

  async startAuthorization(token: string, challenge: string) {
    this.authorizationValue(challenge);
    const schema = z
      .object({
        ...envelope,
        authorization_id: opaqueAuthorization,
        verification_uri: z.url(),
        expires_at: z.iso.datetime(),
        poll_interval_seconds: z.literal(2),
      })
      .strict();
    const result = await this.request(token, "authorizations", "POST", schema, {
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    const expected = new URL(
      `marketplace/authorizations/${result.authorization_id}`,
      this.baseUrl,
    );
    if (result.verification_uri !== expected.href)
      throw new HivemndError(
        "PATH_UNSAFE",
        "Marketplace verification URI differs from the configured tenant handoff",
      );
    return result;
  }
  async exchangeAuthorization(token: string, id: string, verifier: string) {
    this.authorizationValue(id);
    if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier))
      throw new HivemndError("CONFIG_INVALID", "Invalid PKCE verifier");
    const schema = z.discriminatedUnion("status", [
      z
        .object({
          ...envelope,
          status: z.literal("pending"),
          expires_at: z.iso.datetime(),
          poll_interval_seconds: z.literal(2),
        })
        .strict(),
      z
        .object({
          ...envelope,
          status: z.literal("authorized"),
          authorization_token: opaqueAuthorization,
          expires_at: z.iso.datetime(),
        })
        .strict(),
    ]);
    return await this.request(
      token,
      `authorizations/${id}/exchange`,
      "POST",
      schema,
      { code_verifier: verifier },
    );
  }
  async revokeAuthorization(token: string): Promise<void> {
    const response = await this.response(token, "authorization", "DELETE");
    await response.body?.cancel();
    if (response.status !== 204)
      throw new HivemndError(
        "MANIFEST_INVALID",
        "Invalid marketplace revocation response",
      );
  }
  private authorizationValue(value: string): void {
    if (!opaqueAuthorization.safeParse(value).success)
      throw new HivemndError(
        "CONFIG_INVALID",
        "Invalid marketplace authorization identifier or challenge",
      );
  }

  async registrations(token: string): Promise<MarketplaceRegistration[]> {
    const schema = z
      .object({
        ...envelope,
        registrations: z.array(marketplaceRegistrationSchema),
        unavailable: z.array(
          z
            .object({
              id: uuid,
              error: z.string().regex(/^[a-z][a-z0-9_]{0,127}$/),
            })
            .strict(),
        ),
        private_access_error: z
          .literal("github_authorization_required")
          .nullable(),
      })
      .strict();
    return (await this.request(token, "registrations", "GET", schema))
      .registrations;
  }

  async saveRegistration(
    token: string,
    id: string | undefined,
    body: Readonly<Record<string, unknown>>,
  ): Promise<MarketplaceRegistration> {
    const schema = z
      .object({ ...envelope, registration: marketplaceRegistrationSchema })
      .strict();
    return (
      await this.request(
        token,
        this.path("registrations", id),
        id ? "PATCH" : "POST",
        schema,
        body,
      )
    ).registration;
  }

  async refresh(
    token: string,
    id: string,
    body: Readonly<Record<string, unknown>>,
  ): Promise<MarketplaceRegistration> {
    const schema = z
      .object({ ...envelope, registration: marketplaceRegistrationSchema })
      .strict();
    return (
      await this.request(
        token,
        `${this.path("registrations", id)}/refresh`,
        "POST",
        schema,
        body,
      )
    ).registration;
  }

  async catalog(
    token: string,
    id: string,
  ): Promise<z.infer<typeof catalogSchema>> {
    return await this.request(
      token,
      `${this.path("registrations", id)}/catalog`,
      "GET",
      catalogSchema,
    );
  }

  async targets(token: string): Promise<MarketplaceTarget[]> {
    const schema = z
      .object({ ...envelope, targets: z.array(marketplaceTargetSchema) })
      .strict();
    return (await this.request(token, "targets", "GET", schema)).targets;
  }

  async saveTarget(
    token: string,
    id: string | undefined,
    body: Readonly<Record<string, unknown>>,
  ): Promise<MarketplaceTarget> {
    const schema = z
      .object({ ...envelope, target: marketplaceTargetSchema })
      .strict();
    return (
      await this.request(
        token,
        this.path("targets", id),
        id ? "PATCH" : "POST",
        schema,
        body,
      )
    ).target;
  }

  async selections(token: string): Promise<MarketplaceSelection[]> {
    const schema = z
      .object({ ...envelope, selections: z.array(marketplaceSelectionSchema) })
      .strict();
    return (await this.request(token, "selections", "GET", schema)).selections;
  }

  async saveSelection(
    token: string,
    id: string | undefined,
    body: Readonly<Record<string, unknown>>,
  ): Promise<MarketplaceSelection> {
    const schema = z
      .object({ ...envelope, selection: marketplaceSelectionSchema })
      .strict();
    return (
      await this.request(
        token,
        this.path("selections", id),
        id ? "PATCH" : "POST",
        schema,
        body,
      )
    ).selection;
  }

  async reconciliation(
    token: string,
    targetId: string,
  ): Promise<MarketplaceReconciliation> {
    return await this.request(
      token,
      `reconciliation?target_id=${this.identifier(targetId)}`,
      "GET",
      reconciliationSchema,
    );
  }

  async bundle(
    token: string,
    id: string,
    limits: MarketplaceLimits,
  ): Promise<MarketplaceBundle> {
    const query = new URLSearchParams(
      Object.entries(limits).map(([key, value]) => [key, String(value)]),
    );
    return await this.request(
      token,
      `${this.path("packages", id)}/bundle?${query}`,
      "GET",
      bundleSchema,
    );
  }

  private path(resource: string, id: string | undefined): string {
    return id === undefined ? resource : `${resource}/${this.identifier(id)}`;
  }

  private identifier(id: string): string {
    if (!uuid.safeParse(id).success)
      throw new HivemndError(
        "CONFIG_INVALID",
        "Marketplace identifier must be a UUID",
      );
    return id;
  }

  private async request<
    T extends { schema_version: 1; minimum_client_version: string },
  >(
    token: string,
    path: string,
    method: "GET" | "POST" | "PATCH",
    schema: z.ZodType<T>,
    body?: Readonly<Record<string, unknown>>,
  ): Promise<T> {
    try {
      const response = await this.response(token, path, method, body);
      const value = schema.safeParse(
        JSON.parse(await this.readBounded(response)) as unknown,
      );
      if (!value.success)
        throw new HivemndError(
          "MANIFEST_INVALID",
          "Invalid marketplace response contract",
        );
      if (
        !isBoundedSemver(this.clientVersion) ||
        compareSemver(this.clientVersion, value.data.minimum_client_version) < 0
      ) {
        throw new HivemndError(
          "CLIENT_UPDATE_REQUIRED",
          "Update Hivemnd CLI before using this marketplace response",
        );
      }
      return value.data;
    } catch (error: unknown) {
      if (error instanceof HivemndError) throw error;
      throw new HivemndError(
        "HTTP_FAILED",
        "Marketplace API request unavailable",
        { cause: error },
      );
    }
  }

  private async response(
    token: string,
    path: string,
    method: "GET" | "POST" | "PATCH" | "DELETE",
    body?: Readonly<Record<string, unknown>>,
  ): Promise<Response> {
    try {
      const url = new URL(`api/v1/marketplace/${path}`, this.baseUrl);
      const response = await this.fetcher(url, {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
        headers: {
          accept: "application/json",
          authorization: `Bearer ${token}`,
          ...clientRuntimeHeaders({
            clientVersion: this.clientVersion,
            clientFeatures: clientTechnicalFeatures,
          }),
          ...(body === undefined ? {} : { "content-type": "application/json" }),
          ...(this.authorizationToken === undefined
            ? {}
            : {
                "x-hivemnd-marketplace-authorization": this.authorizationToken,
              }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (
        response.url &&
        !isWithinTenant(new URL(response.url), this.baseUrl)
      ) {
        throw new HivemndError(
          "PATH_UNSAFE",
          "Marketplace response left the configured tenant",
        );
      }
      if (!response.ok) {
        if (path.startsWith("authorizations")) {
          let reason: string | undefined;
          try {
            const parsed = z
              .object({ ...envelope, error: authorizationError })
              .strict()
              .safeParse(
                JSON.parse(await this.readBounded(response)) as unknown,
              );
            if (parsed.success) reason = parsed.data.error;
          } catch {
            /* Raw provider and server errors never become CLI messages. */
          }
          if (reason)
            throw new HivemndError(
              "HTTP_FAILED",
              `Marketplace authorization failed: ${reason}`,
            );
        }
        await response.body?.cancel();
        const code =
          response.status === 401
            ? "AUTH_MISSING"
            : response.status === 409
              ? "SYNC_CONFLICT"
              : "HTTP_FAILED";
        throw new HivemndError(
          code,
          response.status === 403
            ? "Marketplace access denied; private sources require verified GitHub authorization"
            : `Marketplace API request failed (${response.status})`,
        );
      }
      return response;
    } catch (error: unknown) {
      if (error instanceof HivemndError) throw error;
      throw new HivemndError(
        "HTTP_FAILED",
        "Marketplace API request unavailable",
        { cause: error },
      );
    }
  }

  private async readBounded(response: Response): Promise<string> {
    const length = response.headers.get("content-length");
    if (
      length !== null &&
      (!/^\d+$/.test(length) || Number(length) > this.maximumResponseBytes)
    ) {
      throw new HivemndError(
        "MANIFEST_INVALID",
        "Marketplace response exceeds configured capacity",
      );
    }
    if (!response.body)
      throw new HivemndError(
        "MANIFEST_INVALID",
        "Marketplace response has no body",
      );
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > this.maximumResponseBytes)
          throw new HivemndError(
            "MANIFEST_INVALID",
            "Marketplace response exceeds configured capacity",
          );
        chunks.push(next.value);
      }
      return new TextDecoder("utf-8", { fatal: true }).decode(
        Buffer.concat(chunks),
      );
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
  }
}
