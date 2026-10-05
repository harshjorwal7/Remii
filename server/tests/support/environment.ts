/**
 * The minimum environment a deployment is allowed to boot with, for tests that need a config but are
 * not testing configuration itself.
 *
 * It lives in one place because the minimum is a moving target: Intelligence became mandatory and
 * five test files each carried their own copy of the environment, so every one of them started
 * failing for a reason that had nothing to do with what it was testing. Tests that assert on
 * configuration should keep building their environment inline; everything else should spread this.
 */
export function testEnvironment(
  overrides: Record<string, string | undefined> = {},
): Record<string, string | undefined> {
  return {
    DATABASE_URL: "postgres://remii:remii@localhost:5432/remii",
    KEY_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    /*
     * An identity provider to point at.
     *
     * Not a real one, and nothing in the suite connects to it: the tests that exercise auth build
     * their own `AuthService` and hand it to `createApp`, and the ones that exercise configuration
     * assert on what `loadConfig` reads. This is here so a test that only needs `config.auth` to
     * exist has one, and it will answer nothing if anything ever does call it.
     */
    NEON_AUTH_BASE_URL:
      "https://ep-example.neonauth.eu-west-2.aws.neon.tech/neondb/auth",
    // Required. See server/src/config.ts: there is no runtime without Intelligence.
    INTELLIGENCE_API_URL: "http://localhost:7100",
    INTELLIGENCE_GATEWAY_WS_URL: "ws://localhost:7103",
    INTELLIGENCE_API_KEY: "tenant-api-key",
    COPILOTKIT_LICENSE_TOKEN: "license-token",
    MANAGED_AGENT_AG_UI_URL: "http://localhost:4200/ag-ui",
    MANAGED_AGENT_TOKEN: "managed-agent-token",
    ...overrides,
  };
}
