# next-app-kit

Sign-in, API tokens, the MCP endpoint and its OAuth, REST with its OpenAPI document, migrations and multipart uploads for Next.js apps: the infrastructure each of [Marceltov](https://github.com/Marceltov)'s apps carried as its own copy, extracted from [noticebox](https://github.com/noticebox/noticebox) so it lives once.

## What is in it

One entry point per part; only `next-app-kit/next` imports Next.js.

| Entry point               | What it holds                                                                                                                                                                                                                                    |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `next-app-kit/signin`     | Better Auth in its own `auth.sqlite`: the allowlist, a code or link by email, passkeys, OIDC providers, the OAuth server for MCP clients and scripts (`signInFromEnv`, `openAuth`, `personOf`, `stillAllowed`, `signInMethods`, `refusedSignIn`) |
| `next-app-kit/tokens`     | API tokens, hashed, scoped `read` or `read+write`, 90 days by default and at most 365 (`createApiToken`, `listApiTokens`, `revokeApiToken`, `restCaller`)                                                                                        |
| `next-app-kit/mcp`        | The MCP endpoint (Streamable HTTP, POST only): origin and token checks, tools whose results carry `guidance: string[]`, connected clients (`defineTool`, `refuse`, `mcpRoute`, `connections`, `revokeConnection`)                                |
| `next-app-kit/rest`       | The REST route table under `/api/v1` and its OpenAPI document; every operation mirrors a tool or names why not (`Op`, `fail`, `restRoute`, `openApiDocument`, `checkOpsMirrorTools`)                                                             |
| `next-app-kit/multipart`  | Multipart uploads into a temporary folder, with limits (`readMultipart`, `MultipartError`)                                                                                                                                                       |
| `next-app-kit/migrations` | The migrations runner (`migrate`)                                                                                                                                                                                                                |
| `next-app-kit/next`       | The route handlers (`authHandler`, `wellKnownHandlers`, `mcpHandler`, `restHandler`)                                                                                                                                                             |
| `next-app-kit/testing`    | Signing in for tests and end-to-end runs, calling a tool, checking the peers (`freshAuth`, `signedInCookie`, `testSignInRoute`, `callTool`, `checkPeers`)                                                                                        |

## Install

Not on npm. Each [release](https://github.com/Marceltov/next-app-kit/releases) carries the package as `npm pack` makes it (`dist/` included; GitHub's archive of a tag has no `dist/`). Install it by its URL, with the peers at the versions the kit's `package.json` names; no git or SSH key is needed in CI, and the lockfile pins its hash:

```sh
npm install https://github.com/Marceltov/next-app-kit/releases/download/v0.1.4/next-app-kit-0.1.4.tgz
```

## Settings

An app passes its prefix (`UPLOAD`, `NOTICEBOX`, …) and the kit reads only `<PREFIX>_*`, plus `PUBLIC_URL`, `PORT` and `NODE_ENV`; the app passes where `auth.sqlite` lives (in its `DATA_DIR`). `signInFromEnv` checks the settings at start and names what is missing.

| Variable                                                                | What it does                                                                                                                                                                                                                                                                                      |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PUBLIC_URL`                                                            | The app's public URL, which sign-in links, OAuth metadata and MCP tokens name. Required (outside a dev user).                                                                                                                                                                                     |
| `<PREFIX>_SECRET`                                                       | Better Auth's secret, at least 32 characters (`openssl rand -base64 48`). Required (outside a dev user).                                                                                                                                                                                          |
| `<PREFIX>_ALLOWED_EMAILS`                                               | Who may sign in: addresses and `@domain` entries, comma-separated. Empty means nobody. An address taken off the list loses its sessions and grants at the next start.                                                                                                                             |
| `<PREFIX>_SMTP_URL`, `<PREFIX>_SMTP_FROM`                               | Sign-in by email (a code; in the browser also a link). Without SMTP, a provider is needed.                                                                                                                                                                                                        |
| `<PREFIX>_OIDC_<NAME>_CLIENT_ID`, `_CLIENT_SECRET`, `_ISSUER`, `_LABEL` | A sign-in provider. `GITHUB`, `GOOGLE` and `APPLE` are built in (no issuer); any other name is an OIDC provider and needs `_ISSUER`, the discovery base.                                                                                                                                          |
| `<PREFIX>_DEV_USER`                                                     | Development only: everyone reaching the app is this person, on pages that pass `signIn.devUser` to `personOf`. Refused under `NODE_ENV=production`. The dev user is no Better Auth user (its id is `dev:<address>`): it has no API tokens, passkeys or MCP connections.                           |
| `<PREFIX>_E2E`                                                          | `1` turns the test sign-in route on, outside production only (`next-app-kit/testing`).                                                                                                                                                                                                            |
| `PORT`                                                                  | **Must be the port the app really listens on** (default 3000). /mcp and /api/v1 check OAuth access tokens against the app's own JWKS at `http://127.0.0.1:$PORT/api/auth/jwks`; with the wrong port, every /mcp call and every REST call with an OAuth token answers 401 (API tokens still work). |

## Wiring an app

[`examples/minimal`](examples/minimal) is the smallest app on the kit; copy from it:

1. `backend/app.ts`: the runtime. `signInFromEnv` with the app's prefix, `openAuth` with the API token prefix and the sign-in mail's texts (`texts`, one set per language; [The sign-in mail's language](#the-sign-in-mails-language)), the tools (`defineTool`) and the operations that mirror them (`Op`), the `log` function (pino in an app), all opened once at the first request. The MCP context (`McpContext`) and the REST app (`RestApp`) both take `log`: a tool that throws is logged as `mcp <tool>: <message>` and its client gets only `internal error` (a `refuse(…)` is no error: its message reaches the client and nothing is logged).
   An app that keeps its runtime on `globalThis` (so Next's dev server, which reloads modules, opens the database once) and opens it from more than one bundle (an `instrumentation.ts` as well as the routes) lists the kit in `next.config.ts`'s `serverExternalPackages`: the kit knows an `Auth` that `openAuth` made by a module-level map, and a copy of the kit bundled into each route would not know an `Auth` another copy made (`this Auth was not made by openAuth`).
2. The route files in [Route files](#route-files), one line each.
3. The sign-in page ([The sign-in page](#the-sign-in-page)), the consent page and the auth client ([The consent page](#the-consent-page)), in the app's own words and styles. The sign-in page and the token page are the app's: the example shows who is signed in and makes a token (`app/page.tsx`, `TokenForm.tsx`, `actions.ts`) but has no sign-in page (it names one, `/sign-in`, as `pages.signIn`); `signInMethods` says what one offers.
4. The test sign-in route and the Playwright setup (`app/api/test/sign-in/route.ts`, `playwright.config.ts`, `scripts/absent-in-production.ts`).
5. The app's own migrations in `backend/db/migrations.ts` ([Migrations](#migrations)).

## Peers move together

Better Auth and its plugins (`@better-auth/*`, `@better-auth/core` included), the MCP SDK, better-sqlite3, kysely, zod, nodemailer and (for `next-app-kit/next` only) Next.js are peer dependencies at exact versions. An app installs the same versions; upgrading one of them alone fails the install instead of running two copies. They are upgraded here first, in one release, then in the apps, together.

npm's refusal is the guard, and an app's `legacy-peer-deps=true` (in `.npmrc` or the environment) switches it off: then two copies run side by side and break quietly. So an app must not set `legacy-peer-deps`, and calls `checkPeers()` from `next-app-kit/testing` in one unit test; it compares each peer installed in the app's `node_modules` (found as Node finds it) with the kit's exact version and throws naming every mismatch and every missing peer (an optional peer, `next`, may be absent):

```ts
import { checkPeers } from "next-app-kit/testing";
import { test } from "vitest";

test("next-app-kit's peers are at its versions", () => checkPeers());
```

The example runs it as `npm run test:peers`.

Dependabot groups the peers into one pull request. If it bumps the `devDependencies` but not the exact `peerDependencies` beside them, `src/package.test.ts` fails and the bump is finished by hand: the peer version, and the same version in `examples/minimal/package.json` (whose peers Dependabot leaves alone), in the same pull request.

## Known gaps

- A tool's result is its structured content and nothing else: it can't carry extra content blocks (an image, a resource) yet. noticebox's `get_file` needs that before noticebox can adopt the kit.
- `callTool` lives in `next-app-kit/testing`, not `next-app-kit/mcp`: it runs a tool without a token, so only tests use it.
- The kit ships no UI: the sign-in page, the token page and the consent page are the app's.

## Migrations

Apps keep their migration list in `backend/db/migrations.ts` and run it with the kit's `migrate` from `next-app-kit/migrations`.

## Route files

`next-app-kit/next` holds the route handlers; each route file of an app is one line over its own runtime (`examples/minimal/backend/app.ts`). Each handler takes a getter, asked at the first request (so `next build` opens no database) and only once, unless it threw:

| Route file                                                        | Export                                                                                         |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `app/api/auth/[...all]/route.ts`                                  | `export const { GET, POST } = authHandler(auth)`                                               |
| `app/.well-known/oauth-authorization-server/[...issuer]/route.ts` | `export const GET = wellKnownHandlers(auth).authorizationServer`                               |
| `app/.well-known/openid-configuration/[...issuer]/route.ts`       | `export const GET = wellKnownHandlers(auth).openidConfiguration`                               |
| `app/.well-known/oauth-protected-resource/[...path]/route.ts`     | `export const GET = wellKnownHandlers(auth).protectedResource` (of `/api/v1` and `/mcp`)       |
| `app/mcp/route.ts`                                                | `export const { POST, GET, DELETE } = mcpHandler(async () => (await app()).mcp)`               |
| `app/api/v1/[...path]/route.ts`                                   | `export const { GET, POST, PUT, PATCH, DELETE } = restHandler(async () => (await app()).rest)` |
| `app/api/test/sign-in/route.ts`                                   | `export const GET = testSignInRoute("PREFIX", auth)` (from `next-app-kit/testing`)             |

## The sign-in page

The kit ships no UI; the sign-in page is the app's, at the path it gives `openAuth` as `pages.signIn` (default `/login`; the consent page is `pages.consent`, default `/consent`). The kit and Better Auth send people there and expect it to keep this contract:

- **It carries `?next=`.** Whoever sends someone to the sign-in page names where they were going as `?next=<path>`: the app's own pages, the consent page when nobody is signed in, a failed sign-in link (`<signIn>?next=…&error=…`). The page passes `safeNext(next)` (a path of this app, `/` otherwise) as each method's `callbackURL`, and the sign-in link in the mail opens the `next` of the page it was asked from (read off the `Referer`), so the page is served at the URL that carries it. During an MCP client's or a script's OAuth sign-in, Better Auth sends the browser here with its signed query instead; the auth client carries it along (below) and the sign-in's answer names where to go next (the consent page).
- **What it offers** is `signInMethods(signIn)`: `email` (a code by mail, in the browser also a link: `authClient.emailOtp.sendVerificationOtp({ email, type: "sign-in" })`, then `authClient.signIn.emailOtp({ email, otp })`), `passkey` (`authClient.signIn.passkey()`) and a button per provider (`authClient.signIn.social({ provider: id, … })`, the built-in GitHub, Google and Apple and the OIDC ones from `<PREFIX>_OIDC_<NAME>_*` alike).
- **Each provider's `errorCallbackURL` carries `provider=<id>`** (and `next`): `${signInPage}?provider=${id}&next=${encodeURIComponent(next)}`. A provider's refusal comes back to it as `?error=`, and `refusedSignIn(query, signIn)` turns the query into what the page may show: `{ provider, code }` with the provider's label (only a provider of this instance) and an OAuth-shaped code (`unknown_error` otherwise); `error_description` is never shown. The kit has already logged the refusal with the provider's name.
- **A code that could not be mailed is an error, not "sent".** `sendVerificationOtp` answers 502 with `code: "MAIL_NOT_SENT"` (`MAIL_NOT_SENT` from `next-app-kit/signin`) when the mail server refused or could not be reached, and 400 `EMAIL_SIGN_IN_OFF` on an instance that mails nothing; the page shows its own words for it instead of asking for the code. An address not on the allowlist gets the answer a listed one would get at that moment (nothing is mailed to it): "sent" while mail goes out, and `MAIL_NOT_SENT` from a failed send until the next one succeeds, so the answer never tells who may sign in. The kit logs each failure once, at error level, without the address.
- **The auth client has these plugins:** `emailOTPClient()` (`better-auth/client/plugins`), `passkeyClient()` (`@better-auth/passkey/client`) and `oauthProviderClient()` (`@better-auth/oauth-provider/client`). The last carries an MCP client's signed query along with every request from the page, which is how the kit tells an MCP or script sign-in apart: without it, such a sign-in mails a link as well as the code, and the authorize step does not continue after it. OIDC providers need no client plugin of their own in Better Auth 1.7 (there is no `genericOAuthClient`): `signIn.social` takes their ids. [`app/auth-client.ts`](examples/minimal/app/auth-client.ts) is the copy-in source.

## The sign-in mail's language

The sign-in mail is written in one of the languages of `openAuth`'s `texts` (the first is the fallback). By default the kit picks it from the `Accept-Language` of the request that asked for the code (`mailLanguage`). An app with a language switch passes its own pick as `languageOf(headers)`, the same function its pages use, so the mail speaks the language the sign-in page did:

```ts
const auth = await openAuth(signIn, { apiTokenPrefix: "upl_", texts: { en, de }, pages: { signIn: "/signin" }, languageOf: languageFrom });
```

`languageOf` gets the request's headers (its cookies included) and returns a key of `texts`; anything else gets the first.

## The consent page

The kit ships no UI. During an MCP client's or a script's OAuth sign-in, Better Auth sends the signed-in person to `/consent` (openAuth's `pages.consent`); someone not signed in who opens it is sent to the sign-in page openAuth was given, with the consent page and its query as `?next=`. Copy [`examples/minimal/app/consent/`](examples/minimal/app/consent/) (the page and its `ConsentForm`) and [`app/auth-client.ts`](examples/minimal/app/auth-client.ts) into the app and give them its own words and styles. The page uses `personOf` and `clientNameFor` from `next-app-kit/signin`; the form answers with `authClient.oauth2.consent({ accept })`.

## MCP tools and connections

`defineTool({ name, description, input, output, annotations?, handle })` from `next-app-kit/mcp`: `input` is a `z.object` (MCP's input schema is an object's), `output` a `z.object` without `guidance` (the kit adds it), and `handle(input, who)` returns the result with `guidance: string[]`, or `refuse(message, { guidance? })` for a refusal the client should read. A refusal is a tool error: its message is the first content item; its guidance, when given (what is missing, where to add it, what to call then), follows as a second item, `{"guidance": [...]}`, and as `structuredContent: { error, guidance }`. A handler that throws is logged through the context's `log` and answered `internal error`.

A person's connections are the MCP clients and scripts they allowed: `connections(auth, person)` lists them (newest first), and `revokeConnection(auth, person, id)` revokes one of their own (`{ ok: true }`, or `{ ok: false, error: "no such connection" }`). Its refresh tokens go at once, and its access tokens, though signed JWTs that live up to ten minutes, are refused at the next call on /mcp and on /api/v1 alike, since both check the connection at every call. Records name such a caller `<email> via <client>`.

## REST operations

`next-app-kit/rest`'s table is the API's one source. Each `Op<Ctx>` names its `method`, its `path` under /api/v1 with `{params}` (each one described in `params`, the same names: `openApiDocument` throws otherwise), its `query` (a `z.object`) and `body` schemas, its `ok` answer and listed `errors`, and the tool it mirrors (`tool`) or why none can (`noTool`). Its `handle` gets an `Input<Ctx>`, `{ ctx, base, caller, params, query, body, headers }` (the parsed values, the `RestCaller` and the request's headers), and returns a `Reply`, `{ status, body? }` for JSON or `{ status, raw }` for a Response of its own (a file). The caller's `kind` is `token` (an API token) or `oauth` (an OAuth access token for /api/v1); tell them apart by it, not by `actor`. A `Reply` may carry `etag` (a quoted tag, `"<sha256>"`): it goes out as the ETag header, and a GET or HEAD whose `If-None-Match` names it is answered 304 without the body (a write never is) (`ok.etag: true` documents both; a JSON reply with an ETag is `private, no-cache` instead of `no-store`). `etagMatches(ifNoneMatch, etag)` is there for an app's own file routes. `fail(status, message)` is the `Reply` of a refusal, `{ error, code }` with the code from the status (`400 invalid_input`, `403 forbidden`, `404 not_found`, `409 conflict`); a handler that throws answers 500 `internal` and its message is logged as `api <operationId>: <message>`, so it must not carry a secret. An app's tests call `checkOpsMirrorTools(ops, tools)` and compare `openApiDocument(ops, info)` with its committed `openapi.json`.

## A token from the server

Whoever runs the server can make an API token without a browser: the first one of an app nobody has signed in to yet, or one for a script. It is made in the app's own `auth.sqlite`, from the app's own settings in the environment, only for an address on the allowed list (a person who never signed in is made as their first sign-in would make them), and printed once on stdout:

```sh
docker exec -u 1000 <container> node node_modules/next-app-kit/dist/cli.js token \
  --prefix UPLOAD --token-prefix upl_ --email marcel@example.org --name "site build" --scope read --days 365
```

`--days none` makes one that never expires. In code: `tokenForAddress` from `next-app-kit/tokens`. A Next.js standalone build traces only what the app imports, so an app that wants the command in its image lists `node_modules/next-app-kit/dist/**` in `outputFileTracingIncludes`.

## Cookies and the app's own routes

The kit's /mcp and /api/v1 take bearer tokens only, never the session cookie, so a page of another site can't drive them. Better Auth's session cookie is `HttpOnly` and `SameSite=Lax`, and the app's own cookie-authenticated POST routes (server actions, route handlers that change something, such as making a token) rely on that: a cross-site POST arrives without the cookie, so it acts for nobody. Keep it that way: don't change the cookie to `SameSite=None`, and don't change anything on a GET.

## Tests

`next-app-kit/testing`, for an app's tests and its end-to-end run:

- `freshAuth(prefix, options?)`: Better Auth as `openAuth` opens it, with its `auth.sqlite` in a new directory under the test's temporary `DATA_DIR`. Options, all optional: `allowed` (addresses and `@domain` entries; default `["@example.com"]`), `baseUrl` (`PUBLIC_URL`; default `http://localhost:3000`, where nothing listens), `apiTokenPrefix` (default `test_`), `texts` (the sign-in mail; default an English one). Returns `{ auth, signIn, mail, logs }`: the `Auth`, the `SignInSettings` it was opened with, the last sign-in mail to each address (`Map<string, SignInMail>`, with its `code` and `link`) and every line the kit and Better Auth logged (`string[]`).
- `signedInCookie(auth, email)`: signs a person on the allowlist in through Better Auth's server side (creating them on first use) and returns the session cookie as a `cookie` header carries it. An address not on the list, or taken off it since, throws `SignInRefused`; any other failure throws as it is.
- `testSignInRoute(prefix, auth)`: `GET ?email=…&next=/path` signs the browser in, for Playwright against `next dev` (403 for an address the allowlist refuses, 500 for any other failure). It returns a handler only with `<PREFIX>_E2E=1` outside production; under `NODE_ENV=production` it returns `undefined`, so the route file exports no `GET`, and the handler is compiled out of the production build (`examples/minimal` checks both in CI: `npm run test:absent`).
- `callTool(ctx, who, name, input)`: runs one MCP tool as `who`, through the MCP server, without a token.
- `checkPeers(appDir?)`: throws unless every peer the kit names is installed at its exact version ([Peers move together](#peers-move-together)); `appDir` defaults to the working directory.

## Example

[`examples/minimal`](examples/minimal) is the smallest app on the kit: one tool, the REST operation that mirrors it, the route files above and the consent page. It installs the kit from `../..` as a copy of what the kit ships (`install-links=true`), so build the kit first. CI (job `example`) builds it and runs its Playwright test:

```sh
npm run build && cd examples/minimal && npm ci && npm run test:peers && npm run build && npm run test:absent && npm run test:e2e
```

## Multipart uploads

`readMultipart(req, { maxFileBytes, maxFiles, types?, tmpDir? })` from `next-app-kit/multipart` leaves each file in a temporary folder and throws a `MultipartError` carrying the status to answer with and a `code` saying which problem it is: `too_large` (413: a file over `maxFileBytes`, or the post or its text fields too large), `wrong_type` (a file not in `types`), `too_many` (more files than `maxFiles`, or too many fields or parts), `empty` (a file without bytes), `not_multipart` (the body is no multipart form) and `aborted` (the request broke off or was aborted before its end), all 400 but the first. A chunked post that grows past what the limits allow is `too_large` too, and once a post is refused no further file of it is written. An app words its answer by the code; the English message is for its log. The folder is removed on every failure; after a success it is the app's to remove, so call `cleanup()` in a `finally`:

```ts
const upload = await readMultipart(req, { maxFileBytes: 20 * 1024 * 1024, maxFiles: 10, types: ["image/*"] });
try {
  // move or read upload.files
} finally {
  await upload.cleanup();
}
```

## Decisions

Why the kit exists, what it was extracted from and what changed on the way: [ADR 0001](docs/adr/0001-shared-infrastructure-lives-once-in-next-app-kit.md).

## License

[Apache-2.0](LICENSE).
