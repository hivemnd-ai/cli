import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { basename, relative, resolve, sep } from "node:path";
import type { AgentKind, DestinationConfig, HivemndConfig } from "../domain.js";
import { HivemndError } from "../errors.js";

export async function canonicalWorkspacePath(path: string): Promise<string> {
  const supplied = resolve(path);
  try {
    const canonical = await realpath(supplied);
    if (!(await stat(canonical)).isDirectory()) {
      throw new HivemndError(
        "CONFIG_INVALID",
        `Workspace is not a directory: ${supplied}`,
      );
    }
    return canonical;
  } catch (error: unknown) {
    if (error instanceof HivemndError) throw error;
    throw new HivemndError(
      "CONFIG_INVALID",
      `Workspace does not exist: ${supplied}`,
      { cause: error },
    );
  }
}

export function mergeWorkspaceDestinations(
  config: HivemndConfig,
  path: string,
  clients: readonly AgentKind[],
): HivemndConfig {
  const absolutePath = resolve(path);
  const additions = clients
    .filter(
      (client) =>
        !config.destinations.some(
          (destination) =>
            destination.agent === client &&
            destination.scope === "workspace" &&
            destination.path === absolutePath,
        ),
    )
    .map((client): DestinationConfig => ({
      name: workspaceDestinationName(client, absolutePath),
      agent: client,
      scope: "workspace",
      path: absolutePath,
    }));
  return { ...config, destinations: [...config.destinations, ...additions] };
}

export function mergeRootDestinations(
  config: HivemndConfig,
  clients: readonly AgentKind[],
): HivemndConfig {
  const additions = clients
    .filter(
      (client) =>
        !config.destinations.some(
          (destination) =>
            destination.agent === client && destination.scope === "root",
        ),
    )
    .map((client): DestinationConfig => ({
      name: `${client}-global`,
      agent: client,
      scope: "root",
    }));
  return { ...config, destinations: [...config.destinations, ...additions] };
}

export function selectContextualDestinationNames(
  config: HivemndConfig,
  path: string,
  all: boolean,
): readonly string[] {
  if (all) return [];
  const selectedPath = resolve(path);
  const containing = config.destinations.filter(
    (destination): destination is DestinationConfig & { path: string } =>
      destination.scope === "workspace" &&
      typeof destination.path === "string" &&
      within(resolve(destination.path), selectedPath),
  );
  if (containing.length > 0) {
    const mostSpecificLength = Math.max(
      ...containing.map((destination) => resolve(destination.path).length),
    );
    return containing
      .filter(
        (destination) =>
          resolve(destination.path).length === mostSpecificLength,
      )
      .map(({ name }) => name);
  }
  const roots = config.destinations
    .filter((destination) => destination.scope === "root")
    .map(({ name }) => name);
  if (roots.length === 0) {
    throw new HivemndError(
      "CONFIG_INVALID",
      `No configured workspace contains ${selectedPath}, and no global destinations are configured`,
    );
  }
  return roots;
}

function within(parent: string, child: string): boolean {
  const fromParent = relative(parent, child);
  return (
    fromParent === "" ||
    (fromParent !== ".." && !fromParent.startsWith(`..${sep}`))
  );
}

function workspaceDestinationName(client: AgentKind, path: string): string {
  const slug =
    basename(path)
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^[^a-z0-9]+/, "")
      .slice(0, 30) || "workspace";
  const identity = createHash("sha256").update(path).digest("hex").slice(0, 8);
  return `${client}-${slug}-${identity}`;
}
