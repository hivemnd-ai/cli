import { parseEnrollmentUrl } from "../auth/enrollment-url.js";
import type { CliContext } from "../cli/context.js";
import { HivemndError } from "../errors.js";

export interface AuthenticationOptions {
  readonly token?: string;
  readonly enrollmentUrl?: string;
}

export async function authenticate(
  options: AuthenticationOptions,
  context: CliContext,
): Promise<void> {
  if (options.token && options.enrollmentUrl) {
    throw new HivemndError(
      "ENROLLMENT_INVALID",
      "Use either --token or --enrollment-url, not both",
    );
  }
  const { dependencies } = context;
  const resolved = await context.resolveConfigured();
  const config = resolved.config;
  const client = dependencies.apiClientFactory(config);
  const store = dependencies.tokenStoreFactory(config);
  let token = options.token ?? dependencies.environment.HIVEMND_TOKEN;
  let installationId: string | undefined;
  let installation = "token authentication";
  if (options.enrollmentUrl) {
    const enrollmentToken = parseEnrollmentUrl(
      options.enrollmentUrl,
      config.apiUrl,
    );
    const result = await client.exchangeEnrollment(enrollmentToken, {
      clientKind: "hivemnd_cli",
      platform: dependencies.clientPlatform,
      clientVersion: dependencies.clientVersion,
    });
    token = result.accessToken;
    installationId = result.installationId;
    installation = `installation ${result.installationId}`;
  }
  if (!token) {
    throw new HivemndError(
      "AUTH_MISSING",
      "Provide --token, --enrollment-url, or HIVEMND_TOKEN",
    );
  }
  await client.manifest(token);
  if (installationId) {
    await dependencies
      .configRepositoryFactory(dependencies.cwd)
      .create(resolved.configPath, { ...config, installationId }, true);
  }
  await store.save(token);
  dependencies.output.write(
    `authenticated: ${installation}; token stored in OS keychain`,
  );
}
