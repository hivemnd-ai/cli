import type { Command } from "commander";
import type { CliContext } from "../cli/context.js";
import { formatSourceList, formatSourceSchema } from "../sources/output.js";

export function registerSourceCommands(
  program: Command,
  context: CliContext,
): void {
  const sources = program
    .command("sources")
    .description("inspect authorized company sources");
  sources
    .command("list")
    .description("list sources and effective actions")
    .action(async () => {
      const { token, client } = await context.bootstrap();
      const authorized = await client.listSources(token.value);
      for (const line of formatSourceList(authorized)) {
        context.dependencies.output.write(line);
      }
    });
  sources
    .command("inspect")
    .description("inspect the authorized schema of a PostgreSQL source")
    .argument("<source-id>", "source identifier")
    .action(async (sourceId: string) => {
      const { token, client } = await context.bootstrap();
      const schema = await client.inspectSourceSchema(token.value, sourceId);
      for (const line of formatSourceSchema(schema)) {
        context.dependencies.output.write(line);
      }
    });
}
