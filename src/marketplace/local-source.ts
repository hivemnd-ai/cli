import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify, TextDecoder } from "node:util";
import { parseTree, type Node, type ParseError } from "jsonc-parser";
import { HivemndError } from "../errors.js";
import { sha256 } from "../sync/hash.js";
import { localGitContext } from "./local-git.js";
import type { ManifestSnapshot, PreviewLimits } from "./types.js";

const git = promisify(execFile);
const defaults: PreviewLimits = {
  maxFileBytes: 524_288,
  maxTotalBytes: 8_388_608,
  maxPlugins: 256,
  maxSkills: 256,
};

export function invalid(message: string): never {
  throw new HivemndError("MANIFEST_INVALID", message);
}

/** A deliberately stricter local inventory policy: no package symlinks at all. */
export class LocalSource {
  readonly manifests: ManifestSnapshot[] = [];
  readonly warnings = [
    "Inventory only: no installation, execution, component-schema or skill-frontmatter validation.",
  ];
  private totalBytes = 0;
  private readonly capturedPaths = new Set<string>();

  private constructor(
    readonly source: { root: string; commitSha: string; dirty: boolean },
    readonly limits: PreviewLimits,
    private readonly gitArgs: string[],
    private readonly gitEnvironment: NodeJS.ProcessEnv,
    private readonly gitPrefix: string,
  ) {}

  static async create(
    root: string,
    overrides: Partial<PreviewLimits>,
  ): Promise<LocalSource> {
    const limits = { ...defaults, ...overrides };
    if (
      Object.values(limits).some(
        (value) => !Number.isSafeInteger(value) || value < 1,
      )
    )
      invalid("Invalid inventory limits");
    const { root: canonical, args, environment } = await localGitContext(root);
    const options = { env: environment, timeout: 10_000, maxBuffer: 1_048_576 };
    try {
      const { stdout } = await git(
        "git",
        [...args, "rev-parse", "--verify", "HEAD^{commit}"],
        options,
      );
      const commitSha = stdout.trim();
      const prefix = await git(
        "git",
        [...args, "rev-parse", "--show-prefix"],
        options,
      );
      return new LocalSource(
        { root: canonical, commitSha, dirty: false },
        limits,
        args,
        environment,
        prefix.stdout.trimEnd(),
      );
    } catch {
      return invalid(
        "A readable local Git repository with a committed HEAD is required",
      );
    }
  }

  relativePath(path: string): string {
    if (
      !path ||
      isAbsolute(path) ||
      path.includes("\\") ||
      path.includes("%") ||
      path.includes("\0") ||
      path.split("/").includes("..")
    )
      invalid("Unsafe package path");
    return relative(this.source.root, resolve(this.source.root, path));
  }

  async kind(
    path: string,
  ): Promise<"file" | "directory" | "other" | "missing"> {
    const normalized = this.relativePath(path);
    let current = this.source.root;
    for (const segment of normalized.split(sep).filter(Boolean)) {
      current = join(current, segment);
      try {
        const entry = await lstat(current);
        if (entry.isSymbolicLink())
          invalid("Package symlink paths are not supported by local inventory");
      } catch (error) {
        if (
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        )
          return "missing";
        throw error;
      }
    }
    const entry = await lstat(current);
    return entry.isFile()
      ? "file"
      : entry.isDirectory()
        ? "directory"
        : "other";
  }

  async read(path: string): Promise<ManifestSnapshot> {
    const normalized = this.relativePath(path);
    if ((await this.kind(path)) !== "file")
      invalid("Expected a regular package file");
    const handle = await open(
      join(this.source.root, normalized),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) invalid("Expected a regular package file");
      if (
        stat.size > this.limits.maxFileBytes ||
        this.totalBytes + stat.size > this.limits.maxTotalBytes
      )
        invalid("Package byte limit exceeded");
      // Bounded reads also handle a file growing after stat without allocating its full size.
      const bytes = Buffer.alloc(this.limits.maxFileBytes + 1);
      let count = 0;
      while (count < bytes.length) {
        const result = await handle.read(
          bytes,
          count,
          bytes.length - count,
          null,
        );
        if (!result.bytesRead) break;
        count += result.bytesRead;
      }
      this.totalBytes += count;
      if (
        count > this.limits.maxFileBytes ||
        this.totalBytes > this.limits.maxTotalBytes
      )
        invalid("Package byte limit exceeded");
      const content = bytes.subarray(0, count);
      let raw: string;
      try {
        raw = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
          content,
        );
      } catch {
        return invalid("Package files must use valid UTF-8");
      }
      const snapshot = {
        path: normalized.split(sep).join("/"),
        raw,
        sha256: sha256(content),
      };
      this.capturedPaths.add(snapshot.path);
      // status/diff/checkout can run repository clean/smudge filters.
      // cat-file reads immutable blobs without invoking those executables.
      try {
        const committed = await git(
          "git",
          [
            ...this.gitArgs,
            "cat-file",
            "blob",
            `${this.source.commitSha}:${this.gitPrefix}${snapshot.path}`,
          ],
          {
            env: this.gitEnvironment,
            encoding: "buffer",
            timeout: 10_000,
            maxBuffer: this.limits.maxFileBytes + 1,
          },
        );
        if (sha256(committed.stdout) !== snapshot.sha256)
          this.source.dirty = true;
      } catch {
        this.source.dirty = true;
      }
      return snapshot;
    } finally {
      await handle.close();
    }
  }

  async verifyInventory(
    files: readonly string[],
    skillRoots: readonly string[],
  ): Promise<void> {
    const surfaces = [...files, ...skillRoots].map(
      (path) =>
        `${this.gitPrefix}${this.relativePath(path).split(sep).join("/")}`,
    );
    const committed = await git(
      "git",
      [
        ...this.gitArgs,
        "ls-tree",
        "--full-tree",
        "-r",
        "--format=%(objectmode) %(path)",
        "-z",
        this.source.commitSha,
        "--",
        ...surfaces,
      ],
      { env: this.gitEnvironment, timeout: 10_000, maxBuffer: 1_048_576 },
    );
    for (const entry of committed.stdout.split("\0").filter(Boolean)) {
      const mode = entry.slice(0, 6);
      const path = entry.slice(7 + this.gitPrefix.length);
      const isSkill = skillRoots.some((root) => {
        const prefix = `${root.replace(/^\.\//, "").replace(/\/$/, "")}/`;
        const remainder = path.slice(prefix.length);
        return path.startsWith(prefix) && /^[^/]+\/SKILL\.md$/.test(remainder);
      });
      if (
        (files.includes(path) || isSkill) &&
        (!this.capturedPaths.has(path) || !["100644", "100755"].includes(mode))
      )
        this.source.dirty = true;
    }
  }

  async json(path: string): Promise<Record<string, unknown>> {
    const snapshot = await this.read(path);
    const errors: ParseError[] = [];
    const tree = parseTree(snapshot.raw, errors, {
      disallowComments: true,
      allowTrailingComma: false,
    });
    if (!tree || errors.length || tree.type !== "object")
      invalid("Expected a valid JSON manifest object");
    const inspect = (node: Node): void => {
      const children = node.children ?? [];
      if (node.type === "object") {
        const keys = new Set<unknown>();
        for (const property of children) {
          const key: unknown = property.children?.[0]?.value;
          if (keys.has(key)) invalid("Duplicate JSON manifest key");
          keys.add(key);
        }
      }
      for (const child of children) inspect(child);
    };
    inspect(tree);
    this.manifests.push(snapshot);
    return JSON.parse(snapshot.raw) as Record<string, unknown>;
  }

  async skills(root: string): Promise<{ path: string; sha256: string }[]> {
    const path = join(root, "skills");
    const kind = await this.kind(path);
    if (kind === "missing") return [];
    if (kind !== "directory") {
      this.warnings.push("Ignored skills location: expected a directory.");
      return [];
    }
    const names = await readdir(
      join(this.source.root, this.relativePath(path)),
    );
    if (names.length > this.limits.maxSkills)
      invalid("Skill entry limit exceeded");
    const skills: { path: string; sha256: string }[] = [];
    for (const name of names.sort()) {
      const directory = join(path, name);
      if ((await this.kind(directory)) !== "directory") continue;
      const skill = join(directory, "SKILL.md");
      if ((await this.kind(skill)) !== "file") continue;
      const snapshot = await this.read(skill);
      skills.push({ path: snapshot.path, sha256: snapshot.sha256 });
    }
    return skills;
  }
}
