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
import type { AgentKind, Artifact, PreparedManifest } from "../domain.js";
import { assertDefined, HivemndError } from "../errors.js";
import { profileKey } from "../organizations/registry.js";
import { tenantBaseUrl } from "../tenant-url.js";
import { sha256 } from "../sync/hash.js";

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

const cacheManifestSchema = z.object({
  version: z.literal(1),
  organizationKey: z.string().regex(/^[a-f\d]{16}$/),
  apiUrl: z.url(),
  releaseId: z.string().min(1),
  entries: z.array(cacheEntrySchema),
});

type CacheManifest = z.infer<typeof cacheManifestSchema>;

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
    const entries = desired.map((artifact) => {
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
        targets: [...artifact.targets],
        file,
      };
    });
    assertOutputLimits(entries, contents);
    const current = await this.readCurrentOptional();
    if (entries.length === 0) {
      return {
        kind: current ? "remove" : "unchanged",
        contents,
      };
    }
    const next = cacheManifestSchema.parse({
      version: 1,
      organizationKey: this.organizationKey,
      apiUrl: this.apiUrl,
      releaseId: manifest.release.id,
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

  async read(client: AgentKind): Promise<string> {
    const manifest = await this.readCurrentOptional();
    if (!manifest) return "";
    const bodies = await this.readManifestContent(manifest, client);
    const output = bodies.join("\n");
    if (Buffer.byteLength(output) > MAX_ALWAYS_CONTEXT_BYTES) {
      throw new HivemndError(
        "INTEGRITY_FAILED",
        `Always-context output exceeds the ${MAX_ALWAYS_CONTEXT_BYTES}-byte limit`,
      );
    }
    return output;
  }

  private async readCurrentOptional(): Promise<CacheManifest | undefined> {
    const content = await readOptional(this.currentPath());
    if (!content) return undefined;
    try {
      const parsed = cacheManifestSchema.parse(
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
    manifest: CacheManifest,
    client?: AgentKind,
  ): Promise<string[]> {
    const entries = client
      ? manifest.entries.filter((entry) => entry.targets.includes(client))
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
        const markdown = decoder.decode(content);
        bodies.push(markdown.endsWith("\n") ? markdown : `${markdown}\n`);
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

export function isAlwaysContextArtifact(artifact: Artifact): boolean {
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
): void {
  for (const client of ["codex", "claude"] as const) {
    const size = entries
      .filter((entry) => entry.targets.includes(client))
      .reduce((total, entry, index) => {
        const content = contents.get(entry.file);
        assertDefined(content, "Always-context bytes disappeared");
        return total + content.byteLength + (index === 0 ? 0 : 1);
      }, 0);
    if (size > MAX_ALWAYS_CONTEXT_BYTES) {
      throw new HivemndError(
        "MANIFEST_INVALID",
        `Always-context output for ${client} exceeds the ${MAX_ALWAYS_CONTEXT_BYTES}-byte limit`,
      );
    }
  }
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
