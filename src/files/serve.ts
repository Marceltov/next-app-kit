// Serving a stored file, moved from noticebox (backend/files.ts). A stranger chose its name, its bytes and its media type, so it is never
// rendered as a page of the app: everything is a download, except the common photo formats, which an app may show as pictures, and even
// those are sandboxed and never sniffed into something else. SVG is not among them: it can carry script. The bytes are streamed a chunk
// at a time, so a large file never sits in memory whole.
//
// A signed link hands one file to whoever holds it for a few minutes, without signing in: that is how an MCP tool gives a file out
// without its bytes passing through the model. It is signed with the app's secret and names the file and its expiry, nothing else.
import { createHmac, timingSafeEqual } from "node:crypto";
import type { FileStore, StoredFile } from "./store.js";

/** The media types an app may show inline as a picture: never SVG. */
export const PICTURE_TYPES: ReadonlySet<string> = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"]);

/** Whether a file may be shown as a picture instead of offered as a download. */
export const isPicture = (f: Pick<StoredFile, "type">): boolean => PICTURE_TYPES.has(f.type);

/**
 * The file as an HTTP answer. `inline` asks to show a picture rather than download it; anything else is a download either way, as
 * `application/octet-stream` with `nosniff` and a sandboxing CSP.
 */
export function fileResponse(store: FileStore, f: StoredFile, opts: { inline?: boolean } = {}): Response {
  const inline = Boolean(opts.inline) && isPicture(f);
  // RFC 6266: an ASCII fallback for old clients, and the real name UTF-8 encoded.
  const ascii = f.name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  let seq = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(c) {
      const chunk = store.chunk(f.id, seq++);
      if (chunk) c.enqueue(chunk);
      else c.close();
    },
  });
  return new Response(body, {
    headers: {
      "content-type": inline ? f.type : "application/octet-stream",
      "content-length": String(f.size),
      "content-disposition": `${inline ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(f.name)}`,
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; sandbox",
      "cache-control": "private, no-store",
    },
  });
}

/** What a signed link is made and checked with: the app's secret, a word that keeps its links apart from any other app's, and now. */
export type LinkSigner = { secret: string; purpose: string; now: () => Date };

const sign = (s: LinkSigner, id: string, exp: number): string => createHmac("sha256", s.secret).update(`${s.purpose}\n${id}\n${exp}`).digest("base64url");

/** `url` (the file's own URL in the app) with `exp` and `sig` added, working for `minutes` from now. */
export function signedFileUrl(s: LinkSigner, url: string, id: string, minutes: number): { url: string; expires_at: string } {
  const exp = Math.floor(s.now().getTime() / 1000) + minutes * 60;
  const u = new URL(url);
  u.searchParams.set("exp", String(exp));
  u.searchParams.set("sig", sign(s, id, exp));
  return { url: u.toString(), expires_at: new Date(exp * 1000).toISOString() };
}

/** Whether a request's `exp` and `sig` are a link for `id` that has not run out. */
export function signedFor(s: LinkSigner, id: string, params: URLSearchParams): boolean {
  const exp = Number(params.get("exp"));
  const sig = params.get("sig") ?? "";
  if (!Number.isInteger(exp) || exp * 1000 < s.now().getTime()) return false;
  const want = Buffer.from(sign(s, id, exp));
  const got = Buffer.from(sig);
  return got.length === want.length && timingSafeEqual(got, want);
}
