// Sign-in end to end, over HTTP as a browser and claude.ai do it: email codes and links, the allowlist, the verified address every person is
// named by, linking a second provider, a provider's refusal, passkeys, and an MCP client's OAuth dance down to its token. Better Auth runs
// for real over an auth.sqlite in the test's temporary DATA_DIR; only the mail is caught, and the OIDC providers are stand-ins served by
// the same test server.
import { createHash, randomBytes } from "node:crypto";
import { afterAll, beforeAll, expect, test } from "vitest";
import { emailAllowed, openAuth, safeNext, type Auth } from "./accounts.js";
import { personOf } from "./person.js";
import { clientNameFor, refusedSignIn } from "./routes.js";
import { API_TOKEN_PREFIX, TEXTS, cookieOf, json, sendCode, signIn, startHarness, startProvider, viaProvider, type Harness } from "./testing.js";

let h: Harness;
const ALLOWED = ["ada@example.com", "marcel@example.com", "leaver@example.com", "@team.example"];

beforeAll(async () => {
  h = await startHarness(ALLOWED);
});

afterAll(async () => {
  await h.close();
});

const location = (r: Response) => new URL(r.headers.get("location")!, h.base);

test("onlyVerifiedAllowedAddressSignsIn", async () => {
  expect(emailAllowed(["ada@example.com", "@team.example"], " Ada@Example.com ")).toBe(true);
  expect(emailAllowed(["@team.example"], "x@team.example")).toBe(true);
  expect(emailAllowed(["@team.example"], "x@evilteam.example")).toBe(false);
  expect(emailAllowed([], "ada@example.com")).toBe(false);

  const signed = await signIn(h, "ada@example.com");
  expect(signed.status).toBe(200);
  const person = await personOf(new Headers({ cookie: cookieOf(signed) }), h.auth);
  expect(person?.email).toBe("ada@example.com");

  // Nobody else even gets a mail.
  expect(await sendCode(h, "eve@example.com")).toBeUndefined();
  expect((await signIn(h, "eve@example.com")).ok).toBe(false);
  const eve = await viaProvider(h, "fake", { sub: "u-eve", email: "eve@example.com", email_verified: true });
  expect(location(eve).searchParams.get("error")).toBe("email_not_allowed");
  expect(cookieOf(eve)).not.toContain("session_token=");
  // A provider that doesn't vouch for the address gets nobody in, even an allowed one; the sign-in page is told why.
  const unverified = await viaProvider(h, "fake", { sub: "u-bob", email: "bob@team.example", email_verified: false });
  const back = location(unverified);
  expect(back.pathname).toBe("/login");
  expect(back.searchParams.get("error")).toBe("email_not_verified");
  expect(back.searchParams.get("provider")).toBe("fake");
  expect(cookieOf(unverified)).not.toContain("session_token=");
  // The log says why, and names neither address.
  expect(h.logs.some((l) => l.includes("TEST_ALLOWED_EMAILS"))).toBe(true);
  expect(h.logs.join("\n")).not.toMatch(/eve@|bob@/);
});

test("browserMailHoldsLinkThatSignsInOnce", async () => {
  const sent = await sendCode(
    h,
    "ada@example.com",
    {},
    { referer: `${h.base}/login?next=${encodeURIComponent("/prints/7")}`, "accept-language": "de-DE,de;q=0.9" },
  );
  expect(sent!.language).toBe("de");
  const link = new URL(sent!.link!);
  expect(link.origin + link.pathname).toBe(`${h.base}/api/auth/magic-link/verify`);
  expect(link.searchParams.get("callbackURL")).toBe("/prints/7");

  const opened = await fetch(link, { redirect: "manual" });
  expect(opened.status).toBe(302);
  expect(opened.headers.get("location")).toBe(`${h.base}/prints/7`);
  expect((await personOf(new Headers({ cookie: cookieOf(opened) }), h.auth))?.email).toBe("ada@example.com");
  const again = await fetch(link, { redirect: "manual" });
  expect(cookieOf(again)).not.toContain("session_token=");

  // A link can't lead off the instance; an unknown language falls back to the first the app has.
  const off = await sendCode(h, "ada@example.com", {}, { referer: `${h.base}/login?next=//evil.example`, "accept-language": "fr" });
  expect(new URL(off!.link!).searchParams.get("callbackURL")).toBe("/");
  expect(off!.language).toBe("en");
  expect(safeNext("/\\evil")).toBe("/");
  expect(safeNext(42)).toBe("/");
});

test("otpStoredHashed", async () => {
  const sent = await sendCode(h, "ada@example.com");
  const token = new URL(sent!.link!).searchParams.get("token")!;
  const ctx = await h.auth.$context;
  const rows = (await ctx.adapter.findMany({ model: "verification" })) as { identifier: string; value: string }[];
  expect(rows.length).toBeGreaterThan(0);
  for (const r of rows) {
    expect(`${r.identifier} ${r.value}`).not.toContain(token);
    expect(r.value).not.toContain(sent!.code);
  }
  // Telemetry stays off: nothing sets it.
  expect((ctx.options as { telemetry?: unknown }).telemetry).toBeUndefined();
});

test("noBearerPlugin", async () => {
  const ids = ((await h.auth.$context).options.plugins ?? []).map((p) => p.id);
  expect(ids).toEqual(expect.arrayContaining(["jwt", "email-otp", "magic-link", "generic-oauth", "api-key", "passkey"]));
  expect(ids).not.toContain("bearer");
  expect(ids).not.toContain("device-authorization");
  // A session token copied out of auth.sqlite is no way in: without the bearer plugin only the signed cookie counts.
  const cookie = cookieOf(await signIn(h, "ada@example.com"));
  const raw = decodeURIComponent(/session_token=([^;]+)/.exec(cookie)![1]!).split(".")[0]!;
  expect(await personOf(new Headers({ authorization: `Bearer ${raw}` }), h.auth)).toBeNull();
  expect(await personOf(new Headers({ cookie: `better-auth.session_token=${raw}` }), h.auth)).toBeNull();
});

test("verifiedAddressNamesThePerson", async () => {
  const first = await viaProvider(h, "fake", { sub: "u-1", email: "marcel@example.com", email_verified: true, preferred_username: "mallory" });
  expect(first.status).toBe(302);
  const me = (await personOf(new Headers({ cookie: cookieOf(first) }), h.auth))!;
  expect(me.email).toBe("marcel@example.com");

  // The same verified address through another provider is the same person.
  const second = await viaProvider(h, "other", { sub: "o-9", email: "marcel@example.com", email_verified: true });
  expect(await personOf(new Headers({ cookie: cookieOf(second) }), h.auth)).toEqual(me);
  // Unverified, it is refused: an address someone merely typed at a provider doesn't open another's account.
  const forged = await viaProvider(h, "other", { sub: "o-10", email: "marcel@example.com", email_verified: false });
  expect(cookieOf(forged)).not.toContain("session_token=");
  expect(location(forged).searchParams.get("error")).toBe("account_not_linked");
  // A provider that leaves email_verified out doesn't vouch for the address either.
  const silent = await viaProvider(h, "fake", { sub: "u-2", email: "silent@team.example" });
  expect(cookieOf(silent)).not.toContain("session_token=");
  expect(location(silent).searchParams.get("error")).toBe("email_not_verified");
});

test("refusedProviderLogged", async () => {
  const { to, cookie } = await startProvider(h, "fake");
  const back = new URL(to.searchParams.get("redirect_uri")!);
  back.searchParams.set("error", "access_denied");
  back.searchParams.set("error_description", "secret-ish words from ada@example.com");
  back.searchParams.set("state", to.searchParams.get("state")!);
  h.logs.length = 0;
  const r = await fetch(back, { redirect: "manual", headers: { cookie } });
  expect(r.status).toBe(302);
  const page = location(r);
  expect(page.pathname).toBe("/login");
  expect(page.searchParams.get("error")).toBe("access_denied");
  expect(page.searchParams.get("provider")).toBe("fake");
  expect(h.logs).toEqual(["sign-in: refused by provider Fake (fake): access_denied"]);

  // What the sign-in page shows of it: a known provider's label and an OAuth-shaped code, nothing else from the query.
  expect(refusedSignIn({ error: "access_denied", provider: "fake" }, h.settings)).toEqual({ provider: "Fake", code: "access_denied" });
  expect(refusedSignIn({ error: "<script>", provider: "nope" }, h.settings)).toEqual({ provider: null, code: "unknown_error" });
  expect(refusedSignIn({}, h.settings)).toBeNull();
});

test("passkeyRegistrationOptions", async () => {
  expect((await fetch(`${h.base}/api/auth/passkey/generate-register-options`)).status).toBe(401);
  const cookie = cookieOf(await signIn(h, "ada@example.com"));
  const r = await fetch(`${h.base}/api/auth/passkey/generate-register-options`, { headers: { cookie } });
  expect(r.status).toBe(200);
  const options = (await r.json()) as { challenge: string; rp: { name: string; id: string }; user: { name: string } };
  expect(options.challenge).toBeTruthy();
  expect(options.rp).toEqual({ name: "Test App", id: "localhost" });
  expect(options.user.name).toBe("ada@example.com");
});

test("removedAddressLosesSession", async () => {
  const cookie = cookieOf(await signIn(h, "leaver@example.com"));
  const kept = cookieOf(await signIn(h, "ada@example.com"));
  expect((await personOf(new Headers({ cookie }), h.auth))?.email).toBe("leaver@example.com");
  // The app restarts with the address taken off the list: its session is gone, everyone else's stays.
  const restarted: Auth = await openAuth(
    { ...h.settings, allowed: ALLOWED.filter((a) => a !== "leaver@example.com") },
    { apiTokenPrefix: API_TOKEN_PREFIX, texts: TEXTS },
  );
  expect(await personOf(new Headers({ cookie }), restarted)).toBeNull();
  expect(await personOf(new Headers({ cookie }), h.auth)).toBeNull();
  expect((await personOf(new Headers({ cookie: kept }), restarted))?.email).toBe("ada@example.com");
});

test("devUserWithoutSession", async () => {
  expect(await personOf(new Headers(), h.auth)).toBeNull();
  expect(await personOf(new Headers(), h.auth, "dev@example.com")).toEqual({ id: "dev:dev@example.com", email: "dev@example.com" });
  // A real session wins over the dev user.
  const cookie = cookieOf(await signIn(h, "ada@example.com"));
  expect((await personOf(new Headers({ cookie }), h.auth, "dev@example.com"))?.email).toBe("ada@example.com");
});

type Meta = {
  registration_endpoint: string;
  authorization_endpoint: string;
  token_endpoint: string;
  code_challenge_methods_supported: string[];
  grant_types_supported: string[];
};

/** The whole OAuth dance for `resource` as an MCP client or a script does it, signed in as `email` with a mailed code. */
async function oauthFor(resource: string, email: string, extra: Record<string, unknown> = {}) {
  const meta = (await (await fetch(`${h.base}/.well-known/oauth-authorization-server/api/auth`)).json()) as Meta;
  const redirect = "https://client.example/cb";
  const reg = await fetch(meta.registration_endpoint, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Claude",
      redirect_uris: [redirect],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      ...extra,
    }),
  });
  expect(reg.status).toBe(201);
  const { client_id } = (await reg.json()) as { client_id: string };
  const verifier = randomBytes(32).toString("base64url");
  const authorize = new URL(meta.authorization_endpoint);
  for (const [k, v] of Object.entries({
    response_type: "code",
    client_id,
    redirect_uri: redirect,
    scope: "openid offline_access",
    state: "st",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    resource,
  }))
    authorize.searchParams.set(k, v);
  const toLogin = await fetch(authorize, { redirect: "manual", headers: { accept: "text/html" } });
  const login = new URL(toLogin.status === 302 ? toLogin.headers.get("location")! : ((await toLogin.json()) as { url: string }).url, h.base);
  expect(login.pathname).toBe("/login");
  const signed = await signIn(h, email, login.search.slice(1));
  expect(signed.status).toBe(200);
  const sent = h.mail.get(email)!;
  const cookie = cookieOf(signed);
  const consent = new URL(((await signed.json()) as { url: string }).url, h.base);
  expect(consent.pathname).toBe("/consent");
  const consented = await fetch(`${h.base}/api/auth/oauth2/consent`, json(h, { accept: true, oauth_query: consent.search.slice(1) }, { cookie }));
  expect(consented.status).toBe(200);
  const back = new URL(((await consented.json()) as { url: string }).url);
  expect(back.origin + back.pathname).toBe(redirect);
  const token = await fetch(meta.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: back.searchParams.get("code")!,
      redirect_uri: redirect,
      client_id,
      code_verifier: verifier,
      resource,
    }),
  });
  expect(token.status).toBe(200);
  return { meta, sent, client_id, cookie, tokens: (await token.json()) as { access_token: string; refresh_token: string; expires_in: number } };
}

const audienceOf = (jwt: string) => (JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString()) as { aud: string | string[] }).aud;

test("mcpSignInMailsOnlyCode", async () => {
  const { meta, sent, client_id, cookie, tokens } = await oauthFor(`${h.base}/mcp`, "ada@example.com");
  expect(meta.code_challenge_methods_supported).toContain("S256");
  expect(meta.grant_types_supported).not.toContain("client_credentials");
  // During an MCP sign-in the mail holds only the code: a link would sign in whichever browser opens it.
  expect(sent.link).toBeUndefined();
  expect(tokens.expires_in).toBeLessThanOrEqual(600);
  expect([audienceOf(tokens.access_token)].flat()).toContain(`${h.base}/mcp`);
  expect(await clientNameFor(new Headers({ cookie }), client_id, h.auth)).toBe("Claude");
  expect(await clientNameFor(new Headers({ cookie }), "no-such-client", h.auth)).toBeNull();
});

test("eachResourceGetsItsOwnToken", async () => {
  const { tokens } = await oauthFor(`${h.base}/api/v1`, "ada@example.com", { resources: [`${h.base}/api/v1`] });
  const aud = [audienceOf(tokens.access_token)].flat();
  expect(aud).toContain(`${h.base}/api/v1`);
  expect(aud).not.toContain(`${h.base}/mcp`);

  // Better Auth's own API-key endpoints are closed to the outside: tokens are made only through the kit's checks (next-app-kit/tokens).
  const cookie = cookieOf(await signIn(h, "ada@example.com"));
  expect((await fetch(`${h.base}/api/auth/api-key/create`, json(h, { name: "x" }, { cookie }))).status).toBe(404);
  expect((await fetch(`${h.base}/api/auth/api-key/list`, { headers: { cookie } })).status).toBe(404);
  // Server-side, the plugin makes keys with the app's prefix.
  const ada = (await personOf(new Headers({ cookie }), h.auth))!;
  const key = (await h.auth.api.createApiKey({ body: { name: "t", userId: ada.id } })) as { key: string };
  expect(key.key.startsWith(API_TOKEN_PREFIX)).toBe(true);
});
