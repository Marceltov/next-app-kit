// The person's connections: the MCP clients they allowed, one Better Auth OAuth consent each. Moved from noticebox (backend/admin.ts). /mcp
// asks `connected` at every call, so revoking a connection stops its access tokens at the next call instead of when they expire.
import type { Auth } from "../signin/accounts.js";

/** One client the person allowed: `id` is the consent's, what revokeConnection takes. */
export type Connection = { id: string; client_id: string; client_name: string; created_at: string };

export type Outcome = { ok: true } | { ok: false; error: string };

type Row = Record<string, unknown>;
type Where = { field: string; value: string }[];
type Adapter = {
  findMany(q: { model: string; where: Where }): Promise<Row[]>;
  findOne(q: { model: string; where: Where }): Promise<Row | null>;
  deleteMany(q: { model: string; where: Where }): Promise<number>;
};

const adapterOf = async (auth: Auth): Promise<Adapter> => (await auth.$context).adapter as unknown as Adapter;
const iso = (d: unknown) => new Date(d as string | Date).toISOString();

/** The name a client registered with; its id when it gave none. */
export async function clientName(auth: Auth, clientId: string): Promise<string> {
  const c = await (await adapterOf(auth)).findOne({ model: "oauthClient", where: [{ field: "clientId", value: clientId }] });
  return typeof c?.name === "string" && c.name ? c.name : clientId;
}

/** The person's connected clients, newest first. */
export async function connections(auth: Auth, person: string): Promise<Connection[]> {
  const rows = await (await adapterOf(auth)).findMany({ model: "oauthConsent", where: [{ field: "userId", value: person }] });
  const list = await Promise.all(
    rows.map(async (r) => ({
      id: String(r.id),
      client_id: String(r.clientId),
      client_name: await clientName(auth, String(r.clientId)),
      created_at: iso(r.createdAt),
    })),
  );
  return list.sort((x, y) => y.created_at.localeCompare(x.created_at));
}

/** Whether the person still allows this client. */
export async function connected(auth: Auth, person: string, clientId: string): Promise<boolean> {
  const rows = await (
    await adapterOf(auth)
  ).findMany({
    model: "oauthConsent",
    where: [
      { field: "userId", value: person },
      { field: "clientId", value: clientId },
    ],
  });
  return rows.length > 0;
}

/**
 * Revokes one of the person's own connections: the consent goes, and with it every refresh and access token of that client for them. An
 * access token already handed out is a signed JWT that outlives its row; /mcp refuses it at the next call because the consent is gone.
 */
export async function revokeConnection(auth: Auth, person: string, id: string): Promise<Outcome> {
  const a = await adapterOf(auth);
  const c = await a.findOne({
    model: "oauthConsent",
    where: [
      { field: "id", value: id },
      { field: "userId", value: person },
    ],
  });
  if (!c) return { ok: false, error: "no such connection" };
  const mine = [
    { field: "clientId", value: String(c.clientId) },
    { field: "userId", value: person },
  ];
  await a.deleteMany({ model: "oauthRefreshToken", where: mine });
  await a.deleteMany({ model: "oauthAccessToken", where: mine });
  await a.deleteMany({ model: "oauthConsent", where: [{ field: "id", value: id }] });
  return { ok: true };
}
