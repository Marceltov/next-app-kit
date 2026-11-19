// testRouteAbsentInProduction, against the production build (`npm run build` first): the test sign-in route's handler is not in the server
// bundle (while another string of the kit is, so the search is shown to look where the kit's code lands), and `next start` with MINIMAL_E2E=1 has no handler for it (Next.js answers a route without one 405), and sets no cookie.
import { spawn } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 3312;
const fail = (message: string) => {
  console.error(`absent-in-production: ${message}`);
  process.exitCode = 1;
};

// What only the handler says; source maps hold the source of everything and are left out. The control is a string of openAuth's, which
// every route over the app's runtime bundles: if it isn't found either, the search looks in the wrong place and proves nothing.
const MARKER = "?email= is needed";
const CONTROL = "this Auth was not made by openAuth";
const bundle = readdirSync(".next/server", { recursive: true, withFileTypes: true })
  .filter((f) => f.isFile() && f.name.endsWith(".js"))
  .map((f) => join(f.parentPath, f.name))
  .map((path) => ({ path, code: readFileSync(path, "utf8") }));
if (!bundle.some((f) => f.code.includes(CONTROL))) fail(`the control "${CONTROL}" is not in the production bundle either: the search proves nothing`);
const holding = bundle.filter((f) => f.code.includes(MARKER)).map((f) => f.path);
if (holding.length) fail(`the handler is in the production bundle: ${holding.join(", ")}`);

const data = mkdtempSync(join(tmpdir(), "minimal-absent-"));
const server = spawn("npx", ["next", "start", "-p", String(PORT)], {
  env: {
    ...process.env,
    DATA_DIR: data,
    PUBLIC_URL: `http://localhost:${PORT}`,
    PORT: String(PORT),
    MINIMAL_E2E: "1",
    MINIMAL_SECRET: "absent-secret-".padEnd(48, "x"),
    MINIMAL_ALLOWED_EMAILS: "ada@example.com",
    MINIMAL_SMTP_URL: "smtp://127.0.0.1:2525",
  },
  stdio: "inherit",
  detached: true,
});
try {
  let up = false;
  for (let i = 0; i < 60 && !up; i++) {
    up = await fetch(`http://localhost:${PORT}/health`).then(
      (r) => r.ok,
      () => false,
    );
    if (!up) await new Promise((r) => setTimeout(r, 500));
  }
  if (!up) fail("next start did not answer /health");
  else {
    const r = await fetch(`http://localhost:${PORT}/api/test/sign-in?email=ada@example.com`, { redirect: "manual" });
    if (r.status !== 404 && r.status !== 405) fail(`GET /api/test/sign-in answered ${r.status}`);
    if (r.headers.get("set-cookie")) fail("GET /api/test/sign-in set a cookie");
    if (!process.exitCode)
      console.log(`absent-in-production: the kit is in the bundle, the handler is not; GET /api/test/sign-in answers ${r.status} without a cookie`);
  }
} finally {
  process.kill(-server.pid!, "SIGTERM");
  rmSync(data, { recursive: true, force: true });
}
