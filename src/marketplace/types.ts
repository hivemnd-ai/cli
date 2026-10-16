export interface PreviewLimits {
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;
  readonly maxPlugins: number;
  readonly maxSkills: number;
}

export interface ManifestSnapshot {
  readonly path: string;
  readonly raw: string;
  readonly sha256: string;
}

export interface PluginPreview {
  readonly name: string;
  readonly source: unknown;
  readonly status: "local-inventory" | "unresolved";
  readonly capabilities: readonly string[];
  readonly declarations: Readonly<Record<string, unknown>>;
  readonly skills: readonly {
    readonly path: string;
    readonly sha256: string;
  }[];
}

export interface MarketplacePreview {
  readonly format: "agent-plugins-v1" | "claude-marketplace";
  readonly source: {
    readonly root: string;
    readonly commitSha: string;
    /** Any captured manifest/skill differs from HEAD; not a full git status. */
    readonly dirty: boolean;
  };
  readonly manifests: readonly ManifestSnapshot[];
  readonly plugins: readonly PluginPreview[];
  readonly warnings: readonly string[];
}
