// next-app-kit/multipart: a multipart post read as it arrives, moved from noticebox (backend/multipart.ts, generalised from a form's file
// fields to `maxFileBytes`, `maxFiles` and `types`). Text fields are kept in memory; each file goes straight into a file of its own in a
// temporary folder, checked as it comes: a file of a kind that is not accepted, or one file too many, is refused before its bytes are read,
// and a file that grows past `maxFileBytes` is cut off there with the rest of the post never read. So a post of any size needs about as
// much memory as one chunk of it. Where this differs from noticebox: it throws a `MultipartError` carrying the HTTP status the caller
// answers with (413 too large; 400 for anything else wrong with the post) and a `code` saying which problem it is (an app words its own
// message by the code; the English message is for logs) instead of returning "too large" / "not a form" / a list of messages; the first
// problem is the answer. The temporary folder is under `tmpDir` (default `os.tmpdir()`, as noticebox's default; an app
// passes its own, as noticebox's NOTICEBOX_UPLOAD_DIR) and is removed on every failure, an aborted request (the body breaking off, or the
// request's abort signal) included, so a phone losing its connection halfway leaves nothing behind; on success the caller calls `cleanup()`.
import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Transform, type TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";
import busboy from "busboy";

/**
 * Which problem a post has: a file or the post too large (413); a file of a kind not in `types`; more files, fields or parts than allowed;
 * an empty file; a body that is no multipart form; a request that broke off or was aborted before its end (all 400).
 */
export type MultipartCode = "too_large" | "wrong_type" | "too_many" | "empty" | "not_multipart" | "aborted";

/** What is wrong with a post: the status to answer with (413 for `too_large`, 400 for the rest) and its code, for the app's own words. */
export class MultipartError extends Error {
  readonly status: 400 | 413;
  constructor(
    readonly code: MultipartCode,
    message: string,
  ) {
    super(message);
    this.status = code === "too_large" ? 413 : 400;
    this.name = "MultipartError";
  }
}

export type MultipartOptions = {
  /** The largest a single file may be, in bytes. */
  maxFileBytes: number;
  /** How many files a post may carry. */
  maxFiles: number;
  /** Where the temporary folder is made; default `os.tmpdir()`. */
  tmpDir?: string;
  /** What a file may be: media types (`image/jpeg`, `image/*`) or extensions (`.stl`). Empty or left out: anything. */
  types?: string[];
};

/** A file of the post, checked and waiting in the temporary folder. */
export type ReceivedFile = { field: string; name: string; type: string; path: string; size: number };

export type Multipart = {
  fields: Record<string, string>;
  files: ReceivedFile[];
  /** Removes the temporary folder and every file in it; call it when done with the files. Safe to call twice. */
  cleanup: () => Promise<void>;
};

/** Text fields may be this large each, and all together this large: the rest of a post is files. */
const FIELD_BYTES = 64 * 1024;
const FIELDS_TOTAL_BYTES = 1024 * 1024;

/** Counts the bytes passing through and fails once there are more than `max`. */
function counter(max: number, onTooMany: () => Error): Transform & { bytes: number } {
  const t = new Transform({
    transform(chunk: Buffer, _enc, done: TransformCallback) {
      t.bytes += chunk.byteLength;
      if (t.bytes > max) done(onTooMany());
      else done(null, chunk);
    },
  }) as Transform & { bytes: number };
  t.bytes = 0;
  return t;
}

/** Reads a multipart post: its text fields and its files, which wait in a temporary folder until `cleanup()`. Throws a MultipartError. */
export async function readMultipart(req: Request, opts: MultipartOptions): Promise<Multipart> {
  const { maxFileBytes, maxFiles } = opts;
  const limit = maxFileBytes * maxFiles + FIELDS_TOTAL_BYTES;
  if (!req.body) throw new MultipartError("not_multipart", "the body is not a form");
  if (Number(req.headers.get("content-length") ?? 0) > limit) throw new MultipartError("too_large", "the body is too large");
  let bb: busboy.Busboy;
  try {
    bb = busboy({ headers: Object.fromEntries(req.headers), limits: { fieldSize: FIELD_BYTES, fields: 100, parts: 100 + maxFiles }, preservePath: true });
  } catch {
    throw new MultipartError("not_multipart", "the body is not a form");
  }
  const dir = await mkdtemp(join(opts.tmpDir ?? tmpdir(), "next-app-kit-upload-"));
  const cleanup = () => rm(dir, { recursive: true, force: true });
  const fields: Record<string, string> = {};
  const files: ReceivedFile[] = [];
  const writing: Promise<void>[] = [];
  const source = Readable.fromWeb(req.body as import("node:stream/web").ReadableStream);
  const total = counter(limit, () => new MultipartError("too_large", "the body is too large"));
  let failure: MultipartError | null = null;
  let fieldBytes = 0;
  let count = 0;
  let n = 0;

  /**
   * Stops reading the post: the first problem is the answer, the rest is never read. The streams are torn down on the next tick: stop is
   * often called from inside busboy's own file event, in the middle of its write, and destroying it there left the pipeline waiting for
   * that write until something unrelated woke the event loop (a refused HEIC hung until the request timed out).
   */
  const stop = (e?: MultipartError) => {
    failure ??= e ?? null;
    process.nextTick(() => {
      source.unpipe();
      source.destroy();
      total.destroy();
      bb.destroy();
    });
  };
  const onAbort = () => stop(new MultipartError("aborted", "the request was aborted"));
  // The body itself failing (the connection dropped) is an abort too; busboy would only call the cut-off rest "not a form". But the body
  // torn down by our own cap (`total`, on a chunked post) fails with that MultipartError, and that one is the answer: too large, not aborted.
  source.once("error", (e) => stop(e instanceof MultipartError ? e : new MultipartError("aborted", "the request was aborted")));
  req.signal.addEventListener("abort", onAbort, { once: true });
  // A signal that was aborted before the listener came fires no event: the request is over already.
  if (req.signal.aborted) onAbort();

  bb.on("field", (name, value, info) => {
    fieldBytes += Buffer.byteLength(value);
    if (info.valueTruncated || info.nameTruncated || fieldBytes > FIELDS_TOTAL_BYTES)
      return stop(new MultipartError("too_large", "the form's text fields are too large"));
    if (!(name in fields)) fields[name] = value;
  });
  bb.on("partsLimit", () => stop(new MultipartError("too_many", "the form has too many parts")));
  bb.on("fieldsLimit", () => stop(new MultipartError("too_many", "the form has too many fields")));
  bb.on("file", (field, stream, info) => {
    // Refused already: busboy may still hand over a file that was in the same chunk before it is torn down; it is never written.
    if (failure) return void stream.resume();
    // A file input left empty still sends a part, without a name and without bytes: that is no file, and never refused.
    if (!info.filename) return void stream.resume();
    const name = safeName(info.filename);
    if (++count > maxFiles) {
      stream.resume();
      return stop(new MultipartError("too_many", `at most ${maxFiles} file${maxFiles === 1 ? "" : "s"}`));
    }
    const type = mediaTypeOf(info.mimeType);
    if (!accepted(opts.types, name, type)) {
      stream.resume();
      return stop(new MultipartError("wrong_type", `${name} is not one of the accepted kinds (${opts.types!.join(", ")})`));
    }
    const path = join(dir, String(n++));
    const size = counter(maxFileBytes, () => new MultipartError("too_large", `${name} is larger than ${megabytes(maxFileBytes)}`));
    writing.push(
      pipeline(stream, size, createWriteStream(path)).then(
        () => {
          if (size.bytes === 0) stop(new MultipartError("empty", `${name} is empty`));
          else files.push({ field, name, type, path, size: size.bytes });
        },
        (e: unknown) => stop(e instanceof MultipartError ? e : undefined),
      ),
    );
  });

  try {
    await pipeline(source, total, bb);
  } catch (e) {
    failure ??= e instanceof MultipartError ? e : new MultipartError("not_multipart", "the body is not a form");
  } finally {
    req.signal.removeEventListener("abort", onAbort);
  }
  await Promise.allSettled(writing);
  if (failure) {
    await cleanup();
    throw failure;
  }
  // Files in the order they came; the parts may have finished writing in another.
  files.sort((a, b) => Number(a.path.slice(dir.length + 1)) - Number(b.path.slice(dir.length + 1)));
  return { fields, files, cleanup };
}

/** An extension in `types` matches the end of the name; a media type matches the sender's, `image/*` any image. */
function accepted(types: string[] | undefined, name: string, type: string): boolean {
  if (!types?.length) return true;
  const lower = name.toLowerCase();
  return types.some((a) => (a.startsWith(".") ? lower.endsWith(a.toLowerCase()) : a.endsWith("/*") ? type.startsWith(a.slice(0, -1)) : type === a));
}

/** The media type a sender declared, lower-cased, or `application/octet-stream` when it is not one. */
export const mediaTypeOf = (type: string): string => (/^[a-z]+\/[a-z0-9.+-]+$/i.test(type) ? type.toLowerCase() : "application/octet-stream");

const megabytes = (bytes: number): string => `${Math.round((bytes / 1024 / 1024) * 10) / 10} MB`;

/** The file's own name without any path, control characters or quotes, at most 120 characters; "file" when none is left. */
export function safeName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const cleaned = base
    // eslint-disable-next-line no-control-regex -- control characters are exactly what is removed
    .replace(/[\u0000-\u001f\u007f"]/g, "")
    .trim()
    .slice(-120);
  return cleaned && cleaned !== "." && cleaned !== ".." ? cleaned : "file";
}
