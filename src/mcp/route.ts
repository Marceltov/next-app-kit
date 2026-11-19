// POST /mcp, moved from noticebox (backend/mcp.ts, the wiring; its tools stay in the app): what may reach the tools, and in whose name they
// act. The bearer is an access token Better Auth issued for /mcp (next-app-kit/signin), so every call acts for the person who allowed the
// client, and records say so: "<email> via <client>". Checked at every request, not only when a token is issued: the origin, the token
// (signature, issuer, audience, expiry), that the person still exists with their address on the allowlist, and that they still allow the
// client. An API token, a token for /api/v1 and a session cookie are no such token. Where this differs from noticebox: the base URL is
// always the configured PUBLIC_URL (never taken from request headers), and a person taken off the allowlist is refused. A tool that throws
// is answered as a tool error saying only "internal error": what it threw (a path, a query, a stack) is for the app's log, not the client.
import { requireMcpAuth } from "@better-auth/mcp";
import { McpServer, createMcpHandler, type AuthInfo, type CallToolResult } from "@modelcontextprotocol/server";
import type { Auth, SignInSettings } from "../signin/accounts.js";
import { allowedPerson } from "../signin/person.js";
import { clientName, connected } from "./connections.js";
import { refusalOf, type Tool, type Who } from "./tools.js";

/** What /mcp serves: the app's sign-in, its tools, and what the server says about itself. */
export type McpContext = {
  auth: Auth;
  signIn: SignInSettings;
  tools: Tool[];
  serverInfo: { name: string; version: string };
  instructions: string;
  /** The app's log (pino in an app): a tool that throws is logged here as `mcp <tool>: <message>`. */
  log: (line: string) => void;
};

/** The MCP protocol version the endpoint speaks. */
export const PROTOCOL = "2026-07-28";

function serverFor(ctx: McpContext, who: Who): McpServer {
  const s = new McpServer(ctx.serverInfo, { instructions: ctx.instructions });
  for (const t of ctx.tools)
    s.registerTool(
      t.name,
      { description: t.description, inputSchema: t.inputSchema, outputSchema: t.outputSchema, annotations: t.annotations },
      async (input: unknown): Promise<CallToolResult> => {
        let r: Awaited<ReturnType<Tool["run"]>>;
        try {
          r = await t.run(input, who);
        } catch (e) {
          ctx.log(`mcp ${t.name}: ${e instanceof Error ? e.message : String(e)}`);
          return { isError: true, content: [{ type: "text", text: "internal error" }] };
        }
        const refused = refusalOf(r);
        if (refused !== null) return { isError: true, content: [{ type: "text", text: refused }] };
        return { structuredContent: r, content: [{ type: "text", text: JSON.stringify(r) }] };
      },
    );
  return s;
}

type WhoAuth = AuthInfo & { extra: Who };

// One handler per context: an app passes the same context object on every request. The server itself is built per request, for its caller.
const handlers = new WeakMap<McpContext, ReturnType<typeof createMcpHandler>>();
function handlerFor(ctx: McpContext) {
  let h = handlers.get(ctx);
  if (!h) {
    h = createMcpHandler(({ authInfo }) => serverFor(ctx, (authInfo as WhoAuth).extra), { legacy: "reject", maxRequestBodySize: 1024 * 1024 });
    handlers.set(ctx, h);
  }
  return h;
}

/** Answers one MCP request as `who`; the caller has checked who that is. next-app-kit/testing's callTool uses it too. */
export const mcpAs = (req: Request, ctx: McpContext, who: Who): Promise<Response> =>
  handlerFor(ctx).fetch(req, { authInfo: { token: "", clientId: who.clientId, scopes: [], extra: who } satisfies WhoAuth });

const rpcError = (status: number, message: string, headers?: Record<string, string>) =>
  Response.json({ jsonrpc: "2.0", error: { code: -32600, message } }, { status, headers });

/**
 * Who a token's person and client stand for: the person must still exist with their address on the allowlist and still allow the client,
 * so taking an address off the list or revoking a connection stops its tokens at the next call. A string says why not.
 */
export async function whoFor(ctx: McpContext, person: string, clientId: string): Promise<Who | string> {
  const p = await allowedPerson(ctx.signIn, ctx.auth, person);
  if (!p) return "this person no longer exists or is no longer allowed to sign in";
  if (!(await connected(ctx.auth, person, clientId))) return "this connection was revoked";
  return { actor: `${p.email} via ${await clientName(ctx.auth, clientId)}`, person: p.id, clientId, base: ctx.signIn.baseUrl };
}

/** POST /mcp: our own origin or none, then an access token for /mcp of a person who still may and a client they still allow. */
export async function mcpRoute(req: Request, ctx: McpContext): Promise<Response> {
  const base = ctx.signIn.baseUrl;
  const origin = req.headers.get("origin");
  if (origin !== null) {
    let from: string | null = null;
    try {
      from = new URL(origin).origin;
    } catch {
      // Not a URL ("null" included): no origin of ours.
    }
    // The whole origin, scheme and port included: http://host is not https://host.
    if (from !== new URL(base).origin) return rpcError(403, "forbidden origin");
  }
  const refuse = (message: string) =>
    rpcError(401, message, { "www-authenticate": `Bearer error="invalid_token", resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"` });
  return requireMcpAuth(
    ctx.auth,
    async (r, claims) => {
      const clientId = typeof claims.azp === "string" ? claims.azp : typeof claims.client_id === "string" ? claims.client_id : null;
      if (typeof claims.sub !== "string" || !clientId) return refuse("invalid token");
      const who = await whoFor(ctx, claims.sub, clientId);
      return typeof who === "string" ? refuse(who) : mcpAs(r, ctx, who);
    },
    { resource: `${base}/mcp`, jwksUrl: ctx.signIn.jwksUrl },
  )(req);
}
