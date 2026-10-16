import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs/promises";
import { deflateSync } from "node:zlib";
import * as plumbing from "../src/marketplace/local-git.js";
import { materializeBundleBytes } from "../src/marketplace/bundle-store.js";
vi.mock("../src/marketplace/local-git.js", async (original) => ({
  ...(await original<typeof import("../src/marketplace/local-git.js")>()),
}));
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  readCommittedGitBundle,
  materializeCommittedGitBundle,
} from "../src/marketplace/git-bundle.js";
import { hash, temporaryDirectory } from "./helpers.js";
const git = promisify(execFile);
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await Promise.all(cleanups.splice(0).map((fn) => fn()));
});
async function fixture(options: { sha256?: boolean; large?: boolean } = {}) {
  const temp = await temporaryDirectory();
  cleanups.push(temp.cleanup);
  const root = await fs.realpath(temp.path);
  const repositoryDirectory = join(root, "repository");
  await fs.mkdir(repositoryDirectory);
  await git("git", [
    "init",
    "-q",
    ...(options.sha256 ? ["--object-format=sha256"] : []),
    repositoryDirectory,
  ]);
  const bodies: Record<string, Buffer> = {
    "plugin.json": Buffer.from(
      '{"name":"fixture","hooks":{"SessionStart":[{"command":"never execute"}]}}',
    ),
    "skills/demo/SKILL.md": Buffer.from("# Fixture"),
    "scripts/run.sh": Buffer.from("#!/bin/sh\nexit 97\n"),
    "data/table.csv": Buffer.from(
      "key,value\n" + "x,y\n".repeat(options.large ? 300000 : 2),
    ),
    "references/binary.dat": Buffer.alloc(options.large ? 600000 : 4, 255),
    ".gitattributes": Buffer.from("* filter=evil\n"),
    LICENSE: Buffer.from("Fixture license"),
  };
  for (const [path, content] of Object.entries(bodies)) {
    const target = join(repositoryDirectory, "plugins/demo", path);
    await fs.mkdir(join(target, ".."), { recursive: true });
    await fs.writeFile(target, content);
    if (path === "scripts/run.sh") await fs.chmod(target, 0o755);
  }
  await fs.mkdir(join(repositoryDirectory, "outside"));
  await fs.writeFile(
    join(repositoryDirectory, "outside/private"),
    "SHOULD_NOT_CAPTURE",
  );
  await git("git", ["-C", repositoryDirectory, "add", "."]);
  await git("git", [
    "-C",
    repositoryDirectory,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "commit",
    "-qm",
    "fixture",
  ]);
  const commitSha = (
    await git("git", ["-C", repositoryDirectory, "rev-parse", "HEAD"])
  ).stdout.trim();
  const input = {
    repositoryDirectory,
    commitSha,
    packageRoot: "plugins/demo",
    limits: {
      maxFiles: 30,
      maxFileBytes: 2000000,
      maxTotalBytes: 4000000,
      maxDepth: 8,
      maxEntries: 60,
      maxOutputBytes: 5000000,
      maxDurationMs: 10000,
    },
  };
  return { root, input, bodies, read: () => readCommittedGitBundle(input) };
}
describe("local committed complete bundle provenance", () => {
  it("anchors every byte/blob/mode to a full commit, excluding working-tree mutations and siblings", async () => {
    const f = await fixture();
    await fs.rm(join(f.input.repositoryDirectory, "plugins"), {
      recursive: true,
    });
    await fs.symlink(
      join(f.input.repositoryDirectory, "outside"),
      join(f.input.repositoryDirectory, "plugins"),
    );
    await fs.writeFile(join(f.input.repositoryDirectory, "extra"), "untracked");
    const result = await f.read();
    expect(result.commitSha).toBe(f.input.commitSha);
    expect(result.packageRoot).toBe("plugins/demo");
    expect(result.treeOid).toMatch(/^[a-f0-9]{40}$/);
    expect(result.files).toHaveLength(Object.keys(f.bodies).length);
    for (const file of result.files) {
      expect(file.content).toEqual(f.bodies[file.path]);
      expect(file.sha256).toBe(hash(file.content));
      expect(file.size).toBe(file.content.length);
      expect(file.blobOid).toMatch(/^[a-f0-9]{40}$/);
      expect(file.mode).toBe(
        file.path === "scripts/run.sh" ? "100755" : "100644",
      );
    }
    expect(result.files.some((file) => file.path.includes("outside"))).toBe(
      false,
    );
  });
  it("connects committed full bundles directly to inert materialization without an executable export", async () => {
    const f = await fixture();
    await fs.writeFile(
      join(f.input.repositoryDirectory, "plugins/demo/LICENSE"),
      "UNTRUSTED WORKTREE",
    );
    const result = await materializeCommittedGitBundle({
      ...f.input,
      storeDirectory: join(f.root, "store"),
      ownerId: "fixture",
    });
    expect(result.source.commitSha).toBe(f.input.commitSha);
    for (const [path, content] of Object.entries(f.bodies)) {
      expect(await fs.readFile(join(result.stored.directory, path))).toEqual(
        content,
      );
      expect(
        (await fs.stat(join(result.stored.directory, path))).mode & 0o777,
      ).toBe(0o600);
    }
    expect(result.stored.created).toBe(true);
  });
  it("rejects abbreviated, symbolic, wrong-type and missing commit inputs", async () => {
    const f = await fixture();
    const blob = (
      await git("git", [
        "-C",
        f.input.repositoryDirectory,
        "rev-parse",
        `${f.input.commitSha}:plugins/demo/LICENSE`,
      ])
    ).stdout.trim();
    for (const commitSha of [
      "HEAD",
      f.input.commitSha.slice(0, 12),
      blob,
      "0".repeat(40),
    ])
      await expect(
        readCommittedGitBundle({ ...f.input, commitSha }),
      ).rejects.toMatchObject({ code: "INTEGRITY_FAILED" });
  });
});

async function writeObject(
  repository: string,
  type: string,
  body: Buffer,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "git",
      [
        "-C",
        repository,
        "hash-object",
        "--literally",
        "-t",
        type,
        "-w",
        "--stdin",
      ],
      { timeout: 10000 },
      (error, stdout) => (error ? reject(error) : resolve(stdout.trim())),
    );
    if (!child.stdin) throw new Error("fixture stdin unavailable");
    child.stdin.end(body);
  });
}
async function commitTree(repository: string, tree: string): Promise<string> {
  return (
    await git("git", [
      "-C",
      repository,
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.test",
      "-c",
      "commit.gpgsign=false",
      "commit-tree",
      tree,
      "-m",
      "fixture",
    ])
  ).stdout.trim();
}
async function literalTree(
  f: Awaited<ReturnType<typeof fixture>>,
  entries: { mode: string; name: Buffer | string; oid: string }[],
) {
  const body = Buffer.concat(
    entries.flatMap((entry) => [
      Buffer.from(`${entry.mode} `),
      Buffer.from(entry.name),
      Buffer.from([0]),
      Buffer.from(entry.oid, "hex"),
    ]),
  );
  const tree = await writeObject(f.input.repositoryDirectory, "tree", body);
  f.input.commitSha = await commitTree(f.input.repositoryDirectory, tree);
  f.input.packageRoot = ".";
}
async function blob(f: Awaited<ReturnType<typeof fixture>>, path = "LICENSE") {
  return (
    await git("git", [
      "-C",
      f.input.repositoryDirectory,
      "rev-parse",
      `${f.input.commitSha}:plugins/demo/${path}`,
    ])
  ).stdout.trim();
}

it("supports SHA-256 Git object identities and larger binary/CSV packages", async () => {
  const f = await fixture({ sha256: true, large: true });
  const result = await f.read();
  expect(result.commitSha).toHaveLength(64);
  expect(result.treeOid).toHaveLength(64);
  for (const file of result.files) expect(file.blobOid).toHaveLength(64);
  expect(
    result.files.find((file) => file.path === "data/table.csv")?.size,
  ).toBeGreaterThan(1048576);
  expect(
    result.files.find((file) => file.path === "references/binary.dat")?.size,
  ).toBe(600000);
});
it.each([
  "",
  "../outside",
  "/absolute",
  "a/./b",
  "a//b",
  "a\\b",
  "nul\0x",
  "e\u0301",
  "plugins/demo/LICENSE",
  "plugins/missing",
  "plugins/*",
])(
  "rejects unsafe or non-tree literal package root %j",
  async (packageRoot) => {
    const f = await fixture();
    await expect(
      readCommittedGitBundle({ ...f.input, packageRoot }),
    ).rejects.toMatchObject({ code: "INTEGRITY_FAILED" });
  },
);
it("does not peel an annotated tag masquerading as a full commit identity", async () => {
  const f = await fixture();
  await git("git", [
    "-C",
    f.input.repositoryDirectory,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "tag",
    "-am",
    "fixture",
    "fixture-tag",
  ]);
  const commitSha = (
    await git("git", [
      "-C",
      f.input.repositoryDirectory,
      "rev-parse",
      "fixture-tag",
    ])
  ).stdout.trim();
  await expect(
    readCommittedGitBundle({ ...f.input, commitSha }),
  ).rejects.toMatchObject({ code: "INTEGRITY_FAILED" });
});
it("ignores Git replacement refs and inherited Git repository/config overrides", async () => {
  const f = await fixture();
  const original = f.input.commitSha;
  await fs.writeFile(
    join(f.input.repositoryDirectory, "plugins/demo/LICENSE"),
    "replacement",
  );
  await git("git", ["-C", f.input.repositoryDirectory, "add", "."]);
  await git("git", [
    "-C",
    f.input.repositoryDirectory,
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.test",
    "commit",
    "-qm",
    "replacement",
  ]);
  const replacement = (
    await git("git", ["-C", f.input.repositoryDirectory, "rev-parse", "HEAD"])
  ).stdout.trim();
  await git("git", [
    "-C",
    f.input.repositoryDirectory,
    "replace",
    original,
    replacement,
  ]);
  vi.stubEnv("GIT_DIR", join(f.root, "wrong"));
  vi.stubEnv("GIT_NO_REPLACE_OBJECTS", "0");
  vi.stubEnv("GIT_CONFIG_COUNT", "1");
  vi.stubEnv("GIT_CONFIG_KEY_0", "core.fsmonitor");
  vi.stubEnv("GIT_CONFIG_VALUE_0", "never execute");
  expect(
    (await f.read()).files.find((file) => file.path === "LICENSE")?.content,
  ).toEqual(f.bodies.LICENSE);
});
it.each(["blob", "tree", "commit"])(
  "rejects corrupt content under an existing %s object identity",
  async (type) => {
    const f = await fixture();
    const oid =
      type === "blob"
        ? await blob(f)
        : type === "commit"
          ? f.input.commitSha
          : (
              await git("git", [
                "-C",
                f.input.repositoryDirectory,
                "rev-parse",
                `${f.input.commitSha}:plugins/demo`,
              ])
            ).stdout.trim();
    const original = (
      await git(
        "git",
        ["-C", f.input.repositoryDirectory, "cat-file", type, oid],
        { encoding: "buffer" },
      )
    ).stdout;
    const changed = Buffer.from(original);
    changed[changed.length - 1] = (changed[changed.length - 1] ?? 0) ^ 1;
    const objectPath = join(
      f.input.repositoryDirectory,
      ".git/objects",
      oid.slice(0, 2),
      oid.slice(2),
    );
    await fs.chmod(objectPath, 0o600);
    await fs.writeFile(
      objectPath,
      deflateSync(
        Buffer.concat([Buffer.from(`${type} ${changed.length}\0`), changed]),
      ),
    );
    await expect(f.read()).rejects.toMatchObject({ code: "INTEGRITY_FAILED" });
  },
);
it.each(["120000", "160000"])(
  "rejects committed mode %s instead of following it",
  async (mode) => {
    const f = await fixture();
    await literalTree(f, [
      {
        mode,
        name: "unsafe",
        oid: mode === "160000" ? f.input.commitSha : await blob(f),
      },
    ]);
    await expect(f.read()).rejects.toMatchObject({ code: "INTEGRITY_FAILED" });
  },
);
it.each([
  "../escape",
  "a/../escape",
  "/absolute",
  "a\\b",
  "a\nb",
  "e\u0301",
  Buffer.from([0xff]),
])("rejects malicious committed paths %j", async (name) => {
  const f = await fixture();
  await literalTree(f, [{ mode: "100644", name, oid: await blob(f) }]);
  await expect(f.read()).rejects.toMatchObject({ code: "INTEGRITY_FAILED" });
});
it("rejects case collisions even when the working filesystem cannot hold both names", async () => {
  const f = await fixture();
  const oid = await blob(f);
  await literalTree(f, [
    { mode: "100644", name: "A", oid },
    { mode: "100644", name: "a", oid },
  ]);
  await expect(f.read()).rejects.toMatchObject({ code: "INTEGRITY_FAILED" });
});
it("rejects committed empty directories rather than silently dropping layout", async () => {
  const f = await fixture();
  const empty = await writeObject(
    f.input.repositoryDirectory,
    "tree",
    Buffer.alloc(0),
  );
  await literalTree(f, [
    { mode: "040000", name: "empty", oid: empty },
    { mode: "100644", name: "LICENSE", oid: await blob(f) },
  ]);
  await expect(f.read()).rejects.toMatchObject({ code: "INTEGRITY_FAILED" });
});
it.each([
  "files",
  "entries",
  "file-bytes",
  "total-bytes",
  "output",
  "invalid",
  "deadline-before",
  "deadline-after",
])("enforces caller %s budget", async (kind) => {
  const f = await fixture();
  if (kind === "files") f.input.limits.maxFiles = 1;
  if (kind === "entries") f.input.limits.maxEntries = 1;
  if (kind === "file-bytes") f.input.limits.maxFileBytes = 1;
  if (kind === "total-bytes") f.input.limits.maxTotalBytes = 1;
  if (kind === "output") f.input.limits.maxOutputBytes = 20;
  if (kind === "invalid") f.input.limits.maxDurationMs = 0;
  if (kind === "deadline-before")
    vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValue(100000);
  if (kind === "deadline-after")
    vi.spyOn(performance, "now")
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValue(100000);
  await expect(f.read()).rejects.toMatchObject({ code: "INTEGRITY_FAILED" });
});
it.each(["missing-repository", "inside-repository"])(
  "rejects materialization %s without changing repository data",
  async (kind) => {
    const f = await fixture();
    await expect(
      materializeCommittedGitBundle({
        ...f.input,
        repositoryDirectory:
          kind === "missing-repository"
            ? join(f.root, "missing")
            : f.input.repositoryDirectory,
        storeDirectory: join(f.input.repositoryDirectory, "store"),
        ownerId: "fixture",
      }),
    ).rejects.toMatchObject({ code: "INTEGRITY_FAILED" });
    expect(
      await fs.readFile(
        join(f.input.repositoryDirectory, "plugins/demo/LICENSE"),
      ),
    ).toEqual(f.bodies.LICENSE);
  },
);
it.each(["length", "hash"])(
  "rejects corrupted byte input %s before creating a store",
  async (kind) => {
    const f = await fixture();
    const source = await f.read();
    const file = source.files[0];
    if (!file) throw new Error("fixture");
    file.content =
      kind === "length" ? Buffer.alloc(0) : Buffer.alloc(file.size, 120);
    await expect(
      materializeBundleBytes({
        ...f.input,
        files: source.files,
        ownerId: "fixture",
        storeDirectory: join(f.root, "store"),
      }),
    ).rejects.toMatchObject({ code: "INTEGRITY_FAILED" });
    await expect(fs.stat(join(f.root, "store"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  },
);
it.each([false, true])(
  "does not execute hooks, filters, fsmonitor or remote helpers (missing blob=%s)",
  async (missing) => {
    const f = await fixture();
    const marker = join(f.root, "EXECUTED");
    const trap = join(f.root, "trap.sh");
    await fs.writeFile(trap, `#!/bin/sh\ntouch "${marker}"\nexit 77\n`, {
      mode: 0o700,
    });
    for (const hook of [
      "post-checkout",
      "post-merge",
      "post-index-change",
      "pre-commit",
    ])
      await fs.writeFile(
        join(f.input.repositoryDirectory, ".git/hooks", hook),
        `#!/bin/sh\nsh "${trap}"\n`,
        { mode: 0o700 },
      );
    for (const [key, value] of [
      ["core.fsmonitor", `sh "${trap}"`],
      ["filter.evil.clean", `sh "${trap}"`],
      ["filter.evil.smudge", `sh "${trap}"`],
      ["filter.evil.required", "true"],
      ["protocol.ext.allow", "always"],
      ["remote.origin.url", `ext::sh ${trap}`],
      ["remote.origin.promisor", "true"],
      ["extensions.partialClone", "origin"],
    ] as const)
      await git("git", [
        "-C",
        f.input.repositoryDirectory,
        "config",
        key,
        value,
      ]);
    if (missing) {
      const oid = await blob(f);
      await fs.rm(
        join(
          f.input.repositoryDirectory,
          ".git/objects",
          oid.slice(0, 2),
          oid.slice(2),
        ),
      );
    }
    const calls = vi.spyOn(plumbing, "executeLocalGit");
    const network = vi.fn(() => {
      throw new Error("network forbidden");
    });
    vi.stubGlobal("fetch", network);
    if (missing)
      await expect(f.read()).rejects.toMatchObject({
        code: "INTEGRITY_FAILED",
        message: "Committed local package could not be verified.",
      });
    else
      expect(
        (
          await materializeCommittedGitBundle({
            ...f.input,
            ownerId: "fixture",
            storeDirectory: join(f.root, "store"),
          })
        ).stored.created,
      ).toBe(true);
    expect(network).not.toHaveBeenCalled();
    await expect(fs.stat(marker)).rejects.toMatchObject({ code: "ENOENT" });
    expect(calls).toHaveBeenCalled();
    for (const call of calls.mock.calls) {
      expect(call[0]).toBe("git");
      expect(call[1]).toContain("--no-replace-objects");
      expect(call[1]).toContain("--literal-pathspecs");
      expect(call[1]).not.toContain("--filters");
      expect(call[1]).not.toContain("checkout");
      expect(call[1]).not.toContain("status");
      expect(call[1]).not.toContain("diff");
      expect(call[2].env).toMatchObject({
        GIT_NO_LAZY_FETCH: "1",
        GIT_NO_REPLACE_OBJECTS: "1",
        GIT_ALLOW_PROTOCOL: "",
        GIT_TERMINAL_PROMPT: "0",
      });
    }
  },
);
it.each(["missing-tree", "wrong-oid-length", "high-bit-header"])(
  "rejects an invalid committed header %s",
  async (kind) => {
    const f = await fixture();
    const root = (
      await git("git", [
        "-C",
        f.input.repositoryDirectory,
        "rev-parse",
        `${f.input.commitSha}^{tree}`,
      ])
    ).stdout.trim();
    const body = Buffer.from(
      kind === "missing-tree"
        ? "not a commit\n"
        : `tree ${kind === "wrong-oid-length" ? "a".repeat(64) : root}\n\nfixture\n`,
    );
    if (kind === "high-bit-header") {
      const at = body.indexOf(Buffer.from("tree ")) + 5;
      body[at] = (body[at] ?? 0) | 128;
    }
    f.input.commitSha = await writeObject(
      f.input.repositoryDirectory,
      "commit",
      body,
    );
    await expect(f.read()).rejects.toMatchObject({ code: "INTEGRITY_FAILED" });
  },
);
it.each(["missing-nul", "wrong-oid-length", "wrong-size", "malformed"])(
  "rejects corrupted plumbing output %s without publishing",
  async (kind) => {
    const f = await fixture();
    const original = plumbing.executeLocalGit;
    vi.spyOn(plumbing, "executeLocalGit").mockImplementation(
      async (file, args, options) => {
        const result = await original(file, args, options);
        if (
          args.includes("ls-tree") &&
          (kind !== "wrong-size" || args.includes("-r"))
        ) {
          let stdout = Buffer.from(result.stdout);
          if (kind === "missing-nul") stdout = stdout.subarray(0, -1);
          if (kind === "wrong-oid-length")
            stdout = Buffer.from(
              stdout.toString().replace(/[a-f0-9]{40}/, "a".repeat(38)),
            );
          if (kind === "malformed") stdout = Buffer.from("malformed\0");
          if (kind === "wrong-size")
            stdout = Buffer.from(
              stdout
                .toString()
                .replace(
                  /(100644 blob [a-f0-9]{40} +)([0-9]+)/,
                  (_match, prefix: string, size: string) =>
                    prefix + String(Number(size) + 1),
                ),
            );
          return { ...result, stdout };
        }
        return result;
      },
    );
    await expect(
      materializeCommittedGitBundle({
        ...f.input,
        ownerId: "fixture",
        storeDirectory: join(f.root, "store"),
      }),
    ).rejects.toMatchObject({ code: "INTEGRITY_FAILED" });
    await expect(fs.stat(join(f.root, "store"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  },
);
it("refuses to return success when the overall deadline expires after the final blob read", async () => {
  const f = await fixture();
  const expectedBlobReads = Object.keys(f.bodies).length;
  let blobReads = 0;
  let finished = false;
  let afterRead = false;
  const original = plumbing.executeLocalGit;
  vi.spyOn(performance, "now").mockImplementation(() => {
    if (!finished) return 0;
    if (!afterRead) {
      afterRead = true;
      return 0;
    }
    return 100000;
  });
  vi.spyOn(plumbing, "executeLocalGit").mockImplementation(
    async (file, args, options) => {
      const result = await original(file, args, options);
      if (args.includes("blob")) {
        blobReads += 1;
        if (blobReads === expectedBlobReads) finished = true;
      }
      return result;
    },
  );
  await expect(f.read()).rejects.toMatchObject({ code: "INTEGRITY_FAILED" });
  expect(blobReads).toBe(expectedBlobReads);
});
