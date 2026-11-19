// What the routes of sign-in need, framework-free and thin over Better Auth (accounts.ts): the OAuth metadata it can't serve from under its
// own base path, the API's protected-resource metadata, and what the sign-in and consent pages need to know. Everything else under
// /api/auth is `auth.handler`. The Next.js route handlers over these are next-app-kit/next's.
import { metadataResponse, oauthProviderAuthServerMetadata, oauthProviderOpenIdConfigMetadata } from "@better-auth/oauth-provider";
import { OAUTH_CODE, type Auth, type SignInSettings } from "./accounts.js";

/** /.well-known/oauth-authorization-server/api/auth (RFC 8414), which Better Auth can't serve from under its base path. */
export const authServerMetadataRoute = (req: Request, auth: Auth): Promise<Response> => oauthProviderAuthServerMetadata(auth)(req);

/** /.well-known/openid-configuration/api/auth, likewise. */
export const openIdConfigRoute = (req: Request, auth: Auth): Promise<Response> => oauthProviderOpenIdConfigMetadata(auth)(req);

/** RFC 9728 metadata of /api/v1: where a script finds the authorization server that issues tokens for this API. */
export const apiResourceMetadataRoute = (s: SignInSettings): Response =>
  metadataResponse({
    resource: `${s.baseUrl}/api/v1`,
    authorization_servers: [`${s.baseUrl}/api/auth`],
    bearer_methods_supported: ["header"],
    resource_name: `${s.appName} API`,
  });

/** The name of the OAuth client a consent page asks about; null when it isn't known. */
export async function clientNameFor(headers: Headers, clientId: string, auth: Auth): Promise<string | null> {
  try {
    const c = (await auth.api.getOAuthClientPublic({ query: { client_id: clientId }, headers })) as { client_name?: string } | null;
    return c?.client_name || null;
  } catch {
    return null;
  }
}

export type RefusedSignIn = { provider: string | null; code: string };

/**
 * What the sign-in page shows of a refused sign-in: Better Auth sends the provider's OAuth error (or the kit's own, such as an address not
 * on the list) back to it as `?error=`, with the `provider` the page put in its errorCallbackURL. The query is anyone's to write, so only a
 * known provider and an OAuth-shaped code get through, and `error_description` is never shown. The log line was written when the refusal
 * arrived (accounts.ts), so this writes none.
 */
export function refusedSignIn(query: { error?: string | string[]; provider?: string | string[] }, s: SignInSettings): RefusedSignIn | null {
  const code = typeof query.error === "string" ? query.error : undefined;
  if (!code) return null;
  const known = typeof query.provider === "string" ? s.providers.find((p) => p.id === query.provider) : undefined;
  return { provider: known?.label ?? null, code: OAUTH_CODE.test(code) ? code : "unknown_error" };
}
