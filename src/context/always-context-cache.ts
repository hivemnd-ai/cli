import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import type {
  AgentKind,
  Artifact,
  InstallScope,
  ManifestArtifact,
  PreparedManifest,
} from "../domain.js";
import { assertDefined, HivemndError } from "../errors.js";
import { profileKey } from "../organizations/registry.js";
import { tenantBaseUrl } from "../tenant-url.js";
import { sha256 } from "../sync/hash.js";
import { isBoundedSemver } from "../version/semver.js";

export const MAX_ALWAYS_CONTEXT_BYTES = 10_000;

const alwaysContextPath = /^context\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.md$/;
const cachedFilePattern = /^[a-f\d]{64}\.md$/;
const decoder = new TextDecoder("utf-8", { fatal: true });

const cacheEntrySchema = z.object({
  logicalId: z.string().min(1),
  artifactVersionId: z.string().min(1),
  relativePath: z.string().regex(alwaysContextPath),
  sha256: z.string().regex(/^[a-f\d]{64}$/),
  size: z.number().int().nonnegative(),
  targets: z.array(z.enum(["codex", "claude"])).min(1),
  file: z.string().regex(cachedFilePattern),
});

const legacyCacheManifestSchema = z.object({
  version: z.literal(1),
  organizationKey: z.string().regex(/^[a-f\d]{16}$/),
  apiUrl: z.url(),
  releaseId: z.string().min(1),
  entries: z.array(cacheEntrySchema),
});

const boundedSemverSchema = z.string().refine(isBoundedSemver);

// `any` is written only while consuming a legacy manifest that has no exact
// targets. Cache v1 is also read broadly for both scopes. New exact targets are
// persisted as user/workspace and may carry a bounded client minimum.
const cachedDeliveryTargetSchema = z.discriminatedUnion("installScope", [
  z
    .object({
      clientKind: z.enum(["codex", "claude"]),
      installScope: z.literal("any"),
    })
    .strict(),
  z
    .object({
      clientKind: z.enum(["codex", "claude"]),
      installScope: z.enum(["user", "workspace"]),
      minimumClientVersion: boundedSemverSchema.optional(),
    })
    .strict(),
]);

const typedCacheEntrySchema = cacheEntrySchema.omit({ targets: true }).extend({
  deliveryTargets: z.array(cachedDeliveryTargetSchema).min(1),
});

const typedCacheManifestSchema = z.object({
  version: z.literal(2),
  organizationKey: z.string().regex(/^[a-f\d]{16}$/),
  apiUrl: z.url(),
  releaseId: z.string().min(1),
  alwaysContextByteLimit: z.number().int().min(0).max(MAX_ALWAYS_CONTEXT_BYTES),
  entries: z.array(typedCacheEntrySchema),
});

const readableCacheManifestSchema = z.discriminatedUnion("version", [
  legacyCacheManifestSchema,
  typedCacheManifestSchema,
]);

type LegacyCacheManifest = z.infer<typeof legacyCacheManifestSchema>;
type CacheManifest = z.infer<typeof typedCacheManifestSchema>;
type ReadableCacheManifest = z.infer<typeof readableCacheManifestSchema>;

export interface AlwaysContextCacheChange {
  readonly kind: "update" | "remove" | "unchanged";
  readonly manifest?: CacheManifest;
  readonly contents: ReadonlyMap<string, Uint8Array>;
}

export interface AlwaysContextCacheSnapshot {
  readonly current?: Uint8Array;
  readonly versionFiles: ReadonlySet<string>;
}

export interface AlwaysContextCacheOptions {
  readonly stateDirectory: string;
  readonly apiUrl: string;
}

export class AlwaysContextCache {
  readonly root: string;
  private readonly organizationKey: string;
  private readonly apiUrl: string;

  constructor(options: AlwaysContextCacheOptions) {
    const stateDirectory = resolve(options.stateDirectory);
    this.organizationKey = profileKey(options.apiUrl);
    this.apiUrl = tenantBaseUrl(options.apiUrl).href.replace(/\/$/, "");
    this.root = join(
      stateDirectory,
      "organizations",
      this.organizationKey,
      "always-context",
    );
  }

  async plan(manifest: PreparedManifest): Promise<AlwaysContextCacheChange> {
    const desired = manifest.artifacts
      .filter(isAlwaysContextArtifact)
      .sort((left, right) =>
        left.relativePath.localeCompare(right.relativePath),
      );
    validateUniqueContext(desired);
    const contents = new Map<string, Uint8Array>();
    const entries: CacheManifest["entries"] = desired.map((artifact) => {
      validateArtifact(artifact);
      const file = versionFile(artifact.artifactVersionId);
      const existing = contents.get(file);
      if (existing && sha256(existing) !== artifact.sha256) {
        throw new HivemndError(
          "MANIFEST_INVALID",
          `Always-context versions collide: ${artifact.artifactVersionId}`,
        );
      }
      contents.set(file, artifact.content);
      return {
        logicalId: artifact.logicalId,
        artifactVersionId: artifact.artifactVersionId,
        relativePath: artifact.relativePath,
        sha256: artifact.sha256,
        size: artifact.size,
        deliveryTargets: artifact.deliveryTargets.map((target) => ({
          clientKind: target.clientKind,
          installScope: target.installScope,
          ...(target.minimumClientVersion
            ? { minimumClientVersion: target.minimumClientVersion }
            : {}),
        })),
        file,
      };
    });
    const limit = effectiveLimit(manifest.alwaysContextByteLimit);
    assertOutputLimits(entries, contents, limit);
    const current = await this.readCurrentOptional();
    if (entries.length === 0) {
      return {
        kind: current ? "remove" : "unchanged",
        contents,
      };
    }
    const next = typedCacheManifestSchema.parse({
      version: 2,
      organizationKey: this.organizationKey,
      apiUrl: this.apiUrl,
      releaseId: manifest.release.id,
      alwaysContextByteLimit: limit,
      entries,
    });
    if (current && JSON.stringify(current) === JSON.stringify(next)) {
      await this.readManifestContent(current);
      return { kind: "unchanged", manifest: next, contents };
    }
    return { kind: "update", manifest: next, contents };
  }

  async snapshot(): Promise<AlwaysContextCacheSnapshot> {
    const current = await readOptional(this.currentPath());
    const versionFiles = new Set<string>();
    try {
      for (const entry of await readdir(this.versionsPath(), {
        withFileTypes: true,
      })) {
        if (entry.isSymbolicLink() || !entry.isFile()) {
          throw unsafe(
            `Always-context version is not a regular file: ${entry.name}`,
          );
        }
        if (!cachedFilePattern.test(entry.name)) {
          throw unsafe(
            `Unexpected file in always-context cache: ${entry.name}`,
          );
        }
        versionFiles.add(entry.name);
      }
    } catch (error: unknown) {
      if (!isMissing(error)) throw error;
    }
    return { ...(current ? { current } : {}), versionFiles };
  }

  async apply(change: AlwaysContextCacheChange): Promise<void> {
    if (change.kind === "unchanged") return;
    const snapshot = await this.snapshot();
    try {
      await privateDirectory(this.root);
      await privateDirectory(this.versionsPath());
      if (change.kind === "remove") {
        await rm(this.currentPath(), { force: true });
        return;
      }
      const manifest = requireManifest(change);
      for (const entry of manifest.entries) {
        const content = change.contents.get(entry.file);
        if (!content) {
          throw new HivemndError(
            "SYNC_FAILED",
            `Missing always-context bytes for ${entry.artifactVersionId}`,
          );
        }
        await this.writeImmutableVersion(entry.file, content, entry.sha256);
      }
      await atomicWrite(
        this.currentPath(),
        Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`),
      );
    } catch (error: unknown) {
      await this.restore(snapshot);
      throw error;
    }
  }

  async restore(snapshot: AlwaysContextCacheSnapshot): Promise<void> {
    await privateDirectory(this.root);
    await privateDirectory(this.versionsPath());
    if (snapshot.current) {
      await atomicWrite(this.currentPath(), snapshot.current);
    } else {
      await rm(this.currentPath(), { force: true });
    }
    for (const entry of await readdir(this.versionsPath(), {
      withFileTypes: true,
    })) {
      if (!snapshot.versionFiles.has(entry.name)) {
        await rm(join(this.versionsPath(), entry.name), { force: true });
      }
    }
  }

  async read(client: AgentKind, scope: InstallScope = "user"): Promise<string> {
    const manifest = await this.readCurrentOptional();
    if (!manifest) return "";
    const bodies = await this.readManifestContent(manifest, client, scope);
    const output =
      manifest.version === 1 ? renderLegacyBodies(bodies) : bodies.join("\n");
    const limit =
      manifest.version === 1
        ? MAX_ALWAYS_CONTEXT_BYTES
        : manifest.alwaysContextByteLimit;
    if (Buffer.byteLength(output) > limit) {
      throw new HivemndError(
        "INTEGRITY_FAILED",
        `Always-context output exceeds the ${limit}-byte limit`,
      );
    }
    return output;
  }

  private async readCurrentOptional(): Promise<
    ReadableCacheManifest | undefined
  > {
    const content = await readOptional(this.currentPath());
    if (!content) return undefined;
    try {
      const parsed = readableCacheManifestSchema.parse(
        JSON.parse(decoder.decode(content)) as unknown,
      );
      if (
        parsed.organizationKey !== this.organizationKey ||
        tenantBaseUrl(parsed.apiUrl).href !== tenantBaseUrl(this.apiUrl).href
      ) {
        throw new Error("organization identity does not match cache path");
      }
      return parsed;
    } catch (error: unknown) {
      throw new HivemndError(
        "INTEGRITY_FAILED",
        "Always-context ownership metadata is invalid",
        { cause: error },
      );
    }
  }

  private async readManifestContent(
    manifest: ReadableCacheManifest,
    client?: AgentKind,
    scope: InstallScope = "user",
  ): Promise<string[]> {
    const entries = client
      ? manifest.entries.filter((entry) =>
          cacheEntryMatches(manifest, entry, client, scope),
        )
      : manifest.entries;
    const bodies: string[] = [];
    for (const entry of entries) {
      const path = this.versionPath(entry.file);
      const stats = await lstat(path).catch((error: unknown) => {
        throw new HivemndError(
          "INTEGRITY_FAILED",
          `Always-context version is missing or unreadable: ${entry.artifactVersionId}`,
          { cause: error },
        );
      });
      /* v8 ignore start -- guarded by the transaction snapshot; retained for TOCTOU safety */
      if (stats.isSymbolicLink() || !stats.isFile()) {
        throw unsafe(`Always-context version must be a regular file: ${path}`);
      }
      /* v8 ignore stop */
      const content = await readFile(path);
      if (
        content.byteLength !== entry.size ||
        sha256(content) !== entry.sha256
      ) {
        throw new HivemndError(
          "INTEGRITY_FAILED",
          `Always-context version failed verification: ${entry.artifactVersionId}`,
        );
      }
      try {
        bodies.push(decoder.decode(content));
      } catch (error: unknown) {
        throw new HivemndError(
          "INTEGRITY_FAILED",
          `Always-context version is not valid UTF-8: ${entry.artifactVersionId}`,
          { cause: error },
        );
      }
    }
    return bodies;
  }

  private async writeImmutableVersion(
    file: string,
    content: Uint8Array,
    expectedSha256: string,
  ): Promise<void> {
    const path = this.versionPath(file);
    try {
      const stats = await lstat(path);
      /* v8 ignore start -- transaction snapshots reject this state; retained for TOCTOU safety */
      if (stats.isSymbolicLink() || !stats.isFile()) {
        throw unsafe(`Always-context version must be a regular file: ${path}`);
      }
      /* v8 ignore stop */
      const existing = await readFile(path);
      if (sha256(existing) !== expectedSha256) {
        throw new HivemndError(
          "SYNC_CONFLICT",
          `Immutable always-context version was modified: ${path}`,
        );
      }
      return;
    } catch (error: unknown) {
      if (!isMissing(error)) throw error;
    }
    await atomicWrite(path, content);
  }

  private versionPath(file: string): string {
    return resolve(this.versionsPath(), file);
  }

  private currentPath(): string {
    return join(this.root, "current.json");
  }

  private versionsPath(): string {
    return join(this.root, "versions");
  }
}

export function isAlwaysContextArtifact(
  artifact: Pick<ManifestArtifact, "kind" | "relativePath">,
): boolean {
  return (
    artifact.kind === "embedded_document" &&
    alwaysContextPath.test(artifact.relativePath)
  );
}

function validateArtifact(artifact: Artifact): void {
  if (
    artifact.content.byteLength !== artifact.size ||
    sha256(artifact.content) !== artifact.sha256
  ) {
    throw new HivemndError(
      "INTEGRITY_FAILED",
      `Always-context bytes do not match manifest: ${artifact.artifactVersionId}`,
    );
  }
  try {
    decoder.decode(artifact.content);
  } catch (error: unknown) {
    throw new HivemndError(
      "MANIFEST_INVALID",
      `Always-context is not valid UTF-8: ${artifact.relativePath}`,
      { cause: error },
    );
  }
}

function validateUniqueContext(artifacts: readonly Artifact[]): void {
  const logicalIds = new Set<string>();
  const paths = new Set<string>();
  for (const artifact of artifacts) {
    if (
      logicalIds.has(artifact.logicalId) ||
      paths.has(artifact.relativePath)
    ) {
      throw new HivemndError(
        "MANIFEST_INVALID",
        `Duplicate always-context artifact: ${artifact.relativePath}`,
      );
    }
    logicalIds.add(artifact.logicalId);
    paths.add(artifact.relativePath);
  }
}

function assertOutputLimits(
  entries: CacheManifest["entries"],
  contents: ReadonlyMap<string, Uint8Array>,
  limit: number,
): void {
  for (const client of ["codex", "claude"] as const) {
    for (const scope of ["user", "workspace"] as const) {
      const selected = entries.filter((entry) =>
        entry.deliveryTargets.some(
          (target) =>
            target.clientKind === client &&
            (target.installScope === "any" || target.installScope === scope),
        ),
      );
      const size = selected.reduce((total, entry, index) => {
        const content = contents.get(entry.file);
        assertDefined(content, "Always-context bytes disappeared");
        return total + content.byteLength + (index === 0 ? 0 : 1);
      }, 0);
      if (size > limit) {
        throw new HivemndError(
          "MANIFEST_INVALID",
          `Always-context output for ${client}/${scope} exceeds the ${limit}-byte limit`,
        );
      }
    }
  }
}

function effectiveLimit(value: number): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new HivemndError(
      "MANIFEST_INVALID",
      "Always-context limit must be a non-negative integer",
    );
  }
  return Math.min(value, MAX_ALWAYS_CONTEXT_BYTES);
}

function cacheEntryMatches(
  manifest: ReadableCacheManifest,
  entry: ReadableCacheManifest["entries"][number],
  client: AgentKind,
  scope: InstallScope,
): boolean {
  if (manifest.version === 1) {
    return (entry as LegacyCacheManifest["entries"][number]).targets.includes(
      client,
    );
  }
  return (entry as CacheManifest["entries"][number]).deliveryTargets.some(
    (target) =>
      target.clientKind === client &&
      (target.installScope === "any" || target.installScope === scope),
  );
}

function renderLegacyBodies(bodies: readonly string[]): string {
  return bodies
    .map((body) => (body.endsWith("\n") ? body : `${body}\n`))
    .join("\n");
}

function versionFile(artifactVersionId: string): string {
  return `${sha256(Buffer.from(artifactVersionId))}.md`;
}

function requireManifest(change: AlwaysContextCacheChange): CacheManifest {
  if (!change.manifest) {
    throw new HivemndError(
      "SYNC_FAILED",
      "Missing always-context cache manifest",
    );
  }
  return change.manifest;
}

async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}

async function atomicWrite(path: string, content: Uint8Array): Promise<void> {
  await privateDirectory(dirname(path));
  const temporary = `${path}.hivemnd-${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { mode: 0o600, flag: "wx" });
    await chmod(temporary, 0o600);
    await rename(temporary, path);
    await chmod(path, 0o600);
  } catch (error: unknown) {
    /* v8 ignore start -- cleanup path for an injected filesystem failure */
    await rm(temporary, { force: true });
    throw error;
    /* v8 ignore stop */
  }
}

async function readOptional(path: string): Promise<Uint8Array | undefined> {
  try {
    const stats = await lstat(path);
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw unsafe(`Always-context metadata must be a regular file: ${path}`);
    }
    return await readFile(path);
  } catch (error: unknown) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

function unsafe(message: string): HivemndError {
  return new HivemndError("PATH_UNSAFE", message);
}

function isMissing(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
