import { describe, expect, spyOn, test } from "bun:test";
import { readFileSync } from "node:fs";
import { configuredAuthProviders, loadConfig } from "../src/config";

// Intelligence is part of the MINIMUM contract, so it belongs in the base environment every other
// case builds on. Leaving it out of the base would make most of this file assert the behaviour of a
// deployment that is not allowed to exist.
const baseEnvironment = {
  DATABASE_URL: "postgres://remii:remii@localhost:5432/remii",
  KEY_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  NEON_AUTH_BASE_URL:
    "https://ep-example.neonauth.eu-west-2.aws.neon.tech/neondb/auth",
  INTELLIGENCE_API_URL: "http://localhost:7100",
  INTELLIGENCE_GATEWAY_WS_URL: "ws://localhost:7103",
  INTELLIGENCE_API_KEY: "tenant-api-key",
  COPILOTKIT_LICENSE_TOKEN: "license-token",
  MANAGED_AGENT_AG_UI_URL: " http://localhost:4200/ag-ui ",
  MANAGED_AGENT_TOKEN: "managed-agent-token",
};

/**
 * The same deployment with nothing signing anybody in.
 *
 * `baseEnvironment` points at an identity provider because most tests want authentication on. The
 * tests below need the opposite starting point, or "no provider is configured" cannot be told apart
 * from "the provider is configured and its address is missing".
 */
const withoutSignIn = Object.fromEntries(
  Object.entries(baseEnvironment).filter(
    ([name]) =>
      name !== "NEON_AUTH_BASE_URL" && name !== "INITIAL_ADMIN_EMAILS",
  ),
);

/**
 * A deployment that is actually deployed.
 *
 * `baseEnvironment` carries the example encryption key, which is refused under
 * `NODE_ENV=production` — so a production case built on it fails on the key before it reaches
 * whatever it meant to test. A real key here keeps each production test about its own subject.
 */
const productionEnvironment = {
  ...baseEnvironment,
  NODE_ENV: "production",
  KEY_ENCRYPTION_KEY: "b3BlbmJvdC1wcm9kdWN0aW9uLXRlc3Qta2V5LTMyMzI=",
};

describe("deployment configuration", () => {
  test("resolves the local runtime, which is the only runtime", () => {
    const config = loadConfig(baseEnvironment);

    /*
     * `runtime` is now two fields and nothing else. It used to carry an `intelligence` object with
     * the cloud API url, the gateway socket, the tenant key and the licence token — the contract with
     * the hosted backend, which no longer exists. The INTELLIGENCE_* variables are still accepted and
     * IGNORED, so an env file written for the hosted backend still boots rather than failing on
     * settings nothing reads. See `runtimeCapabilities` in config.ts.
     */
    expect(config.runtime).toEqual({
      mode: "local",
      durableHistory: true,
    });
    expect(config.managedAgent).toEqual({
      endpoint: new URL("http://localhost:4200/ag-ui"),
      token: "managed-agent-token",
    });
    expect(config.tenantPackageDirectory).toBe("../examples/fintech");
  });

  test("allows deployment without an authentication provider, when asked to", () => {
    const config = loadConfig({
      DATABASE_URL: baseEnvironment.DATABASE_URL,
      KEY_ENCRYPTION_KEY: baseEnvironment.KEY_ENCRYPTION_KEY,
      INTELLIGENCE_API_URL: baseEnvironment.INTELLIGENCE_API_URL,
      INTELLIGENCE_GATEWAY_WS_URL: baseEnvironment.INTELLIGENCE_GATEWAY_WS_URL,
      INTELLIGENCE_API_KEY: baseEnvironment.INTELLIGENCE_API_KEY,
      MANAGED_AGENT_AG_UI_URL: baseEnvironment.MANAGED_AGENT_AG_UI_URL,
      MANAGED_AGENT_TOKEN: baseEnvironment.MANAGED_AGENT_TOKEN,
      // Explicit, because no provider means every visitor is the administrator and a deployment has
      // to say it meant that. See single-user.test.ts.
      REMII_SINGLE_USER: "true",
    });

    expect(config.auth).toBeUndefined();
  });

  /*
   * The INTELLIGENCE_* variables are INERT.
   *
   * Three tests used to assert each one's absence refused to boot, and a fourth asserted that a
   * deployment with none of them refused too — because the hosted backend they configured was
   * mandatory. It is not any more: the runtime is local, `RuntimeCapabilities` has no field for
   * them, and `loadConfig` ignores what it finds.
   *
   * The behaviour worth pinning is therefore the opposite of what it was: an env file carried over
   * from the hosted backend boots, and boots IDENTICALLY with and without the variables. A deployment
   * that has quietly kept them set should get the same server, not a warning and not a failure.
   */
  test.each([
    "INTELLIGENCE_API_URL",
    "INTELLIGENCE_GATEWAY_WS_URL",
    "INTELLIGENCE_API_KEY",
  ])("ignores %s, which nothing reads any more", (name) => {
    const environment: Record<string, string | undefined> = {
      ...baseEnvironment,
    };
    delete environment[name];

    const config = loadConfig(environment);
    expect(config.runtime).toEqual({ mode: "local", durableHistory: true });
  });

  test("boots with no INTELLIGENCE_* variables at all", () => {
    const config = loadConfig({
      DATABASE_URL: baseEnvironment.DATABASE_URL,
      KEY_ENCRYPTION_KEY: baseEnvironment.KEY_ENCRYPTION_KEY,
      MANAGED_AGENT_AG_UI_URL: baseEnvironment.MANAGED_AGENT_AG_UI_URL,
      MANAGED_AGENT_TOKEN: baseEnvironment.MANAGED_AGENT_TOKEN,
      REMII_SINGLE_USER: "true",
    });

    expect(config.runtime).toEqual({ mode: "local", durableHistory: true });
  });

  test("leaves no trace of the licence token on the config", () => {
    // It used to be forwarded as `runtime.intelligence.licenseToken`. There is nowhere left to put
    // it, and the assertion is that the projection cannot grow one back by accident.
    const config = loadConfig({
      ...baseEnvironment,
      COPILOTKIT_LICENSE_TOKEN: "self-hosted-licence",
    });

    expect(config.runtime).toEqual({ mode: "local", durableHistory: true });
    expect(JSON.stringify(config)).not.toContain("self-hosted-licence");
  });

  test("starts without a managed Bot when neither half is set", () => {
    const environment: Record<string, string | undefined> = {
      ...baseEnvironment,
    };
    delete environment.MANAGED_AGENT_AG_UI_URL;
    delete environment.MANAGED_AGENT_TOKEN;

    expect(loadConfig(environment).managedAgent).toBeUndefined();
  });

  test("refuses a URL with no token", () => {
    const environment: Record<string, string | undefined> = {
      ...baseEnvironment,
    };
    delete environment.MANAGED_AGENT_TOKEN;

    expect(() => loadConfig(environment)).toThrow(
      "MANAGED_AGENT_TOKEN must be set when MANAGED_AGENT_AG_UI_URL is set",
    );
  });

  test("ignores a leftover token when no URL is set", () => {
    const environment: Record<string, string | undefined> = {
      ...baseEnvironment,
    };
    delete environment.MANAGED_AGENT_AG_UI_URL;

    expect(loadConfig(environment).managedAgent).toBeUndefined();
  });

  test("refuses a non-HTTP MANAGED_AGENT_AG_UI_URL", () => {
    expect(() =>
      loadConfig({
        ...baseEnvironment,
        MANAGED_AGENT_AG_UI_URL: "ftp://localhost:4200/ag-ui",
      }),
    ).toThrow("MANAGED_AGENT_AG_UI_URL");
  });

  test("requires a base64-encoded 32-byte key-encryption key", () => {
    expect(() =>
      loadConfig({
        ...baseEnvironment,
        KEY_ENCRYPTION_KEY: "local-development-key",
      }),
    ).toThrow("KEY_ENCRYPTION_KEY must be a base64-encoded 32-byte key");
  });

  /*
   * The key in `.env.example`, refused on a deployed server.
   *
   * It is a valid key — right length, right encoding — so nothing else about it fails a check. A
   * deployment that never changed it encrypts its credential vault with a value printed in a public
   * repository and looks exactly like one that did, which is why this refusal is the only thing
   * standing between "copied the example file" and that outcome.
   */
  test("refuses the example encryption key on a production deployment", () => {
    expect(() =>
      loadConfig({
        ...baseEnvironment,
        NODE_ENV: "production",
      }),
    ).toThrow("KEY_ENCRYPTION_KEY is still the example key");
  });

  /*
   * The same trim the private-hosts gate below already gets, on the gate that matters more.
   *
   * Both sides of the comparison come out of one env file, and a trailing space there is invisible:
   * Docker's `env_file` preserves it verbatim and so does every hosting dashboard with a text box.
   * Compared raw, `NODE_ENV="production "` downgraded this refusal to a warning nobody reads at boot
   * and started the deployment on the public key.
   */
  test("refuses the example key when NODE_ENV carries whitespace", () => {
    expect(() =>
      loadConfig({
        ...baseEnvironment,
        NODE_ENV: "production ",
      }),
    ).toThrow("KEY_ENCRYPTION_KEY is still the example key");
  });

  // The local workflow is the reason the example key is usable at all, so off production it still
  // does exactly what it did: warns, and starts.
  test.each(["development", undefined])(
    "warns about the example key and still starts under NODE_ENV=%p",
    (nodeEnv) => {
      const consoleWarn = spyOn(console, "warn").mockImplementation(() => {});

      try {
        expect(() =>
          loadConfig({
            ...baseEnvironment,
            ...(nodeEnv ? { NODE_ENV: nodeEnv } : {}),
          }),
        ).not.toThrow();

        const warning = consoleWarn.mock.calls
          .map(([first]) => String(first))
          .find((line) => line.includes("KEY_ENCRYPTION_KEY"));

        expect(warning).toBeDefined();
        expect(warning).toContain("which is public");
      } finally {
        consoleWarn.mockRestore();
      }
    },
  );

  test("points at the identity provider, and carries nothing but its address", () => {
    const config = loadConfig(baseEnvironment);

    expect(config.auth).toEqual({
      neonAuthUrl:
        "https://ep-example.neonauth.eu-west-2.aws.neon.tech/neondb/auth",
      // The address the provider is told the caller is. Localhost, because the sign-in screen is
      // served from the app's dev port and it is that origin the provider checks.
      origin: "http://localhost:3010",
      // What the buttons are drawn from. `index.ts` replaces this with the branch's own provider
      // configuration at start-up unless this deployment named a list itself; this is the fallback for
      // a branch whose configuration cannot be read, and a branch with google configured is ordinary.
      socialProviders: ["google"],
      // False here, which is what lets the branch's own list win at start-up.
      socialProvidersOverridden: false,
    });
  });

  test("strips a trailing slash off the provider address", () => {
    const config = loadConfig({
      ...baseEnvironment,
      NEON_AUTH_BASE_URL:
        "https://ep-example.neonauth.eu-west-2.aws.neon.tech/neondb/auth/",
    });

    expect(config.auth?.neonAuthUrl).toBe(
      "https://ep-example.neonauth.eu-west-2.aws.neon.tech/neondb/auth",
    );
  });

  /**
   * The provider address has to be https, and it is the provider's cookie that says why.
   *
   * Neon's session cookie is `__Secure-` prefixed, and a browser refuses a `__Secure-` cookie that did
   * not come over TLS. A plain-HTTP address would therefore produce a sign-in that appears to work and
   * leaves no session — the failure a person discovers as "I signed in and it asked me again".
   */
  test("refuses a provider address that is not https", () => {
    expect(() =>
      loadConfig({
        ...baseEnvironment,
        NEON_AUTH_BASE_URL: "http://localhost:3001",
      }),
    ).toThrow("NEON_AUTH_BASE_URL must be an https:// address");
  });

  test("refuses a password form with no provider to accept it", () => {
    expect(() =>
      loadConfig({ ...withoutSignIn, AUTH_EMAIL_PASSWORD: "true" }),
    ).toThrow("NEON_AUTH_BASE_URL is not");
  });

  test("reports no email password form unless the deployment asked for one", () => {
    expect(loadConfig(baseEnvironment).auth?.emailPassword).toBeUndefined();
    expect(
      loadConfig({ ...baseEnvironment, AUTH_EMAIL_PASSWORD: "true" }).auth
        ?.emailPassword,
    ).toBe(true);
  });

  /**
   * The provider's own list of providers, or an override for a branch that has none.
   *
   * The list here is a fallback rather than the answer — `index.ts` reads the branch's
   * configuration at start-up and writes it back onto this. `NEON_AUTH_PROVIDERS` exists for the one
   * case where the fallback would be a lie, which is a branch with no provider configured at all.
   */
  test("takes the button list from the environment when it is given one", () => {
    expect(
      configuredAuthProviders(
        loadConfig({ ...baseEnvironment, NEON_AUTH_PROVIDERS: "google,github" })
          .auth,
      ),
    ).toEqual(["google", "github"]);
  });

  /**
   * `none` draws no social buttons, which is a setting rather than a trick.
   *
   * A social sign-in through the proxy does not finish — Google redirects to the provider's host and
   * this origin never sees the cookie — so a deployment that has not settled that should offer email
   * and password only. Asserted here because the alternative is a button that returns a person to the
   * same screen, which reads as a rejected account rather than as an unfinished feature.
   */
  test("draws no social buttons when asked for none", () => {
    // WITH `AUTH_EMAIL_PASSWORD` ALSO SET, because "no social buttons" is a deployment that still has
    // a way in. On its own it is a deployment with no provider at all, and `loadConfig` refuses to
    // start one — which is correct and is what the next test says.
    const config = loadConfig({
      ...baseEnvironment,
      NEON_AUTH_PROVIDERS: "none",
      AUTH_EMAIL_PASSWORD: "true",
    });

    expect(configuredAuthProviders(config.auth)).toEqual([]);
    expect(config.auth?.emailPassword).toBe(true);
    // And that the choice is marked as one, because `index.ts` reads the branch's own provider list
    // at start-up and writes it back over this. Without the flag an explicit `none` is
    // indistinguishable from a default, and the setting silently does nothing.
    expect(config.auth?.socialProvidersOverridden).toBe(true);
  });

  test("says when the provider list was not overridden", () => {
    // The other half of the same flag: unset means the branch's own list wins, which is the ordinary
    // case and the one that keeps the buttons matching what the provider accepts.
    expect(loadConfig(baseEnvironment).auth?.socialProvidersOverridden).toBe(
      false,
    );
  });

  test("no social buttons and no form is a deployment with no way in, and refuses", () => {
    expect(() =>
      loadConfig({ ...baseEnvironment, NEON_AUTH_PROVIDERS: "none" }),
    ).toThrow("No identity provider is configured");
  });

  test("drops a provider the identity provider does not admit", () => {
    // Silently rather than by refusal: a typo in this variable should not stop a deployment that is
    // otherwise fine, and the branch's own configuration overrides the whole list anyway.
    expect(
      configuredAuthProviders(
        loadConfig({
          ...baseEnvironment,
          NEON_AUTH_PROVIDERS: "google,microsoft,okta",
        }).auth,
      ),
    ).toEqual(["google"]);
  });

  /** What a deployment with no provider has to say before it is allowed to come up. */
  const OPEN = { REMII_SINGLE_USER: "true" };

  /**
   * Somebody has to be an administrator.
   *
   * The role is written from this list and no route anywhere changes one, so a deployment that
   * configures sign-in without it admits everybody as a plain user and can never promote anyone.
   * Start-up is the only cheap moment to notice.
   */
  test("refuses to start with an administrator list, because there are none", () => {
    /*
     * WAS ignored with a warning, which is what made this test say a deployment with the variable set
     * booted the same as one without it. That was true then and is not now: this deployment refuses.
     *
     * The reason to change is the difference between the two behaviours. A warning is invisible to a
     * deployment that is not reading logs, and the setting it warns about grants one address power
     * over every other user's data — so a setting that looks live and does nothing is worse than one
     * that refuses. There is no administrator role for the list to have named.
     */
    expect(() =>
      loadConfig({
        ...baseEnvironment,
        INITIAL_ADMIN_EMAILS: "admin@remii.test",
      }),
    ).toThrow("INITIAL_ADMIN_EMAILS");
  });

  test("boots when the administrator list is absent, and still has none", () => {
    const config = loadConfig(baseEnvironment);
    expect(config.auth).toBeDefined();
    expect(JSON.stringify(config.auth)).not.toContain("initialAdminEmails");
  });

  test("asks for no administrator when nothing signs anybody in", () => {
    // No list to write, and no one to write it for: the single-user mode has exactly one caller and
    // it is sovereign, so requiring an administrator name here would mean naming something that does
    // not exist.
    expect(() => loadConfig({ ...withoutSignIn, ...OPEN })).not.toThrow();
  });

  /**
   * No provider, and nobody saying that was meant.
   *
   * The refusal is not in `authConfig` and never was — it is `singleUserEnabled`, which is what
   * decides between running as one fixed person and refusing. A deployment with no provider and no
   * `REMII_SINGLE_USER` used to come up and serve every visitor as that one person whenever
   * `NODE_ENV` was unset, which is the default on exactly the bare-VM deployment it was meant to
   * catch. So this still throws, and the test says which line.
   */
  test("refuses to start with no provider and nothing saying that was meant", () => {
    expect(() => loadConfig(withoutSignIn)).toThrow(
      "No identity provider is configured",
    );
  });

  test("is off, and lists nothing, when no provider is configured", () => {
    const config = loadConfig({ ...withoutSignIn, ...OPEN });

    expect(config.auth).toBeUndefined();
    expect(configuredAuthProviders(config.auth)).toEqual([]);
  });

  // A turn that is ended is a turn somebody loses, so an unset variable leaves every stream alone
  // rather than acquiring a timeout the deployment never asked for. `.env.example` ships a value.
  test("leaves the stall watchdog off when nothing is configured", () => {
    expect(loadConfig(baseEnvironment).agentStallTimeoutMs).toBe(0);
  });

  test("takes a timeout in milliseconds, and zero as switching it off", () => {
    expect(
      loadConfig({ ...baseEnvironment, AGENT_STALL_TIMEOUT_MS: "120000" })
        .agentStallTimeoutMs,
    ).toBe(120_000);
    expect(
      loadConfig({ ...baseEnvironment, AGENT_STALL_TIMEOUT_MS: "0" })
        .agentStallTimeoutMs,
    ).toBe(0);
  });

  // Refused rather than defaulted, for the same reason a malformed policy is: an operator who meant
  // to write a boundary and mistyped it would otherwise get a deployment enforcing something else.
  test.each(["two minutes", "-1", "1.5"])(
    "refuses to start on AGENT_STALL_TIMEOUT_MS=%p",
    (value) => {
      expect(() =>
        loadConfig({ ...baseEnvironment, AGENT_STALL_TIMEOUT_MS: value }),
      ).toThrow("AGENT_STALL_TIMEOUT_MS");
    },
  );

  /*
   * AND THE EMPTY STRING IS NOT ONE OF THEM, which is why it is not a row of the list above.
   *
   * It rode along in that `test.each` behind an `if` that returned early, so the generated case was
   * named "refuses to start on AGENT_STALL_TIMEOUT_MS=\"\"" over a body asserting that it STARTS.
   * A reader picking a failure out of a run would have been told the opposite of what was checked,
   * and either half could have been changed to agree with the other — a config that began refusing
   * an empty value would have gone on passing under a name that said it should.
   *
   * OFF RATHER THAN REFUSED IS THE BEHAVIOUR, and it is the same one `PORT` has for the same
   * reason: `optional` trims and coerces empty to undefined, so an unset variable declared in a
   * compose file or left as `AGENT_STALL_TIMEOUT_MS=` in a `.env` arrives here as absent, which it
   * is. Refusing it would fail a deployment for writing down the default.
   */
  test("reads an empty AGENT_STALL_TIMEOUT_MS as the absent one, and starts", () => {
    expect(
      loadConfig({ ...baseEnvironment, AGENT_STALL_TIMEOUT_MS: "" })
        .agentStallTimeoutMs,
    ).toBe(0);
    expect(
      loadConfig({ ...baseEnvironment, AGENT_STALL_TIMEOUT_MS: "   " })
        .agentStallTimeoutMs,
    ).toBe(0);
  });

  test("listens on 3001 when neither PORT nor SERVER_PORT is set", () => {
    expect(loadConfig(baseEnvironment).port).toBe(3001);
  });

  test("moves the server by either name", () => {
    expect(loadConfig({ ...baseEnvironment, PORT: "3005" }).port).toBe(3005);
    expect(loadConfig({ ...baseEnvironment, SERVER_PORT: "3005" }).port).toBe(
      3005,
    );
    expect(
      loadConfig({ ...baseEnvironment, PORT: " 3005 ", SERVER_PORT: "3005" })
        .port,
    ).toBe(3005);
  });

  /*
   * An unset variable declared in a compose file, or left as `PORT=` in a `.env`, arrives as an
   * empty string rather than as absent. `process.env.PORT ?? process.env.SERVER_PORT` saw the empty
   * string and never reached the second name, and `Number.parseInt("")` handed `Bun.serve` a NaN,
   * which it answers by binding an ephemeral port nobody asked for.
   */
  test("reads SERVER_PORT when PORT is declared but empty, and the other way round", () => {
    expect(
      loadConfig({ ...baseEnvironment, PORT: "", SERVER_PORT: "3005" }).port,
    ).toBe(3005);
    expect(
      loadConfig({ ...baseEnvironment, PORT: "3005", SERVER_PORT: "" }).port,
    ).toBe(3005);
    expect(
      loadConfig({ ...baseEnvironment, PORT: "", SERVER_PORT: "" }).port,
    ).toBe(3001);
  });

  test("refuses to start when PORT and SERVER_PORT disagree", () => {
    expect(() =>
      loadConfig({ ...baseEnvironment, PORT: "3001", SERVER_PORT: "3005" }),
    ).toThrow("PORT (3001) and SERVER_PORT (3005) disagree");
  });

  // `Number.parseInt("30o1")` is 30, and the server used to come up there. Refused instead, the way
  // a mistyped cap is: a port has to fail at start-up, where somebody is looking.
  test.each(["30o1", "three", "0", "65536", "1.5", "-1"])(
    "refuses to start on PORT=%p",
    (value) => {
      expect(() => loadConfig({ ...baseEnvironment, PORT: value })).toThrow(
        "PORT must be a whole number between 1 and 65535",
      );
      expect(() =>
        loadConfig({ ...baseEnvironment, SERVER_PORT: value }),
      ).toThrow("SERVER_PORT must be a whole number between 1 and 65535");
    },
  );

  test("configures Docker as the per-Bot computer provider", () => {
    const config = loadConfig({
      ...baseEnvironment,
      COMPUTER_SUPERVISOR_URL: "http://localhost:4000",
      SUPERVISOR_TOKEN: "supervisor-token",
      COMPUTER_TOKEN: "computer-token",
    });

    expect(config.computer?.provider).toBe("docker");
    expect(config.computer).toEqual({
      provider: "docker",
      baseUrl: "http://localhost:4000",
      supervisorToken: "supervisor-token",
      token: "computer-token",
      allowPrivateHosts: false,
    });
  });

  /*
   * A shared computer is REFUSED, and the refusal is the behaviour worth pinning.
   *
   * This used to assert that `AGENT_COMPUTER_URL` produced a `provider: "shared"` computer, which was
   * true while the provider existed. Strict per-user sandboxing then removed the provider: one machine
   * means one /workspace, one shell and one browser process for every user, so one person's files and
   * logins are another person's. The variable is now refused at boot rather than half-honoured, and
   * `createComputerProvider` is never handed a `SharedComputerConfig` at all.
   *
   * What matters is that the refusal happens BEFORE anything starts and that it names the three ways
   * out, because the person reading it is looking at an env file they inherited and does not
   * necessarily know which line is the problem.
   */
  test("refuses a shared computer, and names the three ways out", () => {
    const attempt = () =>
      loadConfig({
        ...baseEnvironment,
        AGENT_COMPUTER_URL: "http://localhost:4100",
        COMPUTER_TOKEN: "computer-token",
      });

    expect(attempt).toThrow("AGENT_COMPUTER_URL");
    // The three supported providers, so the message is actionable rather than just a refusal.
    expect(attempt).toThrow("E2B_API_KEY");
    expect(attempt).toThrow("COMPUTER_SUPERVISOR_URL");
    expect(attempt).toThrow("COMPUTER_SANDBOX_NAMESPACE");
  });

  test("leaves computers off when no provider address is configured", () => {
    expect(loadConfig(baseEnvironment).computer).toBeUndefined();
  });

  // `.env.example` used to ship AGENT_COMPUTER_ALLOW_PRIVATE_HOSTS=true, and copying that file is the
  // ordinary way a deployment gets its environment. So the way a hosted deployment ends up reaching
  // its own network is not forgetting to set something, it is inheriting something. Refused in
  // production for the same reason the example encryption key is: convenient locally, and an opening
  // anywhere else.
  /*
   * E2B throughout this block rather than the shared computer these cases used to name.
   *
   * `privateHostsAllowed()` is read before any provider is chosen, so the switch means the same thing
   * to every provider, and these cases are about the switch. They used to reach it through
   * `AGENT_COMPUTER_URL`, which no longer configures anything.
   */
  const privateHostsDeployment = {
    ...baseEnvironment,
    E2B_API_KEY: "e2b-key",
    COMPUTER_TOKEN: "computer-token",
  };

  test("refuses to start when a production deployment allows private hosts", () => {
    expect(() =>
      loadConfig({
        ...productionEnvironment,
        E2B_API_KEY: "e2b-key",
        AGENT_COMPUTER_ALLOW_PRIVATE_HOSTS: "true",
      }),
    ).toThrow("AGENT_COMPUTER_ALLOW_PRIVATE_HOSTS");
  });

  // Both sides of the comparison come out of the same env file, and the switch is read through
  // `optional`, which trims. Comparing NODE_ENV raw would mean a trailing space typed into that file
  // slipped past the refusal while the switch beside it still counted as set.
  test("refuses a production deployment whose NODE_ENV carries whitespace", () => {
    expect(() =>
      loadConfig({
        ...productionEnvironment,
        NODE_ENV: "production ",
        E2B_API_KEY: "e2b-key",
        AGENT_COMPUTER_ALLOW_PRIVATE_HOSTS: "true",
      }),
    ).toThrow("AGENT_COMPUTER_ALLOW_PRIVATE_HOSTS");
  });

  // The refusal has to name the way out, because the person reading it at boot is looking at a file
  // they copied and does not necessarily know which line is the problem.
  test("says to remove the line, and that it is local only", () => {
    const attempt = () =>
      loadConfig({
        ...productionEnvironment,
        E2B_API_KEY: "e2b-key",
        AGENT_COMPUTER_ALLOW_PRIVATE_HOSTS: "true",
      });

    expect(attempt).toThrow("local development only");
    expect(attempt).toThrow("Remove it");
  });

  // The half of the matrix that was always right and has to stay right: absent means off, including
  // in the environment where the new refusal lives.
  test("starts in production when nothing asked for private hosts", () => {
    const config = loadConfig({ ...privateHostsDeployment });

    expect(config.computer?.allowPrivateHosts).toBe(false);
  });

  // The local workflow is the reason the flag exists, so outside production it still does exactly
  // what it did. Warned about, because a laptop is where a deployment is configured and the warning
  // is the only chance to say this line does not travel.
  test.each(["development", undefined])(
    "warns and still allows private hosts under NODE_ENV=%p",
    (nodeEnv) => {
      const consoleWarn = spyOn(console, "warn").mockImplementation(() => {});

      try {
        const config = loadConfig({
          ...baseEnvironment,
          ...(nodeEnv ? { NODE_ENV: nodeEnv } : {}),
          E2B_API_KEY: "e2b-key",
          AGENT_COMPUTER_ALLOW_PRIVATE_HOSTS: "true",
        });

        expect(config.computer?.allowPrivateHosts).toBe(true);
        // Searched rather than indexed: `baseEnvironment` carries the example encryption key, which
        // warns on its own account first.
        const warning = consoleWarn.mock.calls
          .map(([first]) => String(first))
          .find((line) => line.includes("AGENT_COMPUTER_ALLOW_PRIVATE_HOSTS"));

        expect(warning).toBeDefined();
        expect(warning).toContain("local development only");
        expect(warning).toContain("Remove it before deploying");
      } finally {
        consoleWarn.mockRestore();
      }
    },
  );

  // The refusal above only helps a deployment that reads it. The reason there was anything to refuse
  // is that the file everybody copies arrived with the switch on, so the file is worth asserting
  // about directly: a live line here is the regression, whatever the code does afterwards.
  test("the shipped example does not turn private hosts on", () => {
    const example = readFileSync(
      new URL("../../.env.example", import.meta.url),
      "utf8",
    );

    // Commented-out mentions are wanted — that is how the switch stays discoverable for a laptop.
    const live = example
      .split("\n")
      .filter((line) =>
        /^\s*AGENT_COMPUTER_ALLOW_PRIVATE_HOSTS\s*=/.test(line),
      );

    expect(live).toEqual([]);
  });

  /**
   * The shipped example carries no live identity-provider line.
   *
   * The same argument as above, for sign-in. Copying `.env.example` is the ordinary way a deployment
   * gets its environment, and every line that is not commented out is one that deployment has now
   * claimed. A live `NEON_AUTH_BASE_URL` here would point a fresh clone at somebody else's provider;
   * a live `GOOGLE_OAUTH_CLIENT_ID` or `BETTER_AUTH_SECRET` would be a credential-shaped line for a
   * mechanism that no longer exists.
   *
   * Commented mentions are wanted — that is how the provider stays discoverable. What is refused is a
   * line that would be read.
   */
  test("the shipped example configures no identity provider by itself", () => {
    const example = readFileSync(
      new URL("../../.env.example", import.meta.url),
      "utf8",
    );

    const live = example
      .split("\n")
      .filter((line) =>
        /^\s*(NEON_AUTH_BASE_URL|GOOGLE_OAUTH_CLIENT_ID|GOOGLE_OAUTH_CLIENT_SECRET|MICROSOFT_OAUTH_CLIENT_ID|MICROSOFT_OAUTH_CLIENT_SECRET|MICROSOFT_OAUTH_TENANT_ID|OKTA_OAUTH_CLIENT_ID|OKTA_OAUTH_CLIENT_SECRET|OKTA_OAUTH_ISSUER|BETTER_AUTH_SECRET|BETTER_AUTH_URL|INITIAL_ADMIN_EMAILS)\s*=/.test(
          line,
        ),
      );

    expect(live).toEqual([]);
  });

  // Anything that is not the exact opt-in is not an opt-in, so it is not the thing being refused
  // either. A deployment that wrote something else has private hosts off and starts.
  test.each(["false", "1", "yes", ""])(
    "starts in production on AGENT_COMPUTER_ALLOW_PRIVATE_HOSTS=%p",
    (value) => {
      const config = loadConfig({
        ...productionEnvironment,
        E2B_API_KEY: "e2b-key",
        AGENT_COMPUTER_ALLOW_PRIVATE_HOSTS: value,
      });

      expect(config.computer?.allowPrivateHosts).toBe(false);
    },
  );

  /*
   * Only the providers that exist. `AGENT_COMPUTER_URL` used to be the second row here; the variable
   * is refused now rather than parsed into a provider, and the refusal above covers it.
   */
  test.each([["Docker", "COMPUTER_SUPERVISOR_URL"]] as const)(
    "refuses an invalid %s computer provider URL",
    (_, urlName) => {
      expect(() =>
        loadConfig({
          ...baseEnvironment,
          [urlName]: "not a URL",
        }),
      ).toThrow(`${urlName} must be a valid URL`);
    },
  );
});

describe("accessibility", () => {
  test("is on when nothing is set", () => {
    expect(loadConfig(baseEnvironment).accessibility).toBe(true);
  });

  test.each(["true", "1"])(
    "is off on REMII_ACCESSIBILITY_DISABLED=%p",
    (value) => {
      expect(
        loadConfig({
          ...baseEnvironment,
          REMII_ACCESSIBILITY_DISABLED: value,
        }).accessibility,
      ).toBe(false);
    },
  );

  // Anything else is not a way of saying off. A deployment that typed something
  // else has not opted out, and silently treating it as opt-out would be a
  // setting that appears to work and does not.
  test.each(["false", "no", "", "yes"])(
    "stays on for REMII_ACCESSIBILITY_DISABLED=%p",
    (value) => {
      expect(
        loadConfig({
          ...baseEnvironment,
          REMII_ACCESSIBILITY_DISABLED: value,
        }).accessibility,
      ).toBe(true);
    },
  );
});

/**
 * Whether a Bot may answer with an interface it wrote itself.
 *
 * Same shape as accessibility above, and tested to the same bar for the same reason: the off switch
 * has a second reader. It is projected on /api/capabilities so the browser stops offering the tool
 * too, so a value that silently failed to mean "off" would leave Bots generating interfaces nothing
 * renders rather than merely leaving a capability on.
 */
describe("generated interfaces", () => {
  test("are on when nothing is set", () => {
    expect(loadConfig(baseEnvironment).generativeUi).toBe(true);
  });

  test.each(["true", "1"])("stay on for REMII_GENERATIVE_UI=%p", (value) => {
    expect(
      loadConfig({ ...baseEnvironment, REMII_GENERATIVE_UI: value })
        .generativeUi,
    ).toBe(true);
  });

  test.each(["false", "0"])("are off for REMII_GENERATIVE_UI=%p", (value) => {
    expect(
      loadConfig({ ...baseEnvironment, REMII_GENERATIVE_UI: value })
        .generativeUi,
    ).toBe(false);
  });

  test.each(["no", "", "yes", "TRUE", "on"])(
    "stay on for REMII_GENERATIVE_UI=%p",
    (value) => {
      expect(
        loadConfig({ ...baseEnvironment, REMII_GENERATIVE_UI: value })
          .generativeUi,
      ).toBe(true);
    },
  );

  // The old spelling was a disable switch. It must not still work, or a deployment that set it
  // would read as having made a choice it has not made under the new name.
  test("ignore the disable switch this replaced", () => {
    expect(
      loadConfig({
        ...baseEnvironment,
        REMII_GENERATIVE_UI_DISABLED: "false",
      }).generativeUi,
    ).toBe(true);
  });
});

/**
 * The names every deployment already has on disk.
 *
 * `OPENBOT_*` was renamed to `REMII_*`, and a rename that read only the new name would leave every
 * existing deployment running on built-in defaults without saying so: `REMII_GENERATIVE_UI` unset
 * means the setting is ON whatever `.env` asked for. These tests are the only thing standing between
 * that silent reset and a deployment that believes it configured something it did not.
 */
describe("the pre-rebrand setting names", () => {
  test("still switch a setting off, under the old name", () => {
    expect(
      loadConfig({ ...baseEnvironment, OPENBOT_GENERATIVE_UI: "false" })
        .generativeUi,
    ).toBe(false);
  });

  test("are read when the new name is absent", () => {
    expect(
      loadConfig({ ...baseEnvironment, OPENBOT_ACCESSIBILITY_DISABLED: "true" })
        .accessibility,
    ).toBe(false);
  });

  test("lose to the new name when both are set", () => {
    /*
     * The order is the point. A deployment adding `REMII_*` beside its existing `OPENBOT_*` has to
     * be able to change its mind, and a fallback that won over the current name would make the
     * first rename a one-way door.
     */
    expect(
      loadConfig({
        ...baseEnvironment,
        OPENBOT_GENERATIVE_UI: "false",
        REMII_GENERATIVE_UI: "true",
      }).generativeUi,
    ).toBe(true);
    expect(
      loadConfig({
        ...baseEnvironment,
        OPENBOT_GENERATIVE_UI: "true",
        REMII_GENERATIVE_UI: "false",
      }).generativeUi,
    ).toBe(false);
  });

  test("count as unset when they are present and empty", () => {
    // `REMII_FOO=` is a deployment that has not chosen, not one that has chosen the old name's value.
    expect(
      loadConfig({
        ...baseEnvironment,
        REMII_GENERATIVE_UI: "",
        OPENBOT_GENERATIVE_UI: "",
      }).generativeUi,
    ).toBe(true);
  });
});

/**
 * A cap is a safety number, so a value that is not one has to stop the deployment rather than be
 * quietly replaced by the default. Somebody who typed `two` would otherwise believe they had set a
 * cap, and find out at the first loop.
 */
describe("how far a Bot may hand work on", () => {
  test("defaults to two levels and three per run", () => {
    /*
     * WAS "defaults to one level". At one, the only delegation that worked was a single hop: a chief of
     * staff handed to a specialist, and the second hop came back "this is already 1 Bot deep" — so a
     * researcher who was supposed to deliver a report to a mail owner could not. The wiring was correct
     * and the arithmetic stopped it, which reads from the conversation as the supervisor not supervising.
     *
     * Two is the smallest value that lets a report be gathered by one Bot and delivered by another. It
     * is still a hard bound — it is also what stops A asks B asks C asks A.
     */
    const config = loadConfig({ ...baseEnvironment });
    expect(config.handoff).toEqual({ maxDepth: 2, maxPerRun: 3 });
  });

  test("a deployment can widen or switch it off", () => {
    expect(
      loadConfig({
        ...baseEnvironment,
        BOT_HANDOFF_MAX_DEPTH: "0",
        BOT_HANDOFF_MAX_PER_RUN: "10",
      }).handoff,
    ).toEqual({ maxDepth: 0, maxPerRun: 10 });
  });

  test("refuses a cap that is not a whole number", () => {
    expect(() =>
      loadConfig({ ...baseEnvironment, BOT_HANDOFF_MAX_DEPTH: "two" }),
    ).toThrow("BOT_HANDOFF_MAX_DEPTH");
    expect(() =>
      loadConfig({ ...baseEnvironment, BOT_HANDOFF_MAX_PER_RUN: "-1" }),
    ).toThrow("BOT_HANDOFF_MAX_PER_RUN");
    expect(() =>
      loadConfig({ ...baseEnvironment, BOT_HANDOFF_MAX_PER_RUN: "1.5" }),
    ).toThrow("BOT_HANDOFF_MAX_PER_RUN");
  });
});

/**
 * How big one Daytona computer is, which is a money question and therefore not left to a snapshot.
 *
 * The default is 2 vCPU and 2GiB because that is what a desktop with a browser on it actually uses,
 * and because the memory comes out of an organization-wide pool every other person on the
 * deployment shares. The number this used to get was the snapshot's own — `daytona-large` at 8GiB —
 * so the second computer in the account failed on memory and the error named nobody.
 */
/**
 * The hosted desktop on E2B: what a deployment configures, and what it gets when it configures nothing.
 *
 * There is no size here, and that is worth a test. Daytona's size was a decision this repository had to
 * make and could get wrong: an unset number was not "no memory" but "whatever the snapshot has", which
 * was 8GiB out of an organization-wide pool that every computer then competed for. E2B sizes a sandbox
 * from its template, so there is no vCPU or memory variable to get wrong and none is invented here.
 *
 * What IS a decision, and is asserted here, is the template, the volume, the mount path and the idle
 * window — the four things that change what a person gets when they open their computer.
 */
describe("the hosted E2B desktop", () => {
  const e2b = {
    ...baseEnvironment,
    E2B_API_KEY: "e2b-key",
    COMPUTER_TOKEN: "computer-token",
  };

  test("is selected by the presence of an E2B key, and nothing else", () => {
    expect(loadConfig(e2b).computer).toMatchObject({ provider: "e2b" });
    // No key means no computer, rather than a computer that cannot be reached.
    expect(loadConfig(baseEnvironment).computer).toBeUndefined();
  });

  test("builds from the built-in desktop template", () => {
    /*
     * `desktop` is E2B's own, and it is the only thing that makes a screen exist: Xvfb, XFCE, x11vnc,
     * noVNC, xdotool, scrot, ffmpeg, Chrome and Python all come from it. Verified against the live API.
     *
     * Worth noting because the account this was built on reports `GET /templates -> []`, which reads
     * like "no desktop template is available". There is no CUSTOM template; the built-in is not listed
     * by that endpoint and does not need to be.
     */
    expect(loadConfig(e2b).computer).toMatchObject({ template: "desktop" });
  });

  test("a deployment can name a different template", () => {
    expect(
      loadConfig({ ...e2b, E2B_TEMPLATE: "our-desktop" }).computer,
    ).toMatchObject({
      template: "our-desktop",
    });
    // Empty falls back rather than producing a create call for a template named "".
    expect(loadConfig({ ...e2b, E2B_TEMPLATE: "  " }).computer).toMatchObject({
      template: "desktop",
    });
  });

  test("puts each person's files on their own volume by default", () => {
    // ONE volume per person, and this is where the platforms differ: Daytona mounted one shared volume
    // at a per-user subpath and relied on the FUSE mount being scoped to that prefix. E2B mounts a
    // volume whole, so a shared volume would put every person's desktop on one directory.
    expect(loadConfig(e2b).computer).toMatchObject({
      volumes: true,
      workspaceMountPath: "/workspace",
    });
  });

  test("can turn the volume off, and saying so has to be spelled out", () => {
    // `false` and unset are DIFFERENT DECISIONS — one means "no persistence beyond the machine" — so
    // only the explicit string turns it off. Anything else, including a typo, stays on: losing files is
    // the worse of the two failures.
    expect(loadConfig({ ...e2b, E2B_VOLUMES: "false" }).computer).toMatchObject(
      {
        volumes: false,
      },
    );
    for (const value of ["", "true", "0", "no", "FALSE"]) {
      expect(loadConfig({ ...e2b, E2B_VOLUMES: value }).computer).toMatchObject(
        {
          volumes: true,
        },
      );
    }
  });

  test("can move where the volume appears", () => {
    // It has to match what a tool's relative paths resolve against, which is why the two live in one
    // place in the code; this is the operator's way to disagree with that.
    expect(
      loadConfig({ ...e2b, E2B_WORKSPACE_MOUNT: "/data" }).computer,
    ).toMatchObject({ workspaceMountPath: "/data" });
  });

  test("pauses after ten idle minutes by default", () => {
    /*
     * Ten, where Daytona defaulted to seven. The window got LONGER because a pause is no longer a
     * cold boot: Daytona's stop was a one-to-two-minute VM boot, so a short window was necessary to
     * stop the bill. An E2B memory pause restores the desktop as it was and returns in seconds, so a
     * person who stepped away for ten minutes comes back to their windows instead of waiting.
     */
    expect(loadConfig(e2b).computer).toMatchObject({ autoStopMinutes: 10 });
  });

  test("can keep a desktop always on, and zero is the way to say it", () => {
    expect(
      loadConfig({ ...e2b, E2B_AUTOSTOP_MINUTES: "0" }).computer,
    ).toMatchObject({
      autoStopMinutes: 0,
    });
  });

  test("refuses an idle window that is not a number of minutes", () => {
    // Refused at boot rather than coerced. A typo that became 0 would read as "keep every desktop on
    // forever", which is the expensive direction to be wrong in and says nothing in a log.
    expect(() => loadConfig({ ...e2b, E2B_AUTOSTOP_MINUTES: "ten" })).toThrow(
      "E2B_AUTOSTOP_MINUTES",
    );
    expect(() => loadConfig({ ...e2b, E2B_AUTOSTOP_MINUTES: "-5" })).toThrow(
      "E2B_AUTOSTOP_MINUTES",
    );
  });

  test("no longer carries any of Daytona's sizing variables", () => {
    /*
     * Asserted rather than assumed, because a leftover `DAYTONA_VCPU` in a deployment's environment is
     * silently ignored by the new code — there is no longer a size for it to set — and the honest
     * outcome is that it stops being read at all rather than half-honoured.
     */
    const config = loadConfig({
      ...e2b,
      DAYTONA_VCPU: "8",
      DAYTONA_MEMORY_GB: "32",
    });
    expect(config.computer).not.toHaveProperty("vcpu");
    expect(config.computer).not.toHaveProperty("memoryGb");
    // And Daytona itself is no longer a provider that can be selected at all.
    expect(
      () =>
        loadConfig({
          ...baseEnvironment,
          DAYTONA_API_URL: "https://app.daytona.io/api",
          DAYTONA_API_KEY: "dtn_key",
        }).computer?.provider,
    ).not.toBe("daytona");
  });
});

/**
 * Composio, which a deployment either bought or did not.
 *
 * Unset is the ordinary state and not a degraded one, so the absence has to read as `undefined`
 * rather than as an empty string that later code would have to keep asking about. Trimmed like
 * every other secret here, because a key pasted into a hosting dashboard arrives with whatever
 * whitespace came with it and the vendor would refuse the padded copy.
 */
test("a Composio key is read when set and absent when not", () => {
  expect(loadConfig(baseEnvironment).composioApiKey).toBeUndefined();
  expect(
    loadConfig({ ...baseEnvironment, COMPOSIO_API_KEY: "  ak_example  " })
      .composioApiKey,
  ).toBe("ak_example");
});
