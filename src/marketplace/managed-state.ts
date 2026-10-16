import { constants } from "node:fs";
import { lstat, mkdir, open, opendir, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { userInfo } from "node:os";
import { dirname, isAbsolute, join, parse, relative, resolve } from "node:path";
import { z } from "zod";
import { TextDecoder } from "node:util";
import { HivemndError } from "../errors.js";
import type { DeclaredHarnessTarget } from "./harness-adapters.js";
import type { BundleLimits } from "./bundle-store.js";

export interface ManagedBundleLimits extends BundleLimits {
  maxStateBytes: number;
}
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const oid = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const pointerSchema = z
  .object({
    schemaVersion: z.literal(1),
    ownerId: z.string(),
    target: z
      .object({
        id: z.string(),
        harness: z.enum(["codex", "claude"]),
        scope: z.enum(["user", "workspace"]),
        bindingId: z.string().nullable(),
      })
      .strict(),
    digest: sha,
    packageSha256: sha,
    commitSha: oid,
    packageRoot: z.string(),
    files: z.array(
      z
        .object({
          path: z.string(),
          size: z.number().int().nonnegative(),
          sha256: sha,
          executable: z.boolean(),
          blobOid: oid,
          mode: z.enum(["100644", "100755"]),
        })
        .strict(),
    ),
  })
  .strict();
export type ManagedPointer = z.infer<typeof pointerSchema>;
export interface ManagedState {
  directory: string;
  ownerId: string;
  target: DeclaredHarnessTarget;
  limits: ManagedBundleLimits;
}
export const unsafeManagedState = (): never => {
  throw new HivemndError(
    "PATH_UNSAFE",
    "Managed bundle ownership or filesystem boundary is unsafe.",
  );
};
export const invalidManagedBundle = (): never => {
  throw new HivemndError(
    "INTEGRITY_FAILED",
    "Managed bundle content, provenance or state could not be verified.",
  );
};
function validateManagedDirectoryPath(path: string): void {
  if (
    !isAbsolute(path) ||
    resolve(path) !== path ||
    path
      .split("/")
      .some((part) => [".claude", ".codex", ".agents"].includes(part))
  )
    unsafeManagedState();
}
export async function managedAncestry(path: string): Promise<void> {
  validateManagedDirectoryPath(path);
  let cursor = parse(path).root;
  for (const part of relative(cursor, path).split("/").filter(Boolean)) {
    cursor = join(cursor, part);
    const state = await lstat(cursor);
    if (!state.isDirectory() || state.isSymbolicLink()) unsafeManagedState();
  }
}
async function privateDirectory(path: string): Promise<void> {
  await managedAncestry(path);
  const state = await lstat(path);
  if (state.uid !== userInfo().uid || (state.mode & 0o777) !== 0o700)
    unsafeManagedState();
}
export async function readManagedFile(
  path: string,
  maximum: number,
): Promise<Buffer> {
  if (!Number.isSafeInteger(maximum) || maximum < 1) invalidManagedBundle();
  await managedAncestry(dirname(path));
  const state = await lstat(path);
  if (
    !state.isFile() ||
    state.nlink !== 1 ||
    state.uid !== userInfo().uid ||
    (state.mode & 0o777) !== 0o600
  )
    unsafeManagedState();
  if (state.size > maximum) invalidManagedBundle();
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const before = await handle.stat();
    if (
      before.ino !== state.ino ||
      before.dev !== state.dev ||
      !before.isFile()
    )
      unsafeManagedState();
    const bytes = Buffer.alloc(state.size + 1);
    let offset = 0;
    while (offset < bytes.length) {
      const next = await handle.read(
        bytes,
        offset,
        bytes.length - offset,
        null,
      );
      if (!next.bytesRead) break;
      offset += next.bytesRead;
    }
    const after = await handle.stat();
    if (
      offset !== state.size ||
      after.size !== state.size ||
      after.ctimeMs !== state.ctimeMs ||
      after.mtimeMs !== state.mtimeMs
    )
      invalidManagedBundle();
    return bytes.subarray(0, offset);
  } finally {
    await handle.close();
  }
}
async function writeExclusive(path: string, bytes: string): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(bytes);
  } finally {
    await handle.close();
  }
}
function ownerText(state: ManagedState): string {
  return JSON.stringify({
    schemaVersion: 1,
    ownerId: state.ownerId,
    target: state.target,
  });
}
export async function withManagedState<T>(
  state: ManagedState,
  operation: () => Promise<T>,
): Promise<T> {
  validateManagedDirectoryPath(state.directory);
  await managedAncestry(dirname(state.directory));
  try {
    await mkdir(state.directory, { mode: 0o700 });
    await writeExclusive(join(state.directory, "owner.json"), ownerText(state));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  await privateDirectory(state.directory);
  const lockPath = join(state.directory, ".reconcile-lock");
  const entries = await opendir(state.directory);
  const allowed = new Set([
    "owner.json",
    "bundles",
    "current.json",
    "previous.json",
  ]);
  for await (const entry of entries) {
    if (entry.name === ".reconcile-lock")
      throw new HivemndError(
        "SYNC_CONFLICT",
        "Another managed reconciliation owns the lock.",
      );
    if (!allowed.has(entry.name)) unsafeManagedState();
  }
  if (
    (
      await readManagedFile(
        join(state.directory, "owner.json"),
        state.limits.maxStateBytes,
      )
    ).toString() !== ownerText(state)
  )
    unsafeManagedState();
  let lock;
  try {
    lock = await open(lockPath, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new HivemndError(
        "SYNC_CONFLICT",
        "Another managed reconciliation owns the lock.",
      );
    throw error;
  }
  const identity = await lock.stat();
  await lock.close();
  try {
    return await operation();
  } finally {
    await managedAncestry(state.directory);
    const current = await lstat(lockPath);
    if (current.ino !== identity.ino || current.dev !== identity.dev)
      unsafeManagedState();
    await rm(lockPath);
  }
}
export async function readManagedPointer(
  state: ManagedState,
  name: "current" | "previous",
): Promise<ManagedPointer | undefined> {
  let bytes: Buffer;
  try {
    bytes = await readManagedFile(
      join(state.directory, `${name}.json`),
      state.limits.maxStateBytes,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    );
  } catch {
    return invalidManagedBundle();
  }
  const pointer = pointerSchema.safeParse(parsed);
  if (!pointer.success) return invalidManagedBundle();
  if (
    pointer.data.ownerId !== state.ownerId ||
    JSON.stringify(pointer.data.target) !== JSON.stringify(state.target)
  )
    return unsafeManagedState();
  return pointer.data;
}
async function atomicPointer(
  state: ManagedState,
  name: "current" | "previous",
  pointer: ManagedPointer,
): Promise<void> {
  const text = JSON.stringify(pointer);
  if (Buffer.byteLength(text) > state.limits.maxStateBytes)
    invalidManagedBundle();
  await managedAncestry(state.directory);
  const temporary = join(state.directory, `.pointer-${randomUUID()}`);
  await writeExclusive(temporary, text);
  try {
    await managedAncestry(state.directory);
    await rename(temporary, join(state.directory, `${name}.json`));
  } finally {
    await rm(temporary, { force: true });
  }
}
export async function publishManagedPointer(
  state: ManagedState,
  pointer: ManagedPointer,
  current?: ManagedPointer,
): Promise<void> {
  if (current) await atomicPointer(state, "previous", current);
  await atomicPointer(state, "current", pointer);
}
