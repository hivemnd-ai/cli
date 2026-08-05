import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { HivemndError } from "../errors.js";

export interface PrivateJsonOutboxOptions<T> {
  readonly root: string;
  readonly parse: (value: unknown) => T;
  readonly identity: (value: T) => string;
  readonly compare: (left: T, right: T) => number;
  readonly maximumEntries: number;
  readonly maximumBytes: number;
}

export class PrivateJsonOutbox<T> {
  readonly root: string;

  constructor(private readonly options: PrivateJsonOutboxOptions<T>) {
    this.root = resolve(options.root);
  }

  async stage(value: T): Promise<void> {
    const parsed = this.options.parse(value);
    const body = Buffer.from(`${JSON.stringify(parsed)}\n`);
    await privateDirectory(this.root);
    await this.withLock(async () => {
      const pending = await this.entries();
      const existing = pending.find(
        (entry) =>
          this.options.identity(entry.value) === this.options.identity(parsed),
      );
      if (existing) {
        if (JSON.stringify(existing.value) === JSON.stringify(parsed)) return;
        throw new HivemndError(
          "INTEGRITY_FAILED",
          "Private outbox identity cannot be reused with different input",
        );
      }
      if (
        pending.length >= this.options.maximumEntries ||
        pending.reduce((sum, entry) => sum + entry.bytes, 0) + body.byteLength >
          this.options.maximumBytes
      ) {
        throw new HivemndError("SYNC_FAILED", "Private outbox is full");
      }
      const destination = join(
        this.root,
        `${this.options.identity(parsed)}.json`,
      );
      await atomicPrivateWrite(destination, body);
    });
  }

  async pending(): Promise<readonly T[]> {
    return (await this.entries()).map(({ value }) => value);
  }

  async drain(
    deliver: (value: T) => Promise<void>,
  ): Promise<{ readonly accepted: number; readonly pending: number }> {
    await privateDirectory(this.root);
    return this.withLock(async () => {
      const entries = await this.entries();
      let accepted = 0;
      for (const entry of entries) {
        try {
          await deliver(entry.value);
        } catch {
          return { accepted, pending: entries.length - accepted };
        }
        const acceptedPath = join(
          this.root,
          `.accepted-${this.options.identity(entry.value)}-${randomUUID()}.tmp`,
        );
        await rename(entry.path, acceptedPath);
        await rm(acceptedPath, { force: true });
        accepted += 1;
      }
      return { accepted, pending: 0 };
    });
  }

  private async entries(): Promise<
    readonly {
      readonly value: T;
      readonly path: string;
      readonly bytes: number;
    }[]
  > {
    let names: string[];
    try {
      names = (await readdir(this.root, { withFileTypes: true }))
        .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
        .map(({ name }) => name);
    } catch (error: unknown) {
      /* v8 ignore else -- only missing state is a normal empty outbox */
      if (isNodeError(error) && error.code === "ENOENT") return [];
      /* v8 ignore next -- unexpected directory read failures are propagated */
      throw error;
    }
    const entries = await Promise.all(
      names.map(async (name) => {
        const path = join(this.root, name);
        const content = await readFile(path);
        try {
          const value = this.options.parse(
            JSON.parse(content.toString("utf8")) as unknown,
          );
          if (name !== `${this.options.identity(value)}.json`)
            throw new Error();
          return { value, path, bytes: content.byteLength };
        } catch (error: unknown) {
          throw new HivemndError(
            "INTEGRITY_FAILED",
            "Private outbox contains invalid state",
            { cause: error },
          );
        }
      }),
    );
    return entries.sort((left, right) =>
      this.options.compare(left.value, right.value),
    );
  }

  private async withLock<TValue>(
    operation: () => Promise<TValue>,
  ): Promise<TValue> {
    const lock = join(this.root, ".stage.lock");
    for (let attempt = 0; attempt < 50; attempt += 1) {
      try {
        await mkdir(lock, { mode: 0o700 });
        try {
          return await operation();
        } finally {
          await rm(lock, { recursive: true, force: true });
        }
      } catch (error: unknown) {
        if (!isNodeError(error) || error.code !== "EEXIST") throw error;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
      }
    }
    throw new HivemndError("SYNC_FAILED", "Private outbox staging is busy");
  }
}

async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const metadata = await lstat(path);
  if (
    metadata.isSymbolicLink() ||
    !metadata.isDirectory() ||
    (metadata.mode & 0o077) !== 0
  ) {
    throw new HivemndError("PATH_UNSAFE", "Private outbox directory is unsafe");
  }
  await chmod(path, 0o700);
}

async function atomicPrivateWrite(
  path: string,
  content: Uint8Array,
): Promise<void> {
  await privateDirectory(dirname(path));
  const temporary = `${path}.hivemnd-${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { mode: 0o600, flag: "wx" });
    await chmod(temporary, 0o600);
    await rename(temporary, path);
    await chmod(path, 0o600);
    /* v8 ignore start -- cleanup after an injected atomic filesystem failure */
  } catch (error: unknown) {
    await rm(temporary, { force: true });
    throw error;
  }
  /* v8 ignore stop */
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
