import { chmod, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  ClaudeMcpRegistration,
  CodexMcpRegistration,
  RegistrationTransaction,
  hostRegistration,
  mcpServerDefinition,
} from "../src/mcp/registration.js";
import { temporaryDirectory } from "./helpers.js";

describe("MCP host registration", () => {
  it("adds, updates and removes only the owned Codex block", async () => {
    const temporary = await temporaryDirectory();
    try {
      const path = join(temporary.path, ".codex", "config.toml");
      await mkdir(dirname(path), { recursive: true });
      const original =
        'model = "gpt-5.6"\n\n[mcp_servers.other]\ncommand = "other"\n';
      await writeFile(path, original);
      const registration = new CodexMcpRegistration(path);

      expect(
        await registration.install({
          command: "/opt/hivemnd/bin/hivemnd",
          args: ["mcp", "serve", "--client", "codex"],
        }),
      ).toEqual({ changed: true, state: "installed" });
      const installed = await readFile(path, "utf8");
      expect(installed).toContain(original.trimEnd());
      expect(installed).toContain("# BEGIN HIVEMND MANAGED MCP");
      expect(installed).toContain('command = "/opt/hivemnd/bin/hivemnd"');
      expect(installed).not.toContain("token");

      expect(
        await registration.install({
          command: "/opt/hivemnd/bin/hivemnd",
          args: ["mcp", "serve", "--client", "codex"],
        }),
      ).toEqual({ changed: false, state: "installed" });
      expect(
        await registration.remove(undefined, {
          command: "/opt/hivemnd/bin/hivemnd",
          args: ["mcp", "serve", "--client", "codex"],
        }),
      ).toEqual({
        changed: true,
        state: "missing",
      });
      expect(await readFile(path, "utf8")).toBe(original);
    } finally {
      await temporary.cleanup();
    }
  });

  it("pins a custom Hivemnd state directory in Codex and Claude launch environments", async () => {
    const temporary = await temporaryDirectory();
    try {
      const definition = mcpServerDefinition({
        client: "codex",
        runtimeExecutablePath: "/opt/node/bin/node",
        cliScriptPath: "/opt/hivemnd/dist/index.js",
        stateDirectory: "/private/state/hivemnd",
      });
      const codexPath = join(temporary.path, "config.toml");
      await new CodexMcpRegistration(codexPath).install(definition);
      expect(await readFile(codexPath, "utf8")).toContain(
        '[mcp_servers.hivemnd.env]\nHIVEMND_HOME = "/private/state/hivemnd"',
      );

      const claudePath = join(temporary.path, "claude.json");
      await new ClaudeMcpRegistration(claudePath).install(definition);
      expect(
        parseClaudeConfig(await readFile(claudePath, "utf8")).mcpServers
          ?.hivemnd,
      ).toMatchObject({
        env: {
          HIVEMND_MANAGED_MCP: "1",
          HIVEMND_HOME: "/private/state/hivemnd",
        },
      });
    } finally {
      await temporary.cleanup();
    }
  });

  it("never removes a character adjacent to an owned Codex block", async () => {
    const temporary = await temporaryDirectory();
    try {
      const path = join(temporary.path, "config.toml");
      const registration = new CodexMcpRegistration(path);
      await writeFile(path, 'model = "gpt"');
      const definition = { command: "hivemnd", args: ["mcp", "serve"] };
      await registration.install(definition);
      await registration.remove(undefined, definition);
      expect(await readFile(path, "utf8")).toBe('model = "gpt"\n');
    } finally {
      await temporary.cleanup();
    }
  });

  it("refuses to overwrite an unowned Codex server with the same name", async () => {
    const temporary = await temporaryDirectory();
    try {
      const path = join(temporary.path, "config.toml");
      await writeFile(
        path,
        '[mcp_servers.hivemnd]\ncommand = "someone-else"\n',
      );
      const registration = new CodexMcpRegistration(path);
      await expect(
        registration.install({ command: "hivemnd", args: ["mcp", "serve"] }),
      ).rejects.toMatchObject({ code: "MCP_REGISTRATION_CONFLICT" });
      expect(await readFile(path, "utf8")).toContain("someone-else");
    } finally {
      await temporary.cleanup();
    }
  });

  it("edits only the Claude MCP entry for user and private workspace scopes", async () => {
    const temporary = await temporaryDirectory();
    try {
      const path = join(temporary.path, ".claude.json");
      const workspace = join(temporary.path, "repo");
      const original =
        '{\n  "theme": "dark",\n  "mcpServers": {"other":{"command":"other"}},\n  "projects": {}\n}\n';
      await writeFile(path, original);
      const registration = new ClaudeMcpRegistration(path);

      await registration.install(
        { command: "hivemnd", args: ["mcp", "serve", "--client", "claude"] },
        { scope: "workspace", workspace },
      );
      let text = await readFile(path, "utf8");
      expect(text).toContain('"theme": "dark"');
      expect(text).toContain('"other":{"command":"other"}');
      expect(
        parseClaudeConfig(text).projects?.[workspace]?.mcpServers?.hivemnd,
      ).toEqual({
        command: "hivemnd",
        args: ["mcp", "serve", "--client", "claude"],
        env: { HIVEMND_MANAGED_MCP: "1" },
      });

      await registration.install(
        { command: "hivemnd", args: ["mcp", "serve", "--client", "claude"] },
        { scope: "global" },
      );
      text = await readFile(path, "utf8");
      expect(parseClaudeConfig(text).mcpServers?.hivemnd?.command).toBe(
        "hivemnd",
      );
      expect(text).not.toContain("Bearer");
      expect(text).not.toContain("token");

      await expect(
        registration.remove(
          { scope: "global" },
          { command: "other", args: ["mcp", "serve"] },
        ),
      ).rejects.toMatchObject({ code: "MCP_REGISTRATION_CONFLICT" });
      expect(
        parseClaudeConfig(await readFile(path, "utf8")).mcpServers?.hivemnd,
      ).toBeDefined();
      await registration.remove(
        { scope: "global" },
        { command: "hivemnd", args: ["mcp", "serve", "--client", "claude"] },
      );
    } finally {
      await temporary.cleanup();
    }
  });

  it("upgrades only an exactly marked Claude launcher across npm runtime, script, and state paths", async () => {
    const temporary = await temporaryDirectory();
    try {
      const path = join(temporary.path, ".claude.json");
      await writeFile(
        path,
        JSON.stringify({
          theme: "dark",
          mcpServers: {
            hivemnd: {
              command: "/old/npm/node",
              args: [
                "/old/npm/hivemnd/dist/index.js",
                "mcp",
                "serve",
                "--client",
                "claude",
              ],
              env: {
                HIVEMND_MANAGED_MCP: "1",
                HIVEMND_HOME: "/old/state",
              },
            },
          },
        }),
      );
      const registration = new ClaudeMcpRegistration(path);
      const next = mcpServerDefinition({
        client: "claude",
        runtimeExecutablePath: "/new/npm/node",
        cliScriptPath: "/new/npm/hivemnd/dist/index.js",
        stateDirectory: "/new/state",
      });

      await expect(registration.install(next)).resolves.toEqual({
        changed: true,
        state: "installed",
      });
      const upgraded = JSON.parse(await readFile(path, "utf8")) as {
        theme: string;
        mcpServers: Record<string, unknown>;
      };
      expect(upgraded.theme).toBe("dark");
      expect(upgraded.mcpServers.hivemnd).toEqual({
        command: "/new/npm/node",
        args: [
          "/new/npm/hivemnd/dist/index.js",
          "mcp",
          "serve",
          "--client",
          "claude",
        ],
        env: {
          HIVEMND_MANAGED_MCP: "1",
          HIVEMND_HOME: "/new/state",
        },
      });
      await expect(registration.install(next)).resolves.toEqual({
        changed: false,
        state: "installed",
      });
    } finally {
      await temporary.cleanup();
    }
  });

  it("rolls back earlier registrations when a later registration fails", async () => {
    const temporary = await temporaryDirectory();
    try {
      const codexPath = join(temporary.path, "codex.toml");
      const claudePath = join(temporary.path, "claude.json");
      await writeFile(codexPath, 'model = "gpt"\n');
      await writeFile(
        claudePath,
        '{"mcpServers":{"hivemnd":{"command":"unowned"}}}\n',
      );
      const transaction = new RegistrationTransaction();
      await expect(
        transaction.install([
          {
            registration: new CodexMcpRegistration(codexPath),
            definition: { command: "hivemnd", args: ["mcp", "serve"] },
          },
          {
            registration: new ClaudeMcpRegistration(claudePath),
            definition: { command: "hivemnd", args: ["mcp", "serve"] },
            scope: { scope: "global" },
          },
        ]),
      ).rejects.toMatchObject({ code: "MCP_REGISTRATION_CONFLICT" });
      expect(await readFile(codexPath, "utf8")).toBe('model = "gpt"\n');
      expect(await readFile(claudePath, "utf8")).toContain("unowned");
    } finally {
      await temporary.cleanup();
    }
  });

  it("does not remove a Claude entry owned by another command even when its args say mcp serve", async () => {
    const temporary = await temporaryDirectory();
    try {
      const path = join(temporary.path, "claude.json");
      await writeFile(
        path,
        JSON.stringify({
          mcpServers: {
            hivemnd: { command: "another-command", args: ["mcp", "serve"] },
          },
        }),
      );
      const registration = new ClaudeMcpRegistration(path);
      await expect(
        registration.remove(
          { scope: "global" },
          { command: "hivemnd", args: ["mcp", "serve"] },
        ),
      ).rejects.toMatchObject({ code: "MCP_REGISTRATION_CONFLICT" });
      expect(await readFile(path, "utf8")).toContain("another-command");
    } finally {
      await temporary.cleanup();
    }
  });

  it("resolves host-specific paths and rejects impossible target scopes", async () => {
    expect(
      mcpServerDefinition({
        client: "codex",
        runtimeExecutablePath: "/opt/node/bin/node",
        cliScriptPath: "/opt/hivemnd/dist/index.js",
      }),
    ).toEqual({
      command: "/opt/node/bin/node",
      args: ["/opt/hivemnd/dist/index.js", "mcp", "serve", "--client", "codex"],
      stateDirectory: undefined,
    });
    expect(() =>
      mcpServerDefinition({
        client: "codex",
        runtimeExecutablePath: "node",
        cliScriptPath: "hivemnd",
      }),
    ).toThrow("requires absolute runtime and CLI paths");
    expect(
      mcpServerDefinition({
        client: "claude",
        runtimeExecutablePath: "C:\\Program Files\\nodejs\\node.exe",
        cliScriptPath: "C:\\Hivemnd\\dist\\index.js",
      }).args.at(-1),
    ).toBe("claude");
    expect(() =>
      mcpServerDefinition({
        client: "codex",
        runtimeExecutablePath: "/usr/bin/node\nunsafe",
        cliScriptPath: "/opt/hivemnd/index.js",
      }),
    ).toThrow("requires absolute runtime and CLI paths");
    expect(() =>
      mcpServerDefinition({
        client: "codex",
        runtimeExecutablePath: "/usr/bin/node",
        cliScriptPath: "/opt/hivemnd/index.js",
        stateDirectory: "relative/state",
      }),
    ).toThrow("requires an absolute state directory");
    const invalid = await temporaryDirectory();
    try {
      await expect(
        new CodexMcpRegistration(join(invalid.path, "config.toml")).install({
          command: "/usr/bin/node",
          args: ["/opt/hivemnd/index.js", "mcp", "serve"],
          stateDirectory: "relative/state",
        }),
      ).rejects.toThrow("requires an absolute state directory");
    } finally {
      await invalid.cleanup();
    }
    expect(
      hostRegistration({
        client: "codex",
        scope: "global",
        homeDirectory: "/home/person",
      }).path,
    ).toBe("/home/person/.codex/config.toml");
    expect(
      hostRegistration({
        client: "codex",
        scope: "workspace",
        homeDirectory: "/home/person",
        workspace: "/repo",
      }).path,
    ).toBe("/repo/.codex/config.toml");
    expect(
      hostRegistration({
        client: "claude",
        scope: "workspace",
        homeDirectory: "/home/person",
        workspace: "/repo",
      }),
    ).toMatchObject({
      path: "/home/person/.claude.json",
      scope: { scope: "workspace", workspace: "/repo" },
    });
    expect(
      hostRegistration({
        client: "claude",
        scope: "project",
        homeDirectory: "/home/person",
        workspace: "/repo",
      }).path,
    ).toBe("/repo/.mcp.json");
    expect(() =>
      hostRegistration({
        client: "codex",
        scope: "workspace",
        homeDirectory: "/home/person",
      }),
    ).toThrow("requires a workspace path");
    expect(() =>
      hostRegistration({
        client: "codex",
        scope: "project",
        homeDirectory: "/home/person",
        workspace: "/repo",
      }),
    ).toThrow("uses the workspace scope");
  });

  it("reports missing, conflicting, malformed and unsafe registrations without overwriting them", async () => {
    const temporary = await temporaryDirectory();
    try {
      const codexPath = join(temporary.path, "codex.toml");
      const codex = new CodexMcpRegistration(codexPath);
      expect(await codex.status()).toBe("missing");
      await expect(
        codex.install({ command: "", args: [] }),
      ).rejects.toMatchObject({ code: "MCP_REGISTRATION_INVALID" });
      await expect(
        codex.install({ command: "hivemnd", args: ["--token", "secret"] }),
      ).rejects.toMatchObject({ code: "MCP_REGISTRATION_INVALID" });
      await writeFile(codexPath, "# BEGIN HIVEMND MANAGED MCP\n");
      expect(await codex.status()).toBe("conflict");

      const claudePath = join(temporary.path, "claude.json");
      const claude = new ClaudeMcpRegistration(claudePath);
      expect(await claude.status()).toBe("missing");
      await writeFile(claudePath, "{invalid");
      expect(await claude.status()).toBe("conflict");
      await expect(
        claude.install({ command: "hivemnd", args: ["mcp", "serve"] }),
      ).rejects.toMatchObject({ code: "MCP_REGISTRATION_INVALID" });

      const target = join(temporary.path, "target.toml");
      const linked = join(temporary.path, "linked.toml");
      await writeFile(target, "");
      await symlink(target, linked);
      await expect(
        new CodexMcpRegistration(linked).install({
          command: "hivemnd",
          args: ["mcp", "serve"],
        }),
      ).rejects.toMatchObject({ code: "MCP_REGISTRATION_UNSAFE" });
    } finally {
      await temporary.cleanup();
    }
  });

  it("rolls back a newly created file and handles no-op removal safely", async () => {
    const temporary = await temporaryDirectory();
    try {
      const newPath = join(temporary.path, "new", "config.toml");
      const conflictPath = join(temporary.path, "conflict.json");
      await writeFile(
        conflictPath,
        '{"mcpServers":{"hivemnd":{"command":"other"}}}',
      );
      await expect(
        new RegistrationTransaction().install([
          {
            registration: new CodexMcpRegistration(newPath),
            definition: { command: "hivemnd", args: ["mcp", "serve"] },
          },
          {
            registration: new ClaudeMcpRegistration(conflictPath),
            definition: { command: "hivemnd", args: ["mcp", "serve"] },
          },
        ]),
      ).rejects.toMatchObject({ code: "MCP_REGISTRATION_CONFLICT" });
      await expect(readFile(newPath, "utf8")).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(
        await new ClaudeMcpRegistration(
          join(temporary.path, "missing.json"),
        ).remove(
          { scope: "global" },
          { command: "hivemnd", args: ["mcp", "serve"] },
        ),
      ).toEqual({ changed: false, state: "missing" });
    } finally {
      await temporary.cleanup();
    }
  });

  it("reports installed and missing no-op states and commits a successful registration transaction", async () => {
    const temporary = await temporaryDirectory();
    try {
      const codexPath = join(temporary.path, "codex.toml");
      const claudePath = join(temporary.path, "claude.json");
      const definition = mcpServerDefinition({
        client: "claude",
        runtimeExecutablePath: "/opt/node/bin/node",
        cliScriptPath: "/opt/hivemnd/dist/index.js",
      });
      const codex = new CodexMcpRegistration(codexPath);
      const claude = new ClaudeMcpRegistration(claudePath);
      expect(await codex.remove()).toEqual({
        changed: false,
        state: "missing",
      });
      expect(
        await new RegistrationTransaction().install([
          { registration: codex, definition },
          { registration: claude, definition },
        ]),
      ).toEqual([
        { changed: true, state: "installed" },
        { changed: true, state: "installed" },
      ]);
      expect(await codex.status()).toBe("installed");
      expect(await claude.status()).toBe("installed");
      expect(await codex.status(undefined, definition)).toBe("installed");
      expect(await claude.status({ scope: "global" }, definition)).toBe(
        "installed",
      );
      expect(await claude.install(definition)).toEqual({
        changed: false,
        state: "installed",
      });
      await expect(claude.remove()).rejects.toMatchObject({
        code: "MCP_REGISTRATION_CONFLICT",
      });
    } finally {
      await temporary.cleanup();
    }
  });

  it("preserves CRLF and identifies every malformed Codex ownership boundary", async () => {
    const temporary = await temporaryDirectory();
    try {
      const path = join(temporary.path, "codex.toml");
      const registration = new CodexMcpRegistration(path);
      await writeFile(path, 'model = "gpt"\r\n');
      const definition = { command: "hivemnd", args: [] };
      await registration.install(definition);
      const installed = await readFile(path, "utf8");
      expect(installed).toContain(
        "# BEGIN HIVEMND MANAGED MCP\r\n[mcp_servers.hivemnd]",
      );
      expect(await registration.status(undefined, definition)).toBe(
        "installed",
      );
      await writeFile(path, installed.replace('hivemnd"', 'other"'));
      expect(await registration.status(undefined, definition)).toBe("conflict");

      for (const malformed of [
        "# END HIVEMND MANAGED MCP\n",
        "# BEGIN HIVEMND MANAGED MCP\n# BEGIN HIVEMND MANAGED MCP\n[mcp_servers.hivemnd]\n# END HIVEMND MANAGED MCP\n",
        "x# BEGIN HIVEMND MANAGED MCP\n[mcp_servers.hivemnd]\n# END HIVEMND MANAGED MCP\n",
        "# BEGIN HIVEMND MANAGED MCP\n[mcp_servers.hivemnd]\n# END HIVEMND MANAGED MCPx",
        '# BEGIN HIVEMND MANAGED MCP\ncommand = "x"\n# END HIVEMND MANAGED MCP\n',
      ]) {
        await writeFile(path, malformed);
        expect(await registration.status()).toBe("conflict");
      }
      await writeFile(path, '[mcp_servers.hivemnd]\ncommand = "unowned"\n');
      expect(await registration.status()).toBe("conflict");
    } finally {
      await temporary.cleanup();
    }
  });

  it("classifies altered Claude definitions without treating them as owned", async () => {
    const temporary = await temporaryDirectory();
    try {
      const path = join(temporary.path, "claude.json");
      const registration = new ClaudeMcpRegistration(path);
      const values: Array<{
        value: unknown;
        state: "installed" | "conflict";
      }> = [
        { value: null, state: "conflict" },
        {
          value: {
            command: 1,
            args: [],
            env: { HIVEMND_MANAGED_MCP: "1" },
          },
          state: "conflict",
        },
        {
          value: {
            command: "hivemnd",
            args: "mcp",
            env: { HIVEMND_MANAGED_MCP: "1" },
          },
          state: "conflict",
        },
        {
          value: {
            command: "/old/node",
            args: [1],
            env: { HIVEMND_MANAGED_MCP: "1" },
          },
          state: "conflict",
        },
        {
          value: {
            command: "/old/node",
            args: ["/old/cli.js", "mcp", "serve", "--client", "claude"],
            env: null,
          },
          state: "conflict",
        },
        {
          value: {
            command: "/old/node",
            args: ["/old/cli.js", "mcp", "serve", "--client", "claude"],
            env: {},
          },
          state: "conflict",
        },
        {
          value: {
            command: "/old/node",
            args: ["/old/cli.js", "mcp", "serve", "--client", "claude"],
            env: {
              HIVEMND_MANAGED_MCP: "1",
              UNRELATED: "value",
            },
          },
          state: "conflict",
        },
        {
          value: {
            command: "/old/node",
            args: ["/old/cli.js", "mcp", "serve"],
            env: { HIVEMND_MANAGED_MCP: "1" },
          },
          state: "conflict",
        },
        {
          value: {
            command: "/old/node",
            args: ["relative-cli.js", "mcp", "serve", "--client", "claude"],
            env: { HIVEMND_MANAGED_MCP: "1" },
          },
          state: "conflict",
        },
        {
          value: {
            command: "/old/node",
            args: [
              "/old/cli.js",
              "mcp",
              "serve",
              "--client",
              "claude",
              "--extra",
            ],
            env: { HIVEMND_MANAGED_MCP: "1" },
          },
          state: "conflict",
        },
        {
          value: {
            command: "/old/node",
            args: ["/old/cli.js", "mcp", "serve", "--client", "claude"],
            env: {
              HIVEMND_MANAGED_MCP: "1",
              HIVEMND_HOME: "relative-state",
            },
          },
          state: "conflict",
        },
        {
          value: {
            command: "hivemnd",
            args: ["different"],
            env: { HIVEMND_MANAGED_MCP: "1" },
          },
          state: "conflict",
        },
        {
          value: { command: "hivemnd", args: ["mcp", "serve"], env: {} },
          state: "conflict",
        },
        {
          value: {
            command: "hivemnd",
            args: ["mcp", "serve", "--client", "codex"],
            env: { HIVEMND_MANAGED_MCP: "1" },
          },
          state: "conflict",
        },
      ];
      for (const { value, state } of values) {
        await writeFile(
          path,
          JSON.stringify({ mcpServers: { hivemnd: value } }),
        );
        expect(await registration.status()).toBe(state);
        await expect(
          registration.install({ command: "hivemnd", args: ["mcp", "serve"] }),
        ).rejects.toMatchObject({ code: "MCP_REGISTRATION_CONFLICT" });
      }
      await writeFile(path, JSON.stringify({ projects: null }));
      expect(
        await registration.status({ scope: "workspace", workspace: "/repo" }),
      ).toBe("missing");
      await writeFile(
        path,
        JSON.stringify({
          mcpServers: {
            hivemnd: {
              command: "hivemnd",
              args: ["mcp", "serve", "--org", "other"],
              env: { HIVEMND_MANAGED_MCP: "1" },
            },
          },
        }),
      );
      expect(
        await registration.status(
          { scope: "global" },
          { command: "hivemnd", args: ["mcp", "serve"] },
        ),
      ).toBe("conflict");
    } finally {
      await temporary.cleanup();
    }
  });

  it("rejects directories and propagates filesystem failures while cleaning temporary state", async () => {
    const temporary = await temporaryDirectory();
    try {
      const directory = join(temporary.path, "directory");
      await mkdir(directory);
      const directoryRegistration = new CodexMcpRegistration(directory);
      await expect(
        directoryRegistration.install({ command: "hivemnd", args: [] }),
      ).rejects.toMatchObject({ code: "MCP_REGISTRATION_UNSAFE" });
      await expect(directoryRegistration.snapshot()).rejects.toBeDefined();
      await expect(
        directoryRegistration.restore({ existed: false, content: "" }),
      ).rejects.toBeDefined();
      await expect(
        new CodexMcpRegistration(join(temporary.path, "missing.toml")).restore({
          existed: false,
          content: "",
        }),
      ).resolves.toBeUndefined();

      const unwritable = join(temporary.path, "unwritable");
      await mkdir(unwritable);
      await chmod(unwritable, 0o500);
      try {
        await expect(
          new CodexMcpRegistration(join(unwritable, "config.toml")).install({
            command: "hivemnd",
            args: [],
          }),
        ).rejects.toBeDefined();
      } finally {
        await chmod(unwritable, 0o700);
      }
    } finally {
      await temporary.cleanup();
    }
  });

  it("resolves Claude global registration and rejects every credential-bearing argument form", async () => {
    expect(
      hostRegistration({
        client: "claude",
        scope: "global",
        homeDirectory: "/home/person",
      }),
    ).toMatchObject({
      path: "/home/person/.claude.json",
      scope: { scope: "global" },
    });
    const temporary = await temporaryDirectory();
    try {
      const claudePath = join(temporary.path, "claude.json");
      await writeFile(claudePath, '{\r\n  "theme": "dark"\r\n}\r\n');
      await new ClaudeMcpRegistration(claudePath).install({
        command: "hivemnd",
        args: ["mcp", "serve"],
      });
      expect(await readFile(claudePath, "utf8")).toContain("\r\n");

      const registration = new CodexMcpRegistration(
        join(temporary.path, "codex.toml"),
      );
      for (const argument of [
        "--bearer-token=value",
        "--activation-url",
        "--enrollment-token=secret",
        "Bearer secret",
      ]) {
        await expect(
          registration.install({ command: "hivemnd", args: [argument] }),
        ).rejects.toMatchObject({ code: "MCP_REGISTRATION_INVALID" });
      }
    } finally {
      await temporary.cleanup();
    }
  });
});

interface ClaudeConfigFixture {
  readonly mcpServers?: Record<string, { readonly command?: string }>;
  readonly projects?: Record<
    string,
    { readonly mcpServers?: Record<string, unknown> }
  >;
}

function parseClaudeConfig(value: string): ClaudeConfigFixture {
  return JSON.parse(value) as ClaudeConfigFixture;
}
