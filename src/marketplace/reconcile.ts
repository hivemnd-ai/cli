import { createHash } from "node:crypto";
import { join } from "node:path";
import { HivemndError } from "../errors.js";
import { sha256 } from "../sync/hash.js";
import {
  materializeBundleBytes,
  normalizeBundleInventory,
  type BundleFile,
  type BundleLimits,
} from "./bundle-store.js";
import {
  validateDeclaredTarget,
  prepareHarnessLaunch,
  type HarnessLaunchPlan,
  type HarnessProbe,
  type DeclaredHarnessTarget,
} from "./harness-adapters.js";
import {
  invalidManagedBundle,
  readManagedFile,
  readManagedPointer,
  publishManagedPointer,
  withManagedState,
  type ManagedBundleLimits,
  type ManagedPointer,
  type ManagedState,
} from "./managed-state.js";
export type { ManagedBundleLimits } from "./managed-state.js";
export interface ManagedBundleFile extends BundleFile {
  blobOid: string;
  mode: "100644" | "100755";
  content: Uint8Array;
}
export interface ManagedBundleInput {
  apply: boolean;
  declaredTarget: DeclaredHarnessTarget;
  stateDirectory: string;
  ownerId: string;
  commitSha: string;
  packageRoot: string;
  files: readonly ManagedBundleFile[];
  packageSha256: string;
  limits: ManagedBundleLimits;
  harnessProbe?: HarnessProbe;
}
export interface ManagedBundleResult {
  status: "planned" | "applied" | "unchanged";
  directory?: string;
  digest: string;
  packageSha256: string;
  native: HarnessLaunchPlan;
  execution: "unknown";
}
function canonicalPaths(files: readonly BundleFile[]): void {
  const spelling = new Map<string, string>();
  for (const file of files) {
    if (
      file.path.trim() === "" ||
      /^[A-Za-z]:/.test(file.path) ||
      Buffer.from(file.path).toString() !== file.path ||
      file.path
        .split("/")
        .some((part) => /^(?:\.git$|\.hivemnd(?:$|-))/i.test(part))
    )
      invalidManagedBundle();
    const parts = file.path.split("/");
    for (let length = 1; length <= parts.length; length++) {
      const prefix = parts.slice(0, length).join("/");
      // Conservative portable collision key also covers multi-character case mappings.
      const key = prefix.toUpperCase().toLowerCase();
      const prior = spelling.get(key);
      if (prior !== undefined && prior !== prefix) invalidManagedBundle();
      spelling.set(key, prefix);
    }
  }
}
/** Approved tree_sha256_v1: UTF8 byte-sorted u32 path length + path + u64 size + raw SHA256 + executable byte. */
export function canonicalBundleDigest(
  files: readonly BundleFile[],
  limits: BundleLimits,
): string {
  const normalized = normalizeBundleInventory({
    ownerId: "canonical-inventory",
    commitSha: "0".repeat(40),
    files,
    limits,
  });
  canonicalPaths(normalized);
  const digest = createHash("sha256");
  for (const file of normalized) {
    const path = Buffer.from(file.path);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(path.length);
    const size = Buffer.alloc(8);
    size.writeBigUInt64BE(BigInt(file.size));
    digest
      .update(length)
      .update(path)
      .update(size)
      .update(Buffer.from(file.sha256, "hex"))
      .update(Buffer.from([Number(file.executable)]));
  }
  return digest.digest("hex");
}
function descriptor(input: ManagedBundleInput): {
  pointer: ManagedPointer;
  files: ManagedBundleFile[];
  state: ManagedState;
} {
  const target = validateDeclaredTarget(input.declaredTarget);
  const files = normalizeBundleInventory(input);
  canonicalPaths(files);
  if (!Number.isSafeInteger(input.limits.maxStateBytes)) invalidManagedBundle();
  if (input.packageRoot !== ".")
    canonicalBundleDigest(
      [
        {
          path: input.packageRoot,
          size: 0,
          sha256: "0".repeat(64),
          executable: false,
        },
      ],
      input.limits,
    );
  const contents = input.files
    .map((supplied) => {
      const { path, size, sha256: hash, executable } = supplied;
      const file = { path, size, sha256: hash, executable };
      if (supplied.content.byteLength !== file.size) invalidManagedBundle();
      const content = Buffer.from(supplied.content);
      const mode: ManagedBundleFile["mode"] = file.executable
        ? "100755"
        : "100644";
      const blobOid = createHash(
        input.commitSha.length === 40 ? "sha1" : "sha256",
      )
        .update(`blob ${content.length}\0`)
        .update(content)
        .digest("hex");
      if (
        content.length !== file.size ||
        sha256(content) !== file.sha256 ||
        supplied.mode !== mode ||
        supplied.blobOid !== blobOid
      )
        invalidManagedBundle();
      return { ...file, blobOid, mode, content };
    })
    .sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  const packageSha256 = canonicalBundleDigest(files, input.limits);
  if (packageSha256 !== input.packageSha256) invalidManagedBundle();
  const digest = sha256(
    JSON.stringify({
      schemaVersion: 1,
      ownerId: input.ownerId,
      commitSha: input.commitSha,
      files,
    }),
  );
  const pointer: ManagedPointer = {
    schemaVersion: 1,
    ownerId: input.ownerId,
    target,
    digest,
    packageSha256,
    commitSha: input.commitSha,
    packageRoot: input.packageRoot,
    files: contents.map(({ content, ...file }) => {
      void content;
      return file;
    }),
  };
  if (Buffer.byteLength(JSON.stringify(pointer)) > input.limits.maxStateBytes)
    invalidManagedBundle();
  return {
    pointer,
    files: contents,
    state: {
      directory: input.stateDirectory,
      ownerId: input.ownerId,
      target,
      limits: input.limits,
    },
  };
}
function result(
  pointer: ManagedPointer,
  status: ManagedBundleResult["status"],
  directory?: string,
  probe?: HarnessProbe,
): ManagedBundleResult {
  return {
    status,
    digest: pointer.digest,
    packageSha256: pointer.packageSha256,
    native: prepareHarnessLaunch(
      pointer.target,
      directory,
      pointer.files.some((file) => file.path === ".claude-plugin/plugin.json"),
      probe,
    ),
    execution: "unknown",
    ...(directory === undefined ? {} : { directory }),
  };
}
async function verifiedPointer(
  state: ManagedState,
  pointer: ManagedPointer,
): Promise<string> {
  const directory = join(
    state.directory,
    "bundles",
    "versions",
    pointer.digest,
    "payload",
  );
  const files: ManagedBundleFile[] = [];
  normalizeBundleInventory({
    ownerId: state.ownerId,
    commitSha: pointer.commitSha,
    files: pointer.files,
    limits: state.limits,
  });
  for (const file of pointer.files)
    files.push({
      ...file,
      content: await readManagedFile(
        join(directory, file.path),
        state.limits.maxFileBytes,
      ),
    });
  const validated = descriptor({
    apply: true,
    declaredTarget: state.target,
    stateDirectory: state.directory,
    ownerId: state.ownerId,
    commitSha: pointer.commitSha,
    packageRoot: pointer.packageRoot,
    files,
    packageSha256: pointer.packageSha256,
    limits: state.limits,
  });
  if (validated.pointer.digest !== pointer.digest) invalidManagedBundle();
  const stored = await materializeBundleBytes({
    storeDirectory: join(state.directory, "bundles"),
    ownerId: state.ownerId,
    commitSha: pointer.commitSha,
    files,
    limits: state.limits,
  });
  return stored.directory;
}
async function safeOperation<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof HivemndError) throw error;
    throw new HivemndError(
      "INTEGRITY_FAILED",
      "Managed reconciliation failed; inspect owned state before retrying.",
    );
  }
}
/** Updates only a Hivemnd-owned inert store/pointer. No native discovery settings, executable modes or processes. */
export async function reconcileManagedBundle(
  input: ManagedBundleInput,
): Promise<ManagedBundleResult> {
  return safeOperation(async () => {
    const { state, pointer, files } = descriptor(input);
    if (!input.apply) return result(pointer, "planned");
    return withManagedState(state, async () => {
      const current = await readManagedPointer(state, "current");
      await readManagedPointer(state, "previous");
      if (current) await verifiedPointer(state, current);
      const stored = await materializeBundleBytes({
        storeDirectory: join(state.directory, "bundles"),
        ownerId: input.ownerId,
        commitSha: input.commitSha,
        files,
        limits: input.limits,
      });
      if (current && JSON.stringify(current) === JSON.stringify(pointer))
        return result(
          pointer,
          "unchanged",
          stored.directory,
          input.harnessProbe,
        );
      await publishManagedPointer(state, pointer, current);
      return result(pointer, "applied", stored.directory, input.harnessProbe);
    });
  });
}
/** Explicit recovery preserves current/prior immutable versions and mutable bundles/data. */
export async function recoverManagedBundle(
  input: Pick<
    ManagedBundleInput,
    "apply" | "declaredTarget" | "stateDirectory" | "ownerId" | "limits"
  >,
): Promise<ManagedBundleResult> {
  return safeOperation(async () => {
    if (!input.apply)
      throw new HivemndError(
        "SYNC_CONFLICT",
        "Managed recovery requires explicit apply.",
      );
    const state: ManagedState = {
      directory: input.stateDirectory,
      ownerId: input.ownerId,
      target: validateDeclaredTarget(input.declaredTarget),
      limits: input.limits,
    };
    return withManagedState(state, async () => {
      const previous = await readManagedPointer(state, "previous");
      if (!previous) return invalidManagedBundle();
      const current = await readManagedPointer(state, "current");
      const directory = await verifiedPointer(state, previous);
      await publishManagedPointer(state, previous, current);
      return result(previous, "applied", directory);
    });
  });
}
