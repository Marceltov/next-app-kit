// Sign-in mail: the app's texts in the reader's language, and a failed send that logs neither the address nor the code.
import { createServer } from "node:net";
import { expect, test } from "vitest";
import { mailLanguage, renderMail, smtpMailer } from "./mail.js";
import { TEXTS } from "./testing.js";

test("mailLanguage", () => {
  const langs = ["de", "en"];
  expect(mailLanguage("en-GB,en;q=0.9,de;q=0.8", langs)).toBe("en");
  expect(mailLanguage("fr;q=1, de;q=0.5, en;q=0.4", langs)).toBe("de");
  expect(mailLanguage("de-AT", langs)).toBe("de");
  expect(mailLanguage("fr", langs)).toBe("de");
  expect(mailLanguage(null, langs)).toBe("de");
  expect(mailLanguage("*", langs)).toBe("de");
});

test("renderMail", () => {
  expect(renderMail(TEXTS, { to: "a@b.c", code: "123456", link: "https://x/l", language: "de" })).toEqual({
    subject: "123456 ist dein Anmeldecode",
    text: "Code 123456, oder öffne https://x/l",
  });
  // During an MCP or script sign-in there is no link; a language the app lacks falls back to its first.
  expect(renderMail(TEXTS, { to: "a@b.c", code: "123456", link: undefined, language: "fr" })).toEqual({
    subject: "123456 is your sign-in code",
    text: "Code 123456",
  });
});

test("failedSendLogsNoAddressOrCode", async () => {
  // A local server that hangs up at once: the send fails without leaving this machine.
  const server = createServer((socket) => socket.destroy());
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const logs: string[] = [];
  const send = smtpMailer({ url: `smtp://127.0.0.1:${port}`, from: "app@example.org" }, { texts: TEXTS, log: (l) => void logs.push(l) });
  await expect(send({ to: "ada@example.com", code: "987654", link: undefined, language: "en" })).rejects.toThrow();
  server.close();
  expect(logs).toHaveLength(1);
  expect(logs[0]).toMatch(/^mail: sending a sign-in code failed \(/);
  expect(logs[0]).not.toMatch(/ada@|987654/);
});
