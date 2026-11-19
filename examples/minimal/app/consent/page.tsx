// The consent page, the copy-in source next-app-kit documents (README, "The consent page"): the kit ships no UI, so an app copies this
// page and ConsentForm.tsx into app/consent/ and gives them its own words and styles. Better Auth sends the signed-in person here, during an
// MCP client's or a script's OAuth sign-in, with the client and its scopes in a signed query; ConsentForm answers it, and the client gets
// its code.
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { clientNameFor, personOf } from "next-app-kit/signin";
import { auth, SIGN_IN_PAGE } from "@/backend/app";
import { ConsentForm } from "./ConsentForm";

export default async function ConsentPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  // Headers first: reading them makes the page render per request, so `next build` never opens the app.
  const h = await headers();
  const query = await searchParams;
  const a = await auth();
  const person = await personOf(h, a);
  // Not signed in: to the app's sign-in page, the one openAuth was given (`pages.signIn`), carrying this page and its signed query as
  // `?next=`, so the person comes back here once signed in. This example has no sign-in page: its tests sign in through /api/test/sign-in.
  if (!person) {
    const back = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) for (const one of Array.isArray(v) ? v : v === undefined ? [] : [v]) back.append(k, one);
    redirect(`${SIGN_IN_PAGE}?${new URLSearchParams({ next: `/consent?${back}` })}`);
  }
  const clientId = typeof query.client_id === "string" ? query.client_id : "";
  const name = (clientId && (await clientNameFor(h, clientId, a))) || "An app this instance doesn't know";
  return (
    <main>
      <h1>Allow access?</h1>
      <p>
        <strong>{name}</strong> wants to act as <strong>{person.email}</strong>.
      </p>
      <p>What it does is recorded in your name, with its name.</p>
      <ConsentForm />
    </main>
  );
}
