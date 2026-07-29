import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type {
  ApiClient,
  Artifact,
  HivemndConfig,
  Output,
  PreparedManifest,
  SyncManifest,
} from "../src/domain.js";

export const bytes = (value: string): Uint8Array => Buffer.from(value);
export const hash = (value: string | Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

export function manifest(content = "# Team skill\n"): SyncManifest {
  const body = bytes(content);
  return {
    schemaVersion: 1,
    minimumClientVersion: "0.1.0",
    release: { id: "release-1", sequence: 1 },
    generatedAt: new Date("2026-07-25T10:00:00.000Z"),
    expiresAt: new Date("2026-07-26T10:00:00.000Z"),
    policyRevision: "policy-1",
    artifacts: [
      {
        artifactVersionId: "version-1",
        logicalId: "artifact-1",
        kind: "skill",
        version: 1,
        relativePath: "skills/team/SKILL.md",
        size: body.byteLength,
        sha256: hash(body),
        contentPath: "/api/v1/artifact-versions/version-1/content",
        targets: ["codex", "claude"],
      },
    ],
  };
}

export function prepared(content = "# Team skill\n"): PreparedManifest {
  const base = manifest(content);
  return {
    ...base,
    artifacts: base.artifacts.map((artifact): Artifact => ({
      ...artifact,
      content: bytes(content),
    })),
  };
}

export function wireManifest(content = "# Team skill\n") {
  const source = manifest(content);
  return {
    schema_version: 1,
    minimum_client_version: source.minimumClientVersion,
    release: source.release,
    generated_at: source.generatedAt.toISOString(),
    expires_at: source.expiresAt.toISOString(),
    policy_revision: source.policyRevision,
    artifacts: source.artifacts.map((artifact) => ({
      artifact_version_id: artifact.artifactVersionId,
      logical_id: artifact.logicalId,
      kind: artifact.kind,
      version: artifact.version,
      relative_path: artifact.relativePath,
      size: artifact.size,
      sha256: artifact.sha256,
      content_path: artifact.contentPath,
      targets: artifact.targets,
    })),
  };
}

export function config(root: string): HivemndConfig {
  return {
    apiUrl: "https://shared.hivemnd.cloud/eigen",
    destinations: [
      {
        name: "codex-workspace",
        agent: "codex",
        scope: "workspace",
        path: join(root, "codex-workspace"),
      },
      {
        name: "claude-workspace",
        agent: "claude",
        scope: "workspace",
        path: join(root, "claude-workspace"),
      },
    ],
  };
}

export function api(content = "# Team skill\n"): ApiClient & {
  receipts: unknown[];
} {
  const receipts: unknown[] = [];
  return {
    receipts,
    previewEnrollment: async () => ({
      organization: { name: "Eigen", slug: "eigen" },
      enabledClients: ["codex", "claude"],
    }),
    clientConfiguration: async () => ({
      organization: { name: "Eigen", slug: "eigen" },
      enabledClients: ["codex", "claude"],
    }),
    manifest: async () => manifest(content),
    exchangeEnrollment: async () => ({
      accessToken: "enrolled-token",
      installationId: "installation-1",
    }),
    listSources: async () => [],
    inspectSourceSchema: async () => ({
      source: {
        id: "00000000-0000-4000-8000-000000000001",
        name: "Engineering",
        adapterKind: "postgresql_database",
      },
      schemas: [],
    }),
    download: async () => bytes(content),
    receipt: async (_token, value) => {
      receipts.push(value);
    },
  };
}

export function captureOutput(): Output & {
  messages: string[];
  errors: string[];
} {
  const messages: string[] = [];
  const errors: string[] = [];
  return {
    messages,
    errors,
    write: (message) => messages.push(message),
    error: (message) => errors.push(message),
  };
}

export async function temporaryDirectory(): Promise<{
  path: string;
  cleanup: () => Promise<void>;
}> {
  const path = await mkdtemp(join(tmpdir(), "hivemnd-cli-test-"));
  return { path, cleanup: () => rm(path, { recursive: true, force: true }) };
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value), "utf8");
}
