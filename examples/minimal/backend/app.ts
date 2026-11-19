// The example app's runtime: sign-in, its one tool and the REST operation that mirrors it, opened once, at the first request that needs it.
// Everything an app on the kit has to write is here; the route files under app/ are one line each.
import { join } from "node:path";
import { defineTool, type McpContext } from "next-app-kit/mcp";
import type { RestApp } from "next-app-kit/next";
import type { Op } from "next-app-kit/rest";
import { openAuth, signInFromEnv, type Auth } from "next-app-kit/signin";
import * as z from "zod";

export const PREFIX = "MINIMAL";

/** The app's sign-in page, given to openAuth (`pages.signIn`; `/login` by default) and the one the consent page sends a stranger to. */
export const SIGN_IN_PAGE = "/sign-in";

const greet = defineTool({
  name: "greet",
  description: "Greets someone by name.",
  input: z.object({ name: z.string().min(1).max(100) }),
  output: z.object({ greeting: z.string() }),
  annotations: { readOnlyHint: true },
  handle: async ({ name }) => ({ greeting: `Hello, ${name}`, guidance: [`Say "Hello, ${name}" to them.`] }),
});

const ops: Op<null>[] = [
  {
    method: "GET",
    path: "/greeting",
    operationId: "greet",
    tool: "greet",
    summary: "Greets someone by name",
    tag: "Greetings",
    query: z.object({ name: z.string().min(1).max(100) }),
    ok: { status: 200, description: "The greeting", schema: z.object({ greeting: z.string() }) },
    errors: [400, 401],
    handle: ({ query }) => ({ status: 200, body: { greeting: `Hello, ${String(query.name)}` } }),
  },
];

export type App = { auth: Auth; mcp: McpContext; rest: RestApp<null> };

const log = (line: string) => console.log(line);

async function open(): Promise<App> {
  const signIn = signInFromEnv(process.env, { prefix: PREFIX, file: join(process.env.DATA_DIR || ".data", "auth.sqlite"), appName: "Minimal", log });
  const auth = await openAuth(signIn, {
    apiTokenPrefix: "min_",
    pages: { signIn: SIGN_IN_PAGE },
    texts: { en: { subject: (code) => `${code} is your sign-in code`, body: (code, link) => `Your code is ${code}${link ? `, or open ${link}` : ""}.` } },
  });
  return {
    auth,
    mcp: { auth, signIn, tools: [greet], serverInfo: { name: "minimal", version: "0.0.0" }, instructions: "Greets people.", log },
    rest: { auth, signIn, ops, ctx: null, log, openApi: { title: "Minimal API", version: "0.0.0" } },
  };
}

let opened: Promise<App> | null = null;

/** The app, opened at the first call; a failed start is tried again at the next. */
export function app(): Promise<App> {
  opened ??= open().catch((e: unknown) => {
    opened = null;
    throw e;
  });
  return opened;
}

export const auth = async () => (await app()).auth;
