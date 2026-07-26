import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";
import type { AgentAdapter, AgentKind, OwnershipEntry } from "../domain.js";
import { HivemndError } from "../errors.js";

const ownershipLedgerSchema = z.object({
  version: z.literal(2),
  artifacts: z.record(
    z.string(),
    z.object({
      logicalId: z.string().min(1),
      artifactVersionId: z.string().min(1),
      sha256: z.string().regex(/^[a-f\d]{64}$/),
      releaseId: z.string().min(1),
    }),
  ),
});

export class FilesystemAgentAdapter implements AgentAdapter {
  constructor(
    readonly name: string,
    readonly kind: AgentKind,
    readonly root: string,
    private readonly ownershipPath: string,
    private readonly ownershipRoot: string,
  ) {}

  destination(relativePath: string): string {
    if (relativePath.length === 0 || isAbsolute(relativePath)) {
      throw new HivemndError(
        "PATH_UNSAFE",
        `Artifact path must be a non-empty relative path: ${relativePath}`,
      );
    }
    const destination = this.resolveWithinRoot(relativePath);
    const normalizedPath = relative(resolve(this.root), destination);
    if (normalizedPath.length === 0) {
      throw new HivemndError(
        "PATH_UNSAFE",
        "Artifact path must resolve to a file inside the target root",
      );
    }
    if (normalizedPath.split(sep)[0] === ".hivemnd") {
      throw new HivemndError(
        "PATH_UNSAFE",
        `Artifact path uses reserved Hivemnd namespace: ${relativePath}`,
      );
    }
    return destination;
  }

  async read(relativePath: string): Promise<Uint8Array | undefined> {
    const destination = this.destination(relativePath);
    await this.assertNoSymlinks(destination);
    return this.readOptional(destination);
  }

  async write(relativePath: string, content: Uint8Array): Promise<void> {
    await this.writeAtomic(
      this.destination(relativePath),
      content,
      resolve(this.root),
    );
  }

  async remove(relativePath: string): Promise<void> {
    const destination = this.destination(relativePath);
    await this.assertNoSymlinks(destination);
    await rm(destination, { force: true });
  }

  async readOwnership(): Promise<readonly OwnershipEntry[]> {
    const destination = resolve(this.ownershipPath);
    await this.assertNoSymlinks(destination, this.ownershipRoot);
    const contents = await this.readOptional(destination);
    if (contents === undefined) return [];
    const ledger = ownershipLedgerSchema.parse(
      JSON.parse(Buffer.from(contents).toString("utf8")) as unknown,
    );
    const entries = Object.entries(ledger.artifacts).map(
      ([relativePath, ownership]): OwnershipEntry => ({
        relativePath,
        logicalId: ownership.logicalId,
        artifactVersionId: ownership.artifactVersionId,
        sha256: ownership.sha256,
        releaseId: ownership.releaseId,
      }),
    );
    for (const entry of entries) this.destination(entry.relativePath);
    return entries.sort((left, right) =>
      left.relativePath.localeCompare(right.relativePath),
    );
  }

  async replaceOwnership(entries: readonly OwnershipEntry[]): Promise<void> {
    const artifacts: Record<string, Omit<OwnershipEntry, "relativePath">> = {};
    for (const entry of [...entries].sort((left, right) =>
      left.relativePath.localeCompare(right.relativePath),
    )) {
      this.destination(entry.relativePath);
      if (artifacts[entry.relativePath]) {
        throw new HivemndError(
          "SYNC_FAILED",
          `Duplicate ownership entry: ${entry.relativePath}`,
        );
      }
      artifacts[entry.relativePath] = {
        logicalId: entry.logicalId,
        artifactVersionId: entry.artifactVersionId,
        sha256: entry.sha256,
        releaseId: entry.releaseId,
      };
    }
    const ledger = ownershipLedgerSchema.parse({ version: 2, artifacts });
    await this.writeAtomic(
      resolve(this.ownershipPath),
      Buffer.from(`${JSON.stringify(ledger, null, 2)}\n`),
      this.ownershipRoot,
    );
  }

  private resolveWithinRoot(relativePath: string): string {
    const root = resolve(this.root);
    const destination = resolve(root, relativePath);
    const fromRoot = relative(root, destination);
    if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`)) {
      throw new HivemndError(
        "PATH_UNSAFE",
        `Artifact path escapes configured root: ${relativePath}`,
      );
    }
    return destination;
  }

  private async readOptional(path: string): Promise<Uint8Array | undefined> {
    try {
      return await readFile(path);
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === "ENOENT") return undefined;
      throw error;
    }
  }

  private async writeAtomic(
    destination: string,
    content: Uint8Array,
    boundaryRoot: string,
  ): Promise<void> {
    const temporary = `${destination}.hivemnd-${randomUUID()}.tmp`;
    await this.assertNoSymlinks(destination, boundaryRoot);
    await mkdir(dirname(destination), { recursive: true });
    await this.assertNoSymlinks(destination, boundaryRoot);
    try {
      await writeFile(temporary, content, { mode: 0o600, flag: "wx" });
      await rename(temporary, destination);
    } catch (error: unknown) {
      await rm(temporary, { force: true });
      throw error;
    }
  }

  private async assertNoSymlinks(
    destination: string,
    boundaryRoot = resolve(this.root),
  ): Promise<void> {
    const root = resolve(boundaryRoot);
    const fromRoot = relative(root, destination);
    const segments = fromRoot.split(sep);
    const candidates = [root];
    for (let index = 0; index < segments.length; index += 1) {
      candidates.push(resolve(root, ...segments.slice(0, index + 1)));
    }
    for (const candidate of candidates) {
      try {
        if ((await lstat(candidate)).isSymbolicLink()) {
          throw new HivemndError(
            "PATH_UNSAFE",
            `Symbolic links are not allowed in Hivemnd target paths: ${candidate}`,
          );
        }
      } catch (error: unknown) {
        if (isNodeError(error) && error.code === "ENOENT") continue;
        throw error;
      }
    }
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
