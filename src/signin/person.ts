// Who is asking. A page request names its person by Better Auth's HttpOnly session cookie (accounts.ts); nothing else counts, a header a
// proxy might set included. /mcp and /api/v1 check their own tokens (next-app-kit/mcp, next-app-kit/tokens).
import type { Auth } from "./accounts.js";

/** A signed-in person: Better Auth's user id, and the verified address the app shows and records. */
export type Person = { id: string; email: string };

/** The person behind a page request's session cookie; the dev user (<PREFIX>_DEV_USER, development only) when there is none. */
export async function personOf(h: Headers, auth: Auth, devUser?: string | null): Promise<Person | null> {
  const s = await auth.api.getSession({ headers: h });
  if (s) return { id: s.user.id, email: s.user.email };
  return devUser ? { id: `dev:${devUser}`, email: devUser } : null;
}
