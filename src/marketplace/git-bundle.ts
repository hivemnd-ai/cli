import { createHash } from "node:crypto";
import { relative } from "node:path";
import { TextDecoder } from "node:util";
import { HivemndError } from "../errors.js";
import { sha256 } from "../sync/hash.js";
import {
  materializeBundleBytes,
  normalizeBundleInventory,
  type BundleFile,
  type BundleLimits,
  type StoredBundle,
} from "./bundle-store.js";
import { executeLocalGit, localGitContext } from "./local-git.js";
export interface GitBundleLimits extends BundleLimits {
  maxOutputBytes: number;
  maxDurationMs: number;
}
export interface GitBundleInput {
  repositoryDirectory: string;
  commitSha: string;
  packageRoot: string;
  limits: GitBundleLimits;
}
export interface CommittedBundleFile extends BundleFile {
  blobOid: string;
  mode: "100644" | "100755";
  content: Buffer;
}
export interface CommittedGitBundle {
  commitSha: string;
  packageRoot: string;
  treeOid: string;
  files: CommittedBundleFile[];
}
const failed = (): never => {
  throw new HivemndError(
    "INTEGRITY_FAILED",
    "Committed local package could not be verified.",
  );
};
interface Entry {
  mode: string;
  type: string;
  oid: string;
  size: number | undefined;
  path: string;
}
function entries(content: Buffer, oidLength: number): Entry[] {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(content);
  const records = text.split("\0");
  if (records.pop() !== "") failed();
  return records.map((record) => {
    const match =
      /^(?<mode>\d{6}) (?<type>[a-z]+) (?<oid>[a-f0-9]+) +(?<size>-|[0-9]+)\t(?<path>[\s\S]+)$/.exec(
        record,
      );
    if (!match) return failed();
    const fields = match.groups as Record<
      "mode" | "type" | "oid" | "size" | "path",
      string
    >;
    const { mode, type, oid, path } = fields;
    if (oid.length !== oidLength) failed();
    const size = fields.size === "-" ? undefined : Number(fields.size);
    return { mode, type, oid, path, size };
  });
}

/** Verifies local immutable Git objects only; no working-tree authority or remote ACL claim. */
export async function readCommittedGitBundle(
  input: GitBundleInput,
): Promise<CommittedGitBundle> {
  try {
    const { commitSha, packageRoot, limits } = input;
    if (
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commitSha) ||
      Object.values(limits).some(
        (value) => !Number.isSafeInteger(value) || value < 1,
      )
    )
      failed();
    const base = { ownerId: "git-reader", commitSha, limits };
    if (packageRoot !== ".")
      normalizeBundleInventory({
        ...base,
        files: [
          {
            path: packageRoot,
            size: 0,
            sha256: "0".repeat(64),
            executable: false,
          },
        ],
      });
    const context = await localGitContext(input.repositoryDirectory);
    const deadline = performance.now() + limits.maxDurationMs;
    let remaining = limits.maxOutputBytes;
    async function run(args: string[], maximum: number): Promise<Buffer> {
      const timeout = Math.floor(deadline - performance.now());
      if (timeout < 1 || remaining < 1) return failed();
      const result = await executeLocalGit("git", [...context.args, ...args], {
        env: context.environment,
        encoding: "buffer",
        timeout,
        killSignal: "SIGKILL",
        maxBuffer: Math.min(remaining, maximum + 1),
      });
      remaining -= result.stdout.length + result.stderr.length;
      if (
        remaining < 0 ||
        result.stdout.length > maximum ||
        performance.now() > deadline
      )
        failed();
      return result.stdout;
    }
    async function object(
      type: "commit" | "tree" | "blob",
      oid: string,
      maximum: number,
    ): Promise<Buffer> {
      if ((await run(["cat-file", "-t", oid], 16)).toString() !== `${type}\n`)
        return failed();
      const content = await run(["cat-file", type, oid], maximum);
      const hash = createHash(oid.length === 40 ? "sha1" : "sha256")
        .update(`${type} ${content.length}\0`)
        .update(content)
        .digest("hex");
      if (hash !== oid) failed();
      return content;
    }
    const commit = await object("commit", commitSha, limits.maxOutputBytes);
    const tree = /^tree ([a-f0-9]+)\n/.exec(commit.toString("latin1"))?.[1];
    if (tree?.length !== commitSha.length) return failed();
    let treeOid = tree;
    if (packageRoot !== ".")
      for (const part of packageRoot.split("/")) {
        await object("tree", treeOid, limits.maxOutputBytes);
        const selected = entries(
          await run(
            ["ls-tree", "-l", "-z", "--full-tree", treeOid, "--", part],
            limits.maxOutputBytes,
          ),
          commitSha.length,
        );
        const entry = selected[0];
        if (
          selected.length !== 1 ||
          entry?.path !== part ||
          entry.mode !== "040000" ||
          entry.type !== "tree"
        )
          return failed();
        treeOid = entry.oid;
      }
    await object("tree", treeOid, limits.maxOutputBytes);
    const listed = entries(
      await run(
        ["ls-tree", "-r", "-t", "-l", "-z", "--full-tree", treeOid],
        limits.maxOutputBytes,
      ),
      commitSha.length,
    );
    if (listed.length > limits.maxEntries) failed();
    const regular = listed.filter((entry) => entry.mode !== "040000");
    const planned = regular.map((entry) => ({
      path: entry.path,
      size: entry.size ?? -1,
      sha256: "0".repeat(64),
      executable: entry.mode === "100755",
    }));
    normalizeBundleInventory({ ...base, files: planned });
    for (const entry of listed) {
      if (entry.mode === "040000") {
        if (
          entry.type !== "tree" ||
          !regular.some((file) => file.path.startsWith(`${entry.path}/`))
        )
          failed();
        await object("tree", entry.oid, limits.maxOutputBytes);
      } else if (
        !["100644", "100755"].includes(entry.mode) ||
        entry.type !== "blob" ||
        entry.size === undefined
      )
        failed();
    }
    const files: CommittedBundleFile[] = [];
    for (const entry of regular) {
      const content = await object("blob", entry.oid, limits.maxFileBytes);
      if (content.length !== entry.size) failed();
      files.push({
        path: entry.path,
        size: content.length,
        sha256: sha256(content),
        executable: entry.mode === "100755",
        mode: entry.mode as "100644" | "100755",
        blobOid: entry.oid,
        content,
      });
    }
    files.sort((a, b) =>
      Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)),
    );
    if (performance.now() > deadline) failed();
    return { commitSha, packageRoot, treeOid, files };
  } catch {
    return failed();
  }
}
/** Direct bytes→inert store; never exports a runnable source tree. */
export async function materializeCommittedGitBundle(
  input: GitBundleInput & { storeDirectory: string; ownerId: string },
): Promise<{
  source: Omit<CommittedGitBundle, "files"> & {
    files: Omit<CommittedBundleFile, "content">[];
  };
  stored: StoredBundle;
}> {
  const context = await localGitContext(input.repositoryDirectory).catch(() =>
    failed(),
  );
  if (
    !relative(context.root, input.storeDirectory).startsWith("../") ||
    !relative(input.storeDirectory, context.root).startsWith("../")
  )
    return failed();
  const bundle = await readCommittedGitBundle(input);
  const stored = await materializeBundleBytes({
    ...input,
    files: bundle.files,
  });
  return {
    source: {
      ...bundle,
      files: bundle.files.map(({ content, ...file }) => {
        void content;
        return file;
      }),
    },
    stored,
  };
}
