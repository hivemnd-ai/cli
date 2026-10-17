import { parseEnrollmentUrl } from "../auth/enrollment-url.js";
import type { CliContext } from "../cli/context.js";
import { HivemndError } from "../errors.js";

export interface AuthenticationOptions {
  readonly token?: string;
  readonly enrollmentUrl?: string;
  readonly enrollmentStdin?: boolean;
}

export async function authenticate(
  options: AuthenticationOptions,
  context: CliContext,
): Promise<void> {
  const supplied = [
    options.token,
    options.enrollmentUrl,
    options.enrollmentStdin,
  ].filter(Boolean);
  if (supplied.length > 1) {
    throw new HivemndError(
      "ENROLLMENT_INVALID",
      "Use only one of --token, --enrollment-url, or --enrollment-stdin",
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
  let enrollmentUrl = options.enrollmentUrl;
  if (options.enrollmentStdin) {
    if (
      dependencies.authenticationInputIsTTY ||
      dependencies.prompt.interactive
    ) {
      throw new HivemndError(
        "INTERACTIVE_REQUIRED",
        "Run login without --enrollment-stdin to use the hidden activation prompt",
      );
    }
    if (!dependencies.readAuthenticationInput) {
      throw new HivemndError(
        "AUTH_MISSING",
        "Private authentication input is unavailable",
      );
    }
    enrollmentUrl = (await dependencies.readAuthenticationInput()).trim();
    token = undefined;
  } else if (
    !enrollmentUrl &&
    !token &&
    dependencies.prompt.interactive &&
    dependencies.prompt.secret
  ) {
    enrollmentUrl = await dependencies.prompt.secret("Activation URL");
  }
  if (enrollmentUrl) {
    const enrollmentToken = parseEnrollmentUrl(enrollmentUrl, config.apiUrl);
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
      "Run login interactively or provide --enrollment-stdin, --token, --enrollment-url, or HIVEMND_TOKEN",
    );
  }
  await client.clientConfiguration(token);
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
