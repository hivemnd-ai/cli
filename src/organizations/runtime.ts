import { homedir } from "node:os";
import { join } from "node:path";
import type { RuntimeDependencies } from "../runtime/dependencies.js";
import { OrganizationRegistryRepository } from "./registry.js";

export function organizationRegistry(
  dependencies: RuntimeDependencies,
): OrganizationRegistryRepository {
  const stateDirectory =
    dependencies.environment.HIVEMND_HOME ?? join(homedir(), ".hivemnd");
  return new OrganizationRegistryRepository(
    stateDirectory,
    dependencies.configRepositoryFactory(dependencies.cwd),
  );
}
