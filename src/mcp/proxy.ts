import { StringDecoder } from "node:string_decoder";
import type { Readable, Writable } from "node:stream";
import { HivemndError } from "../errors.js";
import { resolveTenantUrl, tenantBaseUrl } from "../tenant-url.js";
import {
  clientRuntimeHeaders,
  type ClientRuntimeMetadata,
} from "../client/runtime-contract.js";

type JsonRpcId = string | number | null;
type JsonRpcMessage = Record<string, unknown>;

export interface McpHttpProxyOptions {
  readonly apiUrl: string;
  readonly token: string;
  readonly fetcher?: typeof fetch;
  readonly timeoutMs?: number;
  readonly maxResponseBytes?: number;
  readonly clientVersion?: string;
  readonly clientFeatures?: readonly string[];
}

export interface StdioProxyStreams {
  readonly input: Readable;
  readonly output: Writable;
  readonly diagnostics: Writable;
}

export interface StdioProxyLimits {
  readonly maxLineBytes?: number;
}

export class McpHttpProxy {
  private readonly endpoint: URL;
  private readonly fetcher: typeof fetch;
  private readonly token: string;
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;
  private readonly runtimeMetadata?: ClientRuntimeMetadata;

  constructor(options: McpHttpProxyOptions) {
    if (!options.token.trim()) {
      throw new HivemndError(
        "AUTH_MISSING",
        "Hivemnd authentication is missing",
      );
    }
    this.endpoint = resolveTenantUrl("mcp", tenantBaseUrl(options.apiUrl));
    this.token = options.token;
    this.fetcher = options.fetcher ?? fetch;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxResponseBytes = options.maxResponseBytes ?? 1_048_576;
    if (options.clientVersion || options.clientFeatures) {
      this.runtimeMetadata = {
        clientVersion: options.clientVersion ?? "",
        clientFeatures: options.clientFeatures ?? [],
      };
      clientRuntimeHeaders(this.runtimeMetadata);
    }
  }

  async forward(message: unknown): Promise<JsonRpcMessage | undefined> {
    if (Array.isArray(message)) {
      throw new HivemndError(
        "MCP_PROTOCOL_INVALID",
        "JSON-RPC batches are not supported",
      );
    }
    if (!isJsonObject(message)) {
      throw new HivemndError(
        "MCP_PROTOCOL_INVALID",
        "MCP input must be a JSON-RPC object",
      );
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, this.timeoutMs);
    timeout.unref();
    try {
      const response = await this.fetcher(this.endpoint, {
        method: "POST",
        headers: {
          accept: "application/json",
          authorization: `Bearer ${this.token}`,
          "content-type": "application/json",
          ...clientRuntimeHeaders(this.runtimeMetadata),
        },
        body: JSON.stringify(message),
        signal: controller.signal,
      });
      if (response.status === 202 || response.status === 204) return undefined;
      const body = await readLimitedBody(response, this.maxResponseBytes);
      if (!body.trim()) {
        if (response.ok) return undefined;
        throw remoteHttpError(response.status);
      }
      try {
        const parsed: unknown = JSON.parse(body);
        if (
          !isJsonObject(parsed) ||
          parsed.jsonrpc !== "2.0" ||
          !("result" in parsed || "error" in parsed)
        ) {
          if (!response.ok) throw remoteHttpError(response.status);
          throw new Error("not a JSON-RPC response");
        }
        return parsed;
      } catch (error: unknown) {
        if (error instanceof HivemndError) throw error;
        if (!response.ok) throw remoteHttpError(response.status);
        throw new HivemndError(
          "MCP_REMOTE_INVALID",
          "Hivemnd MCP returned an invalid JSON-RPC response",
          { cause: error },
        );
      }
    } catch (error: unknown) {
      if (error instanceof HivemndError) throw error;
      throw new HivemndError(
        "MCP_REMOTE_FAILED",
        controller.signal.aborted
          ? `Hivemnd MCP request timed out after ${String(this.timeoutMs)}ms`
          : "Hivemnd MCP request failed",
        { cause: error },
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}

export async function runStdioProxy(
  proxy: McpHttpProxy,
  streams: StdioProxyStreams,
  limits: StdioProxyLimits = {},
): Promise<void> {
  const maxLineBytes = limits.maxLineBytes ?? 1_048_576;
  for await (const framed of readBoundedLines(streams.input, maxLineBytes)) {
    if (framed.oversized) {
      writeJson(
        streams.output,
        protocolError(
          null,
          -32_600,
          `MCP message exceeds ${String(maxLineBytes)} bytes`,
        ),
      );
      continue;
    }
    const line = framed.line;
    if (!line.trim()) continue;
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      writeJson(streams.output, protocolError(null, -32_700, "Parse error"));
      continue;
    }
    try {
      const response = await proxy.forward(message);
      if (response && requestId(message) !== undefined) {
        writeJson(streams.output, response);
      }
    } catch (error: unknown) {
      const failure =
        error instanceof HivemndError
          ? error
          : new HivemndError("MCP_REMOTE_FAILED", "Hivemnd MCP request failed");
      streams.diagnostics.write(`[${failure.code}] ${failure.message}\n`);
      const id = requestId(message);
      if (id !== undefined) {
        writeJson(streams.output, protocolError(id, -32_000, failure.message));
      }
    }
  }
}

async function readLimitedBody(
  response: Response,
  maximumBytes: number,
): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximumBytes) {
    await response.body?.cancel();
    throw remoteTooLarge(maximumBytes);
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const result = await reader.read();
    if (result.done) break;
    size += result.value.byteLength;
    if (size > maximumBytes) {
      await reader.cancel();
      throw remoteTooLarge(maximumBytes);
    }
    chunks.push(result.value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(body);
}

function remoteTooLarge(maximumBytes: number): HivemndError {
  return new HivemndError(
    "MCP_REMOTE_INVALID",
    `Hivemnd MCP response exceeds ${String(maximumBytes)} bytes`,
  );
}

function remoteHttpError(status: number): HivemndError {
  return new HivemndError(
    status === 401 || status === 403 ? "AUTH_MISSING" : "MCP_REMOTE_FAILED",
    `Hivemnd MCP request failed (${String(status)})`,
  );
}

async function* readBoundedLines(
  input: Readable,
  maximumBytes: number,
): AsyncGenerator<{ readonly line: string; readonly oversized: boolean }> {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  let discarded = false;
  for await (const value of input) {
    pending += decoder.write(
      Buffer.isBuffer(value) ? value : Buffer.from(String(value)),
    );
    for (;;) {
      const newline = pending.indexOf("\n");
      if (newline === -1) {
        if (!discarded && Buffer.byteLength(pending) > maximumBytes) {
          discarded = true;
          pending = "";
        } else if (discarded) {
          pending = "";
        }
        break;
      }
      const segment = pending.slice(0, newline).replace(/\r$/, "");
      pending = pending.slice(newline + 1);
      const oversized = discarded || Buffer.byteLength(segment) > maximumBytes;
      yield { line: oversized ? "" : segment, oversized };
      discarded = false;
    }
  }
  pending += decoder.end();
  if (discarded) yield { line: "", oversized: true };
  else if (pending) {
    yield { line: pending, oversized: false };
  }
}

function writeJson(output: Writable, value: JsonRpcMessage): void {
  output.write(`${JSON.stringify(value)}\n`);
}

function protocolError(
  id: JsonRpcId,
  code: number,
  message: string,
): JsonRpcMessage {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function requestId(message: unknown): JsonRpcId | undefined {
  if (!isJsonObject(message) || !("id" in message)) return undefined;
  const id = message.id;
  return typeof id === "string" || typeof id === "number" || id === null
    ? id
    : undefined;
}

function isJsonObject(value: unknown): value is JsonRpcMessage {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
