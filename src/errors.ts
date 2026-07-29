export type ErrorCode =
  | "AUTH_MISSING"
  | "CONFIG_EXISTS"
  | "CONFIG_INVALID"
  | "CLIENT_UPDATE_REQUIRED"
  | "ENROLLMENT_INVALID"
  | "HTTP_FAILED"
  | "INTEGRITY_FAILED"
  | "INTERACTIVE_REQUIRED"
  | "KEYCHAIN_UNAVAILABLE"
  | "MANIFEST_EXPIRED"
  | "MANIFEST_INVALID"
  | "MCP_PROTOCOL_INVALID"
  | "MCP_REGISTRATION_CONFLICT"
  | "MCP_REGISTRATION_INVALID"
  | "MCP_REGISTRATION_UNSAFE"
  | "MCP_REMOTE_FAILED"
  | "MCP_REMOTE_INVALID"
  | "PATH_UNSAFE"
  | "SOURCES_INVALID"
  | "SOURCE_SCHEMA_INVALID"
  | "CLIENT_CONFIGURATION_INVALID"
  | "SCHEDULE_UNSUPPORTED"
  | "SYNC_CONFLICT"
  | "SYNC_FAILED";

export class HivemndError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "HivemndError";
  }
}

export function assertDefined<T>(
  value: T | undefined,
  message: string,
): asserts value is T {
  if (value === undefined) {
    throw new HivemndError("CONFIG_INVALID", message);
  }
}

export function asHivemndError(error: unknown): HivemndError {
  if (error instanceof HivemndError) return error;
  if (error instanceof Error) {
    return new HivemndError("SYNC_FAILED", error.message, { cause: error });
  }
  return new HivemndError("SYNC_FAILED", "Unknown error", { cause: error });
}
