// Sign-in: Better Auth, as the Better Auth and Sign-in conventions set it up, with its tables in their own file, auth.sqlite next to the
// app's database, so a backup or export of the app's data holds no sessions or tokens. Moved from noticebox (backend/accounts.ts), with the
// app's env prefix, name, API-token prefix, sign-in pages and mail texts as parameters.
//   - People sign in with a code mailed to them (with a link to sign in by in the same mail, outside an MCP or script sign-in), with a
//     passkey they added while signed in, or through the providers <PREFIX>_OIDC_<NAME>_* names (GitHub, Google and Apple built in, any
//     other OIDC provider through genericOAuth). Only a verified email on <PREFIX>_ALLOWED_EMAILS gets in; an empty list lets nobody in.
//     An address taken off the list loses its sessions and OAuth grants at the next start.
//   - A person is one account, named by its verified email address. Nothing a provider claims about a username counts, so no two
//     providers can name one person differently.
//   - MCP clients sign in through OAuth (@better-auth/mcp), with access tokens bound to /mcp; scripts likewise, with tokens bound to
//     /api/v1, or with an API token (@better-auth/api-key) that works on /api/v1 only (next-app-kit/tokens).
// Where this differs from Better Auth's defaults: codes and links are stored hashed; no bearer or device-authorization plugin; telemetry
// off; a provider's refusal is logged with the provider's name.
import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { apiKey } from "@better-auth/api-key";
import { cimd } from "@better-auth/cimd";
import { fetchClientMetadataResource } from "@better-auth/cimd/node";
import { defineRequestState, getCurrentAdapter } from "@better-auth/core/context";
import { mcp } from "@better-auth/mcp";
import { passkey } from "@better-auth/passkey";
import BetterSqlite3 from "better-sqlite3";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { getMigrations } from "better-auth/db/migration";
import { emailOTP } from "better-auth/plugins/email-otp";
import { genericOAuth } from "better-auth/plugins/generic-oauth";
import { jwt } from "better-auth/plugins/jwt";
import { magicLink } from "better-auth/plugins/magic-link";
import { mailLanguage, smtpMailer, type MailTexts, type Mailer, type Smtp } from "./mail.js";

/** A provider from <PREFIX>_OIDC_<NAME>_*: `issuer` is null for GitHub, Google and Apple, which Better Auth knows itself. */
export type Provider = { id: string; label: string; clientId: string; clientSecret: string; issuer: string | null };

export type SignInSettings = {
  prefix: string; // the app's env prefix, without the underscore: UPLOAD, NOTICEBOX, …
  appName: string;
  secret: string;
  baseUrl: string; // PUBLIC_URL, without a trailing slash
  file: string; // auth.sqlite, in DATA_DIR
  jwksUrl: string; // where /mcp fetches the keys its tokens are checked with: this process itself, not through the proxy
  allowed: string[]; // addresses and @domain entries, lowercase
  providers: Provider[];
  smtp: Smtp | null;
  mailer?: Mailer; // tests catch the mail here; else SMTP
  devUser: string | null; // <PREFIX>_DEV_USER: everyone is this person without signing in (development only)
  passkey: { rpName: string }; // the name a passkey prompt shows
  log: (line: string) => void;
};

export type OpenAuthOptions = {
  /** API tokens start with this (`upl_`, `nbx_`), so a bearer is told apart from an OAuth access token at a glance, and by a scanner. */
  apiTokenPrefix: string;
  /** The sign-in mail in each language the app speaks; the first is the fallback. */
  texts: Record<string, MailTexts>;
  /** The app's sign-in and consent pages (noticebox's by default). */
  pages?: { signIn?: string; consent?: string };
};

/** Seconds an MCP access token lives: a JWT can't be revoked before it expires, so it is short and the client refreshes it. */
export const ACCESS_TOKEN_SECONDS = 600;

/** Days an API token lives unless its maker chooses otherwise, and the most they may choose (noticebox ADR 0002). */
export const API_TOKEN_DAYS = { default: 90, max: 365 };

/** The resource an API token's permissions name: `{ api: ["read"] }` or `{ api: ["read", "write"] }`. */
export const API_TOKEN_RESOURCE = "api";

export function emailAllowed(allowed: string[], email: string): boolean {
  const e = email.trim().toLowerCase();
  return allowed.some((a) => (a.startsWith("@") ? e.endsWith(a) : e === a));
}

/** Only a path of this instance: never another host (`//evil`), so a link can't lead off the app. */
export function safeNext(next: unknown): string {
  return typeof next === "string" && next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\") ? next : "/";
}

// Whether this request comes from a sign-in page an MCP client sent the browser to: its signed query comes along (the browser client
// adds it to every request from that page). The body the endpoints see has it stripped, so a hook notes it.
const oauthSignIn = defineRequestState(() => false);

/**
 * Why the kit refused a sign-in, in place of Better Auth's "unable to create user": the sign-in page tells the person (and whoever sets
 * up the provider) what is wrong. `email_not_verified` is the one that is hard to find otherwise: a provider that doesn't send
 * `email_verified: true` signs nobody in.
 */
export type Refusal = "email_not_verified" | "email_not_allowed";
const refusal = defineRequestState((): Refusal | null => null);

async function refuse(s: SignInSettings, why: Refusal, what: string): Promise<false> {
  await refusal.set(why).catch(() => {});
  s.log(
    why === "email_not_verified"
      ? `sign-in: refused ${what}: the provider did not send email_verified: true for the address (in Authentik: the email scope mapping)`
      : `sign-in: refused ${what}: the address is not on ${s.prefix}_ALLOWED_EMAILS`,
  );
  return false;
}

/** A request state's value, or `fallback` outside a request (a server-side call, such as an e2e setup's). */
async function stateOr<T>(state: { get(): Promise<T> }, fallback: T): Promise<T> {
  try {
    return await state.get();
  } catch {
    return fallback;
  }
}

// A sign-in link is made only while a code mail is being written, and goes into that mail: the link plugin's own endpoint, called from
// anywhere else, mails nothing.
const linkFor = new AsyncLocalStorage<{ url?: string }>();

const UNTRACKED = { ipAddress: "", userAgent: "" };

/** An OAuth error code as the sign-in page may show it and the log may hold it: anything else in a query is anyone's to write. */
export const OAUTH_CODE = /^[a-z][a-z0-9_.-]{0,63}$/i;

type Lookup = { findOne(q: { model: string; where: { field: string; value: string }[] }): Promise<Record<string, unknown> | null> };

/**
 * The adapter of the transaction a hook runs in, if any: Better Auth creates a user, its account and its session in one transaction on
 * the one SQLite connection, so a query through the plain adapter would wait for it forever.
 */
async function adapterIn(ctx: unknown): Promise<Lookup | null> {
  const plain = (ctx as { context?: { adapter?: unknown } } | null | undefined)?.context?.adapter;
  return plain ? ((await getCurrentAdapter(plain as Parameters<typeof getCurrentAdapter>[0])) as unknown as Lookup) : null;
}

function options(s: SignInSettings, o: OpenAuthOptions, database: BetterSqlite3.Database, self: () => Auth) {
  const mail = s.mailer ?? (s.smtp ? smtpMailer(s.smtp, { texts: o.texts, log: s.log }) : null);
  const languages = Object.keys(o.texts);
  if (languages.length === 0) throw new Error("openAuth needs the sign-in mail texts of at least one language");
  const signInPage = o.pages?.signIn ?? "/login";
  const builtIn = (id: string) => s.providers.find((p) => p.id === id && p.issuer === null);
  const github = builtIn("github");
  const google = builtIn("google");
  const apple = builtIn("apple");

  /** A sign-in link for `email`, to the page the sign-in page was asked for (its `next`, read off the Referer). */
  async function signInLink(email: string, headers: Headers | undefined): Promise<string | undefined> {
    let next = "/";
    try {
      next = safeNext(new URL(headers?.get("referer") ?? "").searchParams.get("next"));
    } catch {
      // No Referer, or not a URL: the link opens the app's start page.
    }
    const slot: { url?: string } = {};
    await linkFor.run(slot, () =>
      self().api.signInMagicLink({
        body: { email, callbackURL: next, errorCallbackURL: `${signInPage}?${new URLSearchParams({ next })}` },
        headers: headers ?? new Headers(),
      }),
    );
    return slot.url;
  }

  return {
    appName: s.appName,
    baseURL: s.baseUrl,
    basePath: "/api/auth",
    secret: s.secret,
    // Typed as Better Auth takes it, so the declaration of Auth needs no name from better-sqlite3.
    database: database as BetterAuthOptions["database"],
    // Nothing turns telemetry on: no `telemetry` option and no BETTER_AUTH_TELEMETRY.
    emailAndPassword: { enabled: false },
    // Apple posts its answer to the callback from its own origin.
    trustedOrigins: apple ? ["https://appleid.apple.com"] : [],
    // Better Auth's lines go to the app's log. On SQLite it stores its list fields as JSON text and then reports each as "a different
    // type in the database" at every start; that one is dropped, everything else is kept.
    logger: {
      log: (level: string, message: string) => {
        if (!/has a different type in the database/.test(message)) s.log(`better-auth ${level}: ${message}`);
      },
    },
    // A second sign-in joins an account only when its provider says the address is verified. A provider listed in trustedProviders
    // would join even without that, so none is listed.
    account: { accountLinking: { enabled: true, trustedProviders: [] as string[] } },
    socialProviders: {
      ...(github ? { github: { clientId: github.clientId, clientSecret: github.clientSecret } } : {}),
      ...(google ? { google: { clientId: google.clientId, clientSecret: google.clientSecret } } : {}),
      ...(apple ? { apple: { clientId: apple.clientId, clientSecret: apple.clientSecret } } : {}),
    },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        // API tokens are made, listed and revoked only through the kit (next-app-kit/tokens), with its checks of name, scope and lifetime:
        // the plugin's own endpoints answer server-side calls only, never a request from outside.
        if (ctx.path.startsWith("/api-key/") && ctx.request) throw new APIError("NOT_FOUND");
        if ((ctx.body as { oauth_query?: unknown } | undefined)?.oauth_query) await oauthSignIn.set(true);
        // A provider that refused the sign-in says so at the callback; Better Auth sends that on to the sign-in page as `?error=`, and the
        // log gets one line naming the provider, so a misconfigured provider shows here, not only in the provider's own logs. Only the
        // code is logged, never its free-text description. A POST callback (Apple's) is turned into this GET first.
        if (ctx.path === "/callback/:id" && ctx.method === "GET") {
          const error = (ctx.query as { error?: unknown } | undefined)?.error;
          if (typeof error === "string" && error) {
            const id = String((ctx.params as { id?: unknown } | undefined)?.id ?? "");
            const known = s.providers.find((p) => p.id === id);
            s.log(`sign-in: refused by provider ${known ? `${known.label} (${known.id})` : "unknown"}: ${OAUTH_CODE.test(error) ? error : "unknown_error"}`);
          }
        }
      }),
      after: createAuthMiddleware(async (ctx) => {
        // A session whose address is no longer on the list is no session: it is deleted when it shows up. (The list is read at start,
        // and openAuth sweeps such sessions then; this catches any that slipped past.)
        if (ctx.path === "/get-session") {
          const found = ctx.context.returned as { session?: { token?: string }; user?: { email?: string } } | null | undefined;
          if (found?.user?.email && !emailAllowed(s.allowed, found.user.email)) {
            if (found.session?.token) await ctx.context.internalAdapter.deleteSession(found.session.token);
            return ctx.json(null);
          }
        }
        // A provider's callback that a hook below refused goes back to the sign-in page with the reason as its error code.
        const why = await stateOr(refusal, null);
        if (!why) return;
        const returned = ctx.context.returned as { headers?: Headers } | undefined;
        const location = returned?.headers?.get("location") ?? ctx.context.responseHeaders?.get("location");
        if (!location) return;
        const to = new URL(location, s.baseUrl);
        if (!to.searchParams.has("error")) return;
        to.searchParams.set("error", why);
        throw ctx.redirect(to.origin === new URL(s.baseUrl).origin ? to.pathname + to.search : to.toString());
      }),
    },
    databaseHooks: {
      user: {
        create: {
          // Who may sign in: a verified address on the list, whichever way it arrives (a provider that doesn't say the address is
          // verified is refused). `false` refuses: Better Auth then sends a provider sign-in back to the sign-in page with an error
          // code, where a thrown error would end on a bare JSON answer.
          before: async (user: { email: string; emailVerified: boolean }) => {
            if (!emailAllowed(s.allowed, user.email)) return refuse(s, "email_not_allowed", "a new account");
            if (!user.emailVerified) return refuse(s, "email_not_verified", "a new account");
            return { data: user };
          },
        },
      },
      session: {
        create: {
          // The allowlist and the verified address hold at every sign-in, not only the first: an address taken off the list can't sign
          // in again, by code, link, provider or passkey. Better Auth writes the client's address and browser into every session;
          // nothing reads them, so neither is stored.
          // Outside a request (a server-side call, with no hook context) there is no transaction adapter; the connection itself is asked
          // then, which sees what any open transaction on it wrote. The check never skips itself.
          before: async (session: Record<string, unknown>, ctx: unknown) => {
            const adapter = await adapterIn(ctx);
            const id = String(session.userId);
            const user = adapter
              ? await adapter.findOne({ model: "user", where: [{ field: "id", value: id }] })
              : ((database.prepare(`select "email", "emailVerified" from "user" where "id" = ?`).get(id) as Record<string, unknown> | undefined) ?? null);
            if (!user || !emailAllowed(s.allowed, String(user.email))) return refuse(s, "email_not_allowed", "a session");
            if (!user.emailVerified) return refuse(s, "email_not_verified", "a session");
            return { data: { ...session, ...UNTRACKED } };
          },
        },
        update: { before: async (session: Record<string, unknown>) => ({ data: { ...session, ...UNTRACKED } }) },
      },
    },
    plugins: [
      // Signs the access tokens; /mcp checks them against /api/auth/jwks.
      jwt(),
      mcp({
        loginPage: signInPage,
        consentPage: o.pages?.consent ?? "/consent",
        resource: `${s.baseUrl}/mcp`,
        // The REST API is a second resource: a script registers for it (`resources`) and asks for a token with resource=<base>/api/v1,
        // which is then bound to that alone. An /mcp token is refused there, and the reverse.
        resources: [`${s.baseUrl}/api/v1`],
        clientRegistrationAllowedResources: [`${s.baseUrl}/api/v1`],
        accessTokenExpiresIn: ACCESS_TOKEN_SECONDS,
        // Tokens only ever stand for a person: no client_credentials grant, whose tokens name nobody.
        grantTypes: ["authorization_code", "refresh_token"],
        // claude.ai registers itself (RFC 7591); clients with a metadata document use cimd() below.
        allowDynamicClientRegistration: true,
        allowUnauthenticatedClientRegistration: true,
      }),
      cimd({ fetchClientMetadataResource, metadataProfile: "mcp-2026-07-28" }),
      // API tokens: stored hashed, with a name, a scope (`api: read` or `api: read, write`) and an expiry. A key never stands for a session
      // (enableSessionForAPIKeys stays off), and only /api/v1 reads it, from the Authorization header.
      apiKey({
        defaultPrefix: o.apiTokenPrefix,
        requireName: true,
        // next-app-kit/tokens always passes the lifetime itself (90 days unless chosen); null there must mean none, which the plugin only
        // honours when its own default is none.
        keyExpiration: { defaultExpiresIn: null, maxExpiresIn: API_TOKEN_DAYS.max },
        // Its default is ten requests a day per key; the app's own limits apply instead.
        rateLimit: { enabled: false },
        permissions: { defaultPermissions: { [API_TOKEN_RESOURCE]: ["read"] } },
      }),
      // Codes and links are stored hashed: auth.sqlite holds no usable code or link.
      emailOTP({
        storeOTP: "hashed",
        sendVerificationOTP: async ({ email, otp, type }: { email: string; otp: string; type: string }, ctx?: { request?: Request }) => {
          if (type !== "sign-in") return;
          if (!mail) throw new APIError("BAD_REQUEST", { message: "Sign-in by email is off on this instance" });
          // No mail to an address that may not sign in: nobody can use the app to send mail to strangers.
          if (!emailAllowed(s.allowed, email)) return;
          const headers = ctx?.request?.headers;
          // During an MCP or script sign-in (the sign-in page's signed query came along) the mail holds only the code: a link would sign
          // in whichever browser opens it, not the one the authorization waits in.
          const link = (await stateOr(oauthSignIn, false)) ? undefined : await signInLink(email, headers);
          await mail({ to: email, code: otp, link, language: mailLanguage(headers?.get("accept-language"), languages) });
        },
      }),
      magicLink({
        storeToken: "hashed",
        sendMagicLink: ({ url }: { url: string }) => {
          const slot = linkFor.getStore();
          if (slot) slot.url = url;
        },
      }),
      // Passkeys are added while signed in (Better Auth's default: registration needs a fresh session) and sign in like any other way:
      // the session hook above still checks the list.
      passkey({ rpID: new URL(s.baseUrl).hostname, rpName: s.passkey.rpName }),
      genericOAuth({
        config: s.providers
          .filter((p) => p.issuer !== null)
          .map((p) => ({
            providerId: p.id,
            discoveryUrl: `${p.issuer}/.well-known/openid-configuration`,
            clientId: p.clientId,
            clientSecret: p.clientSecret || undefined,
            scopes: ["openid", "email", "profile"],
            pkce: true,
          })),
      }),
    ],
  };
}

export type Auth = ReturnType<typeof betterAuth<ReturnType<typeof options>>>;

/**
 * Ends everything an address no longer on the list still holds: its sessions, and its MCP clients' and scripts' OAuth tokens (an access
 * token already handed out lives on for at most ACCESS_TOKEN_SECONDS). The account and its passkeys stay, for when it is put back.
 */
function sweepRemoved(s: SignInSettings, database: BetterSqlite3.Database): void {
  const users = database.prepare(`select id, email from "user"`).all() as { id: string; email: string }[];
  const gone = users.filter((u) => !emailAllowed(s.allowed, u.email)).map((u) => u.id);
  if (gone.length === 0) return;
  const tables = new Set((database.prepare("select name from sqlite_master where type = 'table'").all() as { name: string }[]).map((t) => t.name));
  const marks = gone.map(() => "?").join(", ");
  let ended = 0;
  database.transaction(() => {
    for (const table of ["session", "oauthRefreshToken", "oauthAccessToken", "oauthConsent"])
      if (tables.has(table)) ended += database.prepare(`delete from "${table}" where "userId" in (${marks})`).run(...gone).changes;
  })();
  if (ended > 0) s.log(`sign-in: ended ${ended} sessions and grants of ${gone.length} accounts no longer on ${s.prefix}_ALLOWED_EMAILS`);
}

const opened = new WeakMap<Auth, { apiTokenPrefix: string; settings: SignInSettings }>();

function openedBy(auth: Auth) {
  const found = opened.get(auth);
  if (!found) throw new Error("this Auth was not made by openAuth");
  return found;
}

/** The prefix this instance's API tokens start with (OpenAuthOptions.apiTokenPrefix), for next-app-kit/tokens to tell a key from a JWT. */
export const apiTokenPrefixOf = (auth: Auth): string => openedBy(auth).apiTokenPrefix;

/** The settings this instance was opened with, for what serves it from an Auth alone (next-app-kit/next, next-app-kit/testing). */
export const signInSettingsOf = (auth: Auth): SignInSettings => openedBy(auth).settings;

/** Opens auth.sqlite, creates or extends Better Auth's own tables as its version and plugins need, and starts it. */
export async function openAuth(s: SignInSettings, o: OpenAuthOptions): Promise<Auth> {
  // Every JWT starts with "ey" (base64 of `{"`): a key with that prefix, or with none, could not be told from an access token at a glance.
  if (!o.apiTokenPrefix || o.apiTokenPrefix.startsWith("ey")) throw new Error(`apiTokenPrefix "${o.apiTokenPrefix}" must be non-empty and not start with "ey"`);
  if (s.file !== ":memory:") mkdirSync(dirname(s.file), { recursive: true });
  const database = new BetterSqlite3(s.file, { timeout: 5000 });
  try {
    database.pragma("journal_mode = wal");
    // Migrated before Better Auth starts, which would otherwise report the tables it is about to get as missing.
    const started: { auth?: Auth } = {};
    const opts = options(s, o, database, () => started.auth!);
    const { runMigrations } = await getMigrations(opts);
    await runMigrations();
    sweepRemoved(s, database);
    started.auth = betterAuth(opts);
    opened.set(started.auth, { apiTokenPrefix: o.apiTokenPrefix, settings: s });
    return started.auth;
  } catch (e) {
    database.close();
    throw e;
  }
}

type Env = Record<string, string | undefined>;

const BUILT_IN: Record<string, string> = { GITHUB: "GitHub", GOOGLE: "Google", APPLE: "Apple" };

/**
 * The sign-in settings from the environment, all under the app's prefix (plus PUBLIC_URL and PORT), checked at start: a provider needs
 * its client id and secret (and an issuer, unless it is GITHUB, GOOGLE or APPLE); some way in must exist; <PREFIX>_DEV_USER never runs in
 * production.
 */
export function signInFromEnv(env: Env, opts: { prefix: string; file: string; appName: string; log: (line: string) => void }): SignInSettings {
  const { prefix: P, file, appName, log } = opts;
  const dev = env[`${P}_DEV_USER`] || null;
  if (dev && env.NODE_ENV === "production") throw new Error(`${P}_DEV_USER signs everyone in without a password: it is refused when NODE_ENV=production`);
  const providers: Provider[] = [];
  const pattern = new RegExp(`^${P}_OIDC_([A-Z0-9_]+?)_CLIENT_ID$`);
  for (const key of Object.keys(env).sort()) {
    const m = pattern.exec(key);
    if (!m) continue;
    const name = m[1]!;
    const at = `${P}_OIDC_${name}`;
    const builtIn = name in BUILT_IN;
    const issuer = env[`${at}_ISSUER`]?.replace(/\/$/, "") || null;
    if (!builtIn && !issuer) throw new Error(`${at}_ISSUER is needed: the OIDC discovery base of the provider`);
    const clientSecret = env[`${at}_CLIENT_SECRET`] ?? "";
    if (builtIn && !clientSecret) throw new Error(`${at}_CLIENT_SECRET is needed`);
    const id = name.toLowerCase().replace(/_/g, "-");
    const label = env[`${at}_LABEL`] || BUILT_IN[name] || name.charAt(0) + name.slice(1).toLowerCase();
    providers.push({ id, label, clientId: env[key]!, clientSecret, issuer: builtIn ? null : issuer });
  }
  const smtpUrl = env[`${P}_SMTP_URL`];
  const smtp = smtpUrl ? { url: smtpUrl, from: env[`${P}_SMTP_FROM`] || `${appName} <noreply@localhost>` } : null;
  if (!dev && !smtp && providers.length === 0)
    throw new Error(`there is no way to sign in: set ${P}_SMTP_URL for sign-in by email, or a provider (${P}_OIDC_<NAME>_CLIENT_ID and the rest)`);
  let secret = env[`${P}_SECRET`] ?? "";
  if (secret.length < 32) {
    if (!dev) throw new Error(`${P}_SECRET must be set, with at least 32 characters (openssl rand -base64 48)`);
    // Development without a secret: a new one at every start, so sessions don't outlive the process.
    secret = randomBytes(32).toString("hex");
  }
  const baseUrl = env.PUBLIC_URL?.replace(/\/$/, "") || (dev ? `http://localhost:${env.PORT || 3000}` : "");
  if (!baseUrl) throw new Error("PUBLIC_URL must be set: the public URL of the app, which sign-in links and MCP tokens name");
  const allowed = (env[`${P}_ALLOWED_EMAILS`] ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  if (allowed.length === 0 && !dev) log(`warning: ${P}_ALLOWED_EMAILS is empty, so nobody can sign in`);
  if (dev) log(`warning: ${P}_DEV_USER is set, everyone reaching the app is "${dev}"`);
  return {
    prefix: P,
    appName,
    secret,
    baseUrl,
    file,
    jwksUrl: `http://127.0.0.1:${env.PORT || 3000}/api/auth/jwks`,
    allowed,
    providers,
    smtp,
    devUser: dev,
    passkey: { rpName: appName },
    log,
  };
}

/** What the sign-in page offers: email (when mail can be sent), passkeys, and a button per provider. */
export function signInMethods(s: SignInSettings): { email: boolean; passkey: boolean; providers: { id: string; label: string; builtIn: boolean }[] } {
  return {
    email: s.smtp !== null || s.mailer !== undefined,
    passkey: true,
    providers: s.providers.map((p) => ({ id: p.id, label: p.label, builtIn: p.issuer === null })),
  };
}
