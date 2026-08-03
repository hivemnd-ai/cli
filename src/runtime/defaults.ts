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
import { ReadlinePrompter } from "../prompts/readline-prompter.js";
import type { HivemndConfig } from "../domain.js";
import {
  createScheduleManager,
  PeriodicSyncScheduler,
} from "../schedule/periodic-sync-scheduler.js";
import { DailyUpdateChecker } from "../update/daily-update-checker.js";
import type { RuntimeDependencies } from "./dependencies.js";
import { clientTechnicalFeatures } from "../client/runtime-contract.js";

const stateDirectory = process.env.HIVEMND_HOME ?? join(homedir(), ".hivemnd");
const clientVersion = "0.5.4";

export function createDefaultApiClient(config: HivemndConfig): HttpApiClient {
  return new HttpApiClient(config.apiUrl, fetch, undefined, {
    clientVersion,
    clientFeatures: clientTechnicalFeatures,
  });
}

export const defaultDependencies: RuntimeDependencies = {
  cwd: process.cwd(),
  homeDirectory: homedir(),
  runtimeExecutablePath: process.execPath,
  cliScriptPath: resolveCliScriptPath(process.argv[1]),
  environment: process.env,
  output: {
    write: (message) => {
      console.log(message);
    },
    error: (message) => {
      console.error(message);
    },
  },
  prompt: new ReadlinePrompter(process.stdin, process.stdout),
  readHookInput: readStandardInput,
  configRepositoryFactory: (cwd) => new ConfigRepository(cwd),
  tokenStoreFactory: (config) =>
    new SecureTokenStore(
      process.env,
      new MacOsKeychain(keychainAccount(config.apiUrl)),
    ),
  apiClientFactory: createDefaultApiClient,
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
  clientFeatures: clientTechnicalFeatures,
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

/* v8 ignore next 5 -- process-stdin composition is exercised by hosts, while injection parsing is integration-tested */
async function readStandardInput(): Promise<string> {
  const chunks: string[] = [];
  for await (const chunk of process.stdin) chunks.push(String(chunk));
  return chunks.join("");
}
