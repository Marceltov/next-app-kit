// The MCP endpoint's wiring, moved from noticebox (mcp.test.ts, the parts that are not its tools): who may reach the tools, in whose name
// they act, that a revoked connection, a deleted person or an address taken off the list stops at the next call, and that every result
// carries `guidance`. Better Auth runs for real behind the sign-in test server (../signin/testing.ts), and each client signs in through the
// whole OAuth dance, so the tokens here are the ones an MCP client holds. Two fixture tools stand in for an app's.
import { afterAll, beforeAll, expect, test } from "vitest";
import * as z from "zod";
import { personOf } from "../signin/person.js";
import { cookieOf, oauthFor, signIn, startHarness, type Harness } from "../signin/testing.js";
import { createApiToken } from "../tokens/index.js";
import { callTool } from "../testing/index.js";
import { connections, defineTool, mcpRoute, refuse, revokeConnection, type McpContext, type Tool, type Who } from "./index.js";
import { refusalOf } from "./tools.js";

const V = "2026-07-28";
const META = { "io.modelcontextprotocol/clientInfo": { name: "t", version: "0" }, "io.modelcontextprotocol/clientCapabilities": {} };

const whoami = defineTool({
  name: "whoami",
  description: "Who this call acts for.",
  input: z.object({ shout: z.boolean().default(false) }),
  output: z.object({ actor: z.string(), person: z.string() }),
  annotations: { readOnlyHint: true },
  handle: async ({ shout }, who) => ({
    actor: shout ? who.actor.toUpperCase() : who.actor,
    person: who.person,
    guidance: [`Show the user ${who.base}/settings to see their connections.`],
  }),
});

const echo = defineTool({
  name: "echo",
  description: "Says the text back; refuses an empty one.",
  input: z.object({ text: z.string() }),
  output: z.object({ text: z.string() }),
  handle: async ({ text }) => (text ? { text, guidance: [`Said "${text}".`] } : refuse("nothing to say")),
});

let h: Harness;
let ctx: McpContext;

beforeAll(async () => {
  h = await startHarness(["ada@example.com", "anna@example.com", "leaver@example.com", "gone@example.com"]);
  ctx = { auth: h.auth, signIn: h.settings, tools: [whoami, echo], serverInfo: { name: "test-app", version: "0.0.1" }, instructions: "A test app." };
});

afterAll(async () => {
  await h.close();
});

/** One JSON-RPC request to /mcp through mcpRoute, as an MCP client sends it. */
function rpc(method: string, params: Record<string, unknown> = {}, headers: Record<string, string> = {}, c: McpContext = ctx) {
  const name: Record<string, string> = typeof params.name === "string" ? { "mcp-name": params.name } : {};
  const req = new Request(`${h.base}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-protocol-version": V,
      "mcp-method": method,
      ...name,
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { ...params, _meta: { "io.modelcontextprotocol/protocolVersion": V, ...META } } }),
  });
  return mcpRoute(req, c);
}

type Result = { isError?: boolean; structuredContent: Record<string, unknown>; content: { text: string }[] };
type Listed = { name: string; annotations?: Record<string, unknown>; outputSchema: { properties: Record<string, unknown>; required: string[] } };

/** A client the person allowed, through the OAuth dance: its bearer, and calls with it. */
async function client(email = "ada@example.com") {
  const { tokens, client_id } = await oauthFor(h, `${h.base}/mcp`, email);
  const auth = { authorization: `Bearer ${tokens.access_token}` };
  return {
    auth,
    clientId: client_id,
    call: async (name: string, args: Record<string, unknown> = {}) => {
      const r = await rpc("tools/call", { name, arguments: args }, auth);
      return { status: r.status, result: r.status === 200 ? ((await r.json()) as { result: Result }).result : null };
    },
    list: async () => ((await (await rpc("tools/list", {}, auth)).json()) as { result: { tools: Listed[] } }).result.tools,
  };
}

const personId = async (email: string) => (await personOf(new Headers({ cookie: cookieOf(await signIn(h, email)) }), h.auth))!.id;

test("toolsActAsPersonViaClient", async () => {
  const ada = await client();
  expect((await ada.list()).map((t) => t.name).sort()).toEqual(["echo", "whoami"]);
  const me = await ada.call("whoami");
  expect(me.status).toBe(200);
  expect(me.result!.structuredContent).toEqual({
    actor: "ada@example.com via Claude",
    person: await personId("ada@example.com"),
    guidance: [`Show the user ${h.base}/settings to see their connections.`],
  });
  expect(JSON.parse(me.result!.content[0]!.text)).toEqual(me.result!.structuredContent);
  expect((await ada.call("whoami", { shout: true })).result!.structuredContent.actor).toBe("ADA@EXAMPLE.COM VIA CLAUDE");
  // A refusal is a tool error with its message, not a result.
  const refused = (await ada.call("echo", { text: "" })).result!;
  expect(refused.isError).toBe(true);
  expect(refused.content[0]!.text).toBe("nothing to say");
});

test("foreignOriginRefused", async () => {
  const ada = await client();
  // The origin is checked before any token: a page of another site can't drive the endpoint, even with a good token.
  expect((await rpc("tools/list", {}, { ...ada.auth, origin: "https://evil.example" })).status).toBe(403);
  expect((await rpc("tools/list", {}, { ...ada.auth, origin: "null" })).status).toBe(403);
  expect((await rpc("tools/list", {}, { origin: "https://evil.example" })).status).toBe(403);
  // The whole origin counts, scheme and port included: the same host over another scheme is another origin.
  const other = new URL(h.base);
  other.protocol = "https:";
  expect((await rpc("tools/list", {}, { ...ada.auth, origin: other.origin })).status).toBe(403);
  expect((await rpc("tools/list", {}, { ...ada.auth, origin: h.base })).status).toBe(200);
  expect((await rpc("tools/list", {}, ada.auth)).status).toBe(200);
});

test("noTokenGetsTheWayToSignIn", async () => {
  const none = await rpc("tools/list");
  expect(none.status).toBe(401);
  expect(none.headers.get("www-authenticate")).toContain(`resource_metadata="${h.base}/.well-known/oauth-protected-resource/mcp"`);
  expect((await rpc("tools/list", {}, { authorization: "Bearer abc.def" })).status).toBe(401);
  const { tokens } = await oauthFor(h, `${h.base}/mcp`, "ada@example.com");
  expect((await rpc("tools/list", {}, { authorization: `Bearer ${tokens.access_token.slice(0, -4)}AAAA` })).status).toBe(401);
});

test("apiTokenRefusedOnMcp", async () => {
  const key = await createApiToken(h.auth, await personId("ada@example.com"), { name: "script", scope: "read+write" });
  if ("error" in key) throw new Error(key.error);
  expect((await rpc("tools/list", {}, { authorization: `Bearer ${key.token}` })).status).toBe(401);
  expect((await rpc("tools/list", {}, { "x-api-key": key.token })).status).toBe(401);
  // An OAuth token issued for /api/v1 is no /mcp token either.
  const forApi = await oauthFor(h, `${h.base}/api/v1`, "ada@example.com", { resources: [`${h.base}/api/v1`] });
  expect((await rpc("tools/list", {}, { authorization: `Bearer ${forApi.tokens.access_token}` })).status).toBe(401);
});

test("sessionCookieRefusedOnMcp", async () => {
  const cookie = cookieOf(await signIn(h, "ada@example.com"));
  expect(await personOf(new Headers({ cookie }), h.auth)).not.toBeNull();
  expect((await rpc("tools/list", {}, { cookie })).status).toBe(401);
  expect((await rpc("tools/list", {}, { cookie, origin: h.base })).status).toBe(401);
});

test("revokedConnectionRefused", async () => {
  const ada = await client();
  const other = await client();
  const anna = await client("anna@example.com");
  const me = await personId("ada@example.com");
  const annaId = await personId("anna@example.com");
  const mine = await connections(h.auth, me);
  const c = mine.find((x) => x.client_id === ada.clientId)!;
  expect(c).toMatchObject({ client_name: "Claude" });
  // Only the person who allowed a client revokes it.
  expect(await revokeConnection(h.auth, annaId, c.id)).toEqual({ ok: false, error: "no such connection" });
  expect((await ada.call("whoami")).status).toBe(200);
  expect(await revokeConnection(h.auth, me, c.id)).toEqual({ ok: true });
  // Its token stops at the next call, well within its 600 seconds; the person's other connections and anna's go on.
  const refused = await rpc("tools/list", {}, ada.auth);
  expect(refused.status).toBe(401);
  expect(await refused.text()).toContain("this connection was revoked");
  expect((await connections(h.auth, me)).map((x) => x.id)).not.toContain(c.id);
  expect((await other.call("whoami")).status).toBe(200);
  expect((await anna.call("whoami")).status).toBe(200);
  expect(await revokeConnection(h.auth, me, c.id)).toEqual({ ok: false, error: "no such connection" });
});

test("deletedPersonRefused", async () => {
  const gone = await client("gone@example.com");
  expect((await gone.call("whoami")).status).toBe(200);
  const auth = await h.auth.$context;
  await auth.internalAdapter.deleteUser(await personId("gone@example.com"));
  expect((await rpc("tools/list", {}, gone.auth)).status).toBe(401);
});

test("removedAddressTokenRefused", async () => {
  const leaver = await client("leaver@example.com");
  expect((await leaver.call("whoami")).status).toBe(200);
  // Taken off the list (the settings Better Auth reads, changed in place): the next call is refused, not the one after the token expires.
  const at = h.settings.allowed.indexOf("leaver@example.com");
  h.settings.allowed.splice(at, 1);
  try {
    const refused = await rpc("tools/list", {}, leaver.auth);
    expect(refused.status).toBe(401);
    expect(await refused.text()).toContain("no longer");
  } finally {
    h.settings.allowed.splice(at, 0, "leaver@example.com");
  }
  expect((await leaver.call("whoami")).status).toBe(200);
});

test("outputSchemaHasGuidance", async () => {
  const tools = await (await client()).list();
  for (const t of tools) {
    expect(t.outputSchema.properties.guidance, t.name).toEqual({ type: "array", items: { type: "string" } });
    expect(t.outputSchema.required, t.name).toContain("guidance");
    expect(t.outputSchema.properties.next, t.name).toBeUndefined();
  }
  expect(tools.find((t) => t.name === "whoami")!.annotations).toMatchObject({ readOnlyHint: true });
  // The kit adds guidance; a tool that declares it itself is a mistake caught when it is defined.
  expect(() =>
    defineTool({
      name: "twice",
      description: "",
      input: z.object({}),
      output: z.object({ guidance: z.array(z.string()) }),
      handle: async () => ({ guidance: [] }),
    }),
  ).toThrow(/guidance/);
});

test("toolWithoutGuidanceRejected", async () => {
  const bare = defineTool({
    name: "bare",
    description: "Forgets its guidance.",
    input: z.object({}),
    output: z.object({ n: z.number() }),
    // @ts-expect-error a result without guidance does not compile
    handle: async () => ({ n: 1 }),
  });
  const who: Who = { actor: "ada@example.com via Claude", person: "p", clientId: "c", base: h.base };
  await expect(bare.run({}, who)).rejects.toThrow("bare: a result needs guidance: string[]");
  const withBare: McpContext = { ...ctx, tools: [bare, ...ctx.tools] };
  const r = await callTool(withBare, who, "bare", {});
  expect(r.isError).toBe(true);
  expect(r.structuredContent).toBeUndefined();
  // Guidance that is not a list of strings is no guidance either.
  const odd = defineTool({
    name: "odd",
    description: "",
    input: z.object({}),
    output: z.object({}),
    handle: async () => ({ guidance: [1] as unknown as string[] }),
  });
  await expect(odd.run({}, who)).rejects.toThrow("odd: a result needs guidance: string[]");
});

test("callToolRunsAsWho", async () => {
  const who: Who = { actor: "someone via Tests", person: "p1", clientId: "c1", base: h.base };
  const r = await callTool(ctx, who, "whoami", {});
  expect(r.structuredContent).toMatchObject({ actor: "someone via Tests", person: "p1" });
  expect((await callTool(ctx, who, "echo", { text: "" })).isError).toBe(true);
  const tools: Tool[] = ctx.tools;
  expect(tools).toHaveLength(2);
});

test("refusalOfAnythingElseIsNull", () => {
  expect(refusalOf(refuse("no"))).toBe("no");
  for (const r of [null, undefined, "no", 1, { guidance: [] }]) expect(refusalOf(r)).toBeNull();
});
