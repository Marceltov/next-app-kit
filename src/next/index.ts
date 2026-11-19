// next-app-kit/next: the route handlers an app exports from its Next.js route files, thin over the framework-free parts, as noticebox's
// app/api/auth, app/.well-known, app/mcp and app/api/v1 route files were over its backend. Each takes a getter for what it serves, asked
// at the first request rather than when the route module loads (so `next build` opens no database), and asked once: its answer is kept,
// unless it threw, and then it is asked again at the next request. That also keeps /mcp's context one object, which mcpRoute needs (it
// keeps one MCP handler per context object). This is the one part allowed to import Next.js; the handlers need nothing of it beyond
// the standard Request and Response, so an app's tests call them as plain functions.
import { mcpRoute, type McpContext } from "../mcp/route.js";
import { restRoute, type OpenApiInfo, type Op } from "../rest/index.js";
import { signInSettingsOf, type Auth, type SignInSettings } from "../signin/accounts.js";
import { apiResourceMetadataRoute, authServerMetadataRoute, openIdConfigRoute } from "../signin/routes.js";
import { restCaller } from "../tokens/index.js";

/** What a handler serves, made when it is first needed: an app's own cached runtime, or the parts of it a route uses. */
export type Getter<T> = () => T | Promise<T>;

export type Handler = (req: Request) => Promise<Response>;

/** The getter's answer, asked for once; a failure is not kept, so a request after a bad start tries again. */
function once<T>(get: Getter<T>): () => Promise<T> {
  let kept: Promise<T> | null = null;
  return () => {
    if (!kept) {
      const p = (async () => get())();
      kept = p;
      p.catch(() => {
        if (kept === p) kept = null;
      });
    }
    return kept;
  };
}

/** app/api/auth/[...all]/route.ts: Better Auth (sign-in, sessions, passkeys, the OAuth server's authorize, token, register and jwks). */
export function authHandler(getAuth: Getter<Auth>): { GET: Handler; POST: Handler } {
  const auth = once(getAuth);
  const handle: Handler = async (req) => (await auth()).handler(req);
  return { GET: handle, POST: handle };
}

/**
 * The three /.well-known routes, each the GET of a catch-all route file:
 *   - app/.well-known/oauth-authorization-server/[...issuer]/route.ts: `authorizationServer` (RFC 8414, for the issuer <base>/api/auth);
 *   - app/.well-known/openid-configuration/[...issuer]/route.ts: `openidConfiguration`;
 *   - app/.well-known/oauth-protected-resource/[...path]/route.ts: `protectedResource` (RFC 9728) of /api/v1 and of /mcp, where the 401s of
 *     those two point.
 */
export function wellKnownHandlers(getAuth: Getter<Auth>): { authorizationServer: Handler; protectedResource: Handler; openidConfiguration: Handler } {
  const auth = once(getAuth);
  return {
    authorizationServer: async (req) => authServerMetadataRoute(req, await auth()),
    openidConfiguration: async (req) => openIdConfigRoute(req, await auth()),
    protectedResource: async (req) => {
      const a = await auth();
      // /api/v1's metadata is the kit's; /mcp's (and the bare path's) is @better-auth/mcp's, which Better Auth's handler serves.
      return new URL(req.url).pathname.replace(/\/$/, "") === "/.well-known/oauth-protected-resource/api/v1"
        ? apiResourceMetadataRoute(signInSettingsOf(a))
        : a.handler(req);
    },
  };
}

const notAllowed: Handler = async () => new Response(null, { status: 405, headers: { Allow: "POST" } });

/** app/mcp/route.ts: MCP over Streamable HTTP is POST only; there is no server-sent stream or session to GET or DELETE. */
export function mcpHandler(getCtx: Getter<McpContext>): { POST: Handler; GET: Handler; DELETE: Handler } {
  const ctx = once(getCtx);
  return { POST: async (req) => mcpRoute(req, await ctx()), GET: notAllowed, DELETE: notAllowed };
}

/** What /api/v1 serves: the app's operations and the context they get, the sign-in that says who a caller is, the log, and the OpenAPI info. */
export type RestApp<Ctx> = { auth: Auth; signIn: SignInSettings; ops: Op<Ctx>[]; ctx: Ctx; log: (line: string) => void; openApi?: OpenApiInfo };

/** app/api/v1/[...path]/route.ts: every operation of the app's table, and /api/v1/openapi.json when `openApi` is given. */
export function restHandler<Ctx>(getApp: Getter<RestApp<Ctx>>): Record<"GET" | "POST" | "PUT" | "PATCH" | "DELETE", Handler> {
  const app = once(getApp);
  const handle: Handler = async (req) => {
    const a = await app();
    const caller = await restCaller(req, a.auth, a.signIn);
    return restRoute(req, a.ops, a.ctx, caller, { base: a.signIn.baseUrl, log: a.log, openApi: a.openApi });
  };
  return { GET: handle, POST: handle, PUT: handle, PATCH: handle, DELETE: handle };
}
