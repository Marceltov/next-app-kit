// Vitest's setupFiles: every test file gets a temporary directory as DATA_DIR, set again before each test (a test that changed or deleted
// it doesn't leak into the next) and removed at the end, so no test reads or writes an app's real data directory, auth.sqlite included
// (conventions: code/tests-temp-dirs). A test that needs a directory of its own still sets one.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach } from "vitest";

const dir = mkdtempSync(join(tmpdir(), "next-app-kit-test-"));
process.env.DATA_DIR = dir;
beforeEach(() => {
  process.env.DATA_DIR = dir;
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));
