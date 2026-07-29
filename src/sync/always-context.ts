import type {
  AgentAdapter,
  ContextInstructionChange,
  ContextInstructionOwnership,
  PreparedManifest,
} from "../domain.js";
import { HivemndError } from "../errors.js";
import { isAlwaysContextArtifact } from "../context/always-context-cache.js";
import { sha256 } from "./hash.js";

export const HIVEMND_CONTEXT_BEGIN =
  "<!-- BEGIN HIVEMND MANAGED ALWAYS CONTEXT -->";
export const HIVEMND_CONTEXT_END =
  "<!-- END HIVEMND MANAGED ALWAYS CONTEXT -->";

const decoder = new TextDecoder("utf-8", { fatal: true });

interface ManagedBlock {
  readonly start: number;
  readonly end: number;
  readonly content: string;
}

/**
 * Plans only the one-way migration away from legacy AGENTS.md/CLAUDE.md
 * managed blocks. New always-context is delivered by SessionStart hooks.
 */
export class AlwaysContextPlanner {
  async plan(
    adapters: readonly AgentAdapter[],
  ): Promise<readonly ContextInstructionChange[]> {
    const changes: ContextInstructionChange[] = [];
    for (const adapter of adapters) {
      if (!supportsInstructions(adapter)) continue;
      const ownership = await adapter.readContextInstructionOwnership();
      if (!ownership) continue;
      const currentBytes = await adapter.readInstruction();
      const current = decodeInstruction(currentBytes);
      const expectedFileSha256 = currentBytes ? sha256(currentBytes) : null;
      const parsed = managedBlock(current);
      if (parsed.invalid) {
        changes.push(
          change(adapter, "conflict", expectedFileSha256, {
            conflictReason: "managed-context-markers-invalid",
          }),
        );
        continue;
      }
      if (!parsed.block) {
        changes.push(
          change(adapter, "conflict", expectedFileSha256, {
            conflictReason: "managed-context-block-missing",
          }),
        );
        continue;
      }
      if (ownedBlockEdited(parsed.block, ownership, current)) {
        changes.push(
          change(adapter, "conflict", expectedFileSha256, {
            conflictReason: "managed-context-block-edited",
          }),
        );
        continue;
      }
      const next = removeOwnedBlock(current, parsed.block, ownership);
      changes.push(
        change(adapter, "remove", expectedFileSha256, {
          ...(next.length > 0 || !ownership.createdFile
            ? { content: Buffer.from(next) }
            : {}),
          ownership: null,
        }),
      );
    }
    return changes;
  }
}

export function withoutAlwaysContext(
  manifest: PreparedManifest,
): PreparedManifest {
  return {
    ...manifest,
    artifacts: manifest.artifacts.filter(
      (artifact) => !isAlwaysContextArtifact(artifact),
    ),
  };
}

function supportsInstructions(
  adapter: AgentAdapter,
): adapter is AgentAdapter & {
  readonly instructionPath: string;
  readContextInstructionOwnership(): Promise<
    ContextInstructionOwnership | undefined
  >;
  readInstruction(): Promise<Uint8Array | undefined>;
} {
  if (!adapter.instructionPath) return false;
  if (
    typeof adapter.readContextInstructionOwnership === "function" &&
    typeof adapter.readInstruction === "function"
  ) {
    return true;
  }
  throw new HivemndError(
    "CONFIG_INVALID",
    `Destination ${adapter.name} has incomplete legacy always-context support`,
  );
}

function decodeInstruction(content: Uint8Array | undefined): string {
  if (!content) return "";
  try {
    return decoder.decode(content);
  } catch (error: unknown) {
    throw new HivemndError(
      "SYNC_CONFLICT",
      "Host instruction file is not valid UTF-8",
      { cause: error },
    );
  }
}

function managedBlock(content: string): {
  readonly block?: ManagedBlock;
  readonly invalid: boolean;
} {
  const start = content.indexOf(HIVEMND_CONTEXT_BEGIN);
  const endIndex = content.indexOf(HIVEMND_CONTEXT_END);
  if (start === -1 && endIndex === -1) return { invalid: false };
  if (
    start === -1 ||
    endIndex === -1 ||
    content.slice(start + 1).includes(HIVEMND_CONTEXT_BEGIN) ||
    content.slice(endIndex + 1).includes(HIVEMND_CONTEXT_END) ||
    endIndex < start
  ) {
    return { invalid: true };
  }
  const end = endIndex + HIVEMND_CONTEXT_END.length;
  return {
    invalid: false,
    block: { start, end, content: content.slice(start, end) },
  };
}

function ownedBlockEdited(
  block: ManagedBlock,
  ownership: ContextInstructionOwnership,
  current: string,
): boolean {
  const prefixStart = block.start - ownership.prefix.length;
  return (
    prefixStart < 0 ||
    current.slice(prefixStart, block.start) !== ownership.prefix ||
    sha256(Buffer.from(block.content)) !== ownership.blockSha256
  );
}

function removeOwnedBlock(
  current: string,
  block: ManagedBlock,
  ownership: ContextInstructionOwnership,
): string {
  const start = block.start - ownership.prefix.length;
  return `${current.slice(0, start)}${current.slice(block.end)}`;
}

function change(
  adapter: AgentAdapter & { readonly instructionPath: string },
  kind: ContextInstructionChange["kind"],
  expectedFileSha256: string | null,
  attributes: Pick<
    ContextInstructionChange,
    "conflictReason" | "content" | "ownership"
  > = {},
): ContextInstructionChange {
  return {
    agent: adapter.kind,
    destinationName: adapter.name,
    destination: adapter.instructionPath,
    kind,
    expectedFileSha256,
    ...attributes,
  };
}
