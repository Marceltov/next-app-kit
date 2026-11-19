// next-app-kit/next: the route handlers an app exports from its route files. Each is called here as Next.js calls it, with a Request, against
// Better Auth running for real behind the sign-in test server (../signin/testing.ts), so the tokens are the ones clients hold.
import { afterAll, beforeAll, expect, test } from "vitest";
import * as z from "zod";
import { defineTool, type McpContext } from "../mcp/index.js";
import type { Op } from "../rest/index.js";
import { oauthFor, startHarness, type Harness } from "../signin/testing.js";
import { signedInCookie } from "../testing/index.js";
import { createApiToken } from "../tokens/index.js";
import { authHandler, mcpHandler, restHandler, wellKnownHandlers, type RestApp } from "./index.js";

const greet = defineTool({
  name: "greet",
  description: "Greets someone.",
  input: z.object({ name: z.string() }),
  output: z.object({ greeting: z.string() }),
  handle: async ({ name }) => ({ greeting: `Hello, ${name}`, guidance: ["Say it to them."] }),
});

const OPS: Op<null>[] = [
  {
    method: "GET",
    path: "/greeting",
    operationId: "greet",
    tool: "greet",
    summary: "A greeting",
    tag: "Greetings",
    query: z.object({ name: z.string() }),
    ok: { status: 200, description: "The greeting", schema: z.object({ greeting: z.string() }) },
    errors: [400, 401],
    handle: ({ query, caller }) => ({ status: 200, body: { greeting: `Hello, ${String(query.name)}`, by: caller.actor } }),
  },
];

let h: Harness;
let mcp: McpContext;
let rest: RestApp<null>;

beforeAll(async () => {
  h = await startHarness(["ada@example.com"]);
  mcp = { auth: h.auth, signIn: h.settings, tools: [greet], serverInfo: { name: "t", version: "0.0.1" }, instructions: "A test app." };
  rest = { auth: h.auth, signIn: h.settings, ops: OPS, ctx: null, log: () => {}, openApi: { title: "Test API", version: "0.0.1" } };
});

afterAll(async () => {
  await h.close();
});

test("authHandler serves Better Auth for GET and POST", async () => {
  const { GET, POST } = authHandler(() => h.auth);
  expect((await GET(new Request(`${h.base}/api/auth/ok`))).status).toBe(200);
  const sent = await POST(
    new Request(`${h.base}/api/auth/email-otp/send-verification-otp`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: h.base },
      body: JSON.stringify({ email: "ada@example.com", type: "sign-in" }),
    }),
  );
  expect(sent.status).toBe(200);
  expect(h.mail.get("ada@example.com")?.code).toMatch(/^\d{6}$/);
});

test("wellKnownHandlers: the authorization server's metadata and its OpenID configuration", async () => {
  const wk = wellKnownHandlers(async () => h.auth);
  const as = (await (await wk.authorizationServer(new Request(`${h.base}/.well-known/oauth-authorization-server/api/auth`))).json()) as Record<string, unknown>;
  expect(as.issuer).toBe(`${h.base}/api/auth`);
  expect(as.registration_endpoint).toBe(`${h.base}/api/auth/oauth2/register`);
  const oidc = (await (await wk.openidConfiguration(new Request(`${h.base}/.well-known/openid-configuration/api/auth`))).json()) as Record<string, unknown>;
  expect(oidc.issuer).toBe(`${h.base}/api/auth`);
});

test("wellKnownHandlers: the protected resources /api/v1 and /mcp, which the 401s on them point to", async () => {
  const wk = wellKnownHandlers(() => h.auth);
  const api = await wk.protectedResource(new Request(`${h.base}/.well-known/oauth-protected-resource/api/v1`));
  expect(api.status).toBe(200);
  expect(await api.json()).toMatchObject({ resource: `${h.base}/api/v1`, authorization_servers: [`${h.base}/api/auth`], resource_name: "Test App API" });
  const res = await wk.protectedResource(new Request(`${h.base}/.well-known/oauth-protected-resource/mcp`));
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ resource: `${h.base}/mcp`, authorization_servers: [`${h.base}/api/auth`] });
});

const rpc = (body: unknown, headers: Record<string, string> = {}) =>
  new Request(`${h.base}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": "2026-07-28",
      "mcp-method": "tools/list",
      ...headers,
    },
    body: JSON.stringify(body),
  });

test("mcpHandler: POST /mcp with a token for /mcp lists the tools; without one, 401 pointing to the metadata; GET and DELETE are 405", async () => {
  let asked = 0;
  const { POST, GET, DELETE } = mcpHandler(() => (asked++, { ...mcp }));
  const list = {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/list",
    params: {
      _meta: {
        "io.modelcontextprotocol/protocolVersion": "2026-07-28",
        "io.modelcontextprotocol/clientInfo": { name: "t", version: "0" },
        "io.modelcontextprotocol/clientCapabilities": {},
      },
    },
  };
  const none = await POST(rpc(list));
  expect(none.status).toBe(401);
  expect(none.headers.get("www-authenticate")).toContain(`${h.base}/.well-known/oauth-protected-resource/mcp`);
  const { tokens } = await oauthFor(h, `${h.base}/mcp`, "ada@example.com");
  const ok = await POST(rpc(list, { authorization: `Bearer ${tokens.access_token}` }));
  expect(ok.status).toBe(200);
  expect(JSON.stringify(await ok.json())).toContain('"greet"');
  // The context is asked for once: mcpRoute keeps one handler per context object, so a new one per request would build one per request.
  expect(asked).toBe(1);
  expect([(await GET(new Request(`${h.base}/mcp`))).status, (await DELETE(new Request(`${h.base}/mcp`, { method: "DELETE" }))).status]).toEqual([405, 405]);
  expect((await GET(new Request(`${h.base}/mcp`))).headers.get("allow")).toBe("POST");
});

test("restHandler: an operation with an API token, 401 without, the OpenAPI document for anyone", async () => {
  const handlers = restHandler(() => rest);
  for (const m of ["GET", "POST", "PUT", "PATCH", "DELETE"] as const) expect(handlers[m]).toBeTypeOf("function");
  const { GET } = handlers;
  const at = `${h.base}/api/v1/greeting?name=Grace`;
  const none = await GET(new Request(at));
  expect(none.status).toBe(401);
  expect(none.headers.get("www-authenticate")).toContain(`${h.base}/.well-known/oauth-protected-resource/api/v1`);
  await signedInCookie(h.auth, "ada@example.com");
  const ada = (await (await h.auth.$context).internalAdapter.findUserByEmail("ada@example.com"))!.user;
  const made = await createApiToken(h.auth, ada.id, { name: "test", scope: "read" });
  if ("error" in made) throw new Error(made.error);
  const ok = await GET(new Request(at, { headers: { authorization: `Bearer ${made.token}` } }));
  expect(ok.status).toBe(200);
  expect(await ok.json()).toEqual({ greeting: "Hello, Grace", by: "ada@example.com" });
  const doc = await GET(new Request(`${h.base}/api/v1/openapi.json`));
  expect(doc.status).toBe(200);
  expect(((await doc.json()) as { info: { title: string } }).info.title).toBe("Test API");
});

test("a getter that fails is asked again at the next request", async () => {
  let n = 0;
  const { GET } = authHandler(() => {
    if (n++ === 0) throw new Error("not yet");
    return h.auth;
  });
  await expect(GET(new Request(`${h.base}/api/auth/ok`))).rejects.toThrow("not yet");
  expect((await GET(new Request(`${h.base}/api/auth/ok`))).status).toBe(200);
});
