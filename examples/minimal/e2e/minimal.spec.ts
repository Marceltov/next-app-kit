// The kit in a real Next.js app: sign in through testSignInRoute, make an API token on the app's page, call the REST operation with it, and
// find the metadata the 401s of /api/v1 and /mcp point to. The consent page (the kit's copy-in source) renders for the signed-in person.
import { expect, test } from "@playwright/test";

const PERSON = "ada@example.com";

test("signs in through the test route and calls the REST operation with an API token", async ({ page, playwright, baseURL }) => {
  await page.goto(`/api/test/sign-in?email=${encodeURIComponent(PERSON)}&next=/`);
  await expect(page).toHaveURL(`${baseURL}/`);
  await expect(page.getByText(`Signed in as ${PERSON}`)).toBeVisible();

  await page.getByRole("button", { name: "Make an API token" }).click();
  const token = (await page.getByTestId("token").textContent())!;
  expect(token).toMatch(/^min_/);

  // A client of its own: no session cookie, only the token.
  const api = await playwright.request.newContext({ baseURL });
  const ok = await api.get("/api/v1/greeting?name=Grace", { headers: { authorization: `Bearer ${token}` } });
  expect(ok.status()).toBe(200);
  expect(await ok.json()).toEqual({ greeting: "Hello, Grace" });

  const none = await api.get("/api/v1/greeting?name=Grace");
  expect(none.status()).toBe(401);
  expect(none.headers()["www-authenticate"]).toContain(`${baseURL}/.well-known/oauth-protected-resource/api/v1`);
  await api.dispose();
});

test("the protected resources and the authorization server describe themselves", async ({ request, baseURL }) => {
  const mcp = await request.post("/mcp", { data: {} });
  expect(mcp.status()).toBe(401);
  expect(mcp.headers()["www-authenticate"]).toContain(`${baseURL}/.well-known/oauth-protected-resource/mcp`);
  expect(await (await request.get("/.well-known/oauth-protected-resource/mcp")).json()).toMatchObject({ resource: `${baseURL}/mcp` });
  expect(await (await request.get("/.well-known/oauth-protected-resource/api/v1")).json()).toMatchObject({ resource: `${baseURL}/api/v1` });
  expect(await (await request.get("/.well-known/oauth-authorization-server/api/auth")).json()).toMatchObject({ issuer: `${baseURL}/api/auth` });
  expect(await (await request.get("/.well-known/openid-configuration/api/auth")).json()).toMatchObject({ issuer: `${baseURL}/api/auth` });
  const doc = await request.get("/api/v1/openapi.json");
  expect(((await doc.json()) as { paths: Record<string, unknown> }).paths).toHaveProperty("/greeting");
});

test("the test route refuses an address not on the list", async ({ request }) => {
  const r = await request.get("/api/test/sign-in?email=eve@example.com", { maxRedirects: 0 });
  expect(r.status()).toBe(403);
  expect(r.headers()["set-cookie"]).toBeUndefined();
});

test("the consent page asks the signed-in person", async ({ page }) => {
  await page.goto(`/api/test/sign-in?email=${encodeURIComponent(PERSON)}&next=${encodeURIComponent("/consent?client_id=unknown")}`);
  await expect(page.getByRole("heading", { name: "Allow access?" })).toBeVisible();
  await expect(page.getByText(PERSON)).toBeVisible();
  await expect(page.getByRole("button", { name: "Allow" })).toBeVisible();
});
