// A multipart post read with a rule for each file field, moved from noticebox (backend/multipart.ts). Where next-app-kit/multipart has one
// rule for every file and stops at the first problem, this is for a form: each file field says which kinds it accepts, how many files and
// how large, and the answer lists what is wrong with every field at once, so the person posting can fix all of it in one go. Text fields
// are kept in memory; each file goes straight into a file of its own in a temporary folder (under `tmpDir`, default the system's), checked
// as it comes: a part for a field without a rule (when `strict`), of a kind the field doesn't accept, or one file too many is refused before
// its bytes are read, and a file that grows past its field's size is cut off there, with the rest of the post never read. So a post of any
// size needs about as much memory as one chunk of it. Nothing is stored until the caller has the whole answer (FileStore.add).
import { createWriteStream } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Transform, type TransformCallback } from "node:stream";
import { pipeline } from "node:stream/promises";
import busboy from "busboy";
import { mediaTypeOf, safeName, type ReceivedFile } from "../multipart/index.js";

export type { ReceivedFile };

/** What one file field takes: the kinds (`.stl`, `image/*`, `application/pdf`; none means any), how many files, how large each. */
export type FieldRule = { label: string; accept: string[]; maxFiles: number; maxBytes: number; required?: boolean };

/** What is wrong with one field. `message` is in English, in the field's label; an app with other words builds its own from the rest. */
export type UploadProblem = {
  field: string;
  code: "not_a_file_field" | "too_many" | "wrong_type" | "too_large" | "empty" | "required";
  file?: string;
  message: string;
};

/** What came with the post: its text fields, its files, and what is wrong with them. Call `cleanup()` once done with the files. */
export type Upload = { fields: Record<string, string>; files: ReceivedFile[]; problems: UploadProblem[]; cleanup: () => Promise<void> };

export type UploadOptions = {
  /** The rule of each file field, by the field's name. */
  rules: Record<string, FieldRule>;
  /** The largest the whole post may be, in bytes. */
  limit: number;
  /** Whether a file for a field without a rule is a problem (otherwise it is passed over). */
  strict?: boolean;
  /** Where the temporary folder goes; the system's temporary folder by default. */
  tmpDir?: string;
};

class Limit extends Error {}

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

/**
 * Reads a multipart post by `rules`. The answer is "too large" when the whole post is larger than `limit`, and "not a form" when it can't
 * be read (the temporary folder is gone then); otherwise the fields, the files and every problem found.
 */
export async function readUpload(req: Request, opts: UploadOptions): Promise<Upload | "too large" | "not a form"> {
  if (!req.body) return "not a form";
  let bb: busboy.Busboy;
  try {
    bb = busboy({ headers: Object.fromEntries(req.headers), limits: { fieldSize: opts.limit }, preservePath: true });
  } catch {
    return "not a form";
  }
  const dir = await mkdtemp(join(opts.tmpDir ?? tmpdir(), "upload-"));
  const cleanup = () => rm(dir, { recursive: true, force: true });
  const fields: Record<string, string> = {};
  const files: ReceivedFile[] = [];
  const problems: UploadProblem[] = [];
  const counts: Record<string, number> = {};
  const writing: Promise<void>[] = [];
  const source = Readable.fromWeb(req.body as import("node:stream/web").ReadableStream);
  const total = counter(opts.limit, () => new Limit("too large"));
  let stopped: "too large" | "not a form" | null = null;
  let n = 0;

  const say = (p: UploadProblem) => {
    if (!problems.some((q) => q.message === p.message)) problems.push(p);
  };
  /** Stops reading the post: what is wrong so far is the answer, the rest is never read. */
  const stop = () => {
    source.unpipe();
    source.destroy();
    total.destroy();
    bb.destroy();
  };

  bb.on("field", (name, value) => {
    if (!(name in fields)) fields[name] = value;
  });
  bb.on("file", (name, stream, info) => {
    const rule = Object.hasOwn(opts.rules, name) ? opts.rules[name] : undefined;
    if (!rule) {
      if (opts.strict) say({ field: name, code: "not_a_file_field", message: `${name} is not a file field of this form` });
      stream.resume();
      return;
    }
    // A file input left empty still sends a part, without a name and without bytes: that is no file. A part without a name is never taken
    // as one, so it can't be refused for its kind or count either.
    if (!info.filename) {
      stream.resume();
      return;
    }
    const fileName = safeName(info.filename);
    counts[name] = (counts[name] ?? 0) + 1;
    if (counts[name] > rule.maxFiles) {
      say({ field: name, code: "too_many", message: `${rule.label}: at most ${rule.maxFiles} file${rule.maxFiles === 1 ? "" : "s"}` });
      stream.resume();
      stop();
      return;
    }
    const type = mediaTypeOf(info.mimeType);
    if (!accepted(rule.accept, fileName, type)) {
      say({
        field: name,
        code: "wrong_type",
        file: fileName,
        message: `${rule.label}: ${fileName} is not one of the accepted kinds (${rule.accept.join(", ")})`,
      });
      stream.resume();
      return;
    }
    const path = join(dir, String(n++));
    const tooLarge: UploadProblem = {
      field: name,
      code: "too_large",
      file: fileName,
      message: `${rule.label}: ${fileName} is larger than ${megabytes(rule.maxBytes)}`,
    };
    const size = counter(rule.maxBytes, () => new Limit(tooLarge.message));
    writing.push(
      pipeline(stream, size, createWriteStream(path)).then(
        () => {
          if (size.bytes === 0) say({ field: name, code: "empty", file: fileName, message: `${rule.label}: ${fileName} is empty` });
          else files.push({ field: name, name: fileName, type, size: size.bytes, path });
        },
        (e: unknown) => {
          if (e instanceof Limit) {
            say(tooLarge);
            stop();
          }
        },
      ),
    );
  });

  try {
    await pipeline(source, total, bb);
  } catch (e) {
    if (e instanceof Limit) stopped = "too large";
    else if (problems.length === 0) stopped = "not a form";
  }
  await Promise.allSettled(writing);
  if (stopped) {
    await cleanup();
    return stopped;
  }
  // Each field's files in the order they came; the parts may have finished writing in another.
  files.sort((a, b) => Number(a.path.slice(dir.length + 1)) - Number(b.path.slice(dir.length + 1)));
  for (const [name, rule] of Object.entries(opts.rules))
    if (rule.required && !files.some((x) => x.field === name) && !problems.some((p) => p.field === name))
      problems.push({ field: name, code: "required", message: `${rule.label} is required` });
  return { fields, files, problems, cleanup };
}

/** An extension in `accept` matches the end of the name; a media type matches the browser's, `image/*` any image. None accepts all. */
export function accepted(accept: string[], name: string, type: string): boolean {
  if (accept.length === 0) return true;
  const lower = name.toLowerCase();
  return accept.some((a) => (a.startsWith(".") ? lower.endsWith(a) : a.endsWith("/*") ? type.startsWith(a.slice(0, -1)) : type === a));
}

const megabytes = (bytes: number): string => `${Math.round((bytes / 1024 / 1024) * 10) / 10} MB`;
