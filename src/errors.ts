export type ErrorCode =
  | "AUTH_MISSING"
  | "CONFIG_EXISTS"
  | "CONFIG_INVALID"
  | "ENROLLMENT_INVALID"
  | "HTTP_FAILED"
  | "INTEGRITY_FAILED"
  | "KEYCHAIN_UNAVAILABLE"
  | "MANIFEST_EXPIRED"
  | "MANIFEST_INVALID"
  | "PATH_UNSAFE"
  | "SOURCES_INVALID"
  | "SOURCE_SCHEMA_INVALID"
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

export function asHivemndError(error: unknown): HivemndError {
  if (error instanceof HivemndError) return error;
  if (error instanceof Error) {
    return new HivemndError("SYNC_FAILED", error.message, { cause: error });
  }
  return new HivemndError("SYNC_FAILED", "Unknown error", { cause: error });
}
