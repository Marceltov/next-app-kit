// The sign-in settings an app reads at start, all under its own prefix: what is refused, and what each setting becomes.
import { expect, test } from "vitest";
import { signInFromEnv, signInMethods } from "./accounts.js";

const quiet = () => {};
const opts = (prefix = "TEST") => ({ prefix, file: "/data/auth.sqlite", appName: "Test App", log: quiet });
const env = { TEST_SECRET: "s".repeat(40), PUBLIC_URL: "https://app.example/", TEST_ALLOWED_EMAILS: "A@b.c, @team.example" };

test("refusesDevUserInProductionAndNoWayIn", () => {
  expect(() => signInFromEnv({ ...env, TEST_DEV_USER: "dev", NODE_ENV: "production" }, opts())).toThrow(/TEST_DEV_USER/);
  expect(() => signInFromEnv(env, opts())).toThrow(/no way to sign in.*TEST_SMTP_URL/);
  expect(() => signInFromEnv({ ...env, TEST_OIDC_AUTHENTIK_CLIENT_ID: "x" }, opts())).toThrow(/TEST_OIDC_AUTHENTIK_ISSUER/);
  expect(() => signInFromEnv({ ...env, TEST_OIDC_GITHUB_CLIENT_ID: "x" }, opts())).toThrow(/TEST_OIDC_GITHUB_CLIENT_SECRET/);
  expect(() => signInFromEnv({ ...env, TEST_SMTP_URL: "smtp://m", PUBLIC_URL: "" }, opts())).toThrow(/PUBLIC_URL/);
});

test("missingSecretNamed", () => {
  const smtp = { TEST_SMTP_URL: "smtp://m", UPLOAD_SMTP_URL: "smtp://m" };
  expect(() => signInFromEnv({ ...env, ...smtp, TEST_SECRET: undefined }, opts())).toThrow(/^TEST_SECRET must be set/);
  expect(() => signInFromEnv({ ...env, ...smtp, TEST_SECRET: "short" }, opts())).toThrow(/^TEST_SECRET must be set/);
  // Another app's prefix names its own variable, and a secret under a different prefix doesn't count.
  expect(() => signInFromEnv({ ...env, ...smtp }, opts("UPLOAD"))).toThrow(/^UPLOAD_SECRET must be set/);
});

test("settingsFromEnv", () => {
  const logs: string[] = [];
  const s = signInFromEnv(
    { ...env, PORT: "4000", TEST_SMTP_URL: "smtp://mail.example", TEST_SMTP_FROM: "app@example.org", NOTICEBOX_OIDC_X_CLIENT_ID: "other app's" },
    { ...opts(), log: (l) => void logs.push(l) },
  );
  expect(s).toMatchObject({
    prefix: "TEST",
    appName: "Test App",
    baseUrl: "https://app.example",
    file: "/data/auth.sqlite",
    jwksUrl: "http://127.0.0.1:4000/api/auth/jwks",
    allowed: ["a@b.c", "@team.example"],
    providers: [],
    smtp: { url: "smtp://mail.example", from: "app@example.org" },
    devUser: null,
    passkey: { rpName: "Test App" },
  });
  expect(logs).toEqual([]);
  expect(signInMethods(s)).toEqual({ email: true, passkey: true, providers: [] });

  const defaults = signInFromEnv({ ...env, TEST_SMTP_URL: "smtp://m", TEST_ALLOWED_EMAILS: "" }, { ...opts(), log: (l) => void logs.push(l) });
  expect(defaults.smtp!.from).toBe("Test App <noreply@localhost>");
  expect(logs).toEqual(["warning: TEST_ALLOWED_EMAILS is empty, so nobody can sign in"]);
});

test("providersFromEnv", () => {
  const s = signInFromEnv(
    {
      ...env,
      TEST_OIDC_GITHUB_CLIENT_ID: "gh",
      TEST_OIDC_GITHUB_CLIENT_SECRET: "ghs",
      TEST_OIDC_APPLE_CLIENT_ID: "ap",
      TEST_OIDC_APPLE_CLIENT_SECRET: "aps",
      TEST_OIDC_AUTHENTIK_CLIENT_ID: "ak",
      TEST_OIDC_AUTHENTIK_CLIENT_SECRET: "aks",
      TEST_OIDC_AUTHENTIK_ISSUER: "https://auth.example/application/o/app/",
      TEST_OIDC_AUTHENTIK_LABEL: "Our login",
      TEST_OIDC_MY_IDP_CLIENT_ID: "m",
      TEST_OIDC_MY_IDP_ISSUER: "https://idp.example",
    },
    opts(),
  );
  expect(s.providers).toEqual([
    { id: "apple", label: "Apple", clientId: "ap", clientSecret: "aps", issuer: null },
    { id: "authentik", label: "Our login", clientId: "ak", clientSecret: "aks", issuer: "https://auth.example/application/o/app" },
    { id: "github", label: "GitHub", clientId: "gh", clientSecret: "ghs", issuer: null },
    { id: "my-idp", label: "My_idp", clientId: "m", clientSecret: "", issuer: "https://idp.example" },
  ]);
  expect(signInMethods(s).providers.map((p) => [p.id, p.builtIn])).toEqual([
    ["apple", true],
    ["authentik", false],
    ["github", true],
    ["my-idp", false],
  ]);
});

test("devUserForDevelopment", () => {
  const logs: string[] = [];
  const s = signInFromEnv({ TEST_DEV_USER: "dev@example.com" }, { ...opts(), log: (l) => void logs.push(l) });
  expect(s.baseUrl).toBe("http://localhost:3000");
  expect(s.devUser).toBe("dev@example.com");
  // Without a secret, a new one at every start.
  expect(s.secret.length).toBeGreaterThanOrEqual(32);
  expect(signInFromEnv({ TEST_DEV_USER: "dev@example.com" }, opts()).secret).not.toBe(s.secret);
  expect(logs).toEqual(['warning: TEST_DEV_USER is set, everyone reaching the app is "dev@example.com"']);
});
