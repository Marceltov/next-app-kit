// next-app-kit/testing: what an app's tests and its end-to-end run use to be someone without a mail, a code or a provider. freshAuth opens
// Better Auth in the test's temporary DATA_DIR; signedInCookie makes a person and a session through Better Auth's server side, as the Better
// Auth convention's Tests bullet says; testSignInRoute hands that cookie to a browser, and exists only under <PREFIX>_E2E=1 outside
// production. callTool runs a tool as someone without a token.
import { existsSync } from "node:fs";
import { afterEach, expect, test, vi } from "vitest";
import * as z from "zod";
import { defineTool, type McpContext, type Who } from "../mcp/index.js";
import { openAuth } from "../signin/accounts.js";
import { personOf } from "../signin/person.js";
import { callTool, freshAuth, SignInRefused, signedInCookie, testSignInRoute } from "./index.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

test("freshAuth opens Better Auth with its auth.sqlite in the test's DATA_DIR", async () => {
  const { auth, signIn } = await freshAuth("TEST");
  expect(signIn.prefix).toBe("TEST");
  expect(signIn.file.startsWith(process.env.DATA_DIR!)).toBe(true);
  expect(existsSync(signIn.file)).toBe(true);
  expect((await auth.handler(new Request(`${signIn.baseUrl}/api/auth/ok`))).status).toBe(200);
  // Two are two: each has a file of its own.
  expect((await freshAuth("TEST")).signIn.file).not.toBe(signIn.file);
});

test("signedInCookie signs a person on the list in, the same person each time", async () => {
  const { auth } = await freshAuth("TEST", { allowed: ["ada@example.com"] });
  const cookie = await signedInCookie(auth, "Ada@Example.com");
  const ada = await personOf(new Headers({ cookie }), auth);
  expect(ada?.email).toBe("ada@example.com");
  const again = await personOf(new Headers({ cookie: await signedInCookie(auth, "ada@example.com") }), auth);
  expect(again?.id).toBe(ada?.id);
});

test("signedInCookie refuses an address not on the list, as any sign-in does", async () => {
  const { auth } = await freshAuth("TEST", { allowed: ["ada@example.com"] });
  await expect(signedInCookie(auth, "eve@example.com")).rejects.toThrow(SignInRefused);
  await expect(signedInCookie(auth, "eve@example.com")).rejects.toThrow(/eve@example.com/);
});

test("signedInCookie refuses a person already made once the address is taken off the list", async () => {
  const { auth, signIn } = await freshAuth("TEST", { allowed: ["ada@example.com", "bob@example.com"] });
  await signedInCookie(auth, "ada@example.com");
  // The list shrinks at a restart: the same auth.sqlite opened again with Ada no longer on it.
  const after = await openAuth({ ...signIn, allowed: ["bob@example.com"] }, { apiTokenPrefix: "test_", texts: { en: { subject: (c) => c, body: (c) => c } } });
  await expect(signedInCookie(after, "ada@example.com")).rejects.toThrow(SignInRefused);
  expect(await personOf(new Headers({ cookie: await signedInCookie(after, "bob@example.com") }), after)).toMatchObject({ email: "bob@example.com" });
});

test("testSignInRoute is off without <PREFIX>_E2E=1", async () => {
  vi.stubEnv("TEST_E2E", "");
  vi.stubEnv("NODE_ENV", "development");
  expect(testSignInRoute("TEST", async () => (await freshAuth("TEST")).auth)).toBeUndefined();
});

test("testRouteAbsentInProduction: no handler at all in production, even with <PREFIX>_E2E=1", async () => {
  vi.stubEnv("TEST_E2E", "1");
  vi.stubEnv("NODE_ENV", "production");
  let opened = false;
  expect(
    testSignInRoute("TEST", async () => {
      opened = true;
      return (await freshAuth("TEST")).auth;
    }),
  ).toBeUndefined();
  expect(opened).toBe(false);
});

test("testSignInRoute under <PREFIX>_E2E=1 outside production: a session cookie for the address, then the page asked for", async () => {
  vi.stubEnv("TEST_E2E", "1");
  vi.stubEnv("NODE_ENV", "development");
  const { auth, signIn } = await freshAuth("TEST", { allowed: ["ada@example.com"] });
  const route = testSignInRoute("TEST", () => auth)!;
  expect(route).toBeTypeOf("function");
  const r = await route(new Request(`${signIn.baseUrl}/api/test/sign-in?email=ada@example.com&next=/things`));
  expect(r.status).toBe(303);
  expect(r.headers.get("location")).toBe("/things");
  const set = r.headers.get("set-cookie") ?? "";
  expect(set).toMatch(/HttpOnly/i);
  const cookie = set.split(";")[0]!;
  expect((await personOf(new Headers({ cookie }), auth))?.email).toBe("ada@example.com");
  // Only a path of this instance, never another host.
  const away = await route(new Request(`${signIn.baseUrl}/api/test/sign-in?email=ada@example.com&next=//evil.example`));
  expect(away.headers.get("location")).toBe("/");
  // An address not on the list gets no cookie; no address is a bad request.
  const eve = await route(new Request(`${signIn.baseUrl}/api/test/sign-in?email=eve@example.com`));
  expect(eve.status).toBe(403);
  expect(eve.headers.get("set-cookie")).toBeNull();
  expect((await route(new Request(`${signIn.baseUrl}/api/test/sign-in`))).status).toBe(400);
});

test("testSignInRoute answers 500, not 403, when something other than the allowlist fails", async () => {
  vi.stubEnv("TEST_E2E", "1");
  vi.stubEnv("NODE_ENV", "development");
  const route = testSignInRoute("TEST", () => {
    throw new Error("auth.sqlite can't be opened");
  })!;
  const r = await route(new Request("http://localhost:3000/api/test/sign-in?email=ada@example.com"));
  expect(r.status).toBe(500);
  expect(r.headers.get("set-cookie")).toBeNull();
});

test("callTool runs a tool as someone, through the MCP server, without a token", async () => {
  const { auth, signIn } = await freshAuth("TEST");
  const whoami = defineTool({
    name: "whoami",
    description: "Who this call acts for.",
    input: z.object({}),
    output: z.object({ actor: z.string() }),
    handle: async (_input, who) => ({ actor: who.actor, guidance: ["Nothing else to do."] }),
  });
  const ctx: McpContext = { auth, signIn, tools: [whoami], serverInfo: { name: "t", version: "0" }, instructions: "", log: () => {} };
  const who: Who = { actor: "ada@example.com via Tests", person: "p1", clientId: "c1", base: signIn.baseUrl };
  expect((await callTool(ctx, who, "whoami", {})).structuredContent).toEqual({ actor: "ada@example.com via Tests", guidance: ["Nothing else to do."] });
});
