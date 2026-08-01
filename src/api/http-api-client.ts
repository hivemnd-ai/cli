import { z } from "zod";
import {
  agentKinds,
  artifactKinds,
  installScopes,
  sourceActionKeys,
  sourceActionStatuses,
  sourceAdapterKinds,
  sourceStatuses,
  type ApiClient,
  type ClientConfiguration,
  type EnrollmentClient,
  type EnrollmentResult,
  type ManifestArtifact,
  type SourceSchema,
  type SourceSummary,
  type SyncManifest,
  type SyncReceipt,
} from "../domain.js";
import {
  clientRuntimeHeaders,
  type ClientRuntimeMetadata,
} from "../client/runtime-contract.js";
import { HivemndError } from "../errors.js";
import { isBoundedSemver, parseSemver } from "../version/semver.js";
import {
  isWithinTenant,
  resolveTenantUrl,
  tenantBaseUrl,
} from "../tenant-url.js";

export const apiPaths = {
  enrollment: "api/v1/enrollments/exchange",
  enrollmentPreview: "api/v1/enrollments/preview",
  clientConfiguration: "api/v1/client-configuration",
  manifest: "api/v1/sync/manifest",
  receipts: "api/v1/sync/receipts",
  sources: "api/v1/sources",
} as const;

const deliveryTargetSchema = z
  .object({
    client_kind: z.enum(agentKinds),
    install_scope: z.enum(installScopes),
    minimum_client_version: z
      .string()
      .refine(isBoundedSemver, {
        message:
          "minimum_client_version must be valid SemVer within 128 UTF-8 bytes",
      })
      .nullable(),
  })
  .strict();

const manifestSchema = z.object({
  schema_version: z.literal(1),
  minimum_client_version: z
    .string()
    .refine((value) => parseSemver(value) !== undefined, {
      message: "minimum_client_version must be valid SemVer",
    }),
  release: z.object({
    id: z.string().min(1),
    sequence: z.number().int().nonnegative(),
  }),
  generated_at: z.iso.datetime(),
  expires_at: z.iso.datetime(),
  policy_revision: z.string().min(1),
  always_context_byte_limit: z.number().int().min(0).max(10_000).optional(),
  artifacts: z.array(
    z
      .object({
        artifact_version_id: z.string().min(1),
        logical_id: z.string().min(1),
        kind: z.enum(artifactKinds),
        version: z.number().int().positive(),
        relative_path: z.string().min(1),
        size: z.number().int().nonnegative(),
        sha256: z.string().regex(/^[a-f\d]{64}$/),
        content_path: z.string().startsWith("/"),
        targets: z.array(z.enum(agentKinds)).min(1),
        delivery_targets: z.array(deliveryTargetSchema).min(1).optional(),
      })
      .superRefine(validateWireTargets),
  ),
});

const enrollmentSchema = z.object({
  access_token: z.string().min(1),
  installation_id: z.string().min(1),
});

const clientConfigurationSchema = z
  .object({
    organization: z
      .object({ name: z.string().min(1), slug: z.string().min(1) })
      .strict(),
    enabled_clients: z.array(z.enum(agentKinds)),
    installation: z
      .object({
        client_version: z.string().min(1),
        capability_keys: z.array(z.string().min(1)),
      })
      .strict()
      .optional(),
  })
  .strict();

const sourceIdentitySchema = z
  .object({
    id: z.uuid(),
    name: z.string().min(1),
    adapter_kind: z.enum(sourceAdapterKinds),
  })
  .strict();

const postgresqlSourceIdentitySchema = sourceIdentitySchema.extend({
  adapter_kind: z.literal("postgresql_database"),
});

const sourcesSchema = z
  .object({
    sources: z.array(
      sourceIdentitySchema
        .extend({
          status: z.enum(sourceStatuses),
          actions: z.array(
            z
              .object({
                key: z.enum(sourceActionKeys),
                status: z.enum(sourceActionStatuses),
              })
              .strict(),
          ),
        })
        .strict(),
    ),
  })
  .strict();

const sourceSchemaSchema = z
  .object({
    source: postgresqlSourceIdentitySchema,
    schemas: z.array(
      z
        .object({
          name: z.string().min(1),
          tables: z.array(
            z
              .object({
                name: z.string().min(1),
                columns: z.array(
                  z
                    .object({
                      name: z.string().min(1),
                      data_type: z.string().min(1),
                      nullable: z.boolean(),
                    })
                    .strict(),
                ),
              })
              .strict(),
          ),
        })
        .strict(),
    ),
  })
  .strict();

export class HttpApiClient implements ApiClient {
  private readonly baseUrl: URL;

  constructor(
    baseUrl: string,
    private readonly fetcher: typeof fetch = fetch,
    private readonly now: () => Date = () => new Date(),
    private readonly runtimeMetadata?: ClientRuntimeMetadata,
  ) {
    this.baseUrl = tenantBaseUrl(baseUrl);
  }

  async previewEnrollment(
    enrollmentToken: string,
  ): Promise<ClientConfiguration> {
    const response = await this.request(
      apiPaths.enrollmentPreview,
      undefined,
      "POST",
      { enrollment_token: enrollmentToken },
    );
    return this.parseClientConfiguration(response);
  }

  async clientConfiguration(token: string): Promise<ClientConfiguration> {
    const response = await this.request(
      apiPaths.clientConfiguration,
      token,
      "GET",
    );
    return this.parseClientConfiguration(response);
  }

  async manifest(token: string): Promise<SyncManifest> {
    const response = await this.request(apiPaths.manifest, token, "GET");
    try {
      const wire = manifestSchema.parse(await response.json());
      const expiresAt = new Date(wire.expires_at);
      if (expiresAt <= this.now()) {
        throw new HivemndError(
          "MANIFEST_EXPIRED",
          `Manifest expired at ${wire.expires_at}`,
        );
      }
      return {
        schemaVersion: wire.schema_version,
        minimumClientVersion: wire.minimum_client_version,
        release: wire.release,
        generatedAt: new Date(wire.generated_at),
        expiresAt,
        policyRevision: wire.policy_revision,
        alwaysContextByteLimit: wire.always_context_byte_limit ?? 10_000,
        artifacts: wire.artifacts.map((artifact): ManifestArtifact => ({
          artifactVersionId: artifact.artifact_version_id,
          logicalId: artifact.logical_id,
          kind: artifact.kind,
          version: artifact.version,
          relativePath: artifact.relative_path,
          size: artifact.size,
          sha256: artifact.sha256,
          contentPath: artifact.content_path,
          targets: artifact.targets,
          deliveryTargets: artifact.delivery_targets
            ? artifact.delivery_targets.map((target) => ({
                clientKind: target.client_kind,
                installScope: target.install_scope,
                ...(target.minimum_client_version
                  ? { minimumClientVersion: target.minimum_client_version }
                  : {}),
              }))
            : artifact.targets.map((clientKind) => ({
                clientKind,
                installScope: "any" as const,
              })),
        })),
      };
    } catch (error: unknown) {
      if (error instanceof HivemndError) throw error;
      throw new HivemndError("MANIFEST_INVALID", "Invalid sync manifest", {
        cause: error,
      });
    }
  }

  async exchangeEnrollment(
    enrollmentToken: string,
    client: EnrollmentClient,
  ): Promise<EnrollmentResult> {
    const response = await this.request(
      apiPaths.enrollment,
      undefined,
      "POST",
      {
        enrollment_token: enrollmentToken,
        client_kind: client.clientKind,
        platform: client.platform,
        client_version: client.clientVersion,
      },
    );
    try {
      const result = enrollmentSchema.parse(await response.json());
      return {
        accessToken: result.access_token,
        installationId: result.installation_id,
      };
    } catch (error: unknown) {
      throw new HivemndError(
        "ENROLLMENT_INVALID",
        "Invalid enrollment response",
        { cause: error },
      );
    }
  }

  async listSources(token: string): Promise<readonly SourceSummary[]> {
    const response = await this.request(apiPaths.sources, token, "GET");
    try {
      const wire = sourcesSchema.parse(await response.json());
      return wire.sources.map((source) => ({
        id: source.id,
        name: source.name,
        adapterKind: source.adapter_kind,
        status: source.status,
        actions: source.actions,
      }));
    } catch (error: unknown) {
      throw new HivemndError(
        "SOURCES_INVALID",
        "Invalid authorized sources response",
        { cause: error },
      );
    }
  }

  async inspectSourceSchema(
    token: string,
    sourceId: string,
  ): Promise<SourceSchema> {
    const response = await this.request(
      `${apiPaths.sources}/${encodeURIComponent(sourceId)}/schema`,
      token,
      "GET",
    );
    try {
      const wire = sourceSchemaSchema.parse(await response.json());
      return {
        source: {
          id: wire.source.id,
          name: wire.source.name,
          adapterKind: wire.source.adapter_kind,
        },
        schemas: wire.schemas.map((schema) => ({
          name: schema.name,
          tables: schema.tables.map((table) => ({
            name: table.name,
            columns: table.columns.map((column) => ({
              name: column.name,
              dataType: column.data_type,
              nullable: column.nullable,
            })),
          })),
        })),
      };
    } catch (error: unknown) {
      throw new HivemndError(
        "SOURCE_SCHEMA_INVALID",
        "Invalid PostgreSQL source schema response",
        { cause: error },
      );
    }
  }

  async download(
    token: string,
    artifact: ManifestArtifact,
  ): Promise<Uint8Array> {
    const response = await this.request(artifact.contentPath, token, "GET");
    return new Uint8Array(await response.arrayBuffer());
  }

  async receipt(token: string, receipt: SyncReceipt): Promise<void> {
    await this.request(apiPaths.receipts, token, "POST", {
      idempotency_key: receipt.idempotencyKey,
      release_id: receipt.releaseId,
      status: receipt.status,
      operations: receipt.operations.map((operation) => ({
        artifact_version_id: operation.artifactVersionId,
        target: operation.target,
        action: operation.action,
        result: operation.result,
      })),
    });
  }

  private async parseClientConfiguration(
    response: Response,
  ): Promise<ClientConfiguration> {
    try {
      const value = clientConfigurationSchema.parse(await response.json());
      return {
        organization: value.organization,
        enabledClients: value.enabled_clients,
        ...(value.installation
          ? {
              installation: {
                clientVersion: value.installation.client_version,
                capabilityKeys: value.installation.capability_keys,
              },
            }
          : {}),
      };
    } catch (error: unknown) {
      throw new HivemndError(
        "CLIENT_CONFIGURATION_INVALID",
        "Invalid client configuration response",
        { cause: error },
      );
    }
  }

  private async request(
    path: string,
    token: string | undefined,
    method: "GET" | "POST",
    body?: unknown,
  ): Promise<Response> {
    const url = resolveTenantUrl(path, this.baseUrl);
    if (!isWithinTenant(url, this.baseUrl)) {
      throw new HivemndError(
        "PATH_UNSAFE",
        `Remote content path must stay on the configured Hivemnd origin: ${path}`,
      );
    }
    const headers: Record<string, string> = { accept: "application/json" };
    if (token) {
      headers.authorization = `Bearer ${token}`;
      Object.assign(headers, clientRuntimeHeaders(this.runtimeMetadata));
    }
    if (body !== undefined) headers["content-type"] = "application/json";
    const response = await this.fetcher(url, {
      method,
      headers,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new HivemndError(
          "AUTH_MISSING",
          "Hivemnd authentication is missing or no longer valid",
        );
      }
      throw new HivemndError(
        "HTTP_FAILED",
        `Hivemnd API request failed (${response.status})`,
      );
    }
    return response;
  }
}

function validateWireTargets(
  artifact: {
    readonly targets: readonly (typeof agentKinds)[number][];
    readonly delivery_targets?:
      readonly z.infer<typeof deliveryTargetSchema>[] | undefined;
  },
  context: z.core.$RefinementCtx,
): void {
  const legacy = artifact.targets;
  if (
    new Set(legacy).size !== legacy.length ||
    [...legacy].sort().join("\0") !== legacy.join("\0")
  ) {
    context.addIssue({
      code: "custom",
      message: "legacy targets must be unique and sorted",
      path: ["targets"],
    });
  }
  const exact = artifact.delivery_targets;
  if (!exact) return;
  const exactKeys = exact.map(
    (target) =>
      `${target.client_kind}\0${target.install_scope}\0${target.minimum_client_version ?? ""}`,
  );
  if (
    new Set(exactKeys).size !== exactKeys.length ||
    [...exactKeys].sort().join("\0") !== exactKeys.join("\0")
  ) {
    context.addIssue({
      code: "custom",
      message: "delivery_targets must be unique and sorted",
      path: ["delivery_targets"],
    });
  }
  const exactKinds = [...new Set(exact.map((target) => target.client_kind))];
  if (legacy.join("\0") !== exactKinds.join("\0")) {
    context.addIssue({
      code: "custom",
      message: "legacy and exact target client kinds must agree",
      path: ["delivery_targets"],
    });
  }
}
