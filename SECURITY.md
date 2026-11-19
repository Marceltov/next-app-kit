# Security policy

## Reporting a vulnerability

Report it privately through [**Report a vulnerability**](https://github.com/Marceltov/next-app-kit/security/advisories/new) on this repository's Security tab. Please do not open a public issue for it.

This covers the library: sign-in and its allowlist, API tokens, the MCP endpoint and its OAuth server, the REST layer, migrations, multipart uploads and the Next.js route handlers it provides. A problem in an app that uses it belongs to that app's repository, unless it comes from this code.

Helpful in a report: the version (the tag), how the app wires the kit as far as it matters (how people sign in, which entry points it uses), and the steps that show the problem.

You get an answer within seven days. Once a fix is released, the advisory is published and names you, unless you would rather not be named.

## Supported versions

Security fixes go into a new release, and only the newest release gets them. There are no backports to older versions.

| Version        | Security fixes                    |
| -------------- | --------------------------------- |
| newest release | yes                               |
| anything older | no: upgrade to the newest release |

## What each release carries

The kit is installed from the tarball attached to each GitHub release (`next-app-kit-X.Y.Z.tgz`, what `npm pack` makes), not from a registry, and ships no image. Each release also carries `next-app-kit-X.Y.Z-npm.cdx.json`, a CycloneDX SBOM of the kit's own run-time dependencies (`npm sbom --package-lock-only --omit dev`). Its peers (Better Auth and its plugins, the MCP SDK, Next.js, better-sqlite3, kysely, nodemailer, zod) are not in it: an app installs them itself, at the exact versions in the kit's `package.json`, so they are in the app's SBOM. Read it with any CycloneDX tool, or as JSON:

```sh
gh release download vX.Y.Z --repo Marceltov/next-app-kit --pattern '*.cdx.json'
jq -r '.components[] | "\(.name) \(.version)"' next-app-kit-X.Y.Z-npm.cdx.json
```

## How this repository watches for vulnerabilities

- Dependabot alerts and security updates: a pull request for a fixed version as soon as an advisory is known.
- Secret scanning with push protection: a pushed token is refused.
- CodeQL code scanning on every pull request.
- A daily audit of the dependency tree, the peers included (`.github/workflows/audit.yml`).
