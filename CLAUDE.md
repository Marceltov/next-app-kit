# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

next-app-kit: sign-in, API tokens, MCP, REST, migrations and multipart uploads for Marceltov's Next.js apps, as one TypeScript library extracted from noticebox.

## Commands

```sh
npm test                                   # vitest: src/**/*.test.ts; every test gets a temporary DATA_DIR (src/testing/setup.ts)
npx vitest run src/package.test.ts -t name # one file / one test
npm run typecheck                          # tsc --noEmit
npm run lint                               # eslint, with the Next.js boundary below
npm run format                             # Prettier at 160 columns (format:check in CI)
npm run build                              # tsc -p tsconfig.build.json → dist/
```

```sh
# examples/minimal: the kit in a real Next.js app (build the kit first; it is installed as a copy, install-links=true)
cd examples/minimal && npm ci && npm run typecheck && npm run test:peers && npm run build && npm run test:absent && npm run test:e2e
```

CI (`.github/workflows/ci.yml`) has two jobs `main` requires through a ruleset: `check` (format:check, lint, typecheck, test, build) and `example` (the example app built, its test sign-in route shown absent from the production build, its Playwright test against `next dev`, in the Playwright image of the version the example's lockfile pins).

Release (`.github/workflows/release.yml`, on the tag): set `version` in `package.json` (and `npm install` in `examples/minimal` for its lockfile), commit on `main`, then tag with a headline and push the tag; the workflow checks the tag against `package.json`, runs the checks, attaches `next-app-kit-X.Y.Z.tgz` (`npm pack`, what apps install) and `next-app-kit-X.Y.Z-npm.cdx.json` (SBOM) to a GitHub release with generated notes. Nothing is published from here.

```sh
git tag -a vX.Y.Z -m "A headline for the people who use it" && git push origin vX.Y.Z
```

Dependabot (`.github/dependabot.yml`) opens weekly grouped bumps; patch and minor ones merge by themselves once `check` and `example` are green (`dependabot-automerge.yml`), the one exception to merging only when the maintainer says so. Majors wait for review.

## Architecture

- One entry point per part (`next-app-kit/signin`, `/tokens`, `/mcp`, `/rest`, `/multipart`, `/files`, `/migrations`, `/next`, `/testing`), each `src/<part>/index.ts` built to `dist/<part>/index.js`; a part's `exports` entry is added with the part (`src/package.test.ts` checks every entry has a built file).
- Framework-free core: only `src/next/` imports Next.js (`eslint.config.mjs`, pinned by `src/boundary.test.ts`); its handlers and `next-app-kit/testing`'s are plain `(Request) => Response`.
- `next-app-kit/testing` is imported by an app's production code (its test sign-in route file): it imports no test runner, and `testSignInRoute` returns no handler under `NODE_ENV=production`.
- Migrations: the kit holds the runner (`migrate`); apps keep their list in `backend/db/migrations.ts` and run it with `migrate`.
- No app domain: an app passes its env prefix, token prefix, tools, operations and `log`.

## Rules

- Follows Marceltov/engineering-conventions; the rules here win where they differ.
- Peer dependencies are exact and also devDependencies at the same version (`src/package.test.ts`); Better Auth, its plugins, the MCP SDK and Next.js move together, here first, then in the apps; `examples/minimal/package.json` pins the same versions and moves in the same commit (Dependabot watches the example's own dependencies, not its peers). If Dependabot's peer group bumps the devDependencies but not the exact peerDependencies, finish the pull request by hand.
- Behaviour stays noticebox's unless a decision here says otherwise.
- Settings an app reads are `<PREFIX>_*` with the app's prefix, plus `PUBLIC_URL`, `DATA_DIR`, `PORT`, `TZ`.
- MCP results carry `guidance: string[]`.
- Code, comments and messages in English; comments explain why, at the top of each module.
