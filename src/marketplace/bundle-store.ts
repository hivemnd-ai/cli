import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  opendir,
  rename,
  rm,
} from "node:fs/promises";
import { dirname, isAbsolute, join, parse, relative, resolve } from "node:path";
import { userInfo } from "node:os";
import { HivemndError } from "../errors.js";
import { sha256 } from "../sync/hash.js";

export interface BundleFile {
  path: string;
  size: number;
  sha256: string;
  executable: boolean;
}
export interface BundleLimits {
  maxFiles: number;
  maxFileBytes: number;
  maxTotalBytes: number;
  maxDepth: number;
  maxEntries: number;
}
export interface LocalBundleInput {
  sourceDirectory: string;
  storeDirectory: string;
  ownerId: string;
  commitSha: string;
  files: readonly BundleFile[];
  limits: BundleLimits;
}
export interface StoredBundle {
  directory: string;
  digest: string;
  created: boolean;
}
const fail = (
  code: "PATH_UNSAFE" | "INTEGRITY_FAILED",
  message: string,
): never => {
  throw new HivemndError(code, message);
};
const unsafe = (): never =>
  fail("PATH_UNSAFE", "Bundle path or owned store is unsafe.");
const integrity = (): never =>
  fail(
    "INTEGRITY_FAILED",
    "Bundle inventory, content or runtime limits do not match.",
  );

async function ancestry(path: string): Promise<void> {
  if (!isAbsolute(path) || resolve(path) !== path) unsafe();
  let cursor = parse(path).root;
  for (const part of relative(cursor, path).split("/").filter(Boolean)) {
    cursor = join(cursor, part);
    const state = await lstat(cursor);
    if (!state.isDirectory() || state.isSymbolicLink()) unsafe();
  }
}
async function privateDirectory(path: string): Promise<void> {
  await ancestry(path);
  const state = await lstat(path);
  if (state.uid !== userInfo().uid || (state.mode & 0o777) !== 0o700) unsafe();
}
async function read(
  path: string,
  maximum: number,
  privateFile = false,
): Promise<Buffer> {
  const state = await lstat(path);
  if (
    !state.isFile() ||
    state.nlink !== 1 ||
    state.isSymbolicLink() ||
    (privateFile &&
      (state.uid !== userInfo().uid || (state.mode & 0o777) !== 0o600))
  )
    unsafe();
  if (state.size > maximum) integrity();
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      opened.dev !== state.dev ||
      opened.ino !== state.ino ||
      opened.size !== state.size
    )
      unsafe();
    const buffer = Buffer.alloc(state.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const result = await handle.read(
        buffer,
        offset,
        buffer.length - offset,
        null,
      );
      if (!result.bytesRead) break;
      offset += result.bytesRead;
    }
    const after = await handle.stat();
    if (
      offset !== state.size ||
      after.size !== state.size ||
      after.mtimeMs !== state.mtimeMs ||
      after.ctimeMs !== state.ctimeMs
    )
      integrity();
    return buffer.subarray(0, offset);
  } finally {
    await handle.close();
  }
}
async function write(path: string, content: string | Buffer): Promise<void> {
  const handle = await open(path, "wx", 0o600);
  try {
    await handle.writeFile(content);
  } finally {
    await handle.close();
  }
}
function inventory(input: LocalBundleInput): BundleFile[] {
  const { files, limits } = input;
  if (
    !/^[a-zA-Z0-9_-]{1,128}$/.test(input.ownerId) ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(input.commitSha)
  )
    integrity();
  if (
    Object.values(limits).some(
      (limit) => !Number.isSafeInteger(limit) || limit < 1,
    ) ||
    files.length === 0 ||
    files.length > limits.maxFiles
  )
    integrity();
  const paths = new Set<string>();
  const spelling = new Map<string, string>();
  let total = 0;
  for (const file of files) {
    const parts = file.path.split("/");
    if (
      !file.path ||
      file.path.includes("\\") ||
      Array.from(file.path).some(
        (character) =>
          character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      ) ||
      parts.some(
        (part) =>
          !part ||
          part === "." ||
          part === ".." ||
          part.normalize("NFC") !== part,
      )
    )
      unsafe();
    if (parts.length > limits.maxDepth) integrity();
    for (let length = 1; length <= parts.length; length++) {
      const prefix = parts.slice(0, length).join("/");
      const prior = spelling.get(prefix.toLowerCase());
      if (prior !== undefined && prior !== prefix) integrity();
      spelling.set(prefix.toLowerCase(), prefix);
    }
    const key = file.path.toLowerCase();
    if (
      paths.has(key) ||
      typeof file.executable !== "boolean" ||
      !/^[a-f0-9]{64}$/.test(file.sha256) ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      file.size > limits.maxFileBytes
    )
      integrity();
    paths.add(key);
    total += file.size;
  }
  if (
    total > limits.maxTotalBytes ||
    [...paths].some((path) =>
      path
        .split("/")
        .slice(0, -1)
        .some((_, index) =>
          paths.has(
            path
              .split("/")
              .slice(0, index + 1)
              .join("/"),
          ),
        ),
    )
  )
    integrity();
  return files
    .map((file) => ({
      path: file.path,
      size: file.size,
      sha256: file.sha256,
      executable: file.executable,
    }))
    .sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
}
async function verify(
  directory: string,
  files: BundleFile[],
  limits: BundleLimits,
  destination?: string,
): Promise<void> {
  const expected = new Map(files.map((file) => [file.path, file]));
  let entries = 0;
  let count = 0;
  async function walk(prefix: string, depth: number): Promise<void> {
    const dir = join(directory, prefix);
    if (destination) await ancestry(dir);
    else await privateDirectory(dir);
    const before = await lstat(dir);
    const handle = await opendir(dir);
    let children = 0;
    for await (const entry of handle) {
      if (++entries > limits.maxEntries || depth > limits.maxDepth) integrity();
      children++;
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      const state = await lstat(join(directory, path));
      if (state.isSymbolicLink()) unsafe();
      if (state.isDirectory()) {
        if (destination) await mkdir(join(destination, path), { mode: 0o700 });
        await walk(path, depth + 1);
      } else {
        if (!state.isFile()) unsafe();
        const file = expected.get(path) ?? integrity();
        if (destination && ((state.mode & 0o111) !== 0) !== file.executable)
          integrity();
        const content = await read(
          join(directory, path),
          limits.maxFileBytes,
          !destination,
        );
        if (content.length !== file.size || sha256(content) !== file.sha256)
          integrity();
        count++;
        if (destination) await write(join(destination, path), content);
      }
    }
    const after = await lstat(dir);
    if (
      before.ino !== after.ino ||
      before.dev !== after.dev ||
      before.mtimeMs !== after.mtimeMs ||
      children === 0
    )
      integrity();
  }
  await walk("", 1);
  if (count !== files.length) integrity();
}

/** Copies bytes only. Does not install, discover, enable, execute, or emit usage. */
export async function materializeLocalBundle(
  input: LocalBundleInput,
): Promise<StoredBundle> {
  const files = inventory(input);
  const { sourceDirectory, storeDirectory, limits } = input;
  await ancestry(sourceDirectory);
  await ancestry(dirname(storeDirectory));
  if (
    !isAbsolute(storeDirectory) ||
    resolve(storeDirectory) !== storeDirectory ||
    storeDirectory
      .split("/")
      .some((part) => [".agents", ".claude", ".codex"].includes(part)) ||
    !relative(sourceDirectory, storeDirectory).startsWith("../") ||
    !relative(storeDirectory, sourceDirectory).startsWith("../")
  )
    unsafe();
  const owner = JSON.stringify({ schemaVersion: 1, ownerId: input.ownerId });
  const snapshot = JSON.stringify({
    schemaVersion: 1,
    ownerId: input.ownerId,
    commitSha: input.commitSha,
    files,
  });
  const digest = sha256(snapshot);
  const versions = join(storeDirectory, "versions");
  const directory = join(versions, digest, "payload");
  try {
    await mkdir(storeDirectory, { mode: 0o700 });
    await write(join(storeDirectory, "owner.json"), owner);
    await mkdir(versions, { mode: 0o700 });
    await mkdir(join(storeDirectory, "data"), { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  await privateDirectory(storeDirectory);
  const allowed = new Set(["owner.json", "versions", "data"]);
  const root = await opendir(storeDirectory);
  for await (const entry of root) {
    if (!allowed.delete(entry.name)) unsafe();
  }
  if (
    allowed.size ||
    (await read(join(storeDirectory, "owner.json"), 1024, true)).toString() !==
      owner
  )
    unsafe();
  await privateDirectory(versions);
  await privateDirectory(join(storeDirectory, "data"));
  const stored = await opendir(versions);
  let storedCount = 0;
  for await (const entry of stored) {
    if (++storedCount > limits.maxEntries || !/^[a-f0-9]{64}$/.test(entry.name))
      unsafe();
    await privateDirectory(join(versions, entry.name));
  }
  const lock = await open(join(storeDirectory, ".transport-lock"), "wx", 0o600);
  await lock.close();
  let staging: string | undefined;
  try {
    const existing = await lstat(join(versions, digest)).catch(
      (error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        return undefined;
      },
    );
    if (existing) {
      await privateDirectory(join(versions, digest));
      const entries = await opendir(join(versions, digest));
      const expected = new Set(["snapshot.json", "payload"]);
      for await (const entry of entries) {
        if (!expected.delete(entry.name)) unsafe();
      }
      if (expected.size) unsafe();
      if (
        (
          await read(
            join(versions, digest, "snapshot.json"),
            Buffer.byteLength(snapshot),
            true,
          )
        ).toString() !== snapshot
      )
        integrity();
      await verify(directory, files, limits);
      return { directory, digest, created: false };
    }
    staging = await mkdtemp(join(storeDirectory, ".stage-"));
    await mkdir(join(staging, "payload"), { mode: 0o700 });
    await verify(sourceDirectory, files, limits, join(staging, "payload"));
    await write(join(staging, "snapshot.json"), snapshot);
    await verify(join(staging, "payload"), files, limits);
    await ancestry(sourceDirectory);
    await privateDirectory(storeDirectory);
    await privateDirectory(versions);
    await rename(staging, join(versions, digest));
    staging = undefined;
    return { directory, digest, created: true };
  } finally {
    if (staging) await rm(staging, { recursive: true, force: true });
    await rm(join(storeDirectory, ".transport-lock"));
  }
}
