import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import type {
  AgentAdapter,
  AgentKind,
  DestinationConfig,
  HivemndConfig,
} from "../domain.js";
import { HivemndError } from "../errors.js";
import { tenantBaseUrl } from "../tenant-url.js";
import { FilesystemAgentAdapter } from "./filesystem-agent-adapter.js";

export function createFilesystemAdapters(
  config: HivemndConfig,
  destinationNames: readonly string[],
  homeDirectory: string,
  stateDirectory: string,
): readonly AgentAdapter[] {
  const selected = selectDestinations(config.destinations, destinationNames);
  const occupied = new Set<string>();
  return selected.map((destination) => {
    const root = resolveAgentRoot(destination, homeDirectory);
    const assignment = `${destination.agent}:${root}`;
    if (occupied.has(assignment)) {
      throw new HivemndError(
        "CONFIG_INVALID",
        `Destinations cannot resolve to the same agent directory: ${assignment}`,
      );
    }
    occupied.add(assignment);
    return new FilesystemAgentAdapter(
      destination.name,
      destination.agent,
      root,
      join(
        stateDirectory,
        "destinations",
        stateNamespace(config.apiUrl),
        destination.name,
        "ownership.json",
      ),
      stateDirectory,
      instructionPath(destination, homeDirectory),
      instructionBoundary(destination, homeDirectory),
      destination.scope,
    );
  });
}

function instructionPath(
  destination: DestinationConfig,
  homeDirectory: string,
): string | undefined {
  if (destination.scope === "directory") return undefined;
  if (destination.scope === "root") {
    return destination.agent === "codex"
      ? join(resolve(homeDirectory), ".codex", "AGENTS.md")
      : join(resolve(homeDirectory), ".claude", "CLAUDE.md");
  }
  return join(
    resolve(requirePath(destination)),
    destination.agent === "codex" ? "AGENTS.md" : "CLAUDE.md",
  );
}

function instructionBoundary(
  destination: DestinationConfig,
  homeDirectory: string,
): string | undefined {
  if (destination.scope === "directory") return undefined;
  if (destination.scope === "root") {
    return destination.agent === "codex"
      ? join(resolve(homeDirectory), ".codex")
      : join(resolve(homeDirectory), ".claude");
  }
  return resolve(requirePath(destination));
}

export function resolveAgentRoot(
  destination: DestinationConfig,
  homeDirectory: string,
): string {
  if (destination.scope === "directory")
    return resolve(requirePath(destination));
  const base =
    destination.scope === "root"
      ? resolve(homeDirectory)
      : resolve(requirePath(destination));
  return join(base, agentDirectory(destination.agent));
}

function selectDestinations(
  destinations: readonly DestinationConfig[],
  names: readonly string[],
): readonly DestinationConfig[] {
  if (names.length === 0) return destinations;
  const requested = new Set(names);
  const unknown = [...requested].filter(
    (name) => !destinations.some((destination) => destination.name === name),
  );
  if (unknown.length > 0) {
    throw new HivemndError(
      "CONFIG_INVALID",
      `Unknown destination: ${unknown.join(", ")}`,
    );
  }
  return destinations.filter((destination) => requested.has(destination.name));
}

function requirePath(destination: DestinationConfig): string {
  if (!destination.path) {
    throw new HivemndError(
      "CONFIG_INVALID",
      `Destination ${destination.name} requires an absolute path`,
    );
  }
  return destination.path;
}

function agentDirectory(agent: AgentKind): string {
  return agent === "codex" ? ".agents" : ".claude";
}

function stateNamespace(apiUrl: string): string {
  return createHash("sha256")
    .update(tenantBaseUrl(apiUrl).href)
    .digest("hex")
    .slice(0, 16);
}
