// The package's promises to the apps that install it. Peers are exact, so an app that bumps Better Auth alone fails to install instead of
// running two copies; every peer is also installed here at that same version, so the tests run against what the apps get; and every
// `exports` entry points at a file the build writes (built into a temporary directory, never into the repository's dist/).
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as {
  exports: Record<string, string | Record<string, string>>;
  peerDependencies: Record<string, string>;
  devDependencies: Record<string, string>;
};

describe("package.json", () => {
  it("declares every peer dependency at an exact version", () => {
    const peers = Object.entries(pkg.peerDependencies);
    expect(peers.length).toBeGreaterThan(0);
    for (const [name, version] of peers) expect(version, name).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("installs every peer for its own tests at the same version", () => {
    for (const [name, version] of Object.entries(pkg.peerDependencies)) expect(pkg.devDependencies[name], name).toBe(version);
  });

  it("has a built file for every exports entry after the build", () => {
    const out = join(process.env.DATA_DIR!, "dist");
    execFileSync(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "-p", join(root, "tsconfig.build.json"), "--outDir", out]);
    const targets = Object.values(pkg.exports).flatMap((entry) => (typeof entry === "string" ? [entry] : Object.values(entry)));
    expect(targets.length).toBeGreaterThan(0);
    for (const target of targets) {
      expect(target, "exports point into dist/").toMatch(/^\.\/dist\//);
      expect(existsSync(join(out, target.slice("./dist/".length))), target).toBe(true);
    }
  }, 60_000);
});
