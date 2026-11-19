// What an app's MCP tool is: its name, description, input and output schemas, and a handler that acts for whoever the token names. Every
// result carries `guidance: string[]`, what to do now, built from what the call did (conventions: MCP first); the kit adds it to the output
// schema, the compiler refuses a handler whose result leaves it out, and a result that reaches run() without it anyway throws instead of
// going out. noticebox called the field `next`; that name is not carried over.
import type { ToolAnnotations } from "@modelcontextprotocol/server";
import * as z from "zod";

/** Who an MCP call acts for: the person (Better Auth's user id), what records name them by ("<email> via <client>"), the client they allowed. */
export type Who = { actor: string; person: string; clientId: string; base: string };

/** A result with what to do now. */
export type Guided<T> = T & { guidance: string[] };

const REFUSED: unique symbol = Symbol("refused");

/**
 * A handler's refusal: the call is answered as a tool error carrying `message`, with no result. Its `guidance` (what to do so the call
 * succeeds next time: what is missing, where to add it) goes along in the error, as a result's would.
 */
export type Refused = { readonly [REFUSED]: { message: string; guidance: string[] } };

export const refuse = (message: string, opts?: { guidance?: string[] }): Refused => ({ [REFUSED]: { message, guidance: opts?.guidance ?? [] } });

/** The message of a refusal; null for a result. */
export const refusalOf = (r: unknown): string | null => (typeof r === "object" && r !== null && REFUSED in r ? (r as Refused)[REFUSED].message : null);

/** The guidance a refusal carries; empty for one without, and for a result. */
export const refusalGuidanceOf = (r: unknown): string[] => (typeof r === "object" && r !== null && REFUSED in r ? (r as Refused)[REFUSED].guidance : []);

/** A defined tool, as mcpRoute serves it. `outputSchema` already has `guidance`. */
export type Tool = {
  name: string;
  description: string;
  inputSchema: z.ZodObject;
  outputSchema: z.ZodObject;
  annotations?: ToolAnnotations;
  /** Runs the handler for `who` on an input the input schema has already parsed; throws if the result has no guidance. */
  run(input: unknown, who: Who): Promise<Guided<Record<string, unknown>> | Refused>;
};

// What a handler returns besides guidance: the output schema's type; for an empty schema, nothing (zod types `z.object({})` as an index
// signature of `never`, which no `guidance` would fit).
type Output<S extends z.ZodRawShape> = keyof S extends never ? object : z.output<z.ZodObject<S>>;

const hasGuidance = (r: Record<string, unknown>) => Array.isArray(r.guidance) && r.guidance.every((line) => typeof line === "string");

/**
 * Defines a tool. Its input schema is a `z.object` (MCP's inputSchema is an object's), and its output schema must not declare `guidance`
 * itself: the kit adds it.
 */
export function defineTool<In extends z.ZodObject, S extends z.ZodRawShape>(t: {
  name: string;
  description: string;
  input: In;
  output: z.ZodObject<S>;
  annotations?: ToolAnnotations;
  handle: (input: z.output<In>, who: Who) => Promise<Guided<Output<S>> | Refused>;
}): Tool {
  if (!(t.input instanceof z.ZodObject)) throw new Error(`${t.name}: the input schema must be a z.object`);
  if ("guidance" in t.output.shape) throw new Error(`${t.name}: the output schema declares guidance; the kit adds it`);
  return {
    name: t.name,
    description: t.description,
    inputSchema: t.input,
    outputSchema: t.output.extend({ guidance: z.array(z.string()) }),
    annotations: t.annotations,
    async run(input, who) {
      const r = (await t.handle(input as z.output<In>, who)) as Record<string, unknown>;
      if (refusalOf(r) === null && !hasGuidance(r)) throw new Error(`${t.name}: a result needs guidance: string[]`);
      return r as Guided<Record<string, unknown>> | Refused;
    },
  };
}
