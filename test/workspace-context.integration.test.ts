import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigRepository } from "../src/config.js";
import type { HivemndConfig } from "../src/domain.js";
import {
  canonicalWorkspacePath,
  mergeWorkspaceDestinations,
  selectContextualDestinationNames,
} from "../src/workspaces/destinations.js";
import { temporaryDirectory } from "./helpers.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () =>
  Promise.all(cleanups.splice(0).map((cleanup) => cleanup())),
);

describe("workspace destinations and contextual synchronization", () => {
  it("adds relative workspaces as absolute destinations for selected AI tools and is idempotent", async () => {
    const temp = await temporaryDirectory();
    cleanups.push(temp.cleanup);
    const path = join(temp.path, "repo");
    await mkdir(path);
    const config: HivemndConfig = {
      apiUrl: "https://hivemnd.test",
      destinations: [],
    };

    const first = mergeWorkspaceDestinations(config, path, ["codex", "claude"]);
    const second = mergeWorkspaceDestinations(first, path, ["codex", "claude"]);

    expect(second.destinations).toEqual(first.destinations);
    expect(first.destinations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ agent: "codex", scope: "workspace", path }),
        expect.objectContaining({ agent: "claude", scope: "workspace", path }),
      ]),
    );
  });

  it("chooses the most specific containing workspace, then root, while --all preserves every destination", () => {
    const root = "/work";
    const nested = "/work/apps/api";
    const config: HivemndConfig = {
      apiUrl: "https://hivemnd.test",
      destinations: [
        { name: "global", agent: "codex", scope: "root" },
        { name: "work-codex", agent: "codex", scope: "workspace", path: root },
        { name: "api-codex", agent: "codex", scope: "workspace", path: nested },
        {
          name: "api-claude",
          agent: "claude",
          scope: "workspace",
          path: nested,
        },
      ],
    };

    expect(
      selectContextualDestinationNames(config, "/work/apps/api/lib", false),
    ).toEqual(["api-codex", "api-claude"]);
    expect(selectContextualDestinationNames(config, "/outside", false)).toEqual(
      ["global"],
    );
    expect(selectContextualDestinationNames(config, "/outside", true)).toEqual(
      [],
    );
  });

  it("writes config atomically with private permissions and cleans temporary files after failure", async () => {
    const temp = await temporaryDirectory();
    cleanups.push(temp.cleanup);
    const repository = new ConfigRepository(temp.path);
    const path = join(temp.path, "config.json");
    await repository.create(path, {
      apiUrl: "https://hivemnd.test",
      destinations: [],
    });
    await expect(
      repository.create(path, {
        apiUrl: "https://other.test",
        destinations: [],
      }),
    ).rejects.toMatchObject({ code: "CONFIG_EXISTS" });
    expect((await repository.load(path)).apiUrl).toBe("https://hivemnd.test");
  });

  it("rejects missing and non-directory workspaces", async () => {
    const temp = await temporaryDirectory();
    cleanups.push(temp.cleanup);
    const file = join(temp.path, "file");
    await writeFile(file, "x");
    await expect(canonicalWorkspacePath(file)).rejects.toThrow(
      "not a directory",
    );
    await expect(
      canonicalWorkspacePath(join(temp.path, "missing")),
    ).rejects.toThrow("does not exist");
  });

  it("rejects contextual sync without a fallback and names punctuation-only workspaces", () => {
    expect(() =>
      selectContextualDestinationNames(
        { apiUrl: "https://hivemnd.test", destinations: [] },
        "/outside",
        false,
      ),
    ).toThrow("No configured workspace");
    const generated = mergeWorkspaceDestinations(
      { apiUrl: "https://hivemnd.test", destinations: [] },
      "/tmp/!!!",
      ["codex"],
    );
    expect(generated.destinations[0]?.name).toMatch(/^codex-workspace-/);
  });
});
