// checkPeers, for one of an app's unit tests. The kit's peers are exact so that npm refuses an install with another Better Auth, MCP SDK or
// zod beside the kit's; an app that sets `legacy-peer-deps=true` switches that refusal off and gets two copies running side by side, which
// breaks quietly (a second Better Auth sees none of the first one's plugins). checkPeers makes the same check from what is installed: the
// kit's package.json and each peer's, found as Node finds them from the app's directory (its node_modules, then each parent's). It reads
// files only; it imports nothing, so it works the same under any test runner.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";

type Manifest = { version?: string; peerDependencies?: Record<string, string>; peerDependenciesMeta?: Record<string, { optional?: boolean }> };

/** The package.json of `name` as Node resolves it from `dir`, or null when no node_modules up the tree holds it. */
function installed(dir: string, name: string): Manifest | null {
  for (let at = dir; ; at = dirname(at)) {
    const file = join(at, "node_modules", name, "package.json");
    if (existsSync(file)) return JSON.parse(readFileSync(file, "utf8")) as Manifest;
    if (dirname(at) === at) return null;
  }
}

/**
 * Throws, naming every mismatch, when a peer the kit names is installed at another version than the kit's, or not installed at all (an
 * optional peer, such as `next`, may be absent). `appDir` is where the app's package.json is; default the working directory, where a test
 * runner starts. Call it in one unit test, and don't set `legacy-peer-deps`.
 */
export function checkPeers(appDir: string = process.cwd()): void {
  const kit = installed(appDir, "next-app-kit");
  if (!kit) throw new Error(`next-app-kit is not installed in ${appDir}`);
  const wrong: string[] = [];
  for (const [name, needed] of Object.entries(kit.peerDependencies ?? {})) {
    const got = installed(appDir, name);
    if (!got) {
      if (!kit.peerDependenciesMeta?.[name]?.optional) wrong.push(`${name} is not installed, the kit needs ${needed}`);
    } else if (got.version !== needed) wrong.push(`${name} ${got.version ?? "(no version)"} is installed, the kit needs ${needed}`);
  }
  if (wrong.length > 0)
    throw new Error(`next-app-kit's peers don't match: ${wrong.join("; ")}. Install the versions the kit names, together, and don't set legacy-peer-deps.`);
}
