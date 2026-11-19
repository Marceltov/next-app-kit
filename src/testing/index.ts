// next-app-kit/testing: what an app's tests and its end-to-end run need to be someone, without a mail, a code or a provider (conventions:
// Better Auth, Tests). freshAuth opens Better Auth in the test's temporary DATA_DIR; signedInCookie makes the person and a session through
// Better Auth's server side and returns the signed cookie a browser would hold; testSignInRoute hands that cookie to a browser, for
// Playwright against `next dev`; callTool runs one MCP tool as someone, without a token. Replaces noticebox's e2e/global-setup.ts (the same
// server-side session, there written into Playwright's storage state) and the callTool that was next-app-kit/mcp's.
//
// testSignInRoute is the one piece an app's production code imports (its route file), so it is built to be absent there: under
// NODE_ENV=production it returns no handler at all, before anything else is read, and the route answers as one with no GET (conventions:
// Next.js app, "a test-only route reachable in a production build" is ruled out). Next.js inlines NODE_ENV when it builds, so the handler is
// dead code in a production bundle. Nothing here imports Next.js or a test runner: handlers are plain `(Request) => Response`.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/server";
import { makeSignature } from "better-auth/crypto";
import { mcpAs, PROTOCOL, type McpContext } from "../mcp/route.js";
import type { Who } from "../mcp/tools.js";
import { openAuth, safeNext, type Auth, type SignInSettings } from "../signin/accounts.js";
import type { MailTexts, SignInMail } from "../signin/mail.js";

export type FreshAuth = {
  auth: Auth;
  signIn: SignInSettings;
  /** The last sign-in mail to each address. */
  mail: Map<string, SignInMail>;
  /** What the kit and Better Auth logged. */
  logs: string[];
};

export type FreshAuthOptions = {
  /** Who may sign in (addresses and @domain entries); default `@example.com`. */
  allowed?: string[];
  /** PUBLIC_URL; default `http://localhost:3000`. Nothing listens there: an app's test that needs HTTP serves Better Auth itself. */
  baseUrl?: string;
  /** Default `test_`. */
  apiTokenPrefix?: string;
  /** The sign-in mail; default an English one. */
  texts?: Record<string, MailTexts>;
};

const TEXTS: Record<string, MailTexts> = {
  en: { subject: (code) => `${code} is your sign-in code`, body: (code, link) => `Your code is ${code}${link ? `, or open ${link}` : ""}.` },
};

/**
 * Better Auth as openAuth opens it, with auth.sqlite in a new directory under DATA_DIR (the test's temporary one; the system's temporary
 * directory when unset), sign-in mail caught in `mail` and the log in `logs`.
 */
export async function freshAuth(prefix: string, o: FreshAuthOptions = {}): Promise<FreshAuth> {
  const baseUrl = (o.baseUrl ?? "http://localhost:3000").replace(/\/$/, "");
  const dir = mkdtempSync(join(process.env.DATA_DIR || tmpdir(), "auth-"));
  const mail = new Map<string, SignInMail>();
  const logs: string[] = [];
  const signIn: SignInSettings = {
    prefix,
    appName: "Test App",
    secret: "test-secret-".padEnd(48, "x"),
    baseUrl,
    file: join(dir, "auth.sqlite"),
    jwksUrl: `${baseUrl}/api/auth/jwks`,
    allowed: (o.allowed ?? ["@example.com"]).map((a) => a.trim().toLowerCase()),
    providers: [],
    smtp: null,
    mailer: async (m) => void mail.set(m.to, m),
    devUser: null,
    passkey: { rpName: "Test App" },
    log: (line) => void logs.push(line),
  };
  const auth = await openAuth(signIn, { apiTokenPrefix: o.apiTokenPrefix ?? "test_", texts: o.texts ?? TEXTS });
  return { auth, signIn, mail, logs };
}

type Cookie = { name: string; value: string; attributes: { path?: string; httpOnly?: boolean; secure?: boolean; sameSite?: string; maxAge?: number } };

/** The address may not sign in: not on the allowlist, or not verified. Any other failure is an Error of another kind. */
export class SignInRefused extends Error {
  constructor(address: string) {
    super(`${address} can't sign in: it is not on the allowlist, or not verified`);
    this.name = "SignInRefused";
  }
}

async function sessionCookie(auth: Auth, email: string): Promise<Cookie> {
  const ctx = await auth.$context;
  const address = email.trim().toLowerCase();
  // Better Auth's own hooks run here as at any sign-in: an address not on the list, or not verified, gets no user and no session (the
  // hooks answer false, and Better Auth returns null). Anything that throws is another failure and is passed on as it is.
  const found = await ctx.internalAdapter.findUserByEmail(address);
  const user = found?.user ?? (await ctx.internalAdapter.createUser({ email: address, name: address, emailVerified: true }, { method: "email-otp" }));
  const session = user ? await ctx.internalAdapter.createSession(user.id) : null;
  if (!session) throw new SignInRefused(address);
  const { name, attributes } = ctx.authCookies.sessionToken;
  return { name, value: encodeURIComponent(`${session.token}.${await makeSignature(session.token, ctx.secret)}`), attributes };
}

/**
 * Signs `email` in through Better Auth's server side, creating the person on first use, and returns the session cookie as a request's
 * `cookie` header carries it (`name=value`). Refused with a SignInRefused for an address not on the allowlist (a person already made is
 * refused too once the address is taken off it); other failures throw as they are.
 */
export async function signedInCookie(auth: Auth, email: string): Promise<string> {
  const c = await sessionCookie(auth, email);
  return `${c.name}=${c.value}`;
}

const setCookie = (c: Cookie) =>
  [
    `${c.name}=${c.value}`,
    `Path=${c.attributes.path ?? "/"}`,
    "HttpOnly",
    `SameSite=${c.attributes.sameSite ? c.attributes.sameSite.charAt(0).toUpperCase() + c.attributes.sameSite.slice(1) : "Lax"}`,
    ...(c.attributes.secure ? ["Secure"] : []),
    ...(c.attributes.maxAge ? [`Max-Age=${c.attributes.maxAge}`] : []),
  ].join("; ");

/**
 * GET <route>?email=…&next=/path: the end-to-end tests' way in. Signs the address in (it must be on the allowlist) and sends the browser
 * on to `next` (a path of this instance; `/` otherwise) with the session cookie set. Returns a handler only while `<PREFIX>_E2E=1` and
 * NODE_ENV is not `production`; otherwise `undefined`, so the app's route file exports no GET and the route does not exist. An address
 * the allowlist refuses answers 403; any other failure 500:
 *
 *     // app/api/test/sign-in/route.ts
 *     export const GET = testSignInRoute("UPLOAD", auth);
 */
export function testSignInRoute(prefix: string, getAuth: () => Auth | Promise<Auth>): ((req: Request) => Promise<Response>) | undefined {
  if (process.env.NODE_ENV === "production") return undefined;
  if (process.env[`${prefix}_E2E`] !== "1") return undefined;
  return async (req) => {
    const query = new URL(req.url).searchParams;
    const email = query.get("email")?.trim();
    if (!email) return Response.json({ error: "?email= is needed" }, { status: 400 });
    let cookie: Cookie;
    try {
      cookie = await sessionCookie(await getAuth(), email);
    } catch (e) {
      return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: e instanceof SignInRefused ? 403 : 500 });
    }
    return new Response(null, {
      status: 303,
      headers: { location: safeNext(query.get("next")), "set-cookie": setCookie(cookie), "cache-control": "no-store" },
    });
  };
}

/** Calls one tool as `who`, through the MCP server as a client would (schemas and all), without a token: for an app's tests. */
export async function callTool(ctx: McpContext, who: Who, name: string, input: Record<string, unknown>): Promise<CallToolResult> {
  const req = new Request(`${who.base}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": PROTOCOL,
      "mcp-method": "tools/call",
      "mcp-name": name,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name,
        arguments: input,
        _meta: {
          "io.modelcontextprotocol/protocolVersion": PROTOCOL,
          "io.modelcontextprotocol/clientInfo": { name: "next-app-kit callTool", version: "0" },
          "io.modelcontextprotocol/clientCapabilities": {},
        },
      },
    }),
  });
  const body = (await (await mcpAs(req, ctx, who)).json()) as { result?: CallToolResult; error?: { message: string } };
  if (!body.result) throw new Error(`${name}: ${body.error?.message ?? "no result"}`);
  return body.result;
}
