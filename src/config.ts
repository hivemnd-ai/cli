import { mkdir, readFile, writeFile } from "node:fs/promises";
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
    ),
});

export class ConfigRepository {
  constructor(private readonly cwd: string) {}

  async load(path: string): Promise<HivemndConfig> {
    try {
      const contents = await readFile(this.absolute(path), "utf8");
      return configSchema.parse(JSON.parse(contents) as unknown);
    } catch (error: unknown) {
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
    const parsed = configSchema.parse(config);
    const destination = this.absolute(path);
    await mkdir(dirname(destination), { recursive: true });
    try {
      await writeFile(destination, `${JSON.stringify(parsed, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flag: overwrite ? "w" : "wx",
      });
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === "EEXIST") {
        throw new HivemndError(
          "CONFIG_EXISTS",
          `Config already exists: ${path}; pass --force to replace it`,
        );
      }
      throw error;
    }
  }

  async addDestination(
    path: string,
    destination: DestinationConfig,
  ): Promise<HivemndConfig> {
    const config = await this.load(path);
    const updated = configSchema.parse({
      ...config,
      destinations: [...config.destinations, destination],
    });
    await this.create(path, updated, true);
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
