// Sign-in mail: a code, and a link to sign in with when there may be one (accounts.ts decides: never during an MCP or script sign-in),
// through the app's <PREFIX>_SMTP_URL. The words are the app's (`texts`, one set per language it speaks); the kit holds no copy of its own,
// and picks the language from the Accept-Language of the request that asked for the code. Logs neither the address nor the code nor the
// link (conventions: stacks/nextjs, logs). Tests pass a Mailer of their own instead of SMTP.

export type Smtp = { url: string; from: string };

/** One language's sign-in mail. `link` is undefined when the mail must hold only the code (an MCP or script sign-in). */
export type MailTexts = {
  subject: (code: string) => string;
  body: (code: string, link: string | undefined) => string;
};

/** A sign-in mail to send: `language` is one of the keys of the app's texts. */
export type SignInMail = { to: string; code: string; link: string | undefined; language: string };

export type Mailer = (mail: SignInMail) => Promise<void>;

// An SMTP server that never answers (a blocked port) fails the sign-in within these, logged, instead of hanging it.
const TIMEOUTS = { connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 20_000 };

/** The language of `available` the reader prefers most, by their Accept-Language; the app's first language when none matches. */
export function mailLanguage(acceptLanguage: string | null | undefined, available: string[]): string {
  const wanted = (acceptLanguage ?? "")
    .split(",")
    .map((part, i) => {
      const [tag, ...params] = part.trim().split(";");
      const q = Number(
        params
          .find((p) => p.trim().startsWith("q="))
          ?.trim()
          .slice(2) ?? "1",
      );
      return { tag: (tag ?? "").trim().toLowerCase(), q: Number.isFinite(q) ? q : 0, i };
    })
    .filter((w) => w.tag && w.tag !== "*" && w.q > 0)
    .sort((a, b) => b.q - a.q || a.i - b.i);
  for (const w of wanted) {
    const found = available.find((a) => a.toLowerCase() === w.tag) ?? available.find((a) => a.toLowerCase() === w.tag.split("-")[0]);
    if (found) return found;
  }
  return available[0]!;
}

/** The subject and text of a sign-in mail, in its language, or the app's first when it has no texts in that one. */
export function renderMail(texts: Record<string, MailTexts>, mail: SignInMail): { subject: string; text: string } {
  const t = texts[mail.language] ?? Object.values(texts)[0];
  if (!t) throw new Error("no sign-in mail texts: the app passes them to openAuth");
  return { subject: t.subject(mail.code), text: t.body(mail.code, mail.link) };
}

export function smtpMailer(smtp: Smtp, opts: { texts: Record<string, MailTexts>; log: (line: string) => void }): Mailer {
  return async (mail) => {
    const { subject, text } = renderMail(opts.texts, mail);
    try {
      const { createTransport } = await import("nodemailer");
      await createTransport({ url: smtp.url, ...TIMEOUTS }).sendMail({ from: smtp.from, to: mail.to, subject, text });
    } catch (e) {
      // The error may name the address: only its code is logged.
      opts.log(`mail: sending a sign-in code failed (${(e as NodeJS.ErrnoException).code ?? "unknown"})`);
      throw e;
    }
  };
}
