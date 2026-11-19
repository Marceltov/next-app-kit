// Who is asking. A page request names its person by Better Auth's HttpOnly session cookie (accounts.ts); nothing else counts, a header a
// proxy might set included. /mcp and /api/v1 check their own tokens (next-app-kit/mcp, next-app-kit/tokens).
import { emailAllowed, type Auth, type SignInSettings } from "./accounts.js";

/** A signed-in person: Better Auth's user id, and the verified address the app shows and records. */
export type Person = { id: string; email: string };

/** The person behind a page request's session cookie; the dev user (<PREFIX>_DEV_USER, development only) when there is none. */
export async function personOf(h: Headers, auth: Auth, devUser?: string | null): Promise<Person | null> {
  const s = await auth.api.getSession({ headers: h });
  if (s) return { id: s.user.id, email: s.user.email };
  return devUser ? { id: `dev:${devUser}`, email: devUser } : null;
}

/**
 * The person `userId` names, if their verified address is still on the allowlist: what a token check asks before it lets a token act,
 * since an API key or an access token outlives the change to the list (the list is read from `s.allowed` at every call).
 */
export async function allowedPerson(s: SignInSettings, auth: Auth, userId: string): Promise<Person | null> {
  const user = await (await auth.$context).internalAdapter.findUserById(userId);
  return user && user.emailVerified && emailAllowed(s.allowed, user.email) ? { id: user.id, email: user.email } : null;
}

/** Whether `userId` still exists with a verified address on the allowlist. */
export const stillAllowed = async (s: SignInSettings, auth: Auth, userId: string): Promise<boolean> => (await allowedPerson(s, auth, userId)) !== null;
