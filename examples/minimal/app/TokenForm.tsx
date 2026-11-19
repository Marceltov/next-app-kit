"use client";

import { useActionState } from "react";
import { makeToken } from "./actions";

export function TokenForm() {
  const [made, action, pending] = useActionState(makeToken, null);
  return (
    <form action={action}>
      <label>
        Token name <input name="name" defaultValue="script" required maxLength={60} />
      </label>
      <button type="submit" disabled={pending}>
        Make an API token
      </button>
      {made && "token" in made && (
        <p>
          Your token, shown once: <code data-testid="token">{made.token}</code>
        </p>
      )}
      {made && "error" in made && <p role="alert">{made.error}</p>}
    </form>
  );
}
