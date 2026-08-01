import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { z } from "zod";
import {
  agentKinds,
  destinationScopes,
  type DestinationConfig,
  type HivemndConfig,
} from "./domain.js";
import { HivemndError } from "./errors.js";

const configSchema = z.object({
  apiUrl: z
    .url()
    .refine((value) => ["http:", "https:"].includes(new URL(value).protocol), {
      message: "apiUrl must use http or https",
    }),
  destinations: z
    .array(
      z
        .object({
          id: z.uuid().optional(),
          name: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,62}$/),
          agent: z.enum(agentKinds),
          scope: z.enum(destinationScopes),
          path: z.string().min(1).optional(),
        })
        .superRefine((destination, context) => {
          if (destination.scope === "root" && destination.path !== undefined) {
            context.addIssue({
              code: "custom",
              message: "root destinations must not define path",
              path: ["path"],
            });
          }
          if (destination.scope !== "root" && destination.path === undefined) {
            context.addIssue({
              code: "custom",
              message: `${destination.scope} destinations require path`,
              path: ["path"],
            });
          }
          if (destination.path && !isAbsolute(destination.path)) {
            context.addIssue({
              code: "custom",
              message: "destination path must be absolute",
              path: ["path"],
            });
          }
        }),
    )
    .refine(
      (destinations) =>
        new Set(destinations.map(({ name }) => name)).size ===
        destinations.length,
      { message: "Destination names must be unique" },
    )
    .refine(
      (destinations) => {
        const ids = destinations.flatMap(({ id }) => (id ? [id] : []));
        return new Set(ids).size === ids.length;
      },
      { message: "Destination identifiers must be unique" },
    ),
});

export class ConfigRepository {
  constructor(private readonly cwd: string) {}

  async load(path: string): Promise<HivemndConfig> {
    try {
      const contents = await readFile(this.absolute(path), "utf8");
      const parsed = parseConfig(JSON.parse(contents) as unknown);
      return parsed.upgraded
        ? await this.upgradeLegacyDestinations(path)
        : parsed.config;
    } catch (error: unknown) {
      throw new HivemndError("CONFIG_INVALID", `Cannot load config: ${path}`, {
        cause: error,
      });
    }
  }

  async loadOptional(path: string): Promise<HivemndConfig | undefined> {
    try {
      const contents = await readFile(this.absolute(path), "utf8");
      const parsed = parseConfig(JSON.parse(contents) as unknown);
      return parsed.upgraded
        ? await this.upgradeLegacyDestinations(path)
        : parsed.config;
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === "ENOENT") return undefined;
      throw new HivemndError("CONFIG_INVALID", `Cannot load config: ${path}`, {
        cause: error,
      });
    }
  }

  async create(
    path: string,
    config: HivemndConfig,
    overwrite = false,
  ): Promise<void> {
    await this.write(path, parseConfig(config).config, overwrite);
  }

  private async write(
    path: string,
    config: HivemndConfig,
    overwrite: boolean,
  ): Promise<void> {
    const parsed = configSchema.parse(config);
    const destination = this.absolute(path);
    await mkdir(dirname(destination), { recursive: true });
    const temporary = `${destination}.hivemnd-${randomUUID()}.tmp`;
    try {
      if (!overwrite && (await exists(destination))) {
        throw new HivemndError(
          "CONFIG_EXISTS",
          `Config already exists: ${path}; pass --force to replace it`,
        );
      }
      await writeFile(temporary, `${JSON.stringify(parsed, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      await chmod(temporary, 0o600);
      await rename(temporary, destination);
      await chmod(destination, 0o600);
    } catch (error: unknown) {
      await rm(temporary, { force: true });
      throw error;
    }
  }

  async addDestination(
    path: string,
    destination: DestinationConfig,
  ): Promise<HivemndConfig> {
    const config = await this.load(path);
    const updated = parseConfig({
      ...config,
      destinations: [...config.destinations, destination],
    }).config;
    await this.write(path, updated, true);
    return updated;
  }

  async removeDestination(path: string, name: string): Promise<HivemndConfig> {
    const config = await this.load(path);
    if (!config.destinations.some((destination) => destination.name === name)) {
      throw new HivemndError("CONFIG_INVALID", `Unknown destination: ${name}`);
    }
    const updated = {
      ...config,
      destinations: config.destinations.filter(
        (destination) => destination.name !== name,
      ),
    };
    await this.create(path, updated, true);
    return updated;
  }

  private absolute(path: string): string {
    return isAbsolute(path) ? path : resolve(this.cwd, path);
  }

  private async upgradeLegacyDestinations(
    path: string,
  ): Promise<HivemndConfig> {
    const lock = `${this.absolute(path)}.hivemnd-upgrade.lock`;
    try {
      await mkdir(lock, { mode: 0o700 });
    } catch (error: unknown) {
      /* v8 ignore else -- EEXIST is the only actionable lock failure */
      if (isNodeError(error) && error.code === "EEXIST") {
        throw new HivemndError(
          "CONFIG_INVALID",
          "Another process is upgrading this Hivemnd configuration",
          { cause: error },
        );
      }
      /* v8 ignore next -- defensive propagation for unexpected OS lock failures */
      throw error;
    }
    try {
      const current = parseConfig(
        JSON.parse(await readFile(this.absolute(path), "utf8")) as unknown,
      );
      /* v8 ignore else -- another process cannot replace the config while this exclusive upgrade lock is held */
      if (current.upgraded) await this.write(path, current.config, true);
      return current.config;
    } finally {
      await rm(lock, { recursive: true, force: true });
    }
  }
}

function parseConfig(value: unknown): {
  readonly config: HivemndConfig;
  readonly upgraded: boolean;
} {
  const parsed = configSchema.parse(value);
  let upgraded = false;
  const destinations = parsed.destinations.map((destination) => {
    if (destination.id) return destination;
    upgraded = true;
    return { ...destination, id: randomUUID() };
  });
  return { config: { ...parsed, destinations }, upgraded };
}

export async function loadConfig(
  path: string,
  cwd: string,
): Promise<HivemndConfig> {
  return new ConfigRepository(cwd).load(path);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw error;
  }
}
