import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import type { ApiClient, DeliveryObservationReceipt } from "../domain.js";
import { asHivemndError, HivemndError } from "../errors.js";
import { profileKey } from "../organizations/registry.js";

export const MAXIMUM_CLIENT_SEQUENCE = 9_007_199_254_740_991;
export const MAXIMUM_OUTBOX_ENTRIES = 256;
export const MAXIMUM_OUTBOX_BYTES = 8 * 1024 * 1024;
export const MAXIMUM_RECEIPT_BYTES = 4 * 1024 * 1024;

const uuid = z.uuid();
const reasonByOutcome = {
  applied: ["created", "updated", "adopted"],
  unchanged: ["already_current"],
  removed: ["no_longer_desired"],
  conflict: [
    "unmanaged_existing_file",
    "owned_file_missing",
    "owned_content_drift",
    "artifact_ownership_mismatch",
  ],
  failed: ["local_apply_failed", "rollback_failed"],
} as const;
const operationSchema = z
  .object({
    artifactId: uuid,
    artifactVersionId: uuid,
    observedArtifactVersionId: uuid.nullable(),
    outcome: z.enum(["applied", "unchanged", "removed", "conflict", "failed"]),
    reason: z.enum([
      "created",
      "updated",
      "adopted",
      "already_current",
      "no_longer_desired",
      "unmanaged_existing_file",
      "owned_file_missing",
      "owned_content_drift",
      "artifact_ownership_mismatch",
      "local_apply_failed",
      "rollback_failed",
    ]),
  })
  .strict()
  .superRefine((operation, context) => {
    const allowed = reasonByOutcome[operation.outcome] as readonly string[];
    if (!allowed.includes(operation.reason)) {
      context.addIssue({
        code: "custom",
        message: "Outcome and reason disagree",
      });
    }
    if (
      ["applied", "unchanged"].includes(operation.outcome) &&
      operation.observedArtifactVersionId !== operation.artifactVersionId
    ) {
      context.addIssue({
        code: "custom",
        message: "Observed version must match subject",
      });
    }
    if (
      operation.outcome === "removed" &&
      operation.observedArtifactVersionId !== null
    ) {
      context.addIssue({
        code: "custom",
        message: "Removed artifact must be absent",
      });
    }
  });
const destinationSchema = z
  .object({
    id: uuid,
    label: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,62}$/),
    clientKind: z.enum(["codex", "claude"]),
    installScope: z.enum(["user", "workspace"]),
    selected: z.boolean(),
    operations: z.array(operationSchema),
  })
  .strict()
  .superRefine((destination, context) => {
    if (!destination.selected && destination.operations.length > 0) {
      context.addIssue({
        code: "custom",
        message: "Unselected destination has operations",
      });
    }
    if (
      new Set(destination.operations.map(({ artifactId }) => artifactId))
        .size !== destination.operations.length
    ) {
      context.addIssue({
        code: "custom",
        message: "Duplicate destination artifact",
      });
    }
  });
const receiptSchema = z
  .object({
    idempotencyKey: uuid,
    clientSequence: z.number().int().min(1).max(MAXIMUM_CLIENT_SEQUENCE),
    releaseId: uuid,
    status: z.enum(["applied", "blocked", "failed"]),
    destinations: z.array(destinationSchema).max(128),
  })
  .strict()
  .superRefine((receipt, context) => {
    if (
      new Set(receipt.destinations.map(({ id }) => id)).size !==
      receipt.destinations.length
    ) {
      context.addIssue({
        code: "custom",
        message: "Duplicate destination identity",
      });
    }
    const operations = receipt.destinations.flatMap(
      ({ operations }) => operations,
    );
    if (operations.length > 10_000) {
      context.addIssue({ code: "custom", message: "Too many operations" });
    }
    const allowed = {
      applied: ["applied", "unchanged", "removed"],
      blocked: ["applied", "unchanged", "removed", "conflict"],
      failed: ["applied", "unchanged", "removed", "failed"],
    }[receipt.status];
    if (operations.some(({ outcome }) => !allowed.includes(outcome))) {
      context.addIssue({
        code: "custom",
        message: "Receipt status and outcomes disagree",
      });
    }
  });

const sequenceStateSchema = z
  .object({
    version: z.literal(1),
    lastClientSequence: z.number().int().min(1).max(MAXIMUM_CLIENT_SEQUENCE),
  })
  .strict();

export interface ObservationBootstrap {
  readonly lastClientSequence: number | null;
  readonly nextObservationSequence: number | null;
  readonly sequenceExhausted: boolean;
}

export interface ReceiptOutboxOptions {
  readonly stateDirectory: string;
  readonly apiUrl: string;
  readonly maximumEntries?: number;
  readonly maximumBytes?: number;
  readonly writePrivate?: (path: string, content: Uint8Array) => Promise<void>;
}

export class ReceiptOutbox {
  readonly root: string;
  private readonly organizationRoot: string;
  private readonly maximumEntries: number;
  private readonly maximumBytes: number;
  private readonly writePrivate: (
    path: string,
    content: Uint8Array,
  ) => Promise<void>;

  constructor(options: ReceiptOutboxOptions) {
    this.organizationRoot = join(
      resolve(options.stateDirectory),
      "organizations",
      profileKey(options.apiUrl),
    );
    this.root = join(this.organizationRoot, "receipt-outbox");
    this.maximumEntries = options.maximumEntries ?? MAXIMUM_OUTBOX_ENTRIES;
    this.maximumBytes = options.maximumBytes ?? MAXIMUM_OUTBOX_BYTES;
    this.writePrivate = options.writePrivate ?? atomicPrivateWrite;
  }

  async withLock<T>(operation: () => Promise<T>): Promise<T> {
    await privateDirectory(this.organizationRoot);
    const lock = join(this.organizationRoot, ".sync.lock");
    try {
      await mkdir(lock, { mode: 0o700 });
    } catch (error: unknown) {
      /* v8 ignore else -- EEXIST is the only actionable lock failure */
      if (isNodeError(error) && error.code === "EEXIST") {
        throw new HivemndError(
          "SYNC_FAILED",
          "Another synchronization is already in progress",
          { cause: error },
        );
      }
      /* v8 ignore next -- defensive propagation for unexpected OS failures; EEXIST is the actionable lock state */
      throw error;
    }
    try {
      return await operation();
    } finally {
      await rm(lock, { recursive: true, force: true });
    }
  }

  async allocate(bootstrap: ObservationBootstrap): Promise<number> {
    validateBootstrap(bootstrap);
    if (bootstrap.sequenceExhausted) throw exhausted();
    const state = await this.readSequenceState();
    const pending = await this.pending();
    const localLast = Math.max(
      state?.lastClientSequence ?? 0,
      ...pending.map(({ clientSequence }) => clientSequence),
    );
    if (localLast >= MAXIMUM_CLIENT_SEQUENCE) throw exhausted();
    const serverNext = bootstrap.nextObservationSequence;
    /* v8 ignore next -- validateBootstrap rejects null before this defensive narrowing */
    if (serverNext === null) throw exhausted();
    const sequence = Math.max(serverNext, localLast + 1);
    /* v8 ignore next -- validated server/local inputs cannot exceed the safe-integer maximum */
    if (sequence > MAXIMUM_CLIENT_SEQUENCE) throw exhausted();
    return sequence;
  }

  async assertCapacity(receipt: DeliveryObservationReceipt): Promise<void> {
    const serialized = serializeReceipt(receipt);
    const entries = await this.pendingEntries();
    const bytes = entries.reduce((total, entry) => total + entry.bytes, 0);
    if (
      entries.length >= this.maximumEntries ||
      bytes + serialized.byteLength > this.maximumBytes
    ) {
      throw new HivemndError(
        "SYNC_FAILED",
        "Receipt outbox is full; restore server connectivity before applying again",
      );
    }
  }

  async stage(receipt: DeliveryObservationReceipt): Promise<void> {
    const parsed = parseReceipt(receipt);
    await this.assertCapacity(parsed);
    const previous = await this.readSequenceState();
    const pending = await this.pending();
    const last = Math.max(
      previous?.lastClientSequence ?? 0,
      ...pending.map(({ clientSequence }) => clientSequence),
    );
    if (parsed.clientSequence <= last) {
      throw new HivemndError(
        "SYNC_FAILED",
        "Observation sequence was already allocated and cannot be reused",
      );
    }
    await privateDirectory(this.root);
    const destination = this.receiptPath(parsed.idempotencyKey);
    const body = serializeReceipt(parsed);
    await this.writePrivate(destination, body);
    try {
      await this.writePrivate(
        this.sequencePath(),
        Buffer.from(
          `${JSON.stringify({ version: 1, lastClientSequence: parsed.clientSequence }, null, 2)}\n`,
        ),
      );
    } catch (error: unknown) {
      await rm(destination, { force: true });
      throw error;
    }
  }

  async pending(): Promise<readonly DeliveryObservationReceipt[]> {
    return (await this.pendingEntries()).map(({ receipt }) => receipt);
  }

  async deliverPending(
    client: ApiClient,
    token: string,
  ): Promise<{
    readonly accepted: number;
    readonly pending: number;
    readonly deferredCode?: string;
  }> {
    const entries = await this.pendingEntries();
    let accepted = 0;
    for (const entry of entries) {
      try {
        await client.receipt(token, entry.receipt);
      } catch (error: unknown) {
        return {
          accepted,
          pending: entries.length - accepted,
          deferredCode: asHivemndError(error).code,
        };
      }
      await this.removeAccepted(entry.path, entry.receipt.idempotencyKey);
      accepted += 1;
    }
    return { accepted, pending: 0 };
  }

  private async pendingEntries(): Promise<
    readonly {
      readonly receipt: DeliveryObservationReceipt;
      readonly path: string;
      readonly bytes: number;
    }[]
  > {
    let names: string[];
    try {
      names = (await readdir(this.root, { withFileTypes: true }))
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map(({ name }) => name);
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === "ENOENT") return [];
      throw error;
    }
    const entries = await Promise.all(
      names.map(async (name) => {
        const path = join(this.root, name);
        const content = await readFile(path);
        let receipt: DeliveryObservationReceipt;
        try {
          receipt = parseReceipt(
            JSON.parse(content.toString("utf8")) as unknown,
          );
        } catch (error: unknown) {
          throw new HivemndError(
            "INTEGRITY_FAILED",
            "Private receipt outbox contains invalid state",
            { cause: error },
          );
        }
        if (name !== `${receipt.idempotencyKey}.json`) {
          throw new HivemndError(
            "INTEGRITY_FAILED",
            "Private receipt outbox filename does not match its identity",
          );
        }
        return { receipt, path, bytes: content.byteLength };
      }),
    );
    return entries.sort(
      (left, right) =>
        left.receipt.clientSequence - right.receipt.clientSequence ||
        left.receipt.idempotencyKey.localeCompare(right.receipt.idempotencyKey),
    );
  }

  private async readSequenceState(): Promise<
    z.infer<typeof sequenceStateSchema> | undefined
  > {
    try {
      return sequenceStateSchema.parse(
        JSON.parse(await readFile(this.sequencePath(), "utf8")) as unknown,
      );
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === "ENOENT") return undefined;
      throw new HivemndError(
        "INTEGRITY_FAILED",
        "Observation sequence state is invalid",
        { cause: error },
      );
    }
  }

  private async removeAccepted(path: string, id: string): Promise<void> {
    const accepted = join(this.root, `.accepted-${id}-${randomUUID()}.tmp`);
    await rename(path, accepted);
    await rm(accepted, { force: true });
  }

  private receiptPath(id: string): string {
    return join(this.root, `${id}.json`);
  }

  private sequencePath(): string {
    return join(this.organizationRoot, "receipt-sequence.json");
  }
}

function parseReceipt(value: unknown): DeliveryObservationReceipt {
  try {
    return receiptSchema.parse(value);
  } catch (error: unknown) {
    throw new HivemndError(
      "SYNC_FAILED",
      "Observation receipt violates the bounded wire contract",
      { cause: error },
    );
  }
}

function serializeReceipt(receipt: DeliveryObservationReceipt): Uint8Array {
  const parsed = parseReceipt(receipt);
  const body = Buffer.from(`${JSON.stringify(parsed)}\n`);
  /* v8 ignore next -- stricter destination/operation bounds keep canonical bodies below this defense-in-depth limit */
  if (body.byteLength > MAXIMUM_RECEIPT_BYTES) {
    throw new HivemndError(
      "SYNC_FAILED",
      "Observation receipt exceeds the four MiB wire limit",
    );
  }
  return body;
}

function validateBootstrap(bootstrap: ObservationBootstrap): void {
  const last = bootstrap.lastClientSequence;
  const next = bootstrap.nextObservationSequence;
  const validLast =
    last === null ||
    (Number.isSafeInteger(last) &&
      last >= 1 &&
      last <= MAXIMUM_CLIENT_SEQUENCE);
  const validNext =
    next === null ||
    (Number.isSafeInteger(next) &&
      next >= 1 &&
      next <= MAXIMUM_CLIENT_SEQUENCE);
  const coherent = bootstrap.sequenceExhausted
    ? last === MAXIMUM_CLIENT_SEQUENCE && next === null
    : validLast && validNext && next === (last ?? 0) + 1;
  if (!validLast || !validNext || !coherent) {
    throw new HivemndError(
      "CLIENT_CONFIGURATION_INVALID",
      "Invalid observation sequence bootstrap",
    );
  }
}

function exhausted(): HivemndError {
  return new HivemndError(
    "SYNC_FAILED",
    "Observation sequence is exhausted; explicitly re-enroll or rotate this installation before applying again",
  );
}

async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const metadata = await lstat(path);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new HivemndError(
      "PATH_UNSAFE",
      "Private receipt state must be a regular directory",
    );
  }
  await chmod(path, 0o700);
}

async function atomicPrivateWrite(
  path: string,
  content: Uint8Array,
): Promise<void> {
  await privateDirectory(dirname(path));
  const temporary = `${path}.hivemnd-${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { mode: 0o600, flag: "wx" });
    await chmod(temporary, 0o600);
    await rename(temporary, path);
    await chmod(path, 0o600);
  } catch (error: unknown) {
    await rm(temporary, { force: true });
    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
