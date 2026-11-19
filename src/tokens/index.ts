// next-app-kit/tokens: API tokens and who a REST request is (noticebox ADR 0002), moved from noticebox (backend/tokens.ts). An API token
// belongs to a person and acts as them on /api/v1, and nowhere else: it has a name, a scope (`read`, or `read+write`) and an expiry (90 days
// by default, at most 365, or none when chosen explicitly), is stored hashed by Better Auth's api-key plugin and shown once. A script may
// instead hold an OAuth access token issued for /api/v1. Either way, an /mcp token is refused here, and an API token is refused on /mcp
// (whose check takes only JWTs issued for /mcp). Where this differs from noticebox: the permission resource is `api` (API_TOKEN_RESOURCE),
// the token prefix is the app's, and a token of a person whose address is no longer on the allowlist is refused.
import { requestToResourceInput, verifyAccessTokenRequest } from "better-auth/oauth2";
import { API_TOKEN_DAYS, API_TOKEN_RESOURCE, apiTokenPrefixOf, type Auth, type SignInSettings } from "../signin/accounts.js";
import { allowedPerson } from "../signin/person.js";

export type Scope = "read" | "read+write";

export type ApiToken = { id: string; name: string; scope: Scope; start: string; created_at: string; expires_at: string | null; last_used_at: string | null };

/** A REST caller: the person's id, their address (what the app records as the actor), and what they may do here. */
export type RestCaller = { person: string; actor: string; scope: Scope };

export type Outcome = { ok: true } | { ok: false; error: string };

type Row = Record<string, unknown>;
type Where = { field: string; value: string }[];
type Adapter = {
  findMany(q: { model: string; where: Where }): Promise<Row[]>;
  findOne(q: { model: string; where: Where }): Promise<Row | null>;
  delete(q: { model: string; where: Where }): Promise<void>;
};

const adapterOf = async (auth: Auth): Promise<Adapter> => (await auth.$context).adapter as unknown as Adapter;
const isoOrNull = (d: unknown) => (d ? new Date(d as string | Date).toISOString() : null);

function scopeOf(permissions: unknown): Scope {
  let p: Record<string, unknown> | null = null;
  try {
    p = typeof permissions === "string" ? (JSON.parse(permissions) as Record<string, unknown>) : (permissions as Record<string, unknown> | null);
  } catch {
    // Unreadable permissions grant nothing beyond reading.
  }
  const granted = p?.[API_TOKEN_RESOURCE];
  return Array.isArray(granted) && granted.includes("write") ? "read+write" : "read";
}

const view = (r: Row, prefix: string): ApiToken => ({
  id: String(r.id),
  name: String(r.name ?? ""),
  scope: scopeOf(r.permissions),
  start: String(r.start ?? prefix),
  created_at: isoOrNull(r.createdAt)!,
  expires_at: isoOrNull(r.expiresAt),
  last_used_at: isoOrNull(r.lastRequest),
});

/**
 * Makes an API token for the person (their user id): `expiresInDays` is its lifetime, `null` for none, left out for the default. The token
 * is in the result once and never again; only its hash is kept.
 */
export async function createApiToken(
  auth: Auth,
  person: string,
  input: { name: string; scope: Scope; expiresInDays?: number | null },
): Promise<(ApiToken & { token: string }) | { error: string }> {
  const name = input.name.trim();
  if (!name || name.length > 60) return { error: "a token needs a name of up to 60 characters" };
  if (input.scope !== "read" && input.scope !== "read+write") return { error: 'the scope is "read" or "read+write"' };
  const days = input.expiresInDays === undefined ? API_TOKEN_DAYS.default : input.expiresInDays;
  if (days !== null && (!Number.isInteger(days) || days < 1 || days > API_TOKEN_DAYS.max))
    return { error: `a token lives 1 to ${API_TOKEN_DAYS.max} days, or has no expiry when chosen explicitly` };
  const made = (await auth.api.createApiKey({
    body: {
      userId: person,
      name,
      expiresIn: days === null ? null : days * 86400,
      permissions: { [API_TOKEN_RESOURCE]: input.scope === "read" ? ["read"] : ["read", "write"] },
    },
  })) as Row & { key: string };
  return { ...view(made, apiTokenPrefixOf(auth)), token: made.key };
}

/** The person's API tokens, newest first; never the tokens themselves. */
export async function listApiTokens(auth: Auth, person: string): Promise<ApiToken[]> {
  const rows = await (await adapterOf(auth)).findMany({ model: "apikey", where: [{ field: "referenceId", value: person }] });
  const prefix = apiTokenPrefixOf(auth);
  return rows.map((r) => view(r, prefix)).sort((a, b) => b.created_at.localeCompare(a.created_at));
}

/** Revokes one of the person's own tokens: the next request with it is refused. */
export async function revokeApiToken(auth: Auth, person: string, id: string): Promise<Outcome> {
  const a = await adapterOf(auth);
  const mine = [
    { field: "id", value: id },
    { field: "referenceId", value: person },
  ];
  if (!(await a.findOne({ model: "apikey", where: mine }))) return { ok: false, error: "no such token" };
  await a.delete({ model: "apikey", where: mine });
  return { ok: true };
}

const bearerOf = (h: Headers): string => h.get("authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1] ?? "";

/**
 * Who a REST request is: an API token (checked, expiry and all, and its last use recorded), or an OAuth access token this instance issued
 * for /api/v1 (signature, issuer, audience, expiry). Null for anything else, an /mcp token and a session cookie included. The person must
 * still exist with their address on the allowlist.
 */
export async function restCaller(req: Request, auth: Auth, signIn: SignInSettings): Promise<RestCaller | null> {
  const token = bearerOf(req.headers);
  if (!token) return null;
  let person: string | null;
  let scope: Scope = "read+write";
  if (token.startsWith(apiTokenPrefixOf(auth))) {
    const r = (await auth.api.verifyApiKey({ body: { key: token } }).catch(() => null)) as { valid: boolean; key: Row | null } | null;
    if (!r?.valid || !r.key) return null;
    person = String(r.key.referenceId);
    scope = scopeOf(r.key.permissions);
  } else {
    try {
      const claims = await verifyAccessTokenRequest(requestToResourceInput(req), {
        verifyOptions: { issuer: `${signIn.baseUrl}/api/auth`, audience: `${signIn.baseUrl}/api/v1` },
        jwksUrl: signIn.jwksUrl,
      });
      person = typeof claims.sub === "string" ? claims.sub : null;
    } catch {
      return null;
    }
  }
  if (!person) return null;
  const who = await allowedPerson(signIn, auth, person);
  return who ? { person: who.id, actor: who.email, scope } : null;
}
