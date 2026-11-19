// The kit's core modules never import Next.js; only next-app-kit/next (src/next/) may (eslint.config.mjs). This test runs the real lint
// configuration over a one-line module in both places.
import { join } from "node:path";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const eslint = new ESLint({ cwd: join(import.meta.dirname, "..") });
const errors = async (path: string) =>
  (await eslint.lintText('import { NextResponse } from "next/server";\nexport { NextResponse };\n', { filePath: path }))[0]!.messages.map((m) => m.ruleId);

describe("the Next.js boundary", () => {
  it("refuses a next import in a core module", async () => {
    expect(await errors("src/signin/route.ts")).toContain("no-restricted-imports");
  });

  it("allows it in src/next/", async () => {
    expect(await errors("src/next/route.ts")).not.toContain("no-restricted-imports");
  });
});
