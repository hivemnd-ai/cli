import { HivemndError } from "../errors.js";
import { isWithinTenant, tenantBaseUrl } from "../tenant-url.js";

export function parseEnrollmentUrl(value: string, apiUrl: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error: unknown) {
    throw new HivemndError("ENROLLMENT_INVALID", "Invalid enrollment URL", {
      cause: error,
    });
  }
  if (!isWithinTenant(url, tenantBaseUrl(apiUrl))) {
    throw new HivemndError(
      "ENROLLMENT_INVALID",
      "Enrollment URL must belong to the configured Hivemnd instance",
    );
  }
  const token = url.searchParams.get("token");
  if (!token) {
    throw new HivemndError(
      "ENROLLMENT_INVALID",
      "Enrollment URL is missing its one-time token",
    );
  }
  return token;
}
