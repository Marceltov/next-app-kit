import js from "@eslint/js";
import prettier from "eslint-config-prettier/flat";
import { defineConfig, globalIgnores } from "eslint/config";
import tseslint from "typescript-eslint";

// The kit's core modules are framework-free: only next-app-kit/next (src/next/, the route-handler factories) may import Next.js, so an app
// that uses the kit without Next.js never loads it (src/boundary.test.ts runs this rule).
const NO_NEXT = {
  paths: [{ name: "next", message: "Only src/next/ imports Next.js." }],
  patterns: [{ group: ["next/*", "@next/*"], message: "Only src/next/ imports Next.js." }],
};

export default defineConfig([
  js.configs.recommended,
  ...tseslint.configs.recommended,
  { files: ["src/**"], ignores: ["src/next/**"], rules: { "no-restricted-imports": ["error", NO_NEXT] } },
  // Last, so no ESLint rule argues with Prettier's layout.
  prettier,
  globalIgnores(["dist/**", "coverage/**"]),
]);
