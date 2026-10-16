import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import * as filesystem from "node:fs/promises";
import { LocalSource } from "../src/marketplace/local-source.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli, defaultDependencies } from "../src/cli.js";
import { previewAgentPlugin } from "../src/marketplace/agent-plugins.js";
import { previewClaudeMarketplace } from "../src/marketplace/claude-marketplace.js";
import { captureOutput, temporaryDirectory, writeJson } from "./helpers.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof filesystem>();
  return { ...actual, open: vi.fn(actual.open) };
});

const run = promisify(execFile);
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () =>
  Promise.all(cleanups.splice(0).map((cleanup) => cleanup())),
);
const schema = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
async function repository() {
  const temp = await temporaryDirectory();
  cleanups.push(temp.cleanup);
  await run("git", ["init", "-q", temp.path]);
  await run("git", [
    "-C",
    temp.path,
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@example.test",
    "commit",
    "--allow-empty",
    "-qm",
    "fixture",
  ]);
  return temp.path;
}
async function agent(
  root: string,
  manifest: unknown = { $schema: schema, name: "team" },
) {
  await writeJson(join(root, "plugin.json"), manifest);
}
async function catalog(
  root: string,
  plugins: unknown = [{ name: "team", source: "./plugins/team" }],
) {
  await writeJson(join(root, ".claude-plugin/marketplace.json"), {
    name: "eigen",
    owner: { name: "Eigen" },
    plugins,
  });
}

describe("read-only marketplace previews", () => {
  it("preserves exact manifests, hashes and verified local commit without executing MCP or hooks", async () => {
    const root = await repository();
    await agent(root, {
      $schema: schema,
      name: "team",
      extensions: { "cl.eigen": { permissions: ["read"] } },
    });
    await writeJson(join(root, "mcp.json"), {
      mcpServers: { dangerous: { command: "touch should-not-exist" } },
    });
    await mkdir(join(root, "skills/review"), { recursive: true });
    await writeFile(
      join(root, "skills/review/SKILL.md"),
      "---\nname: review\ndescription: Review code\n---\nPrivate instructions\n",
    );
    const result = await previewAgentPlugin(root);
    expect(result.format).toBe("agent-plugins-v1");
    expect(result.source.commitSha).toMatch(/^[a-f0-9]{40}$/);
    expect(result.source.dirty).toBe(true);
    expect(result.manifests[0]!.raw).toBe(
      await readFile(join(root, "plugin.json"), "utf8"),
    );
    expect(result.manifests[0]!.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(result.plugins[0]!.skills).toEqual([
      {
        path: "skills/review/SKILL.md",
        sha256: result.plugins[0]!.skills[0]!.sha256,
      },
    ]);
    expect(result.plugins[0]!.capabilities).toEqual([
      "skills",
      "mcp-configuration",
    ]);
    expect(result.plugins[0]!.declarations).toEqual({
      extensions: { "cl.eigen": { permissions: ["read"] } },
    });
  });
  it("keeps Claude catalog entries and package manifests distinct, leaving remote sources unresolved", async () => {
    const root = await repository();
    await catalog(root, [
      { name: "team", source: "./plugins/team" },
      {
        name: "remote",
        source: {
          source: "github",
          repo: "eigen-cl/private",
          sha: "a".repeat(40),
        },
      },
    ]);
    await writeJson(join(root, "plugins/team/.claude-plugin/plugin.json"), {
      name: "team",
      hooks: { SessionStart: [{ command: "never run" }] },
      permissions: ["explicit-raw"],
    });
    const result = await previewClaudeMarketplace(root);
    expect(result.format).toBe("claude-marketplace");
    expect(result.plugins[0]!.declarations).toEqual({
      permissions: { plugin: ["explicit-raw"] },
    });
    expect(result.plugins[0]!.capabilities).toContain("hooks-configuration");
    expect(result.plugins[1]).toMatchObject({
      name: "remote",
      status: "unresolved",
      source: {
        source: "github",
        repo: "eigen-cl/private",
        sha: "a".repeat(40),
      },
    });
    expect(result.manifests).toHaveLength(2);
  });
  it("does not treat Claude manifests as Agent Plugins", async () => {
    const root = await repository();
    await writeJson(join(root, ".claude-plugin/plugin.json"), { name: "team" });
    await expect(previewAgentPlugin(root)).rejects.toThrow();
    await agent(root, { name: "team" });
    await expect(previewAgentPlugin(root)).rejects.toThrow(/manifest/i);
  });
  it.each([
    "../escape",
    "./plugins/../escape",
    "/tmp/escape",
    "./plugins\\escape",
    "./plugins/%2e%2e/escape",
  ])("rejects unsafe Claude source %s", async (source) => {
    const root = await repository();
    await catalog(root, [{ name: "unsafe", source }]);
    await expect(previewClaudeMarketplace(root)).rejects.toThrow(/path/i);
  });
  it("rejects symlink manifests and directories, including internal links", async () => {
    const root = await repository();
    await writeJson(join(root, "actual.json"), {
      $schema: schema,
      name: "team",
    });
    await symlink(join(root, "actual.json"), join(root, "plugin.json"));
    await expect(previewAgentPlugin(root)).rejects.toThrow(/symlink/i);
    const other = await repository();
    await catalog(other);
    await mkdir(join(other, "plugins"));
    await symlink(root, join(other, "plugins/team"));
    await expect(previewClaudeMarketplace(other)).rejects.toThrow(/symlink/i);
  });
  it("rejects duplicate catalog IDs and duplicate JSON keys", async () => {
    const root = await repository();
    await catalog(root, [
      { name: "team", source: { source: "github", repo: "a/b" } },
      { name: "team", source: { source: "github", repo: "c/d" } },
    ]);
    await expect(previewClaudeMarketplace(root)).rejects.toThrow(/duplicate/i);
    await writeFile(
      join(root, "plugin.json"),
      `{"$schema":"${schema}","name":"a","name":"b"}`,
    );
    await expect(previewAgentPlugin(root)).rejects.toThrow(/duplicate/i);
  });
  it("enforces bounded manifests, catalog counts, and skill counts", async () => {
    const root = await repository();
    await agent(root);
    await expect(previewAgentPlugin(root, { maxFileBytes: 8 })).rejects.toThrow(
      /limit/i,
    );
    await catalog(root, [
      { name: "one", source: { source: "github", repo: "a/b" } },
      { name: "two", source: { source: "github", repo: "a/c" } },
    ]);
    await expect(
      previewClaudeMarketplace(root, { maxPlugins: 1 }),
    ).rejects.toThrow(/limit/i);
    await mkdir(join(root, "skills/one"), { recursive: true });
    await mkdir(join(root, "skills/two"));
    await expect(previewAgentPlugin(root, { maxSkills: 1 })).rejects.toThrow(
      /limit/i,
    );
  });
  it("requires a local Git commit and exposes modified state separately", async () => {
    const temp = await temporaryDirectory();
    cleanups.push(temp.cleanup);
    await agent(temp.path);
    await expect(previewAgentPlugin(temp.path)).rejects.toThrow(/Git/i);
    const root = await repository();
    await agent(root);
    await run("git", ["-C", root, "add", "."]);
    await run("git", [
      "-C",
      root,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.test",
      "commit",
      "-qm",
      "package",
    ]);
    expect((await previewAgentPlugin(root)).source.dirty).toBe(false);
  });
  it("detects deleted committed skills and MCP configuration without invoking Git filters", async () => {
    const root = await repository();
    await agent(root);
    await mkdir(join(root, "skills/review"), { recursive: true });
    await writeFile(join(root, "skills/review/SKILL.md"), "instructions");
    await writeJson(join(root, "mcp.json"), {});
    await run("git", ["-C", root, "add", "."]);
    await run("git", [
      "-C",
      root,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.test",
      "commit",
      "-qm",
      "components",
    ]);
    expect((await previewAgentPlugin(root)).source.dirty).toBe(false);
    await rm(join(root, "skills"), { recursive: true });
    expect((await previewAgentPlugin(root)).source.dirty).toBe(true);
    await rm(join(root, "mcp.json"));
    expect((await previewAgentPlugin(root)).source.dirty).toBe(true);
    await run("git", [
      "-C",
      root,
      "config",
      "filter.evil.clean",
      `touch ${join(root, "FILTER_EXECUTED")}`,
    ]);
    await writeFile(join(root, ".gitattributes"), "* filter=evil\n");
    expect((await previewAgentPlugin(root)).source.dirty).toBe(true);
    await expect(readFile(join(root, "FILTER_EXECUTED"))).rejects.toThrow();
  });
  it("provides CLI preview without auth, config, update network, raw payloads or mutation", async () => {
    const root = await repository();
    await agent(root, {
      $schema: schema,
      name: "team",
      extensions: { "cl.eigen": { secretLike: "MUST_NOT_PRINT" } },
    });
    const output = captureOutput();
    const check = vi.fn();
    const configRepositoryFactory = vi.fn();
    expect(
      await runCli(
        ["marketplace", "preview", ".", "--format", "agent-plugins"],
        {
          ...defaultDependencies,
          cwd: root,
          output,
          configRepositoryFactory,
          updateService: { check },
        },
      ),
    ).toBe(0);
    expect(check).not.toHaveBeenCalled();
    expect(configRepositoryFactory).not.toHaveBeenCalled();
    expect(output.messages.join("\n")).toContain("agent-plugins-v1");
    expect(output.messages.join("\n")).not.toContain("MUST_NOT_PRINT");
    expect(
      await runCli(["marketplace", "preview", ".", "--format", "invalid"], {
        ...defaultDependencies,
        cwd: root,
        output,
      }),
    ).toBe(1);
  });
});

describe("inventory boundaries and provenance", () => {
  it("reports ignored metadata without printing arbitrary manifest keys", async () => {
    const root = await repository();
    await agent(root, {
      $schema: schema,
      name: "team",
      MUST_NOT_PRINT: "private",
      extensions: [],
    });
    await mkdir(join(root, "mcp.json"));
    const result = await previewAgentPlugin(root);
    expect(result.warnings.join(" ")).toContain("unknown");
    expect(result.warnings.join(" ")).not.toContain("MUST_NOT_PRINT");
    expect(result.warnings.join(" ")).toContain("extensions");
    expect(result.warnings.join(" ")).toContain("MCP");
    expect(result.plugins[0]!.declarations).toEqual({});
  });
  it.each([
    "",
    "null",
    "[]",
    "{",
    '{"name":"a",}',
    '{/* comment */ "name":"a"}',
  ])("rejects malformed or non-object JSON %s", async (raw) => {
    const root = await repository();
    await writeFile(join(root, "plugin.json"), raw);
    await expect(previewAgentPlugin(root)).rejects.toThrow(/manifest/i);
  });
  it("rejects non-UTF8 files and invalid inventory limits", async () => {
    const root = await repository();
    await writeFile(join(root, "plugin.json"), Buffer.from([0xff]));
    await expect(previewAgentPlugin(root)).rejects.toThrow(/UTF-8/i);
    await expect(previewAgentPlugin(root, { maxPlugins: 0 })).rejects.toThrow(
      /limits/i,
    );
  });
  it("bounds the aggregate byte budget", async () => {
    const root = await repository();
    await agent(root);
    await writeJson(join(root, "mcp.json"), { mcpServers: {} });
    const size = Buffer.byteLength(
      await readFile(join(root, "plugin.json"), "utf8"),
    );
    await expect(
      previewAgentPlugin(root, { maxTotalBytes: size }),
    ).rejects.toThrow(/limit/i);
  });
  it("ignores unsupported skills locations and non-skill children", async () => {
    const root = await repository();
    await agent(root);
    await writeFile(join(root, "skills"), "wrong kind");
    expect((await previewAgentPlugin(root)).warnings.join(" ")).toContain(
      "skills location",
    );
    await rm(join(root, "skills"));
    await mkdir(join(root, "skills/empty"), { recursive: true });
    await writeFile(join(root, "skills/file"), "not a directory");
    expect((await previewAgentPlugin(root)).plugins[0]!.skills).toEqual([]);
  });
  it("rejects missing sources, invalid catalogs, and mismatched package names", async () => {
    const root = await repository();
    await writeJson(join(root, ".claude-plugin/marketplace.json"), {
      name: "bad",
    });
    await expect(previewClaudeMarketplace(root)).rejects.toThrow(/manifest/i);
    await catalog(root);
    await expect(previewClaudeMarketplace(root)).rejects.toThrow(/path/i);
    await writeJson(join(root, "plugins/team/.claude-plugin/plugin.json"), {
      name: "different",
    });
    await expect(previewClaudeMarketplace(root)).rejects.toThrow(/names/i);
  });
  it("inventories Claude root plugins and keeps catalog/plugin declarations separately", async () => {
    const root = await repository();
    await catalog(root, [
      {
        name: "team",
        source: "./",
        allowedTools: ["Read"],
        hooks: { SessionStart: [] },
      },
    ]);
    await mkdir(join(root, "skills/review"), { recursive: true });
    await writeFile(join(root, "skills/review/SKILL.md"), "instructions");
    await writeJson(join(root, "hooks/hooks.json"), { hooks: {} });
    await writeJson(join(root, ".mcp.json"), { servers: {} });
    const output = captureOutput();
    expect(
      await runCli(
        ["marketplace", "preview", root, "--format", "claude-marketplace"],
        { ...defaultDependencies, output },
      ),
    ).toBe(0);
    const result = await previewClaudeMarketplace(root);
    expect(result.plugins[0]!.declarations).toEqual({
      allowedTools: { catalog: ["Read"] },
    });
    expect(result.plugins[0]!.capabilities).toEqual([
      "skills",
      "hooks-configuration",
      "mcp-configuration",
    ]);
    expect(result.manifests).toHaveLength(3);
  });
  it("compares captured bytes and ignores Git replace references", async () => {
    const root = await repository();
    await agent(root);
    await run("git", ["-C", root, "add", "."]);
    await run("git", [
      "-C",
      root,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.test",
      "commit",
      "-qm",
      "A",
    ]);
    const a = (
      await run("git", ["-C", root, "rev-parse", "HEAD"])
    ).stdout.trim();
    await agent(root, { $schema: schema, name: "changed" });
    expect((await previewAgentPlugin(root)).source.dirty).toBe(true);
    await run("git", ["-C", root, "add", "."]);
    await run("git", [
      "-C",
      root,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.test",
      "commit",
      "-qm",
      "B",
    ]);
    const b = (
      await run("git", ["-C", root, "rev-parse", "HEAD"])
    ).stdout.trim();
    await run("git", ["-C", root, "update-ref", "HEAD", a]);
    await run("git", ["-C", root, "replace", a, b]);
    const result = await previewAgentPlugin(root);
    expect(result.source.commitSha).toBe(a);
    expect(result.source.dirty).toBe(true);
  });
});

describe("local source failure modes", () => {
  afterEach(() => vi.restoreAllMocks());
  it("detects missing committed skills in nested packages and committed symlink modes", async () => {
    const root = await repository();
    const plugin = join(root, "plugins/team");
    await mkdir(join(plugin, "skills/review"), { recursive: true });
    await agent(plugin);
    await writeFile(join(plugin, "skills/actual"), "instructions");
    await symlink("../actual", join(plugin, "skills/review/SKILL.md"));
    await run("git", ["-C", root, "add", "."]);
    await run("git", [
      "-C",
      root,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.test",
      "commit",
      "-qm",
      "symlink",
    ]);
    await rm(join(plugin, "skills/review/SKILL.md"));
    await writeFile(join(plugin, "skills/review/SKILL.md"), "../actual");
    expect((await previewAgentPlugin(plugin)).source.dirty).toBe(true);
    await rm(join(plugin, "skills/review/SKILL.md"));
    expect((await previewAgentPlugin(plugin)).source.dirty).toBe(true);
  });
  it("rejects all unsafe relative path forms and nonregular package files", async () => {
    const root = await repository();
    const local = await LocalSource.create(root, {});
    for (const path of [
      "",
      "/tmp/outside",
      "../outside",
      "a\\b",
      "a%b",
      "a\0b",
    ])
      expect(() => local.relativePath(path)).toThrow(/path/i);
    await run("mkfifo", [join(root, "pipe")]);
    expect(await local.kind("pipe")).toBe("other");
    await expect(local.read("pipe")).rejects.toThrow(/regular/i);
  });
  it("rejects a file replaced by a directory between inspection and opening", async () => {
    const root = await repository();
    await agent(root);
    const { open: actualOpen } =
      await vi.importActual<typeof filesystem>("node:fs/promises");
    vi.mocked(filesystem.open).mockImplementationOnce(
      async (path, flags, mode) => {
        await rm(join(root, "plugin.json"));
        await mkdir(join(root, "plugin.json"));
        return actualOpen(path, flags, mode);
      },
    );
    await expect(previewAgentPlugin(root)).rejects.toThrow(/regular/i);
  });
  it("enforces limits when content grows after stat", async () => {
    const root = await repository();
    await writeFile(join(root, "plugin.json"), "{}");
    const { open: actualOpen } =
      await vi.importActual<typeof filesystem>("node:fs/promises");
    vi.mocked(filesystem.open).mockImplementationOnce(
      async (path, flags, mode) => {
        const handle = await actualOpen(path, flags, mode);
        const initial = await handle.stat();
        vi.spyOn(handle, "stat").mockImplementationOnce(async () => {
          await writeFile(join(root, "plugin.json"), "x".repeat(100));
          return initial;
        });
        return handle;
      },
    );
    await expect(
      previewAgentPlugin(root, { maxFileBytes: 16 }),
    ).rejects.toThrow(/limit/i);
  });
});
