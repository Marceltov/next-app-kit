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
