"use server";

import { headers } from "next/headers";
import { personOf } from "next-app-kit/signin";
import { createApiToken } from "next-app-kit/tokens";
import { auth } from "@/backend/app";

export type Made = { token: string } | { error: string } | null;

/** A read-only API token for the signed-in person; the token is in the answer once and never again. */
export async function makeToken(_previous: Made, form: FormData): Promise<Made> {
  const a = await auth();
  const person = await personOf(await headers(), a);
  if (!person) return { error: "not signed in" };
  const made = await createApiToken(a, person.id, { name: String(form.get("name") ?? ""), scope: "read" });
  return "error" in made ? { error: made.error } : { token: made.token };
}
