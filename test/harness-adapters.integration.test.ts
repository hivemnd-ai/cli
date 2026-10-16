import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs/promises";
import { join } from "node:path";
import { temporaryDirectory } from "./helpers.js";
import {
  inspectHarnessCapabilities,
  validateDeclaredTarget,
  probeDeclaredHarness,
  prepareHarnessLaunch,
} from "../src/marketplace/harness-adapters.js";
vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof import("node:fs/promises")>()),
}));
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});
const target = {
  id: "11111111-1111-4111-8111-111111111111",
  harness: "claude" as const,
  scope: "user" as const,
  bindingId: null,
};
describe("neutral harness capability boundary", () => {
  it("probes only version/help in an isolated temporary cwd with no credential environment", async () => {
    const temp = await temporaryDirectory();
    cleanups.push(temp.cleanup);
    const marker = join(temp.path, "calls");
    const binary = join(temp.path, "claude");
    await fs.writeFile(
      binary,
      `#!/bin/sh\n[ "$#" = 1 ] || exit 8\n[ -z "$HOME$CODEX_HOME$ANTHROPIC_API_KEY$OPENAI_API_KEY" ] || exit 9\nprintf '%s\\n' "$1" >> '${marker}'\ncase "$1" in --version) printf '2.1.226 (Claude Code)';; --help) printf '%s' '--plugin-dir <paths...> Load plugins';; *) exit 7;; esac\n`,
      { mode: 0o700 },
    );
    vi.stubEnv("PATH", temp.path);
    vi.stubEnv("ANTHROPIC_API_KEY", "synthetic-do-not-forward");
    const probe = await probeDeclaredHarness(target);
    expect(
      await probeDeclaredHarness({ ...target, harness: "codex" }),
    ).toBeUndefined();
    expect(probe?.version).toBe("2.1.226");
    expect(await fs.readFile(marker, "utf8")).toBe("--version\n--help\n");
    expect(
      prepareHarnessLaunch(target, "/private/verified payload", true, probe),
    ).toMatchObject({
      status: "launch-parameter",
      argv: ["claude", "--plugin-dir", "/private/verified payload"],
      currentSession: "unknown",
    });
    expect(prepareHarnessLaunch(target, "relative", true, probe).status).toBe(
      "unsupported",
    );
    expect(
      prepareHarnessLaunch(
        { ...target, harness: "codex" },
        "/private/payload",
        true,
        { ...probe!, harness: "codex" },
      ).status,
    ).toBe("unsupported");
    await fs.writeFile(
      binary,
      "#!/bin/sh\ni=0; while [ $i -lt 70000 ]; do printf x; i=$((i+1)); done\n",
    );
    expect(await probeDeclaredHarness(target)).toBeUndefined();
    await fs.writeFile(binary, "#!/bin/sh\nprintf unrecognized\n");
    expect(await probeDeclaredHarness(target)).toBeUndefined();
    await fs.writeFile(binary, "#!/bin/sh\nprintf '2.1.226'\n");
    expect((await probeDeclaredHarness(target))?.rootHelp).toBe("");
    await fs.unlink(binary);
    expect(await probeDeclaredHarness(target)).toBeUndefined();
  });
  it("keeps probe setup and cleanup failures advisory and never probes an invalid declaration", async () => {
    vi.spyOn(fs, "mkdtemp").mockRejectedValueOnce(new Error("synthetic"));
    expect(await probeDeclaredHarness(target)).toBeUndefined();
    vi.restoreAllMocks();
    const temp = await temporaryDirectory();
    cleanups.push(temp.cleanup);
    const isolatedProbe = join(temp.path, "probe");
    await fs.mkdir(isolatedProbe);
    vi.spyOn(fs, "mkdtemp").mockResolvedValue(isolatedProbe);
    vi.stubEnv("PATH", temp.path);
    vi.spyOn(fs, "rm").mockRejectedValueOnce(new Error("synthetic cleanup"));
    expect(await probeDeclaredHarness(target)).toBeUndefined();
    await expect(
      probeDeclaredHarness({ ...target, id: "bad" }),
    ).rejects.toThrow();
  });
  it("uses bounded host evidence for the declared harness only and keeps session/use unknown", () => {
    const unknown = inspectHarnessCapabilities(target);
    expect(
      inspectHarnessCapabilities(target, {
        harness: "claude",
        version: "2.1.226",
        pluginHelp: "list",
        marketplaceHelp: "add",
      }).commands,
    ).toEqual([]);
    expect(unknown.cli).toBe("unknown");
    expect(unknown.availableInSession).toBe("unknown");
    const claude = inspectHarnessCapabilities(target, {
      harness: "claude",
      version: "2.1.226 (Claude Code)",
      pluginHelp: "install enable disable list",
      marketplaceHelp: "add list",
    });
    expect(claude.cli).toBe("observed");
    expect(claude.registration).toBe("unsupported");
    expect(claude.commands).toContain(
      "claude plugin install NAME@MARKET --scope user|project|local",
    );
    const codex = inspectHarnessCapabilities(
      { ...target, harness: "codex" },
      {
        harness: "codex",
        version: "codex-cli 0.1.0",
        pluginHelp: "add list remove",
        marketplaceHelp: "add list",
      },
    );
    expect(codex.cli).toBe("observed");
    expect(codex.commands).toContain("codex plugin add NAME@MARKET --json");
    expect(codex.observedUse).toBe("unknown");
    expect(
      inspectHarnessCapabilities(target, {
        harness: "codex",
        version: "0.1.0",
        pluginHelp: "add",
        marketplaceHelp: "add",
      }).cli,
    ).toBe("unknown");
    expect(
      inspectHarnessCapabilities(target, {
        harness: "claude",
        version: "2.1.226",
        pluginHelp: "x".repeat(20000),
        marketplaceHelp: "add",
      }).cli,
    ).toBe("unknown");
    expect(
      inspectHarnessCapabilities(target, {
        harness: "claude",
        version: "unrecognized",
        pluginHelp: "list",
        marketplaceHelp: "list",
      }).cli,
    ).toBe("unknown");
  });
  it("rejects invalid explicit targets without consulting any host state", () => {
    expect(validateDeclaredTarget(target)).toEqual(target);
    for (const bad of [
      { ...target, id: "bad" },
      { ...target, harness: "other" },
      { ...target, scope: "other" },
      { ...target, scope: "workspace", bindingId: null },
      { ...target, bindingId: "bad" },
    ])
      expect(() => validateDeclaredTarget(bad as typeof target)).toThrow();
  });
});
