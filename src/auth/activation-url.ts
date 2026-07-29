import { HivemndError } from "../errors.js";

export interface Activation {
  readonly apiUrl: string;
  readonly token: string;
}

export function parseActivationUrl(value: string): Activation {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error: unknown) {
    throw new HivemndError("ENROLLMENT_INVALID", "Invalid activation URL", {
      cause: error,
    });
  }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new HivemndError(
      "ENROLLMENT_INVALID",
      "Activation URL must use http or https",
    );
  }
  const token = url.searchParams.get("token")?.trim();
  if (!token) {
    throw new HivemndError(
      "ENROLLMENT_INVALID",
      "Activation URL is missing its one-time token",
    );
  }
  const segments = url.pathname.split("/").filter(Boolean);
  const action = segments.pop();
  if (action !== "enroll") {
    throw new HivemndError(
      "ENROLLMENT_INVALID",
      "Activation URL has an unsupported path",
    );
  }
  url.pathname = `/${segments.join("/")}`;
  url.search = "";
  url.hash = "";
  return { apiUrl: url.href.replace(/\/$/, ""), token };
}
