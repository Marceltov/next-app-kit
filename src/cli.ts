#!/usr/bin/env node
// next-app-kit's command for whoever runs an app's server. One command so far:
//
//   next-app-kit token --prefix UPLOAD --token-prefix upl_ --email marcel@example.org --name "site build" --scope read [--days 365|none]
//
// makes an API token for a person on the allowed list (also one who never signed in) in the app's own auth.sqlite, from the app's own
// settings (<PREFIX>_*, PUBLIC_URL and DATA_DIR in the environment, as the app reads them), and prints it once on stdout; everything
// else goes to stderr. In a container: docker exec -u <the app's user> <container> node node_modules/next-app-kit/dist/cli.js token …
import { join } from "node:path";
import { parseArgs } from "node:util";
import { openAuth, signInFromEnv } from "./signin/accounts.js";
import { tokenForAddress } from "./tokens/address.js";

const USAGE =
  "usage: next-app-kit token --prefix <ENV PREFIX> --token-prefix <e.g. upl_> --email <address> --name <name> --scope read|read+write [--days <1-365>|none] [--file <auth.sqlite>]";

async function main(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  if (command !== "token") {
    console.error(USAGE);
    return 2;
  }
  const { values: a } = parseArgs({
    args: rest,
    options: {
      prefix: { type: "string" },
      "token-prefix": { type: "string" },
      email: { type: "string" },
      name: { type: "string" },
      scope: { type: "string" },
      days: { type: "string" },
      file: { type: "string" },
    },
  });
  if (!a.prefix || !a["token-prefix"] || !a.email || !a.name || (a.scope !== "read" && a.scope !== "read+write")) {
    console.error(USAGE);
    return 2;
  }
  const days = a.days === undefined ? undefined : a.days === "none" ? null : Number(a.days);
  const file = a.file ?? join(process.env.DATA_DIR ?? ".", "auth.sqlite");
  const log = (line: string) => console.error(line);
  const settings = signInFromEnv(process.env, { prefix: a.prefix, file, appName: a.prefix.toLowerCase(), log });
  // The sign-in mail's words are not needed to make a token; openAuth wants some.
  const auth = await openAuth(settings, {
    apiTokenPrefix: a["token-prefix"],
    texts: { en: { subject: (code) => code, body: (code) => code } },
  });
  const made = await tokenForAddress(auth, settings, { email: a.email, name: a.name, scope: a.scope, expiresInDays: days });
  if ("error" in made) {
    console.error(`error: ${made.error}`);
    return 1;
  }
  console.error(`made "${made.name}" (${made.scope}) for ${a.email.trim().toLowerCase()}, expires ${made.expires_at ?? "never"}`);
  console.log(made.token);
  return 0;
}

// The database stays open in openAuth: leave once the token is out.
process.exit(await main(process.argv.slice(2)));
