import type { CliContext } from "../cli/context.js";
import { HivemndError } from "../errors.js";

export async function runDoctor(context: CliContext): Promise<void> {
  const { dependencies } = context;
  const config = await context.loadConfigured();
  dependencies.output.write("pass config");
  const adapters = dependencies.adapterFactory(config, []);
  if (adapters.length === 0) {
    throw new HivemndError(
      "CONFIG_INVALID",
      "No synchronization destinations are configured",
    );
  }
  for (const adapter of adapters) {
    try {
      await dependencies.targetAccess(adapter.root);
      dependencies.output.write(
        `pass destination ${adapter.name} (${adapter.kind}): ${adapter.root}`,
      );
    } catch (error: unknown) {
      throw new HivemndError(
        "CONFIG_INVALID",
        `Destination is not readable and writable: ${adapter.root}`,
        { cause: error },
      );
    }
  }
  const { token, client } = await context.bootstrap(config);
  dependencies.output.write(`pass credential (${token.source})`);
  const manifest = await client.manifest(token.value);
  dependencies.output.write(`pass API (release ${manifest.release.id})`);
}
