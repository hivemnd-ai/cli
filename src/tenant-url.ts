export function tenantBaseUrl(value: string): URL {
  const url = new URL(value);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/`;
  url.search = "";
  url.hash = "";
  return url;
}

export function isWithinTenant(candidate: URL, base: URL): boolean {
  if (candidate.origin !== base.origin) return false;
  if (base.pathname === "/") return true;
  return (
    candidate.pathname === base.pathname.slice(0, -1) ||
    candidate.pathname.startsWith(base.pathname)
  );
}

export function resolveTenantUrl(path: string, base: URL): URL {
  return new URL(path, base);
}
