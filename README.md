# next-app-kit

Sign-in, API tokens, the MCP endpoint and its OAuth, REST with its OpenAPI document, migrations and multipart uploads for Next.js apps: the infrastructure each of [Marceltov](https://github.com/Marceltov)'s apps carried as its own copy, extracted from [noticebox](https://github.com/noticebox/noticebox) so it lives once.

## What is in it

One entry point per part; only `next-app-kit/next` imports Next.js.

| Entry point               | What it holds                                                                                                                                                                                                  |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `next-app-kit/signin`     | Better Auth in its own `auth.sqlite`: the allowlist, a code or link by email, passkeys, OIDC providers, the OAuth server for MCP clients and scripts (`signInFromEnv`, `openAuth`, `personOf`, `stillAllowed`) |
| `next-app-kit/tokens`     | API tokens, hashed, scoped `read` or `read+write`, 90 days by default and at most 365 (`createApiToken`, `listApiTokens`, `revokeApiToken`, `restCaller`)                                                      |
| `next-app-kit/mcp`        | The MCP endpoint (Streamable HTTP, POST only): origin and token checks, tools whose results carry `guidance: string[]`, connected clients (`defineTool`, `refuse`, `mcpRoute`, `connections`)                  |
| `next-app-kit/rest`       | The REST route table under `/api/v1` and its OpenAPI document; every operation mirrors a tool or names why not (`Op`, `restRoute`, `openApiDocument`, `checkOpsMirrorTools`)                                   |
| `next-app-kit/multipart`  | Multipart uploads into a temporary folder, with limits (`readMultipart`, `MultipartError`)                                                                                                                     |
| `next-app-kit/migrations` | The migrations runner (`migrate`)                                                                                                                                                                              |
| `next-app-kit/next`       | The route handlers (`authHandler`, `wellKnownHandlers`, `mcpHandler`, `restHandler`)                                                                                                                           |
| `next-app-kit/testing`    | Signing in for tests and end-to-end runs, calling a tool (`freshAuth`, `signedInCookie`, `testSignInRoute`, `callTool`)                                                                                        |

## Install

Not on npm. Each [release](https://github.com/Marceltov/next-app-kit/releases) carries the package as `npm pack` makes it (`dist/` included; GitHub's archive of a tag has no `dist/`). Install it by its URL, with the peers at the versions the kit's `package.json` names; no git or SSH key is needed in CI, and the lockfile pins its hash:

```sh
npm install https://github.com/Marceltov/next-app-kit/releases/download/v0.1.0/next-app-kit-0.1.0.tgz
```

## Settings

An app passes its prefix (`UPLOAD`, `NOTICEBOX`, …) and the kit reads only `<PREFIX>_*`, plus `PUBLIC_URL`, `PORT` and `NODE_ENV`; the app passes where `auth.sqlite` lives (in its `DATA_DIR`). `signInFromEnv` checks the settings at start and names what is missing.

| Variable                                                                | What it does                                                                                                                                                          |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PUBLIC_URL`                                                            | The app's public URL, which sign-in links, OAuth metadata and MCP tokens name. Required (outside a dev user).                                                         |
| `<PREFIX>_SECRET`                                                       | Better Auth's secret, at least 32 characters (`openssl rand -base64 48`). Required (outside a dev user).                                                              |
| `<PREFIX>_ALLOWED_EMAILS`                                               | Who may sign in: addresses and `@domain` entries, comma-separated. Empty means nobody. An address taken off the list loses its sessions and grants at the next start. |
| `<PREFIX>_SMTP_URL`, `<PREFIX>_SMTP_FROM`                               | Sign-in by email (a code; in the browser also a link). Without SMTP, a provider is needed.                                                                            |
| `<PREFIX>_OIDC_<NAME>_CLIENT_ID`, `_CLIENT_SECRET`, `_ISSUER`, `_LABEL` | A sign-in provider. `GITHUB`, `GOOGLE` and `APPLE` are built in (no issuer); any other name is an OIDC provider and needs `_ISSUER`, the discovery base.              |
| `<PREFIX>_DEV_USER`                                                     | Development only: everyone reaching the app is this person. Refused under `NODE_ENV=production`.                                                                      |
| `<PREFIX>_E2E`                                                          | `1` turns the test sign-in route on, outside production only (`next-app-kit/testing`).                                                                                |
| `PORT`                                                                  | The port the app listens on: the MCP endpoint checks tokens against the app's own JWKS there.                                                                         |

## Wiring an app

[`examples/minimal`](examples/minimal) is the smallest app on the kit; copy from it:

1. `backend/app.ts`: the runtime. `signInFromEnv` with the app's prefix, `openAuth` with the API token prefix and the sign-in mail's texts, the tools (`defineTool`) and the operations that mirror them (`Op`), the `log` function (pino in an app), all opened once at the first request. The MCP context (`McpContext`) and the REST app (`RestApp`) both take `log`: a tool that throws is logged as `mcp <tool>: <message>` and its client gets only `internal error` (a `refuse(…)` is no error: its message reaches the client and nothing is logged).
2. The route files in [Route files](#route-files), one line each.
3. The consent page and the auth client ([The consent page](#the-consent-page)), in the app's own words and styles. The sign-in page and the token page are the app's: the example shows who is signed in and makes a token (`app/page.tsx`, `TokenForm.tsx`, `actions.ts`) but has no sign-in page; `signInMethods` says what one offers.
4. The test sign-in route and the Playwright setup (`app/api/test/sign-in/route.ts`, `playwright.config.ts`, `scripts/absent-in-production.ts`).
5. The app's own migrations in `backend/db/migrations.ts` ([Migrations](#migrations)).

## Peers move together

Better Auth and its plugins (`@better-auth/*`, `@better-auth/core` included), the MCP SDK, better-sqlite3, kysely, zod, nodemailer and (for `next-app-kit/next` only) Next.js are peer dependencies at exact versions. An app installs the same versions; upgrading one of them alone fails the install instead of running two copies. They are upgraded here first, in one release, then in the apps, together.

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

## The consent page

The kit ships no UI. During an MCP client's or a script's OAuth sign-in, Better Auth sends the signed-in person to `/consent` (openAuth's `pages.consent`); copy [`examples/minimal/app/consent/`](examples/minimal/app/consent/) (the page and its `ConsentForm`) and [`app/auth-client.ts`](examples/minimal/app/auth-client.ts) into the app and give them its own words and styles. The page uses `personOf` and `clientNameFor` from `next-app-kit/signin`; the form answers with `authClient.oauth2.consent({ accept })`.

## Tests

`next-app-kit/testing`, for an app's tests and its end-to-end run:

- `freshAuth(prefix, options?)`: Better Auth as `openAuth` opens it, with its `auth.sqlite` in a new directory under the test's temporary `DATA_DIR`. Options, all optional: `allowed` (addresses and `@domain` entries; default `["@example.com"]`), `baseUrl` (`PUBLIC_URL`; default `http://localhost:3000`, where nothing listens), `apiTokenPrefix` (default `test_`), `texts` (the sign-in mail; default an English one). Returns `{ auth, signIn, mail, logs }`: the `Auth`, the `SignInSettings` it was opened with, the last sign-in mail to each address (`Map<string, SignInMail>`, with its `code` and `link`) and every line the kit and Better Auth logged (`string[]`).
- `signedInCookie(auth, email)`: signs a person on the allowlist in through Better Auth's server side (creating them on first use) and returns the session cookie as a `cookie` header carries it. An address not on the list, or taken off it since, throws `SignInRefused`; any other failure throws as it is.
- `testSignInRoute(prefix, auth)`: `GET ?email=…&next=/path` signs the browser in, for Playwright against `next dev` (403 for an address the allowlist refuses, 500 for any other failure). It returns a handler only with `<PREFIX>_E2E=1` outside production; under `NODE_ENV=production` it returns `undefined`, so the route file exports no `GET`, and the handler is compiled out of the production build (`examples/minimal` checks both in CI: `npm run test:absent`).
- `callTool(ctx, who, name, input)`: runs one MCP tool as `who`, through the MCP server, without a token.

## Example

[`examples/minimal`](examples/minimal) is the smallest app on the kit: one tool, the REST operation that mirrors it, the route files above and the consent page. It installs the kit from `../..` as a copy of what the kit ships (`install-links=true`), so build the kit first. CI (job `example`) builds it and runs its Playwright test:

```sh
npm run build && cd examples/minimal && npm ci && npm run build && npm run test:absent && npm run test:e2e
```

## Multipart uploads

`readMultipart(req, { maxFileBytes, maxFiles, types?, tmpDir? })` from `next-app-kit/multipart` leaves each file in a temporary folder and throws a `MultipartError` carrying the status to answer with. The folder is removed on every failure; after a success it is the app's to remove, so call `cleanup()` in a `finally`:

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
