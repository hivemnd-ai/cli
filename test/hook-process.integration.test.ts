import { execFile, spawn } from "node:child_process";
import { mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { AgentKind } from "../src/domain.js";
import { AlwaysContextCache } from "../src/context/always-context-cache.js";
import {
  hookLauncherDefinition,
  HostHookRegistration,
} from "../src/hooks/registration.js";
import { profileKey } from "../src/organizations/registry.js";
import { UsageReceiptOutbox } from "../src/usage/receipt-outbox.js";
import {
  bytes,
  hash,
  prepared,
  temporaryDirectory,
  writeJson,
} from "./helpers.js";

const run = promisify(execFile);
const cleanups: Array<() => Promise<void>> = [];
const installationId = "synthetic-installation";
const eigenUrl = "https://shared.hivemnd.cloud/eigen";
const acmeUrl = "https://shared.hivemnd.cloud/acme";
const privateMarker = "SYNTHETIC_PRIVATE_INPUT_MUST_NOT_PERSIST";
let build: Awaited<ReturnType<typeof temporaryDirectory>>;
let executable: string;

beforeAll(async () => {
  build = await temporaryDirectory();
  await writeJson(join(build.path, "package.json"), { type: "module" });
  const repository = resolve(import.meta.dirname, "..");
  await symlink(
    join(repository, "node_modules"),
    join(build.path, "node_modules"),
  );
  await run(
    process.execPath,
    [
      join(repository, "node_modules", "typescript", "bin", "tsc"),
      "-p",
      join(repository, "tsconfig.build.json"),
      "--outDir",
      join(build.path, "dist"),
      "--declaration",
      "false",
      "--sourceMap",
      "false",
    ],
    { cwd: repository, timeout: 30_000 },
  );
  executable = join(build.path, "dist", "index.js");
}, 30_000);

afterAll(async () => {
  await build.cleanup();
});

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

// The preload observes forbidden boundary calls in the actual child process.
// It does not replace the CLI's parser, registry, cache, hook, or outbox code.
const boundaryGuard = `
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import net from 'node:net';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import dns from 'node:dns';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
const attempts = [];
const originalWrite = fs.writeFileSync;
function forbidden(operation) {
  return () => {
    attempts.push(operation);
    throw new Error('Synthetic test blocked ' + operation);
  };
}
globalThis.fetch = forbidden('fetch');
net.Socket.prototype.connect = forbidden('socket');
for (const target of [http, https]) {
  target.request = forbidden('http');
  target.get = forbidden('http');
}
tls.connect = forbidden('tls');
dns.lookup = forbidden('dns');
dns.resolve = forbidden('dns');
for (const name of ['exec', 'execFile', 'execSync', 'execFileSync', 'spawn', 'spawnSync', 'fork']) {
  childProcess[name] = forbidden('subprocess');
}
for (const target of [fs, fsp]) {
  for (const name of ['readFile', 'readFileSync']) {
    if (!target[name]) continue;
    const original = target[name];
    target[name] = function(path, ...args) {
      if (String(path) === process.env.TEST_TRANSCRIPT) return forbidden('transcript')();
      return original.call(this, path, ...args);
    };
  }
}
syncBuiltinESMExports();
process.on('exit', () => originalWrite(process.env.TEST_BOUNDARY_REPORT, JSON.stringify(attempts)));
`;

async function fixture() {
  const temp = await temporaryDirectory();
  cleanups.push(temp.cleanup);
  const home = join(temp.path, "home");
  const state = join(home, ".hivemnd");
  const workspace = join(temp.path, "workspace");
  const transcript = join(temp.path, "transcript.jsonl");
  const guard = join(temp.path, "boundary-guard.mjs");
  const report = join(temp.path, "boundary-report.json");
  await mkdir(workspace);
  await mkdir(home);
  await writeFile(guard, boundaryGuard);
  await writeFile(transcript, privateMarker);

  async function addOrganization(
    alias: string,
    apiUrl: string,
    content: string,
  ) {
    const configPath = join(
      state,
      "organizations",
      profileKey(apiUrl),
      "config.json",
    );
    await writeJson(configPath, { apiUrl, installationId, destinations: [] });
    const cache = new AlwaysContextCache({ stateDirectory: state, apiUrl });
    const base = prepared();
    const body = bytes(content);
    await cache.apply(
      await cache.plan({
        ...base,
        artifacts: [
          {
            ...base.artifacts[0]!,
            logicalId: `${alias}-context`,
            artifactVersionId: `${alias}-version`,
            kind: "embedded_document",
            relativePath: `context/${alias}.md`,
            sha256: hash(body),
            size: body.byteLength,
            content: body,
          },
        ],
      }),
    );
    return {
      profile: {
        key: profileKey(apiUrl),
        alias,
        name: alias,
        slug: alias,
        apiUrl,
        configPath,
      },
      cache,
      outbox: new UsageReceiptOutbox({
        stateDirectory: state,
        apiUrl,
        installationId,
      }),
    };
  }

  async function invoke(command: string, input: string) {
    const result = await new Promise<{
      code: number | null;
      stdout: string;
      stderr: string;
    }>((resolve, reject) => {
      const child = spawn("/bin/sh", ["-c", command], {
        cwd: workspace,
        env: {
          HOME: home,
          HIVEMND_HOME: state,
          PATH: dirname(process.execPath),
          NODE_OPTIONS: `--import=${pathToFileURL(guard).href}`,
          TEST_TRANSCRIPT: transcript,
          TEST_BOUNDARY_REPORT: report,
        },
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 5000,
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.once("error", reject);
      child.once("close", (code) => resolve({ code, stdout, stderr }));
      child.stdin.end(input);
    });
    expect(JSON.parse(await readFile(report, "utf8"))).toEqual([]);
    expect(await readFile(transcript, "utf8")).toBe(privateMarker);
    expect(await contentsUnder(home)).not.toContain(privateMarker);
    expect(await contentsUnder(workspace)).not.toContain(privateMarker);
    expect(result.stderr).not.toContain(privateMarker);
    return result;
  }

  function launcher(
    client: AgentKind,
    scope: "global" | "workspace",
    boundWorkspace = workspace,
  ) {
    return hookLauncherDefinition({
      client,
      scope,
      ...(scope === "workspace" ? { workspace: boundWorkspace } : {}),
      runtimeExecutablePath: process.execPath,
      cliScriptPath: executable,
      stateDirectory: state,
    });
  }

  function payload(source = "startup") {
    return {
      hook_event_name: "SessionStart",
      source,
      cwd: workspace,
      session_id: privateMarker,
      transcript_path: transcript,
      prompt: privateMarker,
      private_code: privateMarker,
    };
  }
  return { home, state, workspace, addOrganization, invoke, launcher, payload };
}

async function contentsUnder(root: string): Promise<string> {
  const entries = await readdir(root, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map(async (entry) => {
        const path = join(root, entry.name);
        return entry.isDirectory()
          ? contentsUnder(path)
          : readFile(path, "utf8");
      }),
    )
  ).join("\n");
}

describe("real hook process with synthetic local state", () => {
  it.each(["codex", "claude"] as const)(
    "executes the owned %s SessionStart launcher and stages bounded receipts without external calls",
    async (client) => {
      const test = await fixture();
      const organization = await test.addOrganization(
        "eigen",
        eigenUrl,
        "# VERIFIED EIGEN CONTEXT",
      );
      await writeJson(join(test.state, "registry.json"), {
        version: 1,
        profiles: [organization.profile],
        workspaceBindings: [],
        globalBindings: [{ client, organizationKey: profileKey(eigenUrl) }],
      });
      const definition = test.launcher(client, "global");
      const hookPath = join(
        test.home,
        client === "codex" ? ".codex" : ".claude",
        client === "codex" ? "hooks.json" : "settings.json",
      );
      const userHook = {
        hooks: {
          Stop: [
            { hooks: [{ type: "command", command: "user-owned-do-not-run" }] },
          ],
        },
      };
      await writeJson(hookPath, userHook);
      const registration = new HostHookRegistration(hookPath, client);
      await expect(registration.install(definition)).resolves.toEqual({
        changed: true,
        state: "installed",
      });
      const registered = JSON.parse(await readFile(hookPath, "utf8")) as {
        hooks: {
          Stop: unknown;
          SessionStart: { hooks: { command: string }[] }[];
        };
      };
      expect(registered.hooks.Stop).toEqual(userHook.hooks.Stop);
      const command = registered.hooks.SessionStart[0]!.hooks[0]!.command;
      expect(command).toBe(definition.command);
      for (const source of ["startup", "resume", "clear", "compact"]) {
        await expect(
          test.invoke(command, JSON.stringify(test.payload(source))),
        ).resolves.toEqual({
          code: 0,
          stdout: "# VERIFIED EIGEN CONTEXT\n",
          stderr: "",
        });
      }
      const receipts = await organization.outbox.pending();
      expect(receipts.map((receipt) => receipt.contextTrigger)).toEqual([
        "startup",
        "resume",
        "clear",
        "compact",
      ]);
      expect(
        receipts.every(
          (receipt) =>
            receipt.agentHost === client &&
            receipt.eventKind === "always_context_emitted",
        ),
      ).toBe(true);
      expect(receipts[0]?.items).toEqual([
        {
          artifactId: "eigen-context",
          artifactVersionId: "eigen-version",
          artifactKind: "embedded_document",
        },
      ]);
      expect(JSON.stringify(receipts)).not.toMatch(
        /session|transcript|prompt|private_code|cwd|path/i,
      );
      if (client === "claude") {
        await expect(
          test.invoke(
            command,
            JSON.stringify({
              ...test.payload(),
              agent_id: "synthetic-subagent",
            }),
          ),
        ).resolves.toEqual({ code: 0, stdout: "", stderr: "" });
        expect(await organization.outbox.pending()).toHaveLength(4);
      }
    },
  );

  it("uses the tenant binding before global context and fails closed on corrupt cache bytes or metadata", async () => {
    const test = await fixture();
    const eigen = await test.addOrganization("eigen", eigenUrl, "# EIGEN ONLY");
    const acme = await test.addOrganization("acme", acmeUrl, "# ACME ONLY");
    await writeJson(join(test.state, "registry.json"), {
      version: 1,
      profiles: [eigen.profile, acme.profile],
      workspaceBindings: [
        { path: test.workspace, organizationKey: profileKey(acmeUrl) },
      ],
      globalBindings: [
        { client: "codex", organizationKey: profileKey(eigenUrl) },
      ],
    });
    const global = test.launcher("codex", "global").command;
    const workspace = test.launcher("codex", "workspace").command;
    const ancestor = test.launcher(
      "codex",
      "workspace",
      dirname(test.workspace),
    ).command;
    for (const command of [global, ancestor]) {
      await expect(
        test.invoke(command, JSON.stringify(test.payload())),
      ).resolves.toEqual({ code: 0, stdout: "", stderr: "" });
    }
    await expect(
      test.invoke(workspace, JSON.stringify(test.payload())),
    ).resolves.toEqual({ code: 0, stdout: "# ACME ONLY\n", stderr: "" });
    expect(await eigen.outbox.pending()).toEqual([]);
    expect(await acme.outbox.pending()).toHaveLength(1);
    const versions = join(acme.cache.root, "versions");
    const [version] = await readdir(versions);
    await writeFile(join(versions, version!), "# EVIL ONLY");
    const badHash = await test.invoke(
      workspace,
      JSON.stringify(test.payload()),
    );
    expect(badHash).toMatchObject({ code: 1, stdout: "" });
    expect(badHash.stderr).toContain("INTEGRITY_FAILED");
    await writeFile(join(acme.cache.root, "current.json"), '{"version":999}');
    const badMetadata = await test.invoke(
      workspace,
      JSON.stringify(test.payload()),
    );
    expect(badMetadata).toMatchObject({ code: 1, stdout: "" });
    expect(badMetadata.stderr).not.toBe("");
    expect(await acme.outbox.pending()).toHaveLength(1);
    expect(await eigen.outbox.pending()).toEqual([]);
  });

  it("rejects malformed and unsupported SessionStart payloads without output or usage evidence", async () => {
    const test = await fixture();
    const organization = await test.addOrganization(
      "eigen",
      eigenUrl,
      "# NEVER EMITTED",
    );
    await writeJson(join(test.state, "registry.json"), {
      version: 1,
      profiles: [organization.profile],
      workspaceBindings: [],
      globalBindings: [
        { client: "codex", organizationKey: profileKey(eigenUrl) },
      ],
    });
    const command = test.launcher("codex", "global").command;
    for (const input of [
      "not-json",
      JSON.stringify({
        ...test.payload(),
        hook_event_name: "UserPromptSubmit",
      }),
      JSON.stringify({ ...test.payload(), source: "fork" }),
      JSON.stringify({ ...test.payload(), cwd: "relative" }),
    ]) {
      const result = await test.invoke(command, input);
      expect(result).toMatchObject({ code: 1, stdout: "" });
      expect(result.stderr).toContain("CONFIG_INVALID");
    }
    expect(await organization.outbox.pending()).toEqual([]);
  });
});
