// API tokens and who a REST request is, moved from noticebox (rest.test.ts, accounts.test.ts and mcp.test.ts, the token-level parts): a token
// is shown once and stored hashed, lives 90 days unless chosen otherwise and at most 365, carries its scope, and works on /api/v1 only; an
// /mcp OAuth token, a session cookie, a revoked or expired key and the key of an address taken off the list are no REST caller. Better Auth
// runs for real behind the sign-in test server (../signin/testing.ts), over an auth.sqlite in the test's temporary DATA_DIR.
import { requireMcpAuth } from "@better-auth/mcp";
import { afterAll, beforeAll, expect, test } from "vitest";
import { personOf } from "../signin/person.js";
import { API_TOKEN_PREFIX, cookieOf, oauthFor, signIn, startHarness, type Harness } from "../signin/testing.js";
import { connections, revokeConnection } from "../mcp/connections.js";
import { createApiToken, listApiTokens, revokeApiToken, restCaller, type Scope } from "./index.js";

let h: Harness;
let me = "";
let other = "";

beforeAll(async () => {
  h = await startHarness(["ada@example.com", "anna@example.com", "leaver@example.com"]);
  me = (await personOf(new Headers({ cookie: cookieOf(await signIn(h, "ada@example.com")) }), h.auth))!.id;
  other = (await personOf(new Headers({ cookie: cookieOf(await signIn(h, "anna@example.com")) }), h.auth))!.id;
});

afterAll(async () => {
  await h.close();
});

async function tokenFor(person: string, scope: Scope = "read+write", expiresInDays?: number | null) {
  const t = await createApiToken(h.auth, person, { name: "script", scope, expiresInDays });
  if ("error" in t) throw new Error(t.error);
  return t;
}

const bearer = (token: string, extra: Record<string, string> = {}) =>
  new Request(`${h.base}/api/v1/forms`, { headers: { authorization: `Bearer ${token}`, ...extra } });

const callerOf = (token: string) => restCaller(bearer(token), h.auth, h.settings);

test("shownOnce", async () => {
  const made = await tokenFor(me, "read");
  expect(made.token.startsWith(API_TOKEN_PREFIX)).toBe(true);
  expect(made).toMatchObject({ name: "script", scope: "read", start: made.token.slice(0, 6), last_used_at: null });

  // The list never holds the token itself, only what tells it apart; each person sees only their own.
  const listed = await listApiTokens(h.auth, me);
  expect(listed.map((t) => t.id)).toContain(made.id);
  expect(JSON.stringify(listed)).not.toContain(made.token);
  expect(listed.find((t) => t.id === made.id)).toEqual({ ...made, token: undefined, last_used_at: null });
  expect(await listApiTokens(h.auth, other)).toEqual([]);

  // Using it records when, which the list then shows.
  expect(await callerOf(made.token)).toEqual({ person: me, actor: "ada@example.com", scope: "read", kind: "token" });
  expect((await listApiTokens(h.auth, me)).find((t) => t.id === made.id)!.last_used_at).not.toBeNull();

  // Names: required, at most 60 characters.
  expect(await createApiToken(h.auth, me, { name: "  ", scope: "read" })).toEqual({ error: "a token needs a name of up to 60 characters" });
  expect(await createApiToken(h.auth, me, { name: "x".repeat(61), scope: "read" })).toEqual({ error: "a token needs a name of up to 60 characters" });
  expect(await createApiToken(h.auth, me, { name: "x", scope: "admin" as Scope })).toEqual({ error: 'the scope is "read" or "read+write"' });
});

test("storedHashed", async () => {
  const tokens = [await tokenFor(me), await tokenFor(me, "read"), await tokenFor(other)];
  const ctx = await h.auth.$context;
  const rows = JSON.stringify(await ctx.adapter.findMany({ model: "apikey" }));
  for (const t of tokens) expect(rows).not.toContain(t.token);
  for (const t of tokens) expect(rows).not.toContain(t.token.slice(API_TOKEN_PREFIX.length));
});

test("expiryDefault90Max365", async () => {
  const days = (iso: string | null) => (new Date(iso!).getTime() - Date.now()) / 86400000;
  const standard = await tokenFor(me);
  expect(days(standard.expires_at)).toBeGreaterThan(89.9);
  expect(days(standard.expires_at)).toBeLessThanOrEqual(90);
  expect(days((await tokenFor(me, "read", 365)).expires_at)).toBeGreaterThan(364.9);
  expect(days((await tokenFor(me, "read", 1)).expires_at)).toBeGreaterThan(0.9);
  // No expiry only when chosen explicitly (noticebox ADR 0002).
  expect((await tokenFor(me, "read", null)).expires_at).toBeNull();
  const refused = { error: "a token lives 1 to 365 days, or has no expiry when chosen explicitly" };
  for (const d of [366, 400, 0, -1, 1.5, Number.NaN]) expect(await createApiToken(h.auth, me, { name: "x", scope: "read", expiresInDays: d })).toEqual(refused);
});

test("readCannotWrite", async () => {
  const read = await tokenFor(me, "read");
  const write = await tokenFor(me, "read+write");
  expect(await callerOf(read.token)).toEqual({ person: me, actor: "ada@example.com", scope: "read", kind: "token" });
  expect(await callerOf(write.token)).toEqual({ person: me, actor: "ada@example.com", scope: "read+write", kind: "token" });
  // The scope is the key's permissions on the `api` resource, which the plugin keeps; nothing else grants write.
  const ctx = await h.auth.$context;
  const row = (await ctx.adapter.findOne<{ permissions: unknown }>({ model: "apikey", where: [{ field: "id", value: read.id }] }))!;
  expect(JSON.parse(String(row.permissions))).toEqual({ api: ["read"] });
});

test("apiTokenRefusedOnMcp", async () => {
  // The /mcp check takes only an access token issued for /mcp: an API token is none (and through mcpRoute: ../mcp/mcp.test.ts).
  const write = await tokenFor(me);
  let reached = false;
  const gate = requireMcpAuth(
    h.auth,
    async () => {
      reached = true;
      return new Response("tools");
    },
    { resource: `${h.base}/mcp`, jwksUrl: h.settings.jwksUrl },
  );
  const r = await gate(new Request(`${h.base}/mcp`, { method: "POST", headers: { authorization: `Bearer ${write.token}` }, body: "{}" }));
  expect(r.status).toBe(401);
  expect(reached).toBe(false);
  // Nor is it a browser session, in either header the plugin knows.
  expect(await personOf(new Headers({ authorization: `Bearer ${write.token}` }), h.auth)).toBeNull();
  expect(await personOf(new Headers({ "x-api-key": write.token }), h.auth)).toBeNull();

  // The same gate does take an /mcp token: the refusal above is the token's, not the gate's.
  const { tokens } = await oauthFor(h, `${h.base}/mcp`, "ada@example.com");
  expect((await gate(new Request(`${h.base}/mcp`, { method: "POST", headers: { authorization: `Bearer ${tokens.access_token}` }, body: "{}" }))).status).toBe(
    200,
  );
});

test("mcpTokenRefusedOnRest", async () => {
  // An OAuth access token issued for /api/v1 is a REST caller, with the person's full rights; one for /mcp is not.
  const forApi = await oauthFor(h, `${h.base}/api/v1`, "ada@example.com", { resources: [`${h.base}/api/v1`] });
  // Its actor names the client too, as /mcp's do: records say "<email> via <client>".
  expect(await callerOf(forApi.tokens.access_token)).toEqual({ person: me, actor: "ada@example.com via Claude", scope: "read+write", kind: "oauth" });
  const forMcp = await oauthFor(h, `${h.base}/mcp`, "ada@example.com");
  expect(await callerOf(forMcp.tokens.access_token)).toBeNull();
  // A tampered /api/v1 token, a forged key, no token and a session cookie are no caller either.
  expect(await callerOf(`${forApi.tokens.access_token.slice(0, -4)}AAAA`)).toBeNull();
  expect(await callerOf(`${API_TOKEN_PREFIX}forged`)).toBeNull();
  expect(await callerOf("")).toBeNull();
  const cookie = cookieOf(await signIn(h, "ada@example.com"));
  expect(await restCaller(new Request(`${h.base}/api/v1/forms`, { headers: { cookie } }), h.auth, h.settings)).toBeNull();
  expect(await restCaller(new Request(`${h.base}/api/v1/forms`, { headers: { authorization: `Basic ${btoa("a:b")}` } }), h.auth, h.settings)).toBeNull();
});

test("revokedRefused", async () => {
  const read = await tokenFor(me, "read");
  expect(await callerOf(read.token)).not.toBeNull();
  // Only its owner revokes it.
  expect(await revokeApiToken(h.auth, other, read.id)).toEqual({ ok: false, error: "no such token" });
  expect(await callerOf(read.token)).not.toBeNull();
  expect(await revokeApiToken(h.auth, me, read.id)).toEqual({ ok: true });
  expect(await callerOf(read.token)).toBeNull();
  expect((await listApiTokens(h.auth, me)).map((t) => t.id)).not.toContain(read.id);
  expect(await revokeApiToken(h.auth, me, read.id)).toEqual({ ok: false, error: "no such token" });

  // An expired one is refused like a revoked one.
  const short = await tokenFor(me, "read", 1);
  const ctx = await h.auth.$context;
  await ctx.adapter.update({ model: "apikey", where: [{ field: "id", value: short.id }], update: { expiresAt: new Date(Date.now() - 1000) } });
  expect(await callerOf(short.token)).toBeNull();
});

test("revokedConnectionRefusedOnRest", async () => {
  // A script's OAuth token for /api/v1 stands on the person's consent as an MCP client's does: revoking the connection stops it at the next
  // call, not when it expires. Their other connection goes on.
  const script = await oauthFor(h, `${h.base}/api/v1`, "ada@example.com", { resources: [`${h.base}/api/v1`] });
  const kept = await oauthFor(h, `${h.base}/api/v1`, "ada@example.com", { resources: [`${h.base}/api/v1`] });
  expect(await callerOf(script.tokens.access_token)).not.toBeNull();
  const c = (await connections(h.auth, me)).find((x) => x.client_id === script.client_id)!;
  expect(await revokeConnection(h.auth, me, c.id)).toEqual({ ok: true });
  expect(await callerOf(script.tokens.access_token)).toBeNull();
  expect(await callerOf(kept.tokens.access_token)).not.toBeNull();
});

test("removedAddressKeyRefused", async () => {
  const leaver = (await personOf(new Headers({ cookie: cookieOf(await signIn(h, "leaver@example.com")) }), h.auth))!.id;
  const key = await tokenFor(leaver);
  const { tokens } = await oauthFor(h, `${h.base}/api/v1`, "leaver@example.com", { resources: [`${h.base}/api/v1`] });
  expect((await callerOf(key.token))?.actor).toBe("leaver@example.com");
  expect((await callerOf(tokens.access_token))?.actor).toBe("leaver@example.com via Claude");
  // Taken off the list (the settings Better Auth reads, changed in place): neither the key nor the OAuth token is a caller any more. The
  // key is kept, for when the address is put back.
  const at = h.settings.allowed.indexOf("leaver@example.com");
  h.settings.allowed.splice(at, 1);
  try {
    expect(await callerOf(key.token)).toBeNull();
    expect(await callerOf(tokens.access_token)).toBeNull();
    expect((await listApiTokens(h.auth, leaver)).map((t) => t.id)).toContain(key.id);
  } finally {
    h.settings.allowed.splice(at, 0, "leaver@example.com");
  }
  expect((await callerOf(key.token))?.actor).toBe("leaver@example.com");
});
