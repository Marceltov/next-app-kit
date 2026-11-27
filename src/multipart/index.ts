// next-app-kit/multipart: a multipart post read as it arrives, moved from noticebox (backend/multipart.ts) with what an upload from a phone
// needs. Each file field has its own rule (`files`: which kinds, how many, how large, whether it is required), as a form has; the answer
// lists what is wrong with every field at once (`problems`, each with a `code` and an English message in the field's label), so the person
// posting can fix all of it in one go. Text fields are kept in memory; each file goes straight into a file of its own in a temporary folder,
// checked as it comes: a part of a kind the field doesn't accept is refused before its bytes are read, and one file too many or a file that
// grows past its field's size stops the post there, with the rest never read. So a post of any size needs about as much memory as one chunk
// of it. What is wrong with the post as a whole is thrown as a `MultipartError` carrying the HTTP status to answer with (413 too large;
// 400 for the rest) and a `code` (an app words its own message by the code; the English message is for logs). The temporary folder is under
// `tmpDir` (default `os.tmpdir()`: half-read posts are not data) and is removed on every failure, an aborted request (the body breaking
// off, or the request's abort signal) included, so a phone losing its connection halfway leaves nothing behind; on success the caller
// calls `cleanup()`.
import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Transform, type TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";
import busboy from "busboy";

/**
 * What is wrong with the post as a whole: it or its text fields too large (413); more fields or parts than allowed; a body that is no
 * multipart form; a request that broke off or was aborted before its end (all 400).
 */
export type MultipartCode = "too_large" | "too_many" | "not_multipart" | "aborted";

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

/** What one file field takes: its kinds (`image/*`, `application/pdf`, `.stl`; none means any), how many files, how large each. */
export type FileRule = {
  /** The field's name for people, in the problems' messages; the field's own name when left out. */
  label?: string;
  types?: string[];
  maxFiles: number;
  maxFileBytes: number;
  required?: boolean;
};

/** What is wrong with one file field. `message` is English, in the field's label; an app with other words builds its own from the rest. */
export type FileProblem = {
  field: string;
  code: "unexpected_field" | "too_many" | "wrong_type" | "too_large" | "empty" | "required";
  file?: string;
  message: string;
};

export type MultipartOptions = {
  /** The rule of each file field, by the field's name. */
  files: Record<string, FileRule>;
  /** Whether a file for a field without a rule is a problem (`unexpected_field`); otherwise it is passed over. */
  strict?: boolean;
  /** How large the text fields may be, each and all together, in bytes; default 1 MB. */
  fieldBytes?: number;
  /** Where the temporary folder is made; default `os.tmpdir()`. */
  tmpDir?: string;
};

/** A file of the post, checked and waiting in the temporary folder. */
export type ReceivedFile = { field: string; name: string; type: string; path: string; size: number };

export type Multipart = {
  fields: Record<string, string>;
  files: ReceivedFile[];
  /** What is wrong with the file fields, every field at once; empty when nothing is. */
  problems: FileProblem[];
  /** Removes the temporary folder and every file in it; call it when done with the files. Safe to call twice. */
  cleanup: () => Promise<void>;
};

const FIELDS_BYTES = 1024 * 1024;
/** Room for each file part's own headers in the whole post. */
const PART_HEADERS = 4096;

/** How large a post with these rules may be: every file field full, its part headers, and the text fields. */
export function multipartLimit(opts: Pick<MultipartOptions, "files" | "fieldBytes">): number {
  return Object.values(opts.files).reduce((sum, r) => sum + r.maxFiles * (r.maxFileBytes + PART_HEADERS), opts.fieldBytes ?? FIELDS_BYTES);
}

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

/** A file cut off at its field's size: a problem of the field, not of the post. */
class FileTooLarge extends Error {}

/**
 * Reads a multipart post: its text fields, its files (waiting in a temporary folder until `cleanup()`) and what is wrong with them. Throws a
 * MultipartError when the post as a whole can't be taken.
 */
export async function readMultipart(req: Request, opts: MultipartOptions): Promise<Multipart> {
  const fieldBytes = opts.fieldBytes ?? FIELDS_BYTES;
  const limit = multipartLimit(opts);
  const maxFiles = Object.values(opts.files).reduce((sum, r) => sum + r.maxFiles, 0);
  if (!req.body) throw new MultipartError("not_multipart", "the body is not a form");
  if (Number(req.headers.get("content-length") ?? 0) > limit) throw new MultipartError("too_large", "the body is too large");
  let bb: busboy.Busboy;
  try {
    bb = busboy({ headers: Object.fromEntries(req.headers), limits: { fieldSize: fieldBytes, fields: 100, parts: 100 + maxFiles }, preservePath: true });
  } catch {
    throw new MultipartError("not_multipart", "the body is not a form");
  }
  const dir = await mkdtemp(join(opts.tmpDir ?? tmpdir(), "next-app-kit-upload-"));
  const cleanup = () => rm(dir, { recursive: true, force: true });
  const fields: Record<string, string> = {};
  const files: ReceivedFile[] = [];
  const problems: FileProblem[] = [];
  const counts: Record<string, number> = {};
  const writing: Promise<void>[] = [];
  const source = Readable.fromWeb(req.body as import("node:stream/web").ReadableStream);
  const total = counter(limit, () => new MultipartError("too_large", "the body is too large"));
  let failure: MultipartError | null = null;
  let stopped = false;
  let textBytes = 0;
  let n = 0;

  const say = (p: FileProblem) => {
    if (!problems.some((q) => q.message === p.message)) problems.push(p);
  };
  /**
   * Stops reading the post: a MultipartError is the answer; without one, the problems so far are, and the rest is never read. The streams
   * are torn down on the next tick: stop is often called from inside busboy's own file event, in the middle of its write, and destroying it
   * there left the pipeline waiting for that write until something unrelated woke the event loop (a refused HEIC hung until the request
   * timed out).
   */
  const stop = (e?: MultipartError) => {
    if (!stopped && !failure) failure = e ?? null;
    if (stopped) return;
    stopped = true;
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
  // Once stopped on purpose, the body's error is our own teardown.
  source.once("error", (e) => {
    if (e instanceof MultipartError) failure ??= e;
    else if (!stopped) stop(new MultipartError("aborted", "the request was aborted"));
  });
  req.signal.addEventListener("abort", onAbort, { once: true });
  // A signal that was aborted before the listener came fires no event: the request is over already.
  if (req.signal.aborted) onAbort();

  bb.on("field", (name, value, info) => {
    textBytes += Buffer.byteLength(value);
    if (info.valueTruncated || info.nameTruncated || textBytes > fieldBytes)
      return stop(new MultipartError("too_large", "the form's text fields are too large"));
    if (!(name in fields)) fields[name] = value;
  });
  bb.on("partsLimit", () => stop(new MultipartError("too_many", "the form has too many parts")));
  bb.on("fieldsLimit", () => stop(new MultipartError("too_many", "the form has too many fields")));
  bb.on("file", (field, stream, info) => {
    // Stopped already: busboy may still hand over a file that was in the same chunk before it is torn down; it is never written.
    if (stopped) return void stream.resume();
    const rule = Object.hasOwn(opts.files, field) ? opts.files[field] : undefined;
    if (!rule) {
      if (opts.strict) say({ field, code: "unexpected_field", message: `${field} is not a file field of this form` });
      return void stream.resume();
    }
    // A file input left empty still sends a part, without a name and without bytes: that is no file. A part without a name is never taken
    // as one, so it can't be refused for its kind or count either.
    if (!info.filename) return void stream.resume();
    const label = rule.label ?? field;
    const name = safeName(info.filename);
    counts[field] = (counts[field] ?? 0) + 1;
    if (counts[field] > rule.maxFiles) {
      say({ field, code: "too_many", message: `${label}: at most ${rule.maxFiles} file${rule.maxFiles === 1 ? "" : "s"}` });
      stream.resume();
      return stop();
    }
    const type = mediaTypeOf(info.mimeType);
    if (!accepted(rule.types, name, type)) {
      say({ field, code: "wrong_type", file: name, message: `${label}: ${name} is not one of the accepted kinds (${rule.types!.join(", ")})` });
      return void stream.resume();
    }
    const path = join(dir, String(n++));
    const size = counter(rule.maxFileBytes, () => new FileTooLarge());
    writing.push(
      pipeline(stream, size, createWriteStream(path)).then(
        () => {
          if (size.bytes === 0) say({ field, code: "empty", file: name, message: `${label}: ${name} is empty` });
          else files.push({ field, name, type, path, size: size.bytes });
        },
        (e: unknown) => {
          if (e instanceof FileTooLarge) {
            say({ field, code: "too_large", file: name, message: `${label}: ${name} is larger than ${megabytes(rule.maxFileBytes)}` });
            stop();
          } else if (e instanceof MultipartError) stop(e);
        },
      ),
    );
  });

  try {
    await pipeline(source, total, bb);
  } catch (e) {
    if (e instanceof MultipartError) failure ??= e;
    else if (!stopped) failure ??= new MultipartError("not_multipart", "the body is not a form");
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
  for (const [field, rule] of Object.entries(opts.files))
    if (rule.required && !files.some((f) => f.field === field) && !problems.some((p) => p.field === field))
      problems.push({ field, code: "required", message: `${rule.label ?? field} is required` });
  return { fields, files, problems, cleanup };
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
