import { spawn } from "node:child_process";
import type { ResolvedToken, TokenStore } from "../domain.js";
import { HivemndError } from "../errors.js";
import { tenantBaseUrl } from "../tenant-url.js";

export interface Keychain {
  get(): Promise<string | undefined>;
  save(token: string): Promise<void>;
}

export function keychainAccount(apiUrl: string): string {
  return tenantBaseUrl(apiUrl).href;
}

export class MacOsKeychain implements Keychain {
  constructor(
    private readonly account: string,
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly execute: (
      file: string,
      args: readonly string[],
      input?: string,
    ) => Promise<{ stdout: string }> = runCommand,
  ) {}

  async get(): Promise<string | undefined> {
    this.ensureAvailable();
    try {
      const result = await this.execute("security", [
        "find-generic-password",
        "-a",
        this.account,
        "-s",
        "hivemnd-cli",
        "-w",
      ]);
      return result.stdout.trim() || undefined;
    } catch {
      return undefined;
    }
  }

  async save(token: string): Promise<void> {
    this.ensureAvailable();
    await this.execute("security", [
      "add-generic-password",
      "-U",
      "-a",
      this.account,
      "-s",
      "hivemnd-cli",
      "-w",
      token,
    ]);
  }

  available(): boolean {
    return this.platform === "darwin";
  }

  private ensureAvailable(): void {
    if (this.platform !== "darwin") {
      throw new HivemndError(
        "KEYCHAIN_UNAVAILABLE",
        "No supported OS keychain is available; use HIVEMND_TOKEN for this session",
      );
    }
  }
}

export function runCommand(
  file: string,
  args: readonly string[],
  input?: string,
): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, [...args], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout });
      else
        reject(
          new Error(
            stderr.trim() || `${file} exited with status ${String(code)}`,
          ),
        );
    });
    child.stdin.end(input);
  });
}

export class SecureTokenStore implements TokenStore {
  constructor(
    private readonly environment: NodeJS.ProcessEnv,
    private readonly keychain: Keychain,
  ) {}

  async get(): Promise<ResolvedToken | undefined> {
    const environmentToken = this.environment.HIVEMND_TOKEN?.trim();
    if (environmentToken)
      return { value: environmentToken, source: "environment" };
    const keychainToken = await this.keychain.get();
    return keychainToken
      ? { value: keychainToken, source: "keychain" }
      : undefined;
  }

  save(token: string): Promise<void> {
    if (!token.trim()) {
      throw new HivemndError("AUTH_MISSING", "The token cannot be empty");
    }
    return this.keychain.save(token);
  }

  supportsPersistentStorage(): boolean {
    return this.keychain instanceof MacOsKeychain && this.keychain.available();
  }
}
