import { join, resolve } from "node:path";
import { z } from "zod";
import type { ContextUsageReceipt } from "../domain.js";
import { HivemndError } from "../errors.js";
import { profileKey } from "../organizations/registry.js";
import { PrivateJsonOutbox } from "../outbox/private-json-outbox.js";

const itemSchema = z
  .object({
    artifactId: z.string().min(1).max(128),
    artifactVersionId: z.string().min(1).max(128),
    artifactKind: z.enum(["embedded_document", "skill"]),
  })
  .strict();
const receiptSchema = z
  .object({
    eventId: z.uuid(),
    eventKind: z.enum(["always_context_emitted", "skill_activated"]),
    agentHost: z.enum(["codex", "claude"]),
    observedAt: z.iso.datetime(),
    contextTrigger: z
      .enum(["startup", "resume", "clear", "compact"])
      .optional(),
    items: z.array(itemSchema).min(1).max(10_000),
  })
  .strict()
  .superRefine((receipt, context) => {
    const always = receipt.eventKind === "always_context_emitted";
    if (always !== (receipt.contextTrigger !== undefined)) {
      context.addIssue({ code: "custom", message: "Invalid context trigger" });
    }
    if (
      receipt.eventKind === "skill_activated" &&
      (receipt.agentHost !== "claude" ||
        receipt.items.length !== 1 ||
        receipt.items[0]?.artifactKind !== "skill")
    ) {
      context.addIssue({ code: "custom", message: "Invalid Skill receipt" });
    }
    if (
      always &&
      receipt.items.some((item) => item.artifactKind !== "embedded_document")
    ) {
      context.addIssue({
        code: "custom",
        message: "Invalid always-context item",
      });
    }
  });

export interface UsageReceiptOutboxOptions {
  readonly stateDirectory: string;
  readonly apiUrl: string;
  readonly installationId: string;
  readonly maximumEntries?: number;
  readonly maximumBytes?: number;
}

export class UsageReceiptOutbox {
  readonly root: string;
  private readonly outbox: PrivateJsonOutbox<ContextUsageReceipt>;

  constructor(options: UsageReceiptOutboxOptions) {
    const installationId = z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/)
      .parse(options.installationId);
    this.root = join(
      resolve(options.stateDirectory),
      "organizations",
      profileKey(options.apiUrl),
      "usage-outboxes",
      installationId,
    );
    this.outbox = new PrivateJsonOutbox({
      root: this.root,
      parse: parseReceipt,
      identity: (receipt) => receipt.eventId,
      compare: (left, right) =>
        left.observedAt.localeCompare(right.observedAt) ||
        left.eventId.localeCompare(right.eventId),
      maximumEntries: options.maximumEntries ?? 256,
      maximumBytes: options.maximumBytes ?? 1024 * 1024,
    });
  }

  stage(receipt: ContextUsageReceipt): Promise<void> {
    return this.outbox.stage(receipt);
  }

  pending(): Promise<readonly ContextUsageReceipt[]> {
    return this.outbox.pending();
  }

  deliverPending(
    client: {
      usageReceipt(token: string, receipt: ContextUsageReceipt): Promise<void>;
    },
    token: string,
  ): Promise<{ readonly accepted: number; readonly pending: number }> {
    return this.outbox.drain((receipt) => client.usageReceipt(token, receipt));
  }
}

function parseReceipt(value: unknown): ContextUsageReceipt {
  try {
    const parsed = receiptSchema.parse(value);
    return {
      eventId: parsed.eventId,
      eventKind: parsed.eventKind,
      agentHost: parsed.agentHost,
      observedAt: parsed.observedAt,
      ...(parsed.contextTrigger
        ? { contextTrigger: parsed.contextTrigger }
        : {}),
      items: parsed.items,
    };
  } catch (error: unknown) {
    throw new HivemndError(
      "SYNC_FAILED",
      "Usage receipt violates the bounded wire contract",
      { cause: error },
    );
  }
}
