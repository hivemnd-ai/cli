import { join } from "node:path";
import type { CliContext } from "../cli/context.js";
import { inspectUsageOutboxMetadata } from "../diagnostics/usage-outbox-metadata.js";
import {
  USAGE_OUTBOX_MAXIMUM_BYTES,
  USAGE_OUTBOX_MAXIMUM_ENTRIES,
} from "../usage/receipt-outbox.js";

export async function runOfflineDoctor(context: CliContext): Promise<void> {
  const { dependencies } = context;
  dependencies.output.write(
    "offline: local metadata only; receipt payloads not read",
  );
  let config;
  try {
    config = await context.loadConfigured({ readOnly: true });
  } catch {
    dependencies.output.write(
      "unknown config (local configuration unavailable)",
    );
  }
  if (config) {
    dependencies.output.write("pass config");
    dependencies.output.write(
      `configured destinations: ${config.destinations.length} (access not checked)`,
    );
    const metadata = await inspectUsageOutboxMetadata({
      stateDirectory:
        dependencies.environment.HIVEMND_HOME ??
        join(dependencies.homeDirectory, ".hivemnd"),
      apiUrl: config.apiUrl,
      ...(config.installationId
        ? { installationId: config.installationId }
        : {}),
    });
    dependencies.output.write(
      metadata.state === "unknown"
        ? `usage outbox: unknown (${metadata.reason})`
        : `usage outbox: ${metadata.state}; queued-files: ${metadata.queuedFiles}; bytes: ${metadata.bytes}; oldest-file-mtime-age-seconds: ${metadata.oldestFileAgeSeconds ?? "n/a"} (file age, not event or delivery latency)`,
    );
  } else
    dependencies.output.write(
      "usage outbox: unknown (local configuration unavailable)",
    );
  dependencies.output.write(
    `usage outbox capacity: ${USAGE_OUTBOX_MAXIMUM_ENTRIES} files / ${USAGE_OUTBOX_MAXIMUM_BYTES} bytes; receipt contents not validated`,
  );
  dependencies.output.write("not checked credential (offline)");
  dependencies.output.write("not checked API (offline)");
}
