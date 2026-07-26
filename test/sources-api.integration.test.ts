import { createServer, type RequestListener, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { HttpApiClient } from "../src/api/http-api-client.js";

const sourceId = "00000000-0000-4000-8000-000000000001";
const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function serve(
  handler: RequestListener,
): Promise<{ server: Server; url: string }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanups.push(
    () => new Promise<void>((resolve) => server.close(() => resolve())),
  );
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Expected TCP server address");
  return { server, url: `http://127.0.0.1:${address.port}` };
}

describe("PostgreSQL source API adapter", () => {
  it("lists authorized sources and inspects a source schema with bearer authentication", async () => {
    const requests: Array<{
      path: string | undefined;
      authorization: string | undefined;
    }> = [];
    const { url } = await serve((request, response) => {
      requests.push({
        path: request.url,
        authorization: request.headers.authorization,
      });
      response.setHeader("content-type", "application/json");
      if (request.url === `/api/v1/sources/${sourceId}/schema`) {
        response.end(
          JSON.stringify({
            source: {
              id: sourceId,
              name: "Engineering database",
              adapter_kind: "postgresql_database",
            },
            schemas: [
              {
                name: "public",
                tables: [
                  {
                    name: "users",
                    columns: [
                      { name: "id", data_type: "uuid", nullable: false },
                      {
                        name: "display_name",
                        data_type: "character varying",
                        nullable: true,
                      },
                    ],
                  },
                ],
              },
            ],
          }),
        );
        return;
      }
      response.end(
        JSON.stringify({
          sources: [
            {
              id: sourceId,
              name: "Engineering database",
              adapter_kind: "postgresql_database",
              status: "active",
              actions: [
                { key: "inspect_schema", status: "available" },
                {
                  key: "execute_approved_read_query",
                  status: "disabled",
                },
              ],
            },
          ],
        }),
      );
    });
    const client = new HttpApiClient(url);

    await expect(client.listSources("source-token")).resolves.toEqual([
      {
        id: sourceId,
        name: "Engineering database",
        adapterKind: "postgresql_database",
        status: "active",
        actions: [
          { key: "inspect_schema", status: "available" },
          { key: "execute_approved_read_query", status: "disabled" },
        ],
      },
    ]);
    await expect(
      client.inspectSourceSchema("source-token", sourceId),
    ).resolves.toEqual({
      source: {
        id: sourceId,
        name: "Engineering database",
        adapterKind: "postgresql_database",
      },
      schemas: [
        {
          name: "public",
          tables: [
            {
              name: "users",
              columns: [
                { name: "id", dataType: "uuid", nullable: false },
                {
                  name: "display_name",
                  dataType: "character varying",
                  nullable: true,
                },
              ],
            },
          ],
        },
      ],
    });
    expect(requests).toEqual([
      {
        path: "/api/v1/sources",
        authorization: "Bearer source-token",
      },
      {
        path: `/api/v1/sources/${sourceId}/schema`,
        authorization: "Bearer source-token",
      },
    ]);
  });

  it("rejects unauthorized requests and strict invalid response schemas", async () => {
    const unauthorized = await serve((_request, response) => {
      response.statusCode = 401;
      response.end("{}");
    });
    const unauthorizedClient = new HttpApiClient(unauthorized.url);
    await expect(
      unauthorizedClient.listSources("revoked"),
    ).rejects.toMatchObject({ code: "HTTP_FAILED" });
    await expect(
      unauthorizedClient.inspectSourceSchema("revoked", sourceId),
    ).rejects.toMatchObject({ code: "HTTP_FAILED" });

    const invalidList = await serve((_request, response) =>
      response.end(
        JSON.stringify({
          sources: [
            {
              id: sourceId,
              name: "Database",
              adapter_kind: "postgresql_database",
              status: "active",
              actions: [],
              unexpected: true,
            },
          ],
        }),
      ),
    );
    await expect(
      new HttpApiClient(invalidList.url).listSources("token"),
    ).rejects.toMatchObject({ code: "SOURCES_INVALID" });

    const invalidSchema = await serve((_request, response) =>
      response.end(
        JSON.stringify({
          source: {
            id: sourceId,
            name: "Database",
            adapter_kind: "postgresql_database",
          },
          schemas: [
            {
              name: "public",
              tables: [
                {
                  name: "users",
                  columns: [{ name: "id", data_type: "uuid", nullable: "no" }],
                },
              ],
            },
          ],
        }),
      ),
    );
    await expect(
      new HttpApiClient(invalidSchema.url).inspectSourceSchema(
        "token",
        sourceId,
      ),
    ).rejects.toMatchObject({ code: "SOURCE_SCHEMA_INVALID" });
  });
});
