export const agentKinds = ["codex", "claude"] as const;
export type AgentKind = (typeof agentKinds)[number];

export const artifactKinds = [
  "agent_definition",
  "command",
  "document",
  "embedded_document",
  "hook",
  "mcp",
  "routine",
  "skill",
] as const;
export type ArtifactKind = (typeof artifactKinds)[number];

export const destinationScopes = ["root", "workspace", "directory"] as const;
export type DestinationScope = (typeof destinationScopes)[number];

export interface DestinationConfig {
  readonly name: string;
  readonly agent: AgentKind;
  readonly scope: DestinationScope;
  readonly path?: string | undefined;
}

export interface HivemndConfig {
  readonly apiUrl: string;
  readonly destinations: readonly DestinationConfig[];
}

export interface ManifestArtifact {
  readonly artifactVersionId: string;
  readonly logicalId: string;
  readonly kind: ArtifactKind;
  readonly version: number;
  readonly relativePath: string;
  readonly size: number;
  readonly sha256: string;
  readonly contentPath: string;
  readonly targets: readonly AgentKind[];
}

export interface Artifact extends ManifestArtifact {
  readonly content: Uint8Array;
}

export interface SyncManifest {
  readonly schemaVersion: 1;
  readonly minimumClientVersion: string;
  readonly release: { readonly id: string; readonly sequence: number };
  readonly generatedAt: Date;
  readonly expiresAt: Date;
  readonly policyRevision: string;
  readonly artifacts: readonly ManifestArtifact[];
}

export interface PreparedManifest extends Omit<SyncManifest, "artifacts"> {
  readonly artifacts: readonly Artifact[];
}

export type ChangeKind =
  "adopt" | "create" | "update" | "remove" | "unchanged" | "conflict";
export type ConflictReason =
  | "unmanaged-existing-file"
  | "owned-file-missing"
  | "owned-content-drift"
  | "artifact-ownership-mismatch";

export interface OwnershipEntry {
  readonly relativePath: string;
  readonly logicalId: string;
  readonly artifactVersionId: string;
  readonly sha256: string;
  readonly releaseId: string;
}

export interface SyncChange {
  readonly artifact?: Artifact;
  readonly owned?: OwnershipEntry;
  readonly agent: AgentKind;
  readonly destinationName: string;
  readonly relativePath: string;
  readonly destination: string;
  readonly kind: ChangeKind;
  readonly conflictReason?: ConflictReason;
}

export interface ApplyResult {
  readonly applied: number;
  readonly operations: SyncReceipt["operations"];
}

export interface ResolvedToken {
  readonly value: string;
  readonly source: "environment" | "keychain";
}

export interface TokenStore {
  get(): Promise<ResolvedToken | undefined>;
  save(token: string): Promise<void>;
}

export interface EnrollmentResult {
  readonly accessToken: string;
  readonly installationId: string;
}

export interface EnrollmentClient {
  readonly clientKind: "hivemnd_cli";
  readonly platform: string;
  readonly clientVersion: string;
}

export const sourceAdapterKinds = ["postgresql_database"] as const;
export type SourceAdapterKind = (typeof sourceAdapterKinds)[number];

export const sourceStatuses = [
  "pending",
  "active",
  "degraded",
  "disabled",
] as const;
export type SourceStatus = (typeof sourceStatuses)[number];

export const sourceActionKeys = [
  "inspect_schema",
  "execute_approved_read_query",
] as const;
export type SourceActionKey = (typeof sourceActionKeys)[number];

export const sourceActionStatuses = [
  "available",
  "unavailable",
  "disabled",
] as const;
export type SourceActionStatus = (typeof sourceActionStatuses)[number];

export interface SourceAction {
  readonly key: SourceActionKey;
  readonly status: SourceActionStatus;
}

export interface SourceSummary {
  readonly id: string;
  readonly name: string;
  readonly adapterKind: SourceAdapterKind;
  readonly status: SourceStatus;
  readonly actions: readonly SourceAction[];
}

export interface SourceSchema {
  readonly source: Pick<SourceSummary, "id" | "name" | "adapterKind">;
  readonly schemas: readonly {
    readonly name: string;
    readonly tables: readonly {
      readonly name: string;
      readonly columns: readonly {
        readonly name: string;
        readonly dataType: string;
        readonly nullable: boolean;
      }[];
    }[];
  }[];
}

export type ReceiptAction = "create" | "update" | "remove" | "unchanged";
export interface SyncReceipt {
  readonly idempotencyKey: string;
  readonly releaseId: string;
  readonly status: "applied";
  readonly operations: readonly {
    readonly artifactVersionId: string;
    readonly target: AgentKind;
    readonly action: ReceiptAction;
    readonly result: "applied" | "skipped";
  }[];
}

export interface ApiClient {
  manifest(token: string): Promise<SyncManifest>;
  exchangeEnrollment(
    enrollmentToken: string,
    client: EnrollmentClient,
  ): Promise<EnrollmentResult>;
  listSources(token: string): Promise<readonly SourceSummary[]>;
  inspectSourceSchema(token: string, sourceId: string): Promise<SourceSchema>;
  download(token: string, artifact: ManifestArtifact): Promise<Uint8Array>;
  receipt(token: string, receipt: SyncReceipt): Promise<void>;
}

export interface AgentAdapter {
  readonly name: string;
  readonly kind: AgentKind;
  readonly root: string;
  destination(relativePath: string): string;
  read(relativePath: string): Promise<Uint8Array | undefined>;
  write(relativePath: string, content: Uint8Array): Promise<void>;
  remove(relativePath: string): Promise<void>;
  readOwnership(): Promise<readonly OwnershipEntry[]>;
  replaceOwnership(entries: readonly OwnershipEntry[]): Promise<void>;
}

export interface Output {
  write(message: string): void;
  error(message: string): void;
}
