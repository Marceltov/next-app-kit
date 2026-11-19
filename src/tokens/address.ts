// An API token for a person named by address, for whoever runs the server (next-app-kit's `token` command): the first token of an app
// that nobody has signed in to yet, or one for a script, without a browser. Only for an address on the list, like a sign-in: a person not
// there yet is made as their first sign-in would make them (address verified, since only the server's operator gets here).
import { emailAllowed, type Auth, type SignInSettings } from "../signin/accounts.js";
import { createApiToken, type ApiToken, type Scope } from "./index.js";

export async function tokenForAddress(
  auth: Auth,
  s: Pick<SignInSettings, "allowed">,
  input: { email: string; name: string; scope: Scope; expiresInDays?: number | null },
): Promise<(ApiToken & { token: string }) | { error: string }> {
  const email = input.email.trim().toLowerCase();
  if (!emailAllowed(s.allowed, email)) return { error: `${email} may not sign in here: it is not in the allowed addresses` };
  const adapter = (await auth.$context).internalAdapter;
  const found = await adapter.findUserByEmail(email);
  const person = found?.user ?? (await adapter.createUser({ email, name: email.split("@")[0]!, emailVerified: true }, { method: "admin" }));
  return createApiToken(auth, person.id, { name: input.name, scope: input.scope, expiresInDays: input.expiresInDays });
}
