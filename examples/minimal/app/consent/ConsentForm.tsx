"use client";
// Allow or deny the client. oauthProviderClient sends this page's signed query along, which says what is consented to.
import { useState } from "react";
import { authClient } from "@/app/auth-client";

export function ConsentForm() {
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  async function answer(accept: boolean) {
    setBusy(true);
    const { data, error } = await authClient.oauth2.consent({ accept });
    if (error || !data?.url) {
      setBusy(false);
      setFailed(true);
      return;
    }
    window.location.assign(data.url);
  }

  return (
    <div>
      <button type="button" disabled={busy} onClick={() => answer(true)}>
        Allow
      </button>
      <button type="button" disabled={busy} onClick={() => answer(false)}>
        Deny
      </button>
      {failed && <p role="alert">That didn't work. Start again from the app that sent you here.</p>}
    </div>
  );
}
