import { PassThrough } from "node:stream";
import { Command } from "commander";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { registerMcpCommands } from "../src/commands/mcp.js";
import { mcpStatus, serveMcp } from "../src/mcp/command.js";
import { captureOutput, temporaryDirectory } from "./helpers.js";

const resolved = {
  key: "eigen",
  name: "EIGEN",
  slug: "eigen",
  configPath: "/state/organizations/eigen/config.json",
  config: {
    apiUrl: "https://shared.hivemnd.cloud/eigen",
    destinations: [],
  },
};

describe("MCP command workflows", () => {
  it("resolves the organization before starting stdio and never persists or prints the token", async () => {
    const input = new PassThrough();
    const protocolOutput = new PassThrough();
    const diagnostics = new PassThrough();
    let stdout = "";
    protocolOutput
      .setEncoding("utf8")
      .on("data", (chunk: string) => (stdout += chunk));
    const resolutions: unknown[] = [];
    const running = serveMcp(
      { client: "codex", workspace: "/repo" },
      {
        cwd: "/repo/subdirectory",
        resolver: {
          resolve: async (options) => {
            resolutions.push(options);
            return resolved;
          },
        },
        tokenStoreFactory: () => ({
          get: async () => ({ value: "secret-token", source: "keychain" }),
          save: async () => undefined,
        }),
        input,
        protocolOutput,
        diagnostics,
        fetcher: async () =>
          new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }), {
            status: 200,
          }),
      },
    );
    input.end('{"jsonrpc":"2.0","id":1,"method":"initialize"}\n');
    await running;

    expect(resolutions).toEqual([
      { client: "codex", cwd: "/repo/subdirectory", workspace: "/repo" },
    ]);
    expect(stdout).not.toContain("secret-token");
  });

  it("reports registration and authenticated reachability in English", async () => {
    const output = captureOutput();
    await mcpStatus(
      { client: "claude", org: "eigen" },
      {
        cwd: "/repo",
        resolver: { resolve: async () => resolved },
        tokenStoreFactory: () => ({
          get: async () => ({ value: "secret-token", source: "keychain" }),
          save: async () => undefined,
        }),
        output,
        registrationState: async () => "installed",
        fetcher: async (_input, init) => {
          expect(init?.body).not.toContain("secret-token");
          return new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: "hivemnd-status",
              result: {},
            }),
            { status: 200 },
          );
        },
      },
    );
    expect(output.messages).toEqual([
      "Registration: installed",
      "Organization: EIGEN (eigen)",
      "Reachability: available",
    ]);
  });

  it("fails closed without credentials and status reports the missing credential", async () => {
    const base = {
      cwd: "/repo",
      resolver: { resolve: async () => resolved },
      tokenStoreFactory: () => ({
        get: async () => undefined,
        save: async () => undefined,
      }),
    };
    await expect(
      serveMcp(
        { client: "codex" },
        {
          ...base,
          input: new PassThrough(),
          protocolOutput: new PassThrough(),
          diagnostics: new PassThrough(),
        },
      ),
    ).rejects.toMatchObject({ code: "AUTH_MISSING" });

    const output = captureOutput();
    await mcpStatus({ client: "codex" }, { ...base, output });
    expect(output.messages).toEqual([
      "Organization: EIGEN (eigen)",
      "Reachability: credential missing",
    ]);
  });

  it("registers serve and status with resolved workspace and host scope", async () => {
    const temporary = await temporaryDirectory();
    try {
      const input = new PassThrough();
      const protocolOutput = new PassThrough();
      const diagnostics = new PassThrough();
      const output = captureOutput();
      const resolutions: unknown[] = [];
      const dependencies = {
        cwd: temporary.path,
        environment: { HIVEMND_HOME: join(temporary.path, "state") },
        output,
        clientVersion: "0.4.0",
        clientFeatures: ["exact-delivery-targets-v1"],
        tokenStoreFactory: () => ({
          get: async () => ({
            value: "secret-token",
            source: "keychain" as const,
          }),
          save: async () => undefined,
        }),
      };
      const runtime = {
        resolver: {
          resolve: async (options: unknown) => {
            resolutions.push(options);
            return resolved;
          },
        },
        input,
        protocolOutput,
        diagnostics,
        homeDirectory: join(temporary.path, "home"),
        fetcher: async () =>
          new Response(
            JSON.stringify({
              jsonrpc: "2.0",
              id: "hivemnd-status",
              result: {},
            }),
          ),
      };

      const serve = mcpProgram(dependencies, runtime);
      input.end();
      await serve.parseAsync([
        "node",
        "hivemnd",
        "mcp",
        "serve",
        "--client",
        "codex",
        "--org",
        "eigen",
        "--workspace",
        "repo",
      ]);

      const status = mcpProgram(dependencies, runtime);
      await status.parseAsync([
        "node",
        "hivemnd",
        "mcp",
        "status",
        "--client",
        "claude",
        "--workspace",
        "repo",
        "--scope",
        "project",
      ]);
      expect(resolutions).toEqual([
        {
          client: "codex",
          cwd: temporary.path,
          org: "eigen",
          workspace: join(temporary.path, "repo"),
        },
        {
          client: "claude",
          cwd: temporary.path,
          workspace: join(temporary.path, "repo"),
        },
      ]);
      expect(output.messages).toContain("Registration: missing");
      expect(output.messages).toContain("Reachability: available");
    } finally {
      await temporary.cleanup();
    }
  });

  it("validates command client and status scope before starting MCP", async () => {
    const dependencies = {
      cwd: "/repo",
      output: captureOutput(),
      tokenStoreFactory: () => ({
        get: async () => undefined,
        save: async () => undefined,
      }),
    };
    const runtime = { resolver: { resolve: async () => resolved } };

    await expect(
      mcpProgram(dependencies, runtime).parseAsync([
        "node",
        "hivemnd",
        "mcp",
        "serve",
        "--client",
        "other",
      ]),
    ).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(
      mcpProgram(dependencies, runtime).parseAsync([
        "node",
        "hivemnd",
        "mcp",
        "status",
        "--client",
        "codex",
        "--scope",
        "workspace",
      ]),
    ).rejects.toMatchObject({ code: "CONFIG_INVALID" });
    await expect(
      mcpProgram(dependencies, runtime).parseAsync([
        "node",
        "hivemnd",
        "mcp",
        "status",
        "--client",
        "codex",
        "--scope",
        "other",
      ]),
    ).rejects.toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("uses process streams and platform defaults when no command runtime overrides are supplied", async () => {
    const temporary = await temporaryDirectory();
    const input = new PassThrough();
    const protocolOutput = new PassThrough();
    const diagnostics = new PassThrough();
    input.end();
    const stdin = vi
      .spyOn(process, "stdin", "get")
      .mockReturnValue(input as unknown as typeof process.stdin);
    const stdout = vi
      .spyOn(process, "stdout", "get")
      .mockReturnValue(protocolOutput as unknown as typeof process.stdout);
    const stderr = vi
      .spyOn(process, "stderr", "get")
      .mockReturnValue(diagnostics as unknown as typeof process.stderr);
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: "hivemnd-status",
            result: {},
          }),
        ),
    );
    vi.stubGlobal("fetch", fetcher);
    try {
      const dependencies = {
        cwd: temporary.path,
        output: captureOutput(),
        tokenStoreFactory: () => ({
          get: async () => ({
            value: "secret-token",
            source: "keychain" as const,
          }),
          save: async () => undefined,
        }),
      };
      const runtime = { resolver: { resolve: async () => resolved } };
      await mcpProgram(dependencies, runtime).parseAsync([
        "node",
        "hivemnd",
        "mcp",
        "serve",
        "--client",
        "claude",
      ]);
      await mcpProgram(dependencies, runtime).parseAsync([
        "node",
        "hivemnd",
        "mcp",
        "status",
        "--client",
        "codex",
      ]);
      await mcpProgram(dependencies, runtime).parseAsync([
        "node",
        "hivemnd",
        "mcp",
        "status",
        "--client",
        "codex",
        "--workspace",
        "repo",
      ]);
      await mcpProgram(dependencies, runtime).parseAsync([
        "node",
        "hivemnd",
        "mcp",
        "status",
        "--client",
        "codex",
        "--scope",
        "global",
      ]);
      const cliScript = process.argv[1];
      Object.defineProperty(process.argv, "1", {
        configurable: true,
        enumerable: true,
        writable: true,
        value: undefined,
      });
      try {
        await mcpProgram(dependencies, runtime).parseAsync([
          "node",
          "hivemnd",
          "mcp",
          "status",
          "--client",
          "codex",
        ]);
      } finally {
        Object.defineProperty(process.argv, "1", {
          configurable: true,
          enumerable: true,
          writable: true,
          value: cliScript,
        });
      }
      expect(fetcher).toHaveBeenCalledTimes(4);
    } finally {
      stdin.mockRestore();
      stdout.mockRestore();
      stderr.mockRestore();
      vi.unstubAllGlobals();
      await temporary.cleanup();
    }
  });
});

function mcpProgram(
  dependencies: Parameters<typeof registerMcpCommands>[1],
  runtime: Parameters<typeof registerMcpCommands>[2],
): Command {
  const program = new Command().exitOverride();
  registerMcpCommands(program, dependencies, runtime);
  return program;
}
