import { PassThrough, Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { McpHttpProxy, runStdioProxy } from "../src/mcp/proxy.js";

describe("MCP stdio proxy", () => {
  it("forwards JSON-RPC with a bearer token without writing diagnostics to stdout", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetcher: typeof fetch = async (input, init) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      requests.push({ url, ...(init ? { init } : {}) });
      return new Response(
        JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: [] } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    const input = new PassThrough();
    const output = new PassThrough();
    const diagnostics = new PassThrough();
    let stdout = "";
    let stderr = "";
    output.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    diagnostics
      .setEncoding("utf8")
      .on("data", (chunk: string) => (stderr += chunk));

    const running = runStdioProxy(
      new McpHttpProxy({
        apiUrl: "https://shared.hivemnd.cloud/eigen",
        token: "secret-token",
        fetcher,
      }),
      { input, output, diagnostics },
    );
    input.end('{"jsonrpc":"2.0","id":1,"method":"tools/list"}\n');
    await running;

    expect(JSON.parse(stdout.trim())).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: { tools: [] },
    });
    expect(stderr).toBe("");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://shared.hivemnd.cloud/eigen/mcp");
    expect(requests[0]?.init?.headers).toEqual({
      accept: "application/json",
      authorization: "Bearer secret-token",
      "content-type": "application/json",
    });
    expect(requests[0]?.init?.body).not.toContain("secret-token");
  });

  it("does not emit a response for notifications accepted without a body", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let stdout = "";
    output.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    const running = runStdioProxy(
      new McpHttpProxy({
        apiUrl: "https://shared.hivemnd.cloud/eigen",
        token: "secret-token",
        fetcher: async () => new Response(null, { status: 202 }),
      }),
      { input, output, diagnostics: new PassThrough() },
    );
    input.end('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    await running;
    expect(stdout).toBe("");
  });

  it("does not emit a JSON-RPC response when forwarding a notification fails", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const diagnostics = new PassThrough();
    let stdout = "";
    let stderr = "";
    output.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    diagnostics
      .setEncoding("utf8")
      .on("data", (chunk: string) => (stderr += chunk));
    const running = runStdioProxy(
      new McpHttpProxy({
        apiUrl: "https://shared.hivemnd.cloud/eigen",
        token: "secret-token",
        fetcher: async () => new Response(null, { status: 503 }),
      }),
      { input, output, diagnostics },
    );
    input.end('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    await running;
    expect(stdout).toBe("");
    expect(stderr).toContain("Hivemnd MCP request failed (503)");
  });

  it("returns protocol errors for malformed input and redacts remote response bodies from diagnostics", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const diagnostics = new PassThrough();
    let stdout = "";
    let stderr = "";
    output.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    diagnostics
      .setEncoding("utf8")
      .on("data", (chunk: string) => (stderr += chunk));
    const running = runStdioProxy(
      new McpHttpProxy({
        apiUrl: "https://shared.hivemnd.cloud/eigen",
        token: "secret-token",
        fetcher: async () =>
          new Response("sensitive remote content", { status: 502 }),
      }),
      { input, output, diagnostics },
    );
    input.end('not-json\n{"jsonrpc":"2.0","id":9,"method":"tools/list"}\n');
    await running;

    const messages = stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(messages[0]).toMatchObject({
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Parse error" },
    });
    expect(messages[1]).toMatchObject({
      jsonrpc: "2.0",
      id: 9,
      error: { code: -32000, message: "Hivemnd MCP request failed (502)" },
    });
    expect(stderr).toContain("Hivemnd MCP request failed (502)");
    expect(stderr).not.toContain("sensitive remote content");
    expect(stderr).not.toContain("secret-token");
  });

  it("forwards valid JSON-RPC tool errors even when HTTP carries an error status", async () => {
    const proxy = new McpHttpProxy({
      apiUrl: "https://shared.hivemnd.cloud/eigen",
      token: "secret-token",
      fetcher: async () =>
        new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: 7,
            result: {
              content: [{ type: "text", text: "stale_base: refresh first" }],
              isError: true,
            },
          }),
          { status: 409 },
        ),
    });
    await expect(
      proxy.forward({ jsonrpc: "2.0", id: 7, method: "tools/call" }),
    ).resolves.toMatchObject({
      jsonrpc: "2.0",
      id: 7,
      result: { isError: true },
    });
  });

  it("rejects blank lines and batches without leaking tokens", async () => {
    const proxy = new McpHttpProxy({
      apiUrl: "https://shared.hivemnd.cloud/eigen",
      token: "secret-token",
      fetcher: async () => new Response("[]", { status: 200 }),
    });
    await expect(proxy.forward([])).rejects.toThrow("JSON-RPC batches");
  });

  it("bounds remote response bodies and request duration", async () => {
    const oversized = new McpHttpProxy({
      apiUrl: "https://shared.hivemnd.cloud/eigen",
      token: "secret-token",
      maxResponseBytes: 8,
      fetcher: async () => new Response('{"too":"large"}', { status: 200 }),
    });
    await expect(
      oversized.forward({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    ).rejects.toMatchObject({ code: "MCP_REMOTE_INVALID" });

    const timedOut = new McpHttpProxy({
      apiUrl: "https://shared.hivemnd.cloud/eigen",
      token: "secret-token",
      timeoutMs: 5,
      fetcher: async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("aborted", "AbortError")),
          );
        }),
    });
    await expect(
      timedOut.forward({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    ).rejects.toMatchObject({ code: "MCP_REMOTE_FAILED" });
  });

  it("rejects an oversized stdio line without buffering it into a remote request", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    let stdout = "";
    let calls = 0;
    output.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    const running = runStdioProxy(
      new McpHttpProxy({
        apiUrl: "https://shared.hivemnd.cloud/eigen",
        token: "secret-token",
        fetcher: async () => {
          calls += 1;
          return new Response("{}", { status: 200 });
        },
      }),
      { input, output, diagnostics: new PassThrough() },
      { maxLineBytes: 16 },
    );
    input.end(`${"x".repeat(32)}\n`);
    await running;
    expect(calls).toBe(0);
    expect(JSON.parse(stdout)).toMatchObject({
      error: { code: -32600, message: "MCP message exceeds 16 bytes" },
    });
  });

  it("fails closed for missing credentials, non-object messages, transport failures, and invalid remote JSON-RPC", async () => {
    expect(
      () =>
        new McpHttpProxy({
          apiUrl: "https://shared.hivemnd.cloud/eigen",
          token: "   ",
        }),
    ).toThrow("authentication is missing");

    const proxy = new McpHttpProxy({
      apiUrl: "https://shared.hivemnd.cloud/eigen",
      token: "secret-token",
      fetcher: async () => {
        throw new Error("offline with sensitive details");
      },
    });
    await expect(proxy.forward("request")).rejects.toMatchObject({
      code: "MCP_PROTOCOL_INVALID",
    });
    await expect(
      proxy.forward({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    ).rejects.toMatchObject({
      code: "MCP_REMOTE_FAILED",
      message: "Hivemnd MCP request failed",
    });

    for (const response of [
      new Response("", { status: 401 }),
      new Response("{}", { status: 200 }),
      new Response("{}", { status: 500 }),
      new Response("not-json", { status: 200 }),
    ]) {
      const invalid = new McpHttpProxy({
        apiUrl: "https://shared.hivemnd.cloud/eigen",
        token: "secret-token",
        fetcher: async () => response,
      });
      await expect(
        invalid.forward({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      ).rejects.toBeDefined();
    }
  });

  it("accepts empty successful responses and rejects declared oversized responses before reading the body", async () => {
    const empty = new McpHttpProxy({
      apiUrl: "https://shared.hivemnd.cloud/eigen",
      token: "secret-token",
      fetcher: async () => new Response(null, { status: 200 }),
    });
    await expect(
      empty.forward({ jsonrpc: "2.0", id: 1, method: "ping" }),
    ).resolves.toBeUndefined();

    const declaredOversized = new McpHttpProxy({
      apiUrl: "https://shared.hivemnd.cloud/eigen",
      token: "secret-token",
      maxResponseBytes: 8,
      fetcher: async () =>
        new Response("too large", {
          headers: { "content-length": "9" },
        }),
    });
    await expect(
      declaredOversized.forward({ jsonrpc: "2.0", id: 1, method: "ping" }),
    ).rejects.toMatchObject({ code: "MCP_REMOTE_INVALID" });
  });

  it("keeps stdio framing bounded across chunks, EOF, blank lines, and invalid request ids", async () => {
    const output = new PassThrough();
    const diagnostics = new PassThrough();
    let stdout = "";
    let stderr = "";
    output.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    diagnostics
      .setEncoding("utf8")
      .on("data", (chunk: string) => (stderr += chunk));
    const proxy = new McpHttpProxy({
      apiUrl: "https://shared.hivemnd.cloud/eigen",
      token: "secret-token",
      fetcher: async () => {
        throw new Error("offline");
      },
    });
    await runStdioProxy(
      proxy,
      {
        input: Readable.from([
          "   \n",
          "x".repeat(25),
          `${"y".repeat(25)}\n`,
          '{"jsonrpc":"2.0","id":{},"method":"ping"}',
        ]),
        output,
        diagnostics,
      },
      { maxLineBytes: 48 },
    );
    expect(stdout.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(stdout)).toMatchObject({
      id: null,
      error: { code: -32600, message: "MCP message exceeds 48 bytes" },
    });
    expect(stderr).toContain("Hivemnd MCP request failed");

    const eofOutput = new PassThrough();
    let eofStdout = "";
    eofOutput
      .setEncoding("utf8")
      .on("data", (chunk: string) => (eofStdout += chunk));
    await runStdioProxy(
      new McpHttpProxy({
        apiUrl: "https://shared.hivemnd.cloud/eigen",
        token: "secret-token",
        fetcher: async () => new Response(null, { status: 204 }),
      }),
      {
        input: Readable.from(["z".repeat(17)]),
        output: eofOutput,
        diagnostics: new PassThrough(),
      },
      { maxLineBytes: 16 },
    );
    expect(JSON.parse(eofStdout)).toMatchObject({ error: { code: -32600 } });

    const noNewline = new PassThrough();
    let noNewlineOutput = "";
    noNewline
      .setEncoding("utf8")
      .on("data", (chunk: string) => (noNewlineOutput += chunk));
    await runStdioProxy(
      new McpHttpProxy({
        apiUrl: "https://shared.hivemnd.cloud/eigen",
        token: "secret-token",
        fetcher: async () => new Response(null, { status: 204 }),
      }),
      {
        input: Readable.from(['{"jsonrpc":"2.0","method":"ping"}']),
        output: noNewline,
        diagnostics: new PassThrough(),
      },
      { maxLineBytes: 100 },
    );
    expect(noNewlineOutput).toBe("");
  });

  it("uses the platform fetch default, accepts JSON-RPC errors, and bounds already-discarded chunks", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            jsonrpc: "2.0",
            id: null,
            error: { code: -32_000, message: "failed" },
          }),
        ),
    );
    vi.stubGlobal("fetch", fetcher);
    try {
      const proxy = new McpHttpProxy({
        apiUrl: "https://shared.hivemnd.cloud/eigen",
        token: "secret-token",
      });
      await expect(
        proxy.forward({ jsonrpc: "2.0", id: null, method: "ping" }),
      ).resolves.toMatchObject({ error: { code: -32_000 } });

      const output = new PassThrough();
      let stdout = "";
      output
        .setEncoding("utf8")
        .on("data", (chunk: string) => (stdout += chunk));
      const chunks = async function* () {
        yield "x".repeat(17);
        await Promise.resolve();
        yield "y".repeat(17);
        await Promise.resolve();
        yield "\n";
      };
      await runStdioProxy(
        proxy,
        {
          input: Readable.from(chunks()),
          output,
          diagnostics: new PassThrough(),
        },
        { maxLineBytes: 16 },
      );
      expect(JSON.parse(stdout)).toMatchObject({ error: { code: -32600 } });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("converts unexpected proxy failures to generic protocol failures", async () => {
    const output = new PassThrough();
    const diagnostics = new PassThrough();
    let stdout = "";
    let stderr = "";
    output.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    diagnostics
      .setEncoding("utf8")
      .on("data", (chunk: string) => (stderr += chunk));
    const proxy = new McpHttpProxy({
      apiUrl: "https://shared.hivemnd.cloud/eigen",
      token: "secret-token",
    });
    proxy.forward = async () => {
      throw new Error("unexpected sensitive error");
    };
    await runStdioProxy(proxy, {
      input: Readable.from([
        '{"jsonrpc":"2.0","id":"request","method":"ping"}\n',
      ]),
      output,
      diagnostics,
    });
    expect(JSON.parse(stdout)).toMatchObject({
      id: "request",
      error: { message: "Hivemnd MCP request failed" },
    });
    expect(stderr).not.toContain("unexpected sensitive error");
  });
});
