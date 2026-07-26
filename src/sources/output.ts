import type { SourceSchema, SourceSummary } from "../domain.js";

export function formatSourceList(
  sources: readonly SourceSummary[],
): readonly string[] {
  if (sources.length === 0) return ["No authorized sources."];

  return sources.map((source) => {
    const actions = source.actions
      .map((action) => `${action.key}:${action.status}`)
      .join(", ");
    return `${source.id} | ${source.name} | ${source.adapterKind} | ${source.status} | ${actions}`;
  });
}

export function formatSourceSchema(schema: SourceSchema): readonly string[] {
  const heading = [
    `source: ${schema.source.name} (${schema.source.id})`,
    `adapter: ${schema.source.adapterKind}`,
  ];
  if (schema.schemas.length === 0) {
    return [...heading, "No schema information is available."];
  }

  return [
    ...heading,
    ...schema.schemas.flatMap((namespace) => [
      `schema ${namespace.name}`,
      ...(namespace.tables.length === 0
        ? ["  No tables."]
        : namespace.tables.flatMap((table) => [
            `  table ${table.name}`,
            ...(table.columns.length === 0
              ? ["    No columns."]
              : table.columns.map(
                  (column) =>
                    `    ${column.name}: ${column.dataType}, ${column.nullable ? "nullable" : "required"}`,
                )),
          ])),
    ]),
  ];
}
