import type { AgentKind, HivemndConfig } from "../domain.js";

export interface OrganizationProfile {
  readonly key: string;
  readonly alias: string;
  readonly name: string;
  readonly slug: string;
  readonly apiUrl: string;
  readonly configPath: string;
}

export interface WorkspaceBinding {
  readonly path: string;
  readonly organizationKey: string;
}

export interface GlobalBinding {
  readonly client: AgentKind;
  readonly organizationKey: string;
}

export interface OrganizationRegistry {
  readonly version: 1;
  readonly profiles: readonly OrganizationProfile[];
  readonly workspaceBindings: readonly WorkspaceBinding[];
  readonly globalBindings: readonly GlobalBinding[];
}

export interface ResolvedOrganization extends OrganizationProfile {
  readonly config: HivemndConfig;
}

export interface OrganizationRegistryReader {
  load(): Promise<OrganizationRegistry>;
}
