import { randomUUID } from "node:crypto";
import { access, constants } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createFilesystemAdapters } from "../agents/destinations.js";
import { HttpApiClient } from "../api/http-api-client.js";
import {
  keychainAccount,
  MacOsKeychain,
  SecureTokenStore,
} from "../auth/token-store.js";
import { ConfigRepository } from "../config.js";
import {
  createScheduleManager,
  PeriodicSyncScheduler,
} from "../schedule/periodic-sync-scheduler.js";
import { DailyUpdateChecker } from "../update/daily-update-checker.js";
import type { RuntimeDependencies } from "./dependencies.js";

const stateDirectory = process.env.HIVEMND_HOME ?? join(homedir(), ".hivemnd");
const clientVersion = "0.2.2";

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
      stateDirectory,
    ),
  targetAccess: (path) => access(path, constants.R_OK | constants.W_OK),
  id: randomUUID,
  clientPlatform: `${process.platform}-${process.arch}`,
  clientVersion,
  updateService: new DailyUpdateChecker({
    currentVersion: clientVersion,
    stateDirectory,
  }),
  scheduleManagerFactory: ({ apiUrl, configPath }) =>
    createScheduleManager(
      new PeriodicSyncScheduler({
        platform: process.platform,
        homeDirectory: homedir(),
        stateDirectory,
        runtimeExecutablePath: process.execPath,
        cliScriptPath: resolveCliScriptPath(process.argv[1]),
        userId: resolveUserId(process.getuid),
      }),
      { apiUrl, configPath },
    ),
};

export function resolveUserId(getUserId: (() => number) | undefined): number {
  return getUserId ? getUserId() : 0;
}

export function resolveCliScriptPath(value: string | undefined): string {
  return resolve(value ?? "hivemnd");
}
