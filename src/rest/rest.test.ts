// The REST route table, moved from noticebox (rest.test.ts, the parts that are not its operations): who is asking comes first, a `read`
// token may only GET, a body is at most 256 KiB of JSON its schema accepts, every error is `{error, code}`, the OpenAPI document lists every
// operation, and the table mirrors the app's MCP tools one for one. Two fixture operations stand in for an app's. The token tests at the end
// run Better Auth for real behind the sign-in test server (../signin/testing.ts), with restCaller deciding who a request is, as an app does.
import { afterAll, beforeAll, expect, test } from "vitest";
import * as z from "zod";
import { defineTool } from "../mcp/index.js";
import { personOf } from "../signin/person.js";
import { cookieOf, oauthFor, signIn, startHarness, type Harness } from "../signin/testing.js";
import { createApiToken, restCaller, type RestCaller } from "../tokens/index.js";
import { checkOpsMirrorTools, fail, openApiDocument, restRoute, type Op, type RestSettings } from "./index.js";

type Ctx = { things: string[] };

const OPS: Op<Ctx>[] = [
  {
    method: "GET",
    path: "/things",
    operationId: "listThings",
    tool: "list_things",
    summary: "The things",
    tag: "Things",
    query: z.object({ limit: z.coerce.number().int().min(1).max(10).default(10) }),
    ok: { status: 200, description: "Every thing", schema: z.object({ things: z.array(z.string()) }) },
    errors: [400, 401],
    handle: ({ ctx, query }) => ({ status: 200, body: { things: ctx.things.slice(0, query.limit as number) } }),
  },
  {
    method: "POST",
    path: "/things/{name}",
    operationId: "addThing",
    tool: "add_thing",
    summary: "Add a thing",
    tag: "Things",
    params: { name: "The thing's name" },
    body: z.object({ note: z.string().max(300_000) }),
    ok: { status: 201, description: "Added", schema: z.object({ name: z.string(), by: z.string() }) },
    errors: [400, 401, 403],
    handle: ({ ctx, caller, params }) => {
      if (ctx.things.includes(params.name!)) return fail(400, `"${params.name}" is there already`);
      ctx.things.push(params.name!);
      return { status: 201, body: { name: params.name, by: caller.actor } };
    },
  },
];

const BASE = "https://app.example";
const logs: string[] = [];
const SETTINGS: RestSettings = { base: BASE, log: (line) => void logs.push(line) };
const WRITER: RestCaller = { person: "u1", actor: "ada@example.com", scope: "read+write", kind: "token" };
const READER: RestCaller = { ...WRITER, scope: "read" };

function req(method: string, path: string, body?: string, base = BASE) {
  return new Request(`${base}/api/v1${path}`, { method, headers: body === undefined ? {} : { "content-type": "application/json" }, body });
}

const call = (method: string, path: string, caller: RestCaller | null, body?: unknown) =>
  restRoute(req(method, path, body === undefined ? undefined : JSON.stringify(body)), OPS, { things: ["a", "b"] }, caller, SETTINGS);

test("unauthorizedFirst", async () => {
  // A stranger learns nothing: not that a path exists, not that a method is wrong, not that a value would be refused.
  for (const [method, path, body] of [
    ["GET", "/things"],
    ["GET", "/things?limit=99"],
    ["POST", "/things/c", { note: 1 }],
    ["DELETE", "/things/c"],
    ["GET", "/nowhere"],
  ] as const) {
    const r = await call(method, path, null, body);
    expect(r.status, `${method} ${path}`).toBe(401);
    expect(await r.json()).toEqual({ error: "an API token or an access token for this API is needed", code: "unauthorized" });
    expect(r.headers.get("www-authenticate")).toBe(`Bearer resource_metadata="${BASE}/.well-known/oauth-protected-resource/api/v1"`);
  }
  // A caller does get told.
  expect((await call("GET", "/nowhere", WRITER)).status).toBe(404);
  const wrong = await call("DELETE", "/things/c", WRITER);
  expect(wrong.status).toBe(405);
  expect(wrong.headers.get("allow")).toBe("POST");
  expect(await wrong.json()).toEqual({ error: "method not allowed", code: "method_not_allowed" });
});

test("readOnlyGet", async () => {
  const read = await call("GET", "/things", READER);
  expect(read.status).toBe(200);
  expect(await read.json()).toEqual({ things: ["a", "b"] });
  expect(read.headers.get("cache-control")).toBe("no-store");
  expect((await call("HEAD", "/things", READER)).status).toBe(200);
  const refused = await call("POST", "/things/c", READER, { note: "hi" });
  expect(refused.status).toBe(403);
  expect(await refused.json()).toEqual({ error: "this token may only read", code: "forbidden" });
  const written = await call("POST", "/things/c", WRITER, { note: "hi" });
  expect(written.status).toBe(201);
  expect(await written.json()).toEqual({ name: "c", by: "ada@example.com" });
});

test("bodyTooLarge413", async () => {
  const big = JSON.stringify({ note: "x".repeat(256 * 1024) });
  const r = await restRoute(req("POST", "/things/c", big), OPS, { things: [] }, WRITER, SETTINGS);
  expect(r.status).toBe(413);
  expect(await r.json()).toEqual({ error: "the request body is larger than 256 KiB", code: "too_large" });
  // Counted in bytes, not characters: 100,000 three-byte characters are too many.
  expect((await call("POST", "/things/c", WRITER, { note: "€".repeat(100_000) })).status).toBe(413);
  expect((await call("POST", "/things/c", WRITER, { note: "x".repeat(200_000) })).status).toBe(201);
});

test("invalidBody400", async () => {
  const notJson = await restRoute(req("POST", "/things/c", "{nope"), OPS, { things: [] }, WRITER, SETTINGS);
  expect(notJson.status).toBe(400);
  expect(await notJson.json()).toEqual({ error: "the request body must be JSON", code: "invalid_input" });
  const wrong = await call("POST", "/things/c", WRITER, { note: 1 });
  expect(wrong.status).toBe(400);
  const { error, code } = (await wrong.json()) as { error: string; code: string };
  expect(code).toBe("invalid_input");
  expect(error).toContain("note");
  expect((await call("GET", "/things?limit=99", WRITER)).status).toBe(400);
  // A handler's own refusal is the same JSON.
  expect(await (await call("POST", "/things/a", WRITER, { note: "" })).json()).toEqual({ error: '"a" is there already', code: "invalid_input" });
  // A handler that throws answers 500 without details, and the app's log says which operation.
  const broken: Op<Ctx> = { ...OPS[0]!, handle: () => Promise.reject(new Error("disk full")) };
  const r = await restRoute(req("GET", "/things"), [broken], { things: [] }, WRITER, SETTINGS);
  expect(r.status).toBe(500);
  expect(await r.json()).toEqual({ error: "internal error", code: "internal" });
  expect(logs.at(-1)).toBe("api listThings: disk full");
});

test("openApiListsEveryOp", async () => {
  const doc = openApiDocument(OPS, { title: "Test API", version: "1", serverUrl: `${BASE}/api/v1` }) as {
    openapi: string;
    info: { title: string; version: string };
    servers: { url: string }[];
    paths: Record<string, Record<string, { operationId: string; description: string; security: unknown[]; responses: Record<string, unknown> }>>;
  };
  expect(doc.openapi).toBe("3.1.1");
  expect(doc.info).toMatchObject({ title: "Test API", version: "1" });
  expect(doc.servers).toEqual([{ url: `${BASE}/api/v1` }]);
  const listed = Object.entries(doc.paths).flatMap(([path, item]) => Object.entries(item).map(([m, o]) => `${m} ${path} ${o.operationId}`));
  expect(listed.sort()).toEqual(["get /things listThings", "post /things/{name} addThing"]);
  for (const item of Object.values(doc.paths)) for (const o of Object.values(item)) expect(o.security).toEqual([{ bearer: [] }]);
  expect(doc.paths["/things/{name}"]!.post!.description).toBe("The REST counterpart of the MCP tool `add_thing`.");
  // An operation with a body may answer 413, whether or not it lists it.
  expect(Object.keys(doc.paths["/things/{name}"]!.post!.responses).sort()).toEqual(["201", "400", "401", "403", "413"]);
  // Served without a token when the app asks restRoute to.
  const served = await restRoute(req("GET", "/openapi.json"), OPS, { things: [] }, null, { ...SETTINGS, openApi: { title: "Test API", version: "1" } });
  expect(served.status).toBe(200);
  expect(await served.json()).toEqual(doc);
});

const tool = (name: string) =>
  defineTool({ name, description: name, input: z.object({}), output: z.object({}), handle: async () => ({ guidance: [] as string[] }) });

test("opNamingUnknownToolFails", () => {
  expect(() => checkOpsMirrorTools(OPS, [tool("list_things"), tool("add_thing")])).not.toThrow();
  expect(() => checkOpsMirrorTools(OPS, [tool("list_things")])).toThrow("operations naming no MCP tool: addThing (add_thing)");
  const twice = [...OPS, { ...OPS[0]!, path: "/more" }];
  expect(() => checkOpsMirrorTools(twice, [tool("list_things"), tool("add_thing")])).toThrow("operationIds used twice: listThings");
});

test("toolWithoutOpFails", () => {
  expect(() => checkOpsMirrorTools(OPS, [tool("list_things"), tool("add_thing"), tool("remove_thing"), tool("rename_thing")])).toThrow(
    "MCP tools without an operation: remove_thing, rename_thing",
  );
});

test("opWithNoToolReasonAccepted", () => {
  const download: Op<Ctx> = {
    ...OPS[0]!,
    path: "/things/{name}/file",
    operationId: "getThingFile",
    tool: undefined,
    noTool: "the bytes of a file, which MCP can't carry",
  };
  expect(() => checkOpsMirrorTools([...OPS, download], [tool("list_things"), tool("add_thing")])).not.toThrow();
  // A tool still needs its operation, and an op still names a tool or says why not, never both.
  expect(() => checkOpsMirrorTools([download], [tool("list_things")])).toThrow("MCP tools without an operation: list_things");
  const neither = { ...download, noTool: undefined } as unknown as Op<Ctx>;
  expect(() => checkOpsMirrorTools([neither], [])).toThrow("operations naming neither an MCP tool nor why not: getThingFile");
  const both = { ...download, tool: "list_things" } as unknown as Op<Ctx>;
  expect(() => checkOpsMirrorTools([both, OPS[1]!], [tool("list_things"), tool("add_thing")])).toThrow(
    "operations naming both a tool and noTool: getThingFile",
  );
});

test("opWithEmptyNoToolReasonFails", () => {
  const silent: Op<Ctx> = { ...OPS[0]!, operationId: "silent", tool: undefined, noTool: "  " };
  expect(() => checkOpsMirrorTools([silent], [])).toThrow("operations naming neither an MCP tool nor why not: silent");
});

// Route-level token tests: restCaller as an app calls it, then restRoute.
let h: Harness;
let me = "";

beforeAll(async () => {
  h = await startHarness(["ada@example.com"]);
  me = (await personOf(new Headers({ cookie: cookieOf(await signIn(h, "ada@example.com")) }), h.auth))!.id;
});

afterAll(async () => {
  await h.close();
});

async function viaToken(method: string, path: string, token: string | null, body?: unknown) {
  const r = new Request(`${h.base}/api/v1${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return restRoute(r, OPS, { things: [] }, await restCaller(r, h.auth, h.settings), { base: h.base, log: () => {} });
}

test("tokensOnTheRoute", async () => {
  // No token and a forged one: 401, with the way to an access token.
  for (const token of [null, "tst_forged", "eyJforged.x.y"]) {
    const r = await viaToken("GET", "/things", token);
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toBe(`Bearer resource_metadata="${h.base}/.well-known/oauth-protected-resource/api/v1"`);
    const text = await r.text();
    if (token) expect(text).not.toContain(token);
  }
  // A `read` token reads and may not write.
  const read = await createApiToken(h.auth, me, { name: "r", scope: "read" });
  if ("error" in read) throw new Error(read.error);
  expect((await viaToken("GET", "/things", read.token)).status).toBe(200);
  const refused = await viaToken("POST", "/things/x", read.token, { note: "" });
  expect(refused.status).toBe(403);
  expect(await refused.text()).not.toContain(read.token);
  // An access token issued for /mcp is no caller here.
  const { tokens } = await oauthFor(h, `${h.base}/mcp`, "ada@example.com");
  expect((await viaToken("GET", "/things", tokens.access_token)).status).toBe(401);
});

const op = (method: Op<Ctx>["method"], path: string, id: string, errors: number[] = [401]): Op<Ctx> => ({
  method,
  path,
  operationId: id,
  noTool: "test fixture",
  summary: id,
  tag: "Things",
  params: Object.fromEntries([...path.matchAll(/\{(\w+)\}/g)].map((m) => [m[1]!, "a parameter"])),
  ok: { status: 200, description: "ok" },
  errors,
  handle: ({ params }) => ({ status: 200, body: { id, params } }),
});

test("conflict409: fail(409, …) answers {error, code: conflict}, and openApiDocument accepts 409 in errors", async () => {
  expect(fail(409, "it changed")).toEqual({ status: 409, body: { error: "it changed", code: "conflict" } });
  const doc = openApiDocument([op("PUT", "/x/{id}", "putX", [401, 409])], { title: "T", version: "1", serverUrl: BASE }) as {
    paths: Record<string, Record<string, { responses: Record<string, { description: string }> }>>;
  };
  expect(doc.paths["/x/{id}"]!.put!.responses["409"]!.description).toContain("`conflict`");
});

test("literalPathsWin: /x/export and /x/{id} each reach their own operation, in either order", async () => {
  const byParam = op("GET", "/x/{id}", "getX");
  const literal = op("GET", "/x/export", "exportX");
  for (const table of [
    [byParam, literal],
    [literal, byParam],
  ]) {
    const run = (path: string) => restRoute(req("GET", path), table, { things: [] }, WRITER, SETTINGS).then((r) => r.json());
    expect(await run("/x/export")).toEqual({ id: "exportX", params: {} });
    expect(await run("/x/abc")).toEqual({ id: "getX", params: { id: "abc" } });
  }
  // The literal route has only GET; a POST to it is the parameter route's own business, not a 405 for the literal one.
  const post = op("POST", "/x/{id}", "postX");
  const r = await restRoute(req("POST", "/x/export", "{}"), [literal, post], { things: [] }, WRITER, SETTINGS);
  expect(await r.json()).toEqual({ id: "postX", params: { id: "export" } });
});

test("a 405 and a 500 are never cached", async () => {
  const wrong = await call("DELETE", "/things", WRITER);
  expect(wrong.status).toBe(405);
  expect(wrong.headers.get("cache-control")).toBe("no-store");
  const broken: Op<Ctx> = { ...OPS[0]!, handle: () => Promise.reject(new Error("disk full")) };
  const r = await restRoute(req("GET", "/things"), [broken], { things: [] }, WRITER, SETTINGS);
  expect(r.status).toBe(500);
  expect(r.headers.get("cache-control")).toBe("no-store");
});

test("pathParamsMatchDeclared: openApiDocument refuses a path whose {params} differ from the operation's params", () => {
  const doc = (ops: Op<Ctx>[]) => () => openApiDocument(ops, { title: "T", version: "1", serverUrl: BASE });
  expect(doc([op("GET", "/x/{id}/y/{part}", "getPart")])).not.toThrow();
  // A parameter the path has and params leaves out would be undocumented; one params names and the path lacks never arrives.
  expect(doc([{ ...op("GET", "/x/{id}", "getX"), params: {} }])).toThrow("getX: the path's parameters {id} differ from params {}");
  expect(doc([{ ...op("GET", "/x", "listX"), params: { id: "an id" } }])).toThrow("listX: the path's parameters {} differ from params {id}");
  expect(doc([{ ...op("GET", "/x/{id}", "getX"), params: { ident: "an id" } }])).toThrow("getX: the path's parameters {id} differ from params {ident}");
  // An operation without params and a path without any is fine.
  expect(doc([{ ...op("GET", "/x", "listX"), params: undefined }])).not.toThrow();
});
