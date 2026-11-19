// checkPeers: npm refuses an app's install when a peer is at another version than the kit's exact one, unless the app set
// `legacy-peer-deps=true`; then nothing stops two copies of Better Auth running side by side. checkPeers, called in one of the app's unit
// tests, makes the same check from what is installed. The fixtures here are app directories with a node_modules of package.json files.
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import { checkPeers } from "./index.js";

const kit = JSON.parse(readFileSync(join(import.meta.dirname, "../../package.json"), "utf8")) as {
  peerDependencies: Record<string, string>;
  peerDependenciesMeta: Record<string, { optional?: boolean }>;
};

function install(dir: string, name: string, pkg: Record<string, unknown>) {
  mkdirSync(join(dir, "node_modules", name), { recursive: true });
  writeFileSync(join(dir, "node_modules", name, "package.json"), JSON.stringify({ name, ...pkg }));
}

/** An app directory with the kit and every peer at the kit's version, then `changes` (a version, or null for not installed). */
function app(changes: Record<string, string | null> = {}, dir = mkdtempSync(join(process.env.DATA_DIR!, "app-"))): string {
  install(dir, "next-app-kit", kit);
  for (const [name, version] of Object.entries({ ...kit.peerDependencies, ...changes })) if (version !== null) install(dir, name, { version });
  return dir;
}

test("peersMatch: every peer at the kit's version passes", () => {
  expect(() => checkPeers(app())).not.toThrow();
});

test("peerMismatchNamed: every mismatch and every missing peer is named, in one error", () => {
  const dir = app({ zod: "4.6.6", "better-auth": "1.8.0", "better-sqlite3": null });
  let message = "";
  try {
    checkPeers(dir);
  } catch (e) {
    message = (e as Error).message;
  }
  expect(message).toContain(`zod 4.6.6 is installed, the kit needs ${kit.peerDependencies.zod}`);
  expect(message).toContain(`better-auth 1.8.0 is installed, the kit needs ${kit.peerDependencies["better-auth"]}`);
  expect(message).toContain(`better-sqlite3 is not installed, the kit needs ${kit.peerDependencies["better-sqlite3"]}`);
  expect(message).toContain("legacy-peer-deps");
  expect(message).not.toContain("kysely");
});

test("optionalPeerSkipped: an optional peer that is not installed passes; installed, it must match", () => {
  expect(kit.peerDependenciesMeta.next?.optional).toBe(true);
  expect(() => checkPeers(app({ next: null }))).not.toThrow();
  expect(() => checkPeers(app({ next: "16.0.0" }))).toThrow(`next 16.0.0 is installed, the kit needs ${kit.peerDependencies.next}`);
});

test("peersResolvedAsNodeDoes: a peer hoisted to a parent directory's node_modules counts", () => {
  const root = app({ zod: null });
  install(root, "zod", { version: "4.0.0" });
  const nested = join(root, "apps", "web");
  mkdirSync(nested, { recursive: true });
  // The nested app finds the kit and its peers in the parent's node_modules, and its own zod first.
  install(nested, "zod", { version: kit.peerDependencies.zod! });
  expect(() => checkPeers(nested)).not.toThrow();
  expect(() => checkPeers(root)).toThrow("zod 4.0.0 is installed");
});

test("kitNotInstalled: an app directory without next-app-kit is refused by name", () => {
  expect(() => checkPeers(mkdtempSync(join(process.env.DATA_DIR!, "empty-")))).toThrow("next-app-kit is not installed");
});
