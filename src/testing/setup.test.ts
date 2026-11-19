// Pins the test setup (setup.ts, Vitest's setupFiles): with nothing set by the test, DATA_DIR is a directory of its own under the system's
// temp directory, so no test can write to an app's real data directory.
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

describe("test setup", () => {
  it("points DATA_DIR at an existing temporary directory", () => {
    const dir = process.env.DATA_DIR;
    expect(dir).toBeDefined();
    expect(dir!.startsWith(tmpdir())).toBe(true);
    expect(existsSync(dir!)).toBe(true);
  });

  it("sets DATA_DIR again for the next test after one changed it", () => {
    process.env.DATA_DIR = "/data";
  });

  it("still has the temporary directory after a test changed it", () => {
    expect(process.env.DATA_DIR!.startsWith(tmpdir())).toBe(true);
  });
});
