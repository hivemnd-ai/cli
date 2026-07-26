import type { ApiClient, PreparedManifest, SyncManifest } from "../domain.js";
import { HivemndError } from "../errors.js";
import { sha256 } from "./hash.js";

export class SyncPreparer {
  async prepare(
    manifest: SyncManifest,
    token: string,
    client: ApiClient,
  ): Promise<PreparedManifest> {
    const artifacts = await Promise.all(
      manifest.artifacts.map(async (artifact) => {
        const content = await client.download(token, artifact);
        if (content.byteLength !== artifact.size) {
          throw new HivemndError(
            "INTEGRITY_FAILED",
            `Artifact ${artifact.artifactVersionId} has unexpected size`,
          );
        }
        if (sha256(content) !== artifact.sha256) {
          throw new HivemndError(
            "INTEGRITY_FAILED",
            `Artifact ${artifact.artifactVersionId} failed SHA-256 validation`,
          );
        }
        return { ...artifact, content };
      }),
    );
    return { ...manifest, artifacts };
  }
}
