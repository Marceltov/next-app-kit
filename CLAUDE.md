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

CI (`.github/workflows/ci.yml`, job `check`) runs format:check, lint, typecheck, test and build; `main` requires `check` through a ruleset.

Dependabot (`.github/dependabot.yml`) opens weekly grouped bumps; patch and minor ones merge by themselves once `check` is green (`dependabot-automerge.yml`), the one exception to merging only when the maintainer says so. Majors wait for review.

## Architecture

- One entry point per part (`next-app-kit/signin`, `/tokens`, `/mcp`, `/rest`, `/multipart`, `/migrations`, `/next`, `/testing`), each `src/<part>/index.ts` built to `dist/<part>/index.js`; a part's `exports` entry is added with the part (`src/package.test.ts` checks every entry has a built file).
- Framework-free core: only `src/next/` imports Next.js (`eslint.config.mjs`, pinned by `src/boundary.test.ts`).
- Migrations: the kit holds the runner (`migrate`); apps keep their list in `backend/db/migrations.ts` and run it with `migrate`.
- No app domain: an app passes its env prefix, token prefix, tools, operations and `log`.

## Rules

- Follows Marceltov/engineering-conventions; the rules here win where they differ.
- Peer dependencies are exact and also devDependencies at the same version (`src/package.test.ts`); Better Auth, its plugins, the MCP SDK and Next.js move together, here first, then in the apps.
- Behaviour stays noticebox's unless a decision here says otherwise.
- Settings an app reads are `<PREFIX>_*` with the app's prefix, plus `PUBLIC_URL`, `DATA_DIR`, `PORT`, `TZ`.
- MCP results carry `guidance: string[]`.
- Code, comments and messages in English; comments explain why, at the top of each module.
