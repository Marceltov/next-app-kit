// What the kit's own sign-in tests share (not exported; an app's tests use next-app-kit/testing): a real HTTP server in front of Better Auth, because
// codes, links, cookies and provider redirects only behave as in a browser over HTTP; stand-in OIDC providers served by the same server; and
// the mail and the log caught in memory. auth.sqlite lives in the test's temporary DATA_DIR, so nothing reaches the network or the disk
// outside it.
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { expect } from "vitest";
import { openAuth, type Auth, type SignInSettings } from "./accounts.js";
import type { MailTexts, SignInMail } from "./mail.js";
import { authServerMetadataRoute } from "./routes.js";

export const TEXTS: Record<string, MailTexts> = {
  en: { subject: (code) => `${code} is your sign-in code`, body: (code, link) => `Code ${code}${link ? `, or open ${link}` : ""}` },
  de: { subject: (code) => `${code} ist dein Anmeldecode`, body: (code, link) => `Code ${code}${link ? `, oder öffne ${link}` : ""}` },
};

export const API_TOKEN_PREFIX = "tst_";

/** A new directory under the test's DATA_DIR, for an auth.sqlite of its own. */
export const freshDir = (name: string) => mkdtempSync(join(process.env.DATA_DIR!, `${name}-`));

export type Harness = {
  base: string;
  settings: SignInSettings;
  auth: Auth;
  mail: Map<string, SignInMail>;
  logs: string[];
  /** What each stand-in provider says about the person behind a code it handed out. */
  claims: Map<string, Record<string, unknown>>;
  close(): Promise<void>;
};

function provider(base: string, name: string, path: string): Response | null {
  const root = `/${name}-oidc`;
  if (path === `${root}/.well-known/openid-configuration`)
    return Response.json({
      issuer: `${base}${root}`,
      authorization_endpoint: `${base}${root}/authorize`,
      token_endpoint: `${base}${root}/token`,
      userinfo_endpoint: `${base}${root}/userinfo`,
      jwks_uri: `${base}${root}/jwks`,
      response_types_supported: ["code"],
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: ["RS256"],
    });
  return null;
}

/** Starts Better Auth behind a local HTTP server, with two stand-in OIDC providers (`fake`, `other`) and every address in `allowed`. */
export async function startHarness(allowed: string[]): Promise<Harness> {
  const mail = new Map<string, SignInMail>();
  const logs: string[] = [];
  const claims = new Map<string, Record<string, unknown>>();
  let base = "";
  const started: { auth?: Auth } = {};

  async function route(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname;
    for (const name of ["fake", "other"]) {
      const found = provider(base, name, path);
      if (found) return found;
      if (path === `/${name}-oidc/token`) {
        const code = new URLSearchParams(await req.text()).get("code") ?? "";
        return Response.json({ access_token: `${name}:${code}`, token_type: "Bearer", expires_in: 3600 });
      }
      if (path === `/${name}-oidc/userinfo`) {
        const token = (req.headers.get("authorization") ?? "").replace(/^Bearer /, "");
        return claims.has(token) ? Response.json(claims.get(token)) : new Response("no", { status: 401 });
      }
    }
    if (path.startsWith("/.well-known/oauth-authorization-server")) return authServerMetadataRoute(req, started.auth!);
    return started.auth!.handler(req);
  }

  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const headers = new Headers(
      Object.entries(req.headers).flatMap(([k, v]) => (Array.isArray(v) ? v.map((x) => [k, x]) : v === undefined ? [] : [[k, v]])) as [string, string][],
    );
    const reply = await route(
      new Request(new URL(req.url!, base), { method: req.method, headers, body: req.method === "GET" || req.method === "HEAD" ? undefined : body }),
    ).catch((e) => (console.error(e), new Response("thrown", { status: 599 })));
    for (const [k, v] of reply.headers) if (k !== "set-cookie") res.setHeader(k, v);
    const cookies = reply.headers.getSetCookie();
    if (cookies.length) res.setHeader("set-cookie", cookies);
    res.writeHead(reply.status);
    res.end(Buffer.from(await reply.arrayBuffer()));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://localhost:${(server.address() as AddressInfo).port}`;
  const settings: SignInSettings = {
    prefix: "TEST",
    appName: "Test App",
    secret: "s".repeat(40),
    baseUrl: base,
    file: join(freshDir("auth"), "auth.sqlite"),
    jwksUrl: `${base}/api/auth/jwks`,
    allowed,
    providers: [
      { id: "fake", label: "Fake", clientId: "kit", clientSecret: "x", issuer: `${base}/fake-oidc` },
      { id: "other", label: "Other", clientId: "kit", clientSecret: "x", issuer: `${base}/other-oidc` },
    ],
    smtp: null,
    mailer: async (m) => void mail.set(m.to, m),
    devUser: null,
    passkey: { rpName: "Test App" },
    log: (line) => void logs.push(line),
  };
  const auth = (started.auth = await openAuth(settings, { apiTokenPrefix: API_TOKEN_PREFIX, texts: TEXTS }));
  return {
    base,
    settings,
    auth,
    mail,
    logs,
    claims,
    close: async () => {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    },
  };
}

export const json = (h: Harness, body: unknown, extra: Record<string, string> = {}) => ({
  method: "POST",
  headers: { "content-type": "application/json", origin: h.base, ...extra },
  body: JSON.stringify(body),
});

export const cookieOf = (r: Response) =>
  r.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");

/** Asks for a code for `email`; the mail that arrived, if any. */
export async function sendCode(h: Harness, email: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  h.mail.delete(email);
  const r = await fetch(`${h.base}/api/auth/email-otp/send-verification-otp`, json(h, { email, type: "sign-in", ...extra }, headers));
  expect(r.status).toBe(200);
  return h.mail.get(email);
}

/** Signs `email` in with the mailed code; `oauthQuery` is the signed query of the sign-in page an MCP client sent the browser to. */
export async function signIn(h: Harness, email: string, oauthQuery?: string) {
  const query = oauthQuery ? { oauth_query: oauthQuery } : {};
  const sent = await sendCode(h, email, query);
  return fetch(`${h.base}/api/auth/sign-in/email-otp`, json(h, { email, otp: sent?.code ?? "000000", ...query }));
}

/** Starts a sign-in at a stand-in provider: the provider's authorize URL and the state cookie. */
export async function startProvider(h: Harness, name: string, cookie = "") {
  const start = await fetch(
    `${h.base}/api/auth/sign-in/social`,
    json(h, { provider: name, callbackURL: "/", errorCallbackURL: `/login?provider=${name}` }, cookie ? { cookie } : {}),
  );
  expect(start.status).toBe(200);
  const to = new URL(((await start.json()) as { url: string }).url);
  return { to, cookie: [cookie, cookieOf(start)].filter(Boolean).join("; ") };
}

/** Signs in through a stand-in provider that says `profile` about the person; the callback's response. */
export async function viaProvider(h: Harness, name: string, profile: Record<string, unknown>, cookie = "") {
  const { to, cookie: jar } = await startProvider(h, name, cookie);
  expect(to.origin + to.pathname).toBe(`${h.base}/${name}-oidc/authorize`);
  expect(to.searchParams.get("code_challenge_method")).toBe("S256");
  const code = randomBytes(6).toString("hex");
  h.claims.set(`${name}:${code}`, profile);
  const back = new URL(to.searchParams.get("redirect_uri")!);
  back.searchParams.set("code", code);
  back.searchParams.set("state", to.searchParams.get("state")!);
  return fetch(back, { redirect: "manual", headers: { cookie: jar } });
}
export type Meta = {
  registration_endpoint: string;
  authorization_endpoint: string;
  token_endpoint: string;
  code_challenge_methods_supported: string[];
  grant_types_supported: string[];
};

/** The whole OAuth dance for `resource` as an MCP client or a script does it, signed in as `email` with a mailed code. */
export async function oauthFor(h: Harness, resource: string, email: string, extra: Record<string, unknown> = {}) {
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

export const audienceOf = (jwt: string) => (JSON.parse(Buffer.from(jwt.split(".")[1]!, "base64url").toString()) as { aud: string | string[] }).aud;
