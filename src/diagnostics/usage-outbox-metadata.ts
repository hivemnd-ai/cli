import { constants } from "node:fs";
import { lstat, open, opendir } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";
import {
  usageOutboxRoot,
  USAGE_OUTBOX_MAXIMUM_BYTES,
  USAGE_OUTBOX_MAXIMUM_ENTRIES,
} from "../usage/receipt-outbox.js";

const MAX_SCANNED_ENTRIES = 512;
type UnknownReason =
  | "installation identity unavailable"
  | "unsafe local state"
  | "inspection limit exceeded"
  | "local state unreadable";
export type UsageOutboxMetadata =
  | { readonly state: "unknown"; readonly reason: UnknownReason }
  | {
      readonly state: "empty" | "queued";
      readonly queuedFiles: number;
      readonly bytes: number;
      readonly oldestFileAgeSeconds: number | null;
    };
class InspectionFailure extends Error {
  constructor(readonly reason: UnknownReason) {
    super(reason);
  }
}

/** Only filesystem metadata: never parse, deliver, create, fix permissions, or delete receipts. */
export async function inspectUsageOutboxMetadata(options: {
  readonly stateDirectory: string;
  readonly apiUrl: string;
  readonly installationId?: string;
}): Promise<UsageOutboxMetadata> {
  if (!options.installationId)
    return { state: "unknown", reason: "installation identity unavailable" };
  try {
    const state = resolve(options.stateDirectory);
    const root = usageOutboxRoot({
      ...options,
      installationId: options.installationId,
    });
    const paths = [state];
    let current = state;
    for (const segment of relative(state, root).split(sep)) {
      current = join(current, segment);
      paths.push(current);
    }
    const directories = [];
    for (const path of paths) {
      let metadata;
      try {
        metadata = await lstat(path);
      } catch (error: unknown) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return empty();
        throw error;
      }
      if (!metadata.isDirectory() || (metadata.mode & 0o077) !== 0)
        throw new InspectionFailure("unsafe local state");
      directories.push({ path, metadata });
    }
    let scanned = 0;
    let queuedFiles = 0;
    let bytes = 0;
    let oldest: number | null = null;
    const directory = await opendir(root, { bufferSize: 32 });
    for await (const entry of directory) {
      if (++scanned > MAX_SCANNED_ENTRIES)
        throw new InspectionFailure("inspection limit exceeded");
      if (entry.isSymbolicLink())
        throw new InspectionFailure("unsafe local state");
      if (!entry.name.endsWith(".json")) continue;
      const path = join(root, entry.name);
      const before = await lstat(path);
      if (!before.isFile() || (before.mode & 0o077) !== 0)
        throw new InspectionFailure("unsafe local state");
      // O_NONBLOCK also avoids hanging if a file is replaced by a FIFO before open.
      const handle = await open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const metadata = await handle.stat();
        if (
          !metadata.isFile() ||
          (metadata.mode & 0o077) !== 0 ||
          `${metadata.dev}:${metadata.ino}` !== `${before.dev}:${before.ino}`
        )
          throw new InspectionFailure("unsafe local state");
        queuedFiles += 1;
        bytes += metadata.size;
        if (
          queuedFiles > USAGE_OUTBOX_MAXIMUM_ENTRIES ||
          bytes > USAGE_OUTBOX_MAXIMUM_BYTES
        )
          throw new InspectionFailure("inspection limit exceeded");
        oldest =
          oldest === null
            ? metadata.mtimeMs
            : Math.min(oldest, metadata.mtimeMs);
      } finally {
        await handle.close();
      }
    }
    // Refuse changed/renamed directory ancestry rather than reporting a trusted snapshot.
    for (const { path, metadata } of directories) {
      const after = await lstat(path);
      if (
        !after.isDirectory() ||
        (after.mode & 0o077) !== 0 ||
        `${after.dev}:${after.ino}` !== `${metadata.dev}:${metadata.ino}`
      )
        throw new InspectionFailure("unsafe local state");
    }
    return {
      state: queuedFiles === 0 ? "empty" : "queued",
      queuedFiles,
      bytes,
      oldestFileAgeSeconds:
        oldest === null
          ? null
          : Math.max(0, Math.floor((Date.now() - oldest) / 1000)),
    };
  } catch (error: unknown) {
    return {
      state: "unknown",
      reason:
        error instanceof InspectionFailure
          ? error.reason
          : "local state unreadable",
    };
  }
}
function empty(): UsageOutboxMetadata {
  return {
    state: "empty",
    queuedFiles: 0,
    bytes: 0,
    oldestFileAgeSeconds: null,
  };
}
