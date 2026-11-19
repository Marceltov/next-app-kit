// Sign-in end to end, over HTTP as a browser and claude.ai do it: email codes and links, the allowlist, the verified address every person is
// named by, linking a second provider, a provider's refusal, passkeys, and an MCP client's OAuth dance down to its token. Better Auth runs
// for real over an auth.sqlite in the test's temporary DATA_DIR; only the mail is caught, and the OIDC providers are stand-ins served by
// the same test server.
import { join } from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { emailAllowed, openAuth, safeNext, type Auth } from "./accounts.js";
import { mailLanguage, type SignInMail } from "./mail.js";
import { personOf, stillAllowed } from "./person.js";
import { clientNameFor, refusedSignIn } from "./routes.js";
import {
  API_TOKEN_PREFIX,
  TEXTS,
  audienceOf,
  cookieOf,
  freshDir,
  json,
  oauthFor,
  sendCode,
  signIn,
  startHarness,
  startProvider,
  viaProvider,
  type Harness,
} from "./testing.js";

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

test("removedAddressLosesSessionAtNextLook", async () => {
  // The list changed under a running app (the settings object is the one Better Auth reads): the next look at the session ends it.
  h.settings.allowed.push("brief@example.com");
  const cookie = cookieOf(await signIn(h, "brief@example.com"));
  const me = (await personOf(new Headers({ cookie }), h.auth))!;
  expect(me.email).toBe("brief@example.com");
  expect(await stillAllowed(h.settings, h.auth, me.id)).toBe(true);
  h.settings.allowed.splice(h.settings.allowed.indexOf("brief@example.com"), 1);
  expect(await stillAllowed(h.settings, h.auth, me.id)).toBe(false);
  expect(await stillAllowed(h.settings, h.auth, "no-such-user")).toBe(false);
  expect(await personOf(new Headers({ cookie }), h.auth)).toBeNull();
  const ctx = await h.auth.$context;
  expect(await ctx.adapter.findMany({ model: "session", where: [{ field: "userId", value: me.id }] })).toEqual([]);
});

test("sessionRefusedOutsideRequest", async () => {
  // A session made server-side, outside any request (no hook context, no transaction adapter), still passes the allowlist check.
  const ctx = await h.auth.$context;
  const now = new Date();
  const make = (email: string, emailVerified = true) =>
    ctx.adapter.create<Record<string, unknown>>({ model: "user", data: { email, name: email, emailVerified, createdAt: now, updatedAt: now } });
  const eve = await make("eve-direct@example.com");
  const unverified = await make("unverified@team.example", false);
  const ada = (await ctx.internalAdapter.findUserByEmail("ada@example.com"))!.user;
  expect(await ctx.internalAdapter.createSession(String(eve.id)).catch(() => null)).toBeNull();
  expect(await ctx.internalAdapter.createSession(String(unverified.id)).catch(() => null)).toBeNull();
  expect(await ctx.adapter.findMany({ model: "session", where: [{ field: "userId", value: String(eve.id) }] })).toEqual([]);
  expect(await ctx.adapter.findMany({ model: "session", where: [{ field: "userId", value: String(unverified.id) }] })).toEqual([]);
  expect((await ctx.internalAdapter.createSession(ada.id))?.userId).toBe(ada.id);
});

test("devUserWithoutSession", async () => {
  expect(await personOf(new Headers(), h.auth)).toBeNull();
  expect(await personOf(new Headers(), h.auth, "dev@example.com")).toEqual({ id: "dev:dev@example.com", email: "dev@example.com" });
  // A real session wins over the dev user.
  const cookie = cookieOf(await signIn(h, "ada@example.com"));
  expect((await personOf(new Headers({ cookie }), h.auth, "dev@example.com"))?.email).toBe("ada@example.com");
});

test("mcpSignInMailsOnlyCode", async () => {
  const { meta, sent, client_id, cookie, tokens } = await oauthFor(h, `${h.base}/mcp`, "ada@example.com");
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
  const { tokens } = await oauthFor(h, `${h.base}/api/v1`, "ada@example.com", { resources: [`${h.base}/api/v1`] });
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

test("apiTokenPrefixNotEmptyNorJwtLike", async () => {
  // A key must be told apart from a JWT by its prefix alone, and every JWT starts with "ey".
  for (const apiTokenPrefix of ["", "ey", "eyx_"])
    await expect(openAuth({ ...h.settings, file: ":memory:" }, { apiTokenPrefix, texts: TEXTS })).rejects.toThrow(/apiTokenPrefix/);
});

test("languageOfPicksTheMailLanguage", async () => {
  // An app with a language switch passes languageOf: its cookie wins over Accept-Language. Without it, Accept-Language alone decides.
  const mail = new Map<string, SignInMail>();
  const settings = { ...h.settings, file: join(freshDir("lang"), "auth.sqlite"), mailer: async (m: SignInMail) => void mail.set(m.to, m) };
  const languageOf = (headers: Headers) =>
    /(?:^|;\s*)lang=(\w+)/.exec(headers.get("cookie") ?? "")?.[1] ?? mailLanguage(headers.get("accept-language"), ["en", "de"]);
  const auth = await openAuth(settings, { apiTokenPrefix: API_TOKEN_PREFIX, texts: TEXTS, languageOf });
  const send = async (headers: Record<string, string>) => {
    const r = await auth.handler(
      new Request(`${h.base}/api/auth/email-otp/send-verification-otp`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: h.base, ...headers },
        body: JSON.stringify({ email: "ada@example.com", type: "sign-in" }),
      }),
    );
    expect(r.status).toBe(200);
    return mail.get("ada@example.com")!.language;
  };
  expect(await send({ cookie: "lang=en", "accept-language": "de" })).toBe("en");
  expect(await send({ "accept-language": "de-DE" })).toBe("de");
  // A language the app has no texts in gets its first.
  expect(await send({ cookie: "lang=fr" })).toBe("en");
});

test("mailFailureIsAnError: a sign-in mail that could not be sent is not answered as sent", async () => {
  // Better Auth awaits the mail but swallows its failure and answers success, so the page said "code sent" when nothing went out.
  const logs: string[] = [];
  let failing = true;
  const settings = {
    ...h.settings,
    file: join(freshDir("mailfail"), "auth.sqlite"),
    log: (l: string) => void logs.push(l),
    mailer: async () => {
      if (failing) throw Object.assign(new Error("connect ECONNREFUSED for ada@example.com"), { code: "ECONNREFUSED" });
    },
  };
  const auth = await openAuth(settings, { apiTokenPrefix: API_TOKEN_PREFIX, texts: TEXTS });
  const send = (email = "ada@example.com") =>
    auth.handler(
      new Request(`${h.base}/api/auth/email-otp/send-verification-otp`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: h.base },
        body: JSON.stringify({ email, type: "sign-in" }),
      }),
    );
  const r = await send();
  expect(r.status).toBe(502);
  expect(await r.json()).toMatchObject({ code: "MAIL_NOT_SENT", message: "The sign-in mail could not be sent" });
  // Logged at error level, without the address.
  expect(logs.filter((l) => l.startsWith("error: sign-in mail could not be sent"))).toHaveLength(1);
  expect(logs.join("\n")).not.toContain("ada@example.com");
  // While mail is failing, an address that may not sign in gets the same answer as one that may: the answer tells nobody who is on the list.
  const stranger = await send("eve@elsewhere.example");
  expect(stranger.status).toBe(502);
  expect(await stranger.json()).toMatchObject({ code: "MAIL_NOT_SENT" });
  // The next send that goes out clears it, for everyone.
  failing = false;
  expect((await send()).status).toBe(200);
  expect((await send("eve@elsewhere.example")).status).toBe(200);
  // Each failed send logged one line.
  expect(logs.filter((l) => l.includes("could not be sent") || l.includes("failed ("))).toHaveLength(1);
  // An instance that mails nothing says so, too, rather than "sent".
  const silent = await openAuth(
    { ...settings, file: join(freshDir("nomail"), "auth.sqlite"), mailer: undefined, smtp: null },
    { apiTokenPrefix: API_TOKEN_PREFIX, texts: TEXTS },
  );
  const off = await silent.handler(
    new Request(`${h.base}/api/auth/email-otp/send-verification-otp`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: h.base },
      body: JSON.stringify({ email: "ada@example.com", type: "sign-in" }),
    }),
  );
  expect(off.status).toBe(400);
  expect(await off.json()).toMatchObject({ code: "EMAIL_SIGN_IN_OFF" });
});

test("smtpFailureLogsOneLine: one failed send through SMTP is one line in the log", async () => {
  // A local server that hangs up at once: the send fails without leaving this machine.
  const { createServer } = await import("node:net");
  const server = createServer((socket) => socket.destroy());
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const logs: string[] = [];
  const settings = {
    ...h.settings,
    file: join(freshDir("smtpfail"), "auth.sqlite"),
    log: (l: string) => void logs.push(l),
    mailer: undefined,
    smtp: { url: `smtp://127.0.0.1:${port}`, from: "app@example.org" },
  };
  const auth = await openAuth(settings, { apiTokenPrefix: API_TOKEN_PREFIX, texts: TEXTS });
  const r = await auth.handler(
    new Request(`${h.base}/api/auth/email-otp/send-verification-otp`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: h.base },
      body: JSON.stringify({ email: "ada@example.com", type: "sign-in" }),
    }),
  );
  server.close();
  expect(r.status).toBe(502);
  expect(logs.filter((l) => /could not be sent|failed \(/.test(l))).toEqual([expect.stringMatching(/^error: sign-in mail could not be sent \(/)]);
});
