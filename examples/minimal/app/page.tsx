import { headers } from "next/headers";
import { personOf } from "next-app-kit/signin";
import { auth } from "@/backend/app";
import { TokenForm } from "./TokenForm";

// Who is signed in, and a way to make an API token for /api/v1 (shown once).
export default async function Home() {
  const person = await personOf(await headers(), await auth());
  return (
    <main>
      <h1>Minimal</h1>
      {person ? (
        <>
          <p>Signed in as {person.email}</p>
          <TokenForm />
        </>
      ) : (
        <p>Not signed in.</p>
      )}
    </main>
  );
}
