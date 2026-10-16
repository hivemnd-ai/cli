import { createHash } from "node:crypto";
import { canonicalBundleDigest } from "../src/marketplace/reconcile.js";

export const registrationId = "00000000-0000-4000-8000-000000000001";
export const targetId = "00000000-0000-4000-8000-000000000002";
export const selectionId = "00000000-0000-4000-8000-000000000003";
export const packageId = "00000000-0000-4000-8000-000000000004";
export const wireEnvelope = {
  schema_version: 1,
  minimum_client_version: "0.5.4",
};
export const wireRegistration = {
  id: registrationId,
  name: "Engineering",
  provider_repository_id: 42,
  repository_owner: "fixture",
  repository_name: "plugins",
  format: "claude_marketplace",
  manifest_path: ".claude-plugin/marketplace.json",
  configured_ref: "main",
  sync_with_hivemnd: true,
  status: "active",
  source_visibility: "public",
  lock_version: 0,
  current_catalog_snapshot: null,
  head_observed_at: null,
  last_checked_at: null,
  last_error_code: null,
};
export const wireTarget = {
  id: targetId,
  harness_kind: "claude" as const,
  install_scope: "user" as const,
  workspace_binding_id: null,
  status: "active" as const,
  lock_version: 0,
};
export const wireSelection = {
  id: selectionId,
  registration_id: registrationId,
  plugin_key: "team",
  audience: "installation",
  harness_kind: "claude",
  install_scope: "user",
  target_id: targetId,
  enabled: true,
  lock_version: 0,
};
const content = Buffer.from("# Team skill\nNever execute fixture scripts.\n");
export const wireFile = {
  relative_path: "skills/team/SKILL.md",
  git_blob_oid: createHash("sha1")
    .update(`blob ${content.byteLength}\0`)
    .update(content)
    .digest("hex"),
  sha256: createHash("sha256").update(content).digest("hex"),
  byte_size: content.byteLength,
  executable: false,
};
export const wirePackage = {
  id: packageId,
  plugin_key: "team",
  package_root: "plugins/team",
  declared_version: null,
  inventory_encoding: "tree_sha256_v1",
  package_sha256: canonicalBundleDigest(
    [
      {
        path: wireFile.relative_path,
        sha256: wireFile.sha256,
        size: wireFile.byte_size,
        executable: false,
      },
    ],
    {
      maxFiles: 10,
      maxFileBytes: 10_000,
      maxTotalBytes: 10_000,
      maxDepth: 10,
      maxEntries: 20,
    },
  ),
  package_bytes: content.byteLength,
  file_count: 1,
  provenance: {
    provider_repository_id: 42,
    repository_owner: "fixture",
    repository_name: "plugins",
    commit_sha: "a".repeat(40),
    catalog_snapshot_id: "00000000-0000-4000-8000-000000000005",
    manifest_sha256: "b".repeat(64),
  },
};
export const wireReady = {
  selection_id: selectionId,
  registration_id: registrationId,
  plugin_key: "team",
  enabled: true,
  status: "ready",
  mode: "managed",
  package: { ...wirePackage, files: [wireFile] },
  bundle_path: `/eigen/api/v1/marketplace/packages/${packageId}/bundle`,
};
export const wireBundle = {
  ...wireEnvelope,
  registration_id: registrationId,
  package: { ...wirePackage, files: [wireFile] },
  files: [{ ...wireFile, content_base64: content.toString("base64") }],
};

export function requestUrl(value: Parameters<typeof fetch>[0]): string {
  return value instanceof Request ? value.url : value.toString();
}
