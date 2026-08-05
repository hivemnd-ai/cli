import { chmod, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  hookInstallOperation,
  hookLauncherDefinition,
  hostHookRegistration,
  managedHookStateDirectory,
  SessionStartHookRegistration,
} from "../src/hooks/registration.js";
import { RegistrationTransaction } from "../src/mcp/registration.js";
import { temporaryDirectory } from "./helpers.js";

function definition(
  client: "codex" | "claude" = "codex",
  scope: "global" | "workspace" = "global",
  workspace?: string,
) {
  return hookLauncherDefinition({
    client,
    scope,
    ...(workspace ? { workspace } : {}),
    runtimeExecutablePath: "/opt/node/bin/node",
    cliScriptPath: "/opt/hivemnd/dist/index.js",
    stateDirectory: "/private/state/hivemnd",
  });
}

describe("SessionStart hook registration", () => {
  it("installs Claude slash-only expansion coverage and never installs a Codex or PreToolUse Skill hook", async () => {
    const temp = await temporaryDirectory();
    try {
      const claudePath = join(temp.path, "claude.json");
      const codexPath = join(temp.path, "codex.json");
      await new SessionStartHookRegistration(claudePath, "claude").install(
        definition("claude"),
      );
      await new SessionStartHookRegistration(codexPath, "codex").install(
        definition("codex"),
      );
      const claude = await readFile(claudePath, "utf8");
      const codex = await readFile(codexPath, "utf8");
      expect(claude).toContain('"UserPromptExpansion"');
      expect(claude).toContain("context skill-activated --client claude");
      expect(claude).not.toContain("PreToolUse");
      expect(codex).not.toContain("UserPromptExpansion");
      expect(codex).not.toContain("skill-activated");

      const legacy = JSON.parse(claude) as {
        hooks: Record<string, unknown>;
      };
      delete legacy.hooks.UserPromptExpansion;
      await writeFile(
        claudePath,
        JSON.stringify(legacy).replaceAll(
          "--hivemnd-managed-hook 2",
          "--hivemnd-managed-hook 1",
        ),
      );
      const claudeRegistration = new SessionStartHookRegistration(
        claudePath,
        "claude",
      );
      await expect(
        claudeRegistration.status(definition("claude")),
      ).resolves.toBe("conflict");
      await expect(
        claudeRegistration.install(definition("claude")),
      ).resolves.toEqual({ changed: true, state: "installed" });
      const upgraded = JSON.parse(await readFile(claudePath, "utf8")) as {
        hooks: Record<string, unknown>;
      };
      expect(upgraded.hooks).toHaveProperty("UserPromptExpansion");
      delete upgraded.hooks.UserPromptExpansion;
      await writeFile(
        claudePath,
        JSON.stringify(upgraded).replaceAll(
          "--hivemnd-managed-hook 2",
          "--hivemnd-managed-hook 1",
        ),
      );
      await expect(
        claudeRegistration.remove(definition("claude")),
      ).resolves.toEqual({ changed: true, state: "missing" });
    } finally {
      await temp.cleanup();
    }
  });

  it("resolves the managed cache from HIVEMND_HOME or the user home", () => {
    expect(
      managedHookStateDirectory({ HIVEMND_HOME: "/private/state" }, "/home/x"),
    ).toBe("/private/state");
    expect(managedHookStateDirectory({}, "/home/x")).toBe("/home/x/.hivemnd");
  });

  it("adds, updates and removes one Codex root-only hook while preserving user hooks and mode", async () => {
    const temp = await temporaryDirectory();
    try {
      const path = join(temp.path, "hooks.json");
      await writeFile(
        path,
        JSON.stringify({
          description: "user config",
          hooks: {
            SessionStart: [
              {
                matcher: "startup",
                hooks: [{ type: "command", command: "user-command" }],
              },
            ],
            UserPromptSubmit: [
              {
                matcher: "",
                hooks: [{ type: "command", command: "user-prompt-command" }],
              },
            ],
            Stop: [{ hooks: [{ type: "command", command: "user-stop" }] }],
          },
        }),
      );
      await chmod(path, 0o640);
      const registration = new SessionStartHookRegistration(path, "codex");
      expect(await registration.install(definition())).toEqual({
        changed: true,
        state: "installed",
      });
      const installed = JSON.parse(await readFile(path, "utf8")) as {
        description: string;
        hooks: Record<string, Array<Record<string, unknown>>>;
      };
      expect(installed.description).toBe("user config");
      expect(installed.hooks.Stop).toHaveLength(1);
      expect(installed.hooks.SessionStart).toHaveLength(2);
      expect(installed.hooks.UserPromptSubmit).toHaveLength(2);
      expect(JSON.stringify(installed)).not.toContain("SubagentStart");
      expect(JSON.stringify(installed)).toContain("additionalContextLimit");
      expect(JSON.stringify(installed)).toContain(
        '"additionalContextLimit":12000',
      );
      expect(JSON.stringify(installed)).toContain("--scope global");
      expect(JSON.stringify(installed)).toContain("--hivemnd-managed-hook");
      const promptHooks = (installed.hooks.UserPromptSubmit ?? []).flatMap(
        (group) =>
          Array.isArray(group.hooks)
            ? (group.hooks as Array<Record<string, unknown>>)
            : [],
      );
      const updateNotice = promptHooks.find(
        (hook) =>
          typeof hook.command === "string" &&
          hook.command.includes("context update-notice"),
      );
      expect(updateNotice?.type).toBe("command");
      expect(updateNotice?.timeout).toBe(5);
      expect(typeof updateNotice?.command).toBe("string");
      if (typeof updateNotice?.command === "string") {
        expect(updateNotice.command).toContain("--client codex");
      }
      expect(updateNotice).not.toHaveProperty("statusMessage");
      expect(updateNotice).not.toHaveProperty("additionalContextLimit");
      expect(await registration.status(definition())).toBe("installed");
      expect(await registration.install(definition())).toEqual({
        changed: false,
        state: "installed",
      });
      expect(
        await registration.install({
          ...definition(),
          command: definition().command.replace(
            "/opt/hivemnd/dist/index.js",
            "/opt/hivemnd/dist/new.js",
          ),
        }),
      ).toEqual({ changed: true, state: "installed" });
      expect(await registration.status(definition())).toBe("conflict");
      await expect(registration.remove(definition())).rejects.toMatchObject({
        code: "MCP_REGISTRATION_CONFLICT",
      });
      const revised = {
        ...definition(),
        command: definition().command.replace(
          "/opt/hivemnd/dist/index.js",
          "/opt/hivemnd/dist/new.js",
        ),
      };
      expect(await registration.remove(revised)).toEqual({
        changed: true,
        state: "missing",
      });
      expect(await registration.remove(revised)).toEqual({
        changed: false,
        state: "missing",
      });
      expect(await registration.status(revised)).toBe("missing");
      const restored = JSON.parse(await readFile(path, "utf8")) as {
        description: string;
        hooks: { Stop: unknown; UserPromptSubmit: unknown[] };
      };
      expect(restored.description).toBe("user config");
      expect(Array.isArray(restored.hooks.Stop)).toBe(true);
      expect(restored.hooks.UserPromptSubmit).toEqual([
        {
          matcher: "",
          hooks: [{ type: "command", command: "user-prompt-command" }],
        },
      ]);
    } finally {
      await temp.cleanup();
    }
  });

  it("uses user and private workspace paths for both hosts and omits Codex-only output settings from Claude", async () => {
    const codex = hostHookRegistration({
      client: "codex",
      scope: "global",
      homeDirectory: "/home/person",
    });
    const claude = hostHookRegistration({
      client: "claude",
      scope: "workspace",
      homeDirectory: "/home/person",
      workspace: "/repo",
    });
    expect(codex.path).toBe("/home/person/.codex/hooks.json");
    expect(claude.path).toBe("/repo/.claude/settings.local.json");
    const temp = await temporaryDirectory();
    try {
      const path = join(temp.path, "settings.json");
      const registration = new SessionStartHookRegistration(path, "claude");
      await registration.install(definition("claude", "workspace", "/repo"));
      const text = await readFile(path, "utf8");
      expect(text).toContain("SessionStart");
      expect(text).toContain("UserPromptSubmit");
      expect(text).toContain("context update-notice --client claude");
      expect(text).not.toContain("SubagentStart");
      expect(text).not.toContain("additionalContextLimit");
      expect(text).toContain("--scope workspace --workspace '/repo'");
    } finally {
      await temp.cleanup();
    }
    expect(() =>
      hostHookRegistration({
        client: "codex",
        scope: "workspace",
        homeDirectory: "/home/person",
      }),
    ).toThrow("requires a workspace path");
  });

  it("rejects unsafe definitions/configs and rolls back custom registrations transactionally", async () => {
    expect(() =>
      hookLauncherDefinition({
        client: "codex",
        scope: "global",
        runtimeExecutablePath: "node",
        cliScriptPath: "/cli.js",
        stateDirectory: "/state",
      }),
    ).toThrow("absolute safe");
    const quoted = hookLauncherDefinition({
      client: "codex",
      scope: "global",
      runtimeExecutablePath: "/opt/O'Reilly/node",
      cliScriptPath: "/opt/cli.js",
      stateDirectory: "/state",
    });
    expect(quoted.command).toContain(`O'"'"'Reilly`);
    expect(() =>
      hookLauncherDefinition({
        client: "codex",
        scope: "workspace",
        runtimeExecutablePath: "/opt/node/bin/node",
        cliScriptPath: "/opt/cli.js",
        stateDirectory: "/state",
      }),
    ).toThrow("workspace path");
    expect(() =>
      hookLauncherDefinition({
        client: "codex",
        scope: "global",
        workspace: "/repo",
        runtimeExecutablePath: "/opt/node/bin/node",
        cliScriptPath: "/opt/cli.js",
        stateDirectory: "/state",
      }),
    ).toThrow("Global SessionStart");
    expect(() =>
      hookLauncherDefinition({
        client: "codex",
        scope: "workspace",
        workspace: "/repo/../repo",
        runtimeExecutablePath: "/opt/node/bin/node",
        cliScriptPath: "/opt/cli.js",
        stateDirectory: "/state",
      }),
    ).toThrow("absolute safe workspace");

    const temp = await temporaryDirectory();
    try {
      const malformed = join(temp.path, "malformed.json");
      await writeFile(malformed, "{broken");
      const bad = new SessionStartHookRegistration(malformed, "codex");
      await expect(bad.install(definition())).rejects.toMatchObject({
        code: "MCP_REGISTRATION_INVALID",
      });
      expect(await bad.status(definition())).toBe("conflict");
      const target = join(temp.path, "target.json");
      const linked = join(temp.path, "linked.json");
      await writeFile(target, "{}\n");
      await symlink(target, linked);
      await expect(
        new SessionStartHookRegistration(linked, "codex").install(definition()),
      ).rejects.toMatchObject({ code: "MCP_REGISTRATION_UNSAFE" });

      const firstPath = join(temp.path, "first.json");
      const first = new SessionStartHookRegistration(firstPath, "codex");
      const transaction = new RegistrationTransaction();
      await expect(
        transaction.install([
          hookInstallOperation(first, definition()),
          {
            snapshot: async () => "before",
            install: async () => {
              throw new Error("later failure");
            },
            restore: async () => undefined,
          },
        ]),
      ).rejects.toThrow("later failure");
      await expect(readFile(firstPath)).rejects.toMatchObject({
        code: "ENOENT",
      });
      const reversible = await transaction.installReversible([
        hookInstallOperation(first, definition()),
      ]);
      await reversible.rollback();
      await expect(readFile(firstPath)).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(
        first.install({ ...definition(), client: "claude" }),
      ).rejects.toThrow("Invalid Hivemnd");
      await expect(first.snapshot()).resolves.toMatchObject({ existed: false });
    } finally {
      await temp.cleanup();
    }
  });

  it("upgrades the exact legacy managed command while retaining ownership conflicts", async () => {
    const temp = await temporaryDirectory();
    try {
      const path = join(temp.path, "hooks.json");
      const current = definition();
      const legacyCommand = current.command
        .replace(" --scope global", "")
        .replace("--hivemnd-managed-hook 2", "--hivemnd-managed-hook 1");
      await writeFile(
        path,
        JSON.stringify({
          hooks: {
            SessionStart: [
              {
                matcher: "^(startup|resume|clear|compact)$",
                hooks: [
                  {
                    type: "command",
                    command: legacyCommand,
                    timeout: 5,
                    statusMessage: "Loading verified Hivemnd context",
                    additionalContextLimit: 2500,
                  },
                ],
              },
            ],
          },
        }),
      );
      const registration = new SessionStartHookRegistration(path, "codex");
      await expect(registration.install(current)).resolves.toEqual({
        changed: true,
        state: "installed",
      });
      const upgraded = await readFile(path, "utf8");
      expect(upgraded).toContain("--scope global");
      expect(upgraded).toContain('"additionalContextLimit": 12000');
      expect(upgraded).toContain('"UserPromptSubmit"');
      expect(upgraded).toContain("context update-notice --client codex");
      expect(await registration.status(current)).toBe("installed");
    } finally {
      await temp.cleanup();
    }
  });

  it("detects duplicate or structurally invalid SessionStart ownership", async () => {
    const temp = await temporaryDirectory();
    try {
      const path = join(temp.path, "hooks.json");
      const registration = new SessionStartHookRegistration(path, "codex");
      await registration.install(definition());
      const installedText = await readFile(path, "utf8");
      const parsed = JSON.parse(await readFile(path, "utf8")) as {
        hooks: { SessionStart: unknown[]; UserPromptSubmit: unknown[] };
      };
      expect(parsed.hooks.UserPromptSubmit).toHaveLength(1);
      parsed.hooks.UserPromptSubmit = [];
      await writeFile(path, JSON.stringify(parsed));
      await expect(registration.status(definition())).resolves.toBe("conflict");
      await expect(registration.install(definition())).rejects.toMatchObject({
        code: "MCP_REGISTRATION_CONFLICT",
      });
      expect(await readFile(path, "utf8")).toBe(JSON.stringify(parsed));
      await writeFile(path, installedText);
      const tampered = JSON.parse(installedText) as {
        hooks: {
          SessionStart: { matcher: string }[];
        };
      };
      tampered.hooks.SessionStart[0]!.matcher = "startup";
      await writeFile(path, JSON.stringify(tampered));
      await expect(registration.install(definition())).rejects.toMatchObject({
        code: "MCP_REGISTRATION_CONFLICT",
      });
      expect(await readFile(path, "utf8")).toBe(JSON.stringify(tampered));
      await writeFile(path, installedText);
      const repaired = JSON.parse(await readFile(path, "utf8")) as {
        hooks: { SessionStart: unknown[]; UserPromptSubmit: unknown[] };
      };
      repaired.hooks.UserPromptSubmit.push(repaired.hooks.UserPromptSubmit[0]);
      await writeFile(path, JSON.stringify(repaired));
      await expect(registration.install(definition())).rejects.toThrow(
        "multiple",
      );
      repaired.hooks.UserPromptSubmit.pop();
      await writeFile(path, JSON.stringify(repaired));
      expect(await registration.status(definition())).toBe("installed");
      parsed.hooks.SessionStart = repaired.hooks.SessionStart;
      parsed.hooks.SessionStart.push(parsed.hooks.SessionStart[0]);
      await writeFile(path, JSON.stringify(parsed));
      await expect(registration.install(definition())).rejects.toThrow(
        "multiple",
      );
      await writeFile(path, JSON.stringify({ hooks: { SessionStart: {} } }));
      await expect(registration.install(definition())).rejects.toThrow(
        "must be an array",
      );
      await writeFile(path, JSON.stringify({ hooks: [] }));
      await expect(registration.install(definition())).rejects.toThrow(
        "must be an object",
      );
      await writeFile(path, '{\r\n  "hooks": {}\r\n}\r\n');
      await expect(registration.install(definition())).resolves.toEqual({
        changed: true,
        state: "installed",
      });
      expect(await readFile(path, "utf8")).toContain("\r\n");
      await writeFile(path, JSON.stringify([]));
      await expect(registration.install(definition())).rejects.toThrow(
        "must be a JSON object",
      );
      await writeFile(
        path,
        JSON.stringify({
          hooks: {
            SessionStart: [null, { matcher: "startup", hooks: {} }],
          },
        }),
      );
      await expect(registration.install(definition())).resolves.toEqual({
        changed: true,
        state: "installed",
      });
      const linkTarget = join(temp.path, "target.json");
      const link = join(temp.path, "snapshot-link.json");
      await writeFile(linkTarget, "{}\n");
      await symlink(linkTarget, link);
      await expect(
        new SessionStartHookRegistration(link, "codex").snapshot(),
      ).rejects.toMatchObject({ code: "MCP_REGISTRATION_UNSAFE" });
      await mkdir(dirname(path), { recursive: true });
    } finally {
      await temp.cleanup();
    }
  });
});
