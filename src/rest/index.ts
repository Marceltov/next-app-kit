// next-app-kit/rest: an app's REST API, /api/v1, defined in code as a table of operations, moved from noticebox (backend/rest.ts, the table
// machinery; its operations stay in noticebox). The table is the API's single source: `restRoute` serves requests through it and
// `openApiDocument` describes it (an app commits the result as openapi.json and a test fails when it is stale). MCP comes first: every
// operation names the tool it mirrors and `checkOpsMirrorTools` fails an app's test when an operation names no tool or a tool has no
// operation. An operation no tool can mirror (the bytes of a file) says why in `noTool` instead; noticebox had no such way out. Handlers
// call the same domain functions as the tools; what a tool adds for an assistant (`guidance`) stays out. Callers are API tokens and OAuth
// tokens for /api/v1 (next-app-kit/tokens); a `read` token may only GET. Where this differs from noticebox: an operation is generic over the
// app's context (`ctx` in place of `rt`); the app decides who the caller is (restCaller) and passes it in, and a request without one gets
// 401 before anything else, an unknown path or method included; a body over 256 KiB (counted in bytes, read no further) answers 413, not
// 400; the OpenAPI title, version, licence, tags and texts are the app's. Conditional GETs (not in noticebox): an operation sees the request's
// headers and may return an ETag with its 200; restRoute then answers a request whose If-None-Match names it 304 without the body, so a
// client that polls a file (the site build fetching every photo) moves only what changed.
import * as z from "zod";
import type { Tool } from "../mcp/tools.js";
import type { RestCaller } from "../tokens/index.js";

export const API_PREFIX = "/api/v1";

/** The largest JSON body read: a form with many fields is a few kilobytes. */
export const MAX_BODY_BYTES = 256 * 1024;

/**
 * A handler's answer: JSON (`body`), nothing (no `body`), or a Response of its own that is not JSON, such as a file (`raw`). `etag` (a
 * quoted entity tag, `"<hash>"`) goes out as the ETag header; on a GET's or HEAD's 200 a request whose If-None-Match names it is answered 304.
 */
export type Reply = { status: number; body?: unknown; raw?: Response; etag?: string };

/**
 * What a handler gets: the app's context, the base URL, the caller, the path parameters, query and body its schemas have parsed, and the
 * request's headers.
 */
export type Input<Ctx> = {
  ctx: Ctx;
  base: string;
  caller: RestCaller;
  params: Record<string, string>;
  query: Record<string, unknown>;
  body: unknown;
  headers: Headers;
};

/**
 * One operation of the table. It names the MCP tool it mirrors (`tool`), or, where no tool can do what it does (the bytes of a file), says
 * why not (`noTool`, a reason that is not empty); never both.
 */
export type Op<Ctx> = ({ tool: string; noTool?: undefined } | { tool?: undefined; noTool: string }) & {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string; // under /api/v1, with {params}
  operationId: string;
  summary: string;
  tag: string;
  params?: Record<string, string>; // name: description
  query?: z.ZodObject;
  body?: z.ZodType;
  // `binary`: the bytes of a file, not JSON; `etag`: the 200 carries an ETag and the operation may answer 304 (documented as such).
  ok: { status: number; description: string; schema?: z.ZodType; binary?: boolean; etag?: boolean };
  errors: number[];
  handle: (input: Input<Ctx>) => Promise<Reply> | Reply;
};

/** What the OpenAPI document says about the app besides its operations. */
export type OpenApiInfo = {
  title: string;
  version: string;
  /** What the API is for; the kit adds a paragraph on errors. */
  description?: string;
  license?: { name: string; identifier: string };
  tags?: { name: string; description: string }[];
  /** What a bearer is here: the app's token prefix and where tokens are made. */
  bearer?: string;
};

/** What restRoute needs besides the table: the configured base URL (PUBLIC_URL, never taken from the request), the app's log, and, to serve
 * /api/v1/openapi.json without a token, what the document says about the app. */
export type RestSettings = { base: string; log: (line: string) => void; openApi?: OpenApiInfo };

const ErrorJson = z.object({ error: z.string(), code: z.string() });
const ERRORS: Record<number, [string, string]> = {
  400: ["invalid_input", "The request can't be read, or a value in it is not acceptable"],
  401: ["unauthorized", "No valid API token or OAuth access token for this API"],
  403: ["forbidden", "The token's scope is `read`, and this changes something"],
  404: ["not_found", "No such thing"],
  409: ["conflict", "The request conflicts with the current state of the thing, such as a name that is taken"],
  413: ["too_large", "The request body is larger than 256 KiB"],
};

/** A refusal as every error is answered: `{error, code}`, the code from the status. The message is English and never holds a token. A handler
 * that throws is answered 500 and its message is logged through `settings.log`, so an error message must not carry a secret either. */
export const fail = (status: number, error: string): Reply => ({ status, body: { error, code: ERRORS[status]?.[0] ?? "internal" } });

/** Whether an If-None-Match header (a list of tags, weak ones allowed, or `*`) names `etag`. An app's own route that serves files uses it too. */
export function etagMatches(ifNoneMatch: string | null, etag: string): boolean {
  if (!ifNoneMatch) return false;
  const strong = etag.replace(/^W\//, "");
  return ifNoneMatch.split(",").some((t) => {
    const tag = t.trim();
    return tag === "*" || tag.replace(/^W\//, "") === strong;
  });
}

/** Every operation whose path fits, each with its own path parameters, the one with the most literal segments first: `/x/export` wins over `/x/{id}`. */
function match<Ctx>(ops: Op<Ctx>[], segments: string[]): { op: Op<Ctx>; params: Record<string, string> }[] {
  const found: { op: Op<Ctx>; params: Record<string, string>; literals: number }[] = [];
  for (const op of ops) {
    const tpl = op.path.slice(1).split("/");
    if (tpl.length !== segments.length) continue;
    const params: Record<string, string> = {};
    let literals = 0;
    if (tpl.every((t, i) => (t.startsWith("{") ? ((params[t.slice(1, -1)] = segments[i]!), true) : t === segments[i] && ++literals)))
      found.push({ op, params, literals });
  }
  return found.sort((x, y) => y.literals - x.literals);
}

const complaint = (error: z.ZodError) => z.prettifyError(error).replace(/\s+/g, " ").replace(/^✖ /, "");

/** The body, read only up to the cap: a client that sends more is stopped there, not buffered whole. */
async function cappedText(req: Request): Promise<string | null> {
  if (Number(req.headers.get("content-length") ?? 0) > MAX_BODY_BYTES) return null;
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function jsonBody(req: Request, schema: z.ZodType): Promise<{ ok: true; data: unknown } | { ok: false; reply: Reply }> {
  const text = await cappedText(req);
  if (text === null) return { ok: false, reply: fail(413, "the request body is larger than 256 KiB") };
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, reply: fail(400, "the request body must be JSON") };
  }
  const parsed = schema.safeParse(json);
  return parsed.success ? { ok: true, data: parsed.data } : { ok: false, reply: fail(400, complaint(parsed.error)) };
}

/**
 * /api/v1/…: who is asking comes first, so a stranger learns nothing, not even that a path exists or a parameter is wrong. `caller` is
 * restCaller's answer for this request; `ctx` is handed to the operation as it is.
 */
export async function restRoute<Ctx>(req: Request, ops: Op<Ctx>[], ctx: Ctx, caller: RestCaller | null, settings: RestSettings): Promise<Response> {
  const { base } = settings;
  const path = new URL(req.url).pathname;
  const segments = path.startsWith(`${API_PREFIX}/`) ? path.slice(API_PREFIX.length + 1).split("/") : null;
  if (settings.openApi && segments?.length === 1 && segments[0] === "openapi.json" && req.method === "GET")
    return Response.json(openApiDocument(ops, { ...settings.openApi, serverUrl: base + API_PREFIX }), { headers: { "cache-control": "no-store" } });
  const challenge = { "www-authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource${API_PREFIX}"` };
  const send = (r: Reply) => {
    // A reply with an ETag may be kept and asked about again; any other JSON is never stored.
    const cache = r.raw?.headers.get("cache-control") ?? (r.etag ? "private, no-cache" : "no-store");
    // Only a read is answered 304 (RFC 9110 13.1.2): a write that returns an ETag its caller already held still sends its answer.
    const read = req.method === "GET" || req.method === "HEAD";
    if (read && r.etag && r.status === 200 && etagMatches(req.headers.get("if-none-match"), r.etag)) {
      void r.raw?.body?.cancel();
      return new Response(null, { status: 304, headers: { etag: r.etag, "cache-control": cache } });
    }
    if (r.raw) {
      if (r.etag && !r.raw.headers.has("etag")) {
        const headers = new Headers(r.raw.headers);
        headers.set("etag", r.etag);
        return new Response(r.raw.body, { status: r.raw.status, statusText: r.raw.statusText, headers });
      }
      return r.raw;
    }
    const etag = r.etag ? { etag: r.etag } : {};
    return r.body === undefined
      ? new Response(null, { status: r.status, headers: etag })
      : Response.json(r.body, { status: r.status, headers: { "cache-control": cache, ...etag, ...(r.status === 401 ? challenge : {}) } });
  };
  if (!caller) return send(fail(401, "an API token or an access token for this API is needed"));
  const candidates = segments ? match(ops, segments) : [];
  if (!candidates.length) return send(fail(404, "no such endpoint"));
  const method = req.method === "HEAD" ? "GET" : req.method;
  const found = candidates.find((c) => c.op.method === method);
  if (!found)
    return Response.json(
      { error: "method not allowed", code: "method_not_allowed" },
      { status: 405, headers: { Allow: [...new Set(candidates.map((c) => c.op.method))].join(", "), "cache-control": "no-store" } },
    );
  const { op } = found;
  if (op.method !== "GET" && caller.scope !== "read+write") return send(fail(403, "this token may only read"));
  let query: Record<string, unknown> = {};
  if (op.query) {
    const raw = Object.fromEntries([...new URL(req.url).searchParams].filter(([, v]) => v !== ""));
    const parsed = op.query.safeParse(raw);
    if (!parsed.success) return send(fail(400, complaint(parsed.error)));
    query = parsed.data;
  }
  let body: unknown;
  if (op.body) {
    const b = await jsonBody(req, op.body);
    if (!b.ok) return send(b.reply);
    body = b.data;
  }
  let params: Record<string, string>;
  try {
    params = Object.fromEntries(Object.entries(found.params).map(([k, v]) => [k, decodeURIComponent(v)]));
  } catch {
    return send(fail(400, "a path parameter is not valid percent-encoding"));
  }
  try {
    return send(await op.handle({ ctx, base, caller, params, query, body, headers: req.headers }));
  } catch (e) {
    settings.log(`api ${op.operationId}: ${(e as Error).message}`);
    return Response.json({ error: "internal error", code: "internal" }, { status: 500, headers: { "cache-control": "no-store" } });
  }
}

const jsonSchema = (s: z.ZodType, io: "input" | "output") => {
  const { $schema: _drop, ...rest } = z.toJSONSchema(s, { io, unrepresentable: "any" }) as Record<string, unknown>;
  void _drop;
  return rest;
};

/**
 * The OpenAPI 3.1 description of the table, served at /api/v1/openapi.json and committed by the app as openapi.json. Throws when an
 * operation's path parameters (`{name}`) and its `params` are not the same names.
 */
export function openApiDocument<Ctx>(ops: Op<Ctx>[], info: OpenApiInfo & { serverUrl: string }): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const o of ops) {
    // The path's {params} and the declared ones are the same set: one left out of params would be undocumented, one params names that the
    // path lacks never arrives.
    const inPath = [...o.path.matchAll(/\{([^}]+)\}/g)].map((m) => m[1]!).sort();
    const declared = Object.keys(o.params ?? {}).sort();
    if (inPath.join(",") !== declared.join(","))
      throw new Error(`${o.operationId}: the path's parameters {${inPath.join(", ")}} differ from params {${declared.join(", ")}}`);
    const parameters = [
      ...Object.entries(o.params ?? {}).map(([name, description]) => ({ name, in: "path", required: true, description, schema: { type: "string" } })),
      ...Object.entries((o.query?.shape ?? {}) as Record<string, z.ZodType>).map(([name, s]) => ({
        name,
        in: "query",
        required: false,
        ...(s.description && { description: s.description }),
        schema: jsonSchema(s, "input"),
      })),
    ];
    const responses: Record<string, unknown> = {
      [o.ok.status]: {
        description: o.ok.description,
        ...(o.ok.etag && {
          headers: { ETag: { description: "The entity tag; send it back as If-None-Match to get 304 when nothing changed", schema: { type: "string" } } },
        }),
        ...(o.ok.schema && { content: { "application/json": { schema: jsonSchema(o.ok.schema, "output") } } }),
        ...(o.ok.binary && { content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } } }),
      },
      ...(o.ok.etag && { 304: { description: "Not modified: If-None-Match named the current ETag; no body" } }),
    };
    // Any operation with a body may answer 413, listed or not.
    const errors = o.body && !o.errors.includes(413) ? [...o.errors, 413] : o.errors;
    for (const status of errors) {
      const known = ERRORS[status];
      if (!known) throw new Error(`${o.operationId}: no description for error ${status}`);
      responses[status] = {
        description: `${known[1]} (\`${known[0]}\`)`,
        content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } },
      };
    }
    paths[o.path] = {
      ...paths[o.path],
      [o.method.toLowerCase()]: {
        operationId: o.operationId,
        summary: o.summary,
        ...(o.tool !== undefined && { description: `The REST counterpart of the MCP tool \`${o.tool}\`.` }),
        tags: [o.tag],
        security: [{ bearer: [] }],
        ...(parameters.length && { parameters }),
        ...(o.body && { requestBody: { required: true, content: { "application/json": { schema: jsonSchema(o.body, "input") } } } }),
        responses,
      },
    };
  }
  const errorsParagraph =
    'Every error is JSON, `{"error": "...", "code": "..."}`. Besides the responses listed per operation, an unknown path answers 404, a method an operation doesn\'t have 405 with `Allow`, and a failure on the server\'s side 500 (`internal`) without details.';
  return {
    openapi: "3.1.1",
    info: {
      title: info.title,
      version: info.version,
      description: info.description ? `${info.description}\n\n${errorsParagraph}` : errorsParagraph,
      ...(info.license && { license: info.license }),
    },
    servers: [{ url: info.serverUrl }],
    ...(info.tags && { tags: info.tags }),
    paths,
    components: {
      schemas: { Error: jsonSchema(ErrorJson, "output") },
      securitySchemes: {
        bearer: {
          type: "http",
          scheme: "bearer",
          description:
            info.bearer ??
            "An API token (a `read` token may only GET), or an OAuth access token from this instance issued for this API (`resource=<base>/api/v1`). A token for /mcp is refused here.",
        },
      },
    },
  };
}

/**
 * MCP first, checked: every operation names an MCP tool that exists or says why there is none (`noTool`, not empty), never both; every tool
 * has an operation; and no operationId is used twice. Throws with every name that is off; an app calls it in a test with its table and its
 * tools.
 */
export function checkOpsMirrorTools<Ctx>(ops: Op<Ctx>[], tools: Pick<Tool, "name">[]): void {
  const toolNames = new Set(tools.map((t) => t.name));
  const mirrored = new Set(ops.flatMap((o) => (o.tool === undefined ? [] : [o.tool])));
  const problems: string[] = [];
  const neither = ops.filter((o) => o.tool === undefined && !o.noTool?.trim()).map((o) => o.operationId);
  if (neither.length) problems.push(`operations naming neither an MCP tool nor why not: ${neither.join(", ")}`);
  // The type forbids both; a table built from untyped data may still have them.
  const both = (ops as { tool?: string; noTool?: string; operationId: string }[])
    .filter((o) => o.tool !== undefined && o.noTool !== undefined)
    .map((o) => o.operationId);
  if (both.length) problems.push(`operations naming both a tool and noTool: ${both.join(", ")}`);
  const unknown = ops.filter((o) => o.tool !== undefined && !toolNames.has(o.tool)).map((o) => `${o.operationId} (${o.tool})`);
  if (unknown.length) problems.push(`operations naming no MCP tool: ${unknown.join(", ")}`);
  const bare = tools.filter((t) => !mirrored.has(t.name)).map((t) => t.name);
  if (bare.length) problems.push(`MCP tools without an operation: ${bare.join(", ")}`);
  const ids = ops.map((o) => o.operationId);
  const twice = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
  if (twice.length) problems.push(`operationIds used twice: ${twice.join(", ")}`);
  if (problems.length) throw new Error(`the REST table does not mirror the MCP tools: ${problems.join("; ")}`);
}
