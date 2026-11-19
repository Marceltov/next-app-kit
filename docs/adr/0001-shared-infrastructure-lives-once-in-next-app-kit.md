---
status: accepted
date: 2026-11-19
decision-makers: Marcel Bruckner
---

# Sign-in, API tokens, MCP, REST and migrations live once, in next-app-kit, extracted from noticebox

## Context and Problem Statement

Each of Marcel's Next.js apps (noticebox, freundebuch, Gamepanion, and upload, the next one) carries its own copy of the same infrastructure: Better Auth with an allowlist and an emailed code, API tokens, the MCP endpoint and its OAuth server, a REST route table with its OpenAPI document, a migrations runner, multipart uploads and a way for end-to-end tests to sign in. The copies have drifted: a fix made in one (an origin check, a refused token, a hashed code) reaches the others only if someone remembers to carry it over, and each new app starts by copying whichever copy is newest. upload was about to be the fifth copy.

How do the apps share this code, and what does the shared copy start from?

## Decision Drivers

- A security fix in sign-in or tokens has to reach every app, in one change.
- The conventions (_Sign-in_, _MCP first_, _Better Auth_, _Next.js app_) describe one behaviour; the code should exist once to match them.
- No registry account, no secrets and nothing published from a laptop (conventions _Releases_).
- Apps keep their domain, their UI and their own words; the shared part holds none of it.
- One version of Better Auth and of the MCP SDK per app process.

## Considered Options

1. Keep copying: each app owns its copy and ports fixes by hand.
2. A template repository that new apps start from.
3. A library, `next-app-kit`, installed by every app from a GitHub release, extracted from noticebox (the most complete copy).
4. A library on the npm registry.

## Decision Outcome

Chosen: **3, a library installed from a GitHub release**, because it is the only option where a fix lands once and every app takes it with a version bump, without a registry account or a token. A template (2) only moves the copying to the start; npm (4) adds an account, a publish secret and a public package name for code only these apps use.

The kit was extracted from noticebox's `main`: `backend/accounts.ts`, `auth.ts`, `signin.ts` and `mail.ts` became `next-app-kit/signin`; `tokens.ts` became `/tokens`; the wiring of `mcp.ts` and `admin.ts` (not its tools) became `/mcp`; the table machinery of `rest.ts` (not its operations) became `/rest`; `multipart.ts` became `/multipart`; the runner of `migrations.ts` (not its list) became `/migrations`; `testutil.ts` and `e2e/global-setup.ts` became `/testing`; and the route files under `app/api/auth/`, `app/.well-known/` and `app/mcp/` became the handler factories of `/next`. noticebox's tests for these modules came along and pass. Behaviour stays noticebox's, except where it changed on the way:

- **`next` became `guidance`.** An MCP tool's result carries `guidance: string[]` (conventions _MCP first_); `defineTool` adds it to every output schema and refuses a result without it, at compile time and at run time. noticebox's `next` is not carried over.
- **Passkeys** (`@better-auth/passkey`) are new; noticebox has none. They join the allowlist like every other way in.
- **Prefix parameters.** Every setting is `<PREFIX>_*` with the app's prefix (`NOTICEBOX`, `UPLOAD`, …); the API token prefix is a parameter too, refused when empty or starting with `ey` (a JWT's start, which would make a token look like an OAuth one).
- **`PUBLIC_URL` is the only base.** Every URL the kit writes (links, OAuth metadata, REST responses) comes from `PUBLIC_URL`; noticebox fell back to the request's forwarded headers when it was unset. It is required now.
- **The allowlist holds outside requests.** The session check no longer skips itself when Better Auth creates a session without a request; `stillAllowed` lets the token checks refuse a person whose address left the list, on `/mcp` and on REST.
- **API tokens carry their scope on the `api` resource** (`read`, `read+write`); `@better-auth/core` became a peer, because the sign-in hooks use its request state and transaction adapter (`@better-auth/core/context`).
- **REST** gained `409 conflict`, literal path segments win over `{param}`, and an operation may name why it has no tool (`noTool: "<reason>"`) instead of mirroring one silently.
- **The MCP origin check** compares the whole origin, scheme included.
- **The test sign-in** became `testSignInRoute`, a route that has no handler at all under `NODE_ENV=production`, so a production build carries none (checked in CI against the example's production build).
- **No app domain:** the app passes its prefix, token prefix, tools, operations, mail texts and `log`; the kit ships no UI.

Peers (Better Auth and its plugins, the MCP SDK, Next.js, better-sqlite3, kysely, zod, nodemailer) are exact, so an app installs the same versions and they move together: here first, in one release, then in the apps. Each release attaches the `npm pack` tarball (GitHub's archive of a tag has no `dist/`) and its SBOM; apps install the tarball by its URL.

### Consequences

- Good, because a fix to sign-in, tokens or MCP is made once and reaches every app as a version bump.
- Good, because upload starts on the kit instead of a fifth copy, and the conventions point at one implementation.
- Good, because the kit's tests, its example app and its CI (the example built, its test route shown absent from production, its Playwright run) check the shared behaviour once, for every app.
- Bad, because the peers are pinned exactly: upgrading Better Auth, the MCP SDK or Next.js in one app means a kit release first, and every app moves in step.
- Bad, because the apps already running (noticebox, freundebuch, Gamepanion) keep their copies until each adopts the kit; until then a fix still has to be ported. freundebuch (and questlog) still name the tool result field `next`, so adopting means renaming it to `guidance`.
- Bad, because a tool's result can't carry extra content blocks yet; noticebox's `get_file` needs that before noticebox can adopt.
- Bad, because the kit is not on a registry: apps depend on a release asset URL, and `npm outdated` doesn't see new versions; Dependabot doesn't bump it either.
- Bad, because Dependabot may bump the peers' devDependencies without the exact peerDependencies beside them; such a pull request is finished by hand.
