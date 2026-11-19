# next-app-kit

Sign-in, API tokens, the MCP endpoint and its OAuth, REST with its OpenAPI document, migrations and multipart uploads for Next.js apps: the infrastructure each of [Marceltov](https://github.com/Marceltov)'s apps carried as its own copy, extracted from [noticebox](https://github.com/noticebox/noticebox) so it lives once.

**Status:** in development; nothing to install before `v0.1.0`.

## Install

Not on npm; install a tag's archive from GitHub (no git or SSH key needed in CI, and the lockfile pins its hash):

```sh
npm install https://github.com/Marceltov/next-app-kit/archive/refs/tags/vX.Y.Z.tar.gz
```

## Peers move together

Better Auth and its plugins, the MCP SDK, better-sqlite3, kysely, zod, nodemailer and (for `next-app-kit/next` only) Next.js are peer dependencies at exact versions. An app installs the same versions; upgrading one of them alone fails the install instead of running two copies. They are upgraded here first, then in the apps, together.

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

## License

[Apache-2.0](LICENSE).
