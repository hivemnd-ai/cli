import { randomUUID } from "node:crypto";
import { access, constants } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createFilesystemAdapters } from "../agents/destinations.js";
import { HttpApiClient } from "../api/http-api-client.js";
import {
  keychainAccount,
  MacOsKeychain,
  SecureTokenStore,
} from "../auth/token-store.js";
import { ConfigRepository } from "../config.js";
import type { RuntimeDependencies } from "./dependencies.js";

export const defaultDependencies: RuntimeDependencies = {
  cwd: process.cwd(),
  environment: process.env,
  output: {
    write: (message) => {
      console.log(message);
    },
    error: (message) => {
      console.error(message);
    },
  },
  configRepositoryFactory: (cwd) => new ConfigRepository(cwd),
  tokenStoreFactory: (config) =>
    new SecureTokenStore(
      process.env,
      new MacOsKeychain(keychainAccount(config.apiUrl)),
    ),
  apiClientFactory: (config) => new HttpApiClient(config.apiUrl),
  adapterFactory: (config, destinationNames) =>
    createFilesystemAdapters(
      config,
      destinationNames,
      homedir(),
      process.env.HIVEMND_HOME ?? join(homedir(), ".hivemnd"),
    ),
  targetAccess: (path) => access(path, constants.R_OK | constants.W_OK),
  id: randomUUID,
  clientPlatform: `${process.platform}-${process.arch}`,
  clientVersion: "0.1.3",
};
