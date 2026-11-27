// Multipart uploads, moved from noticebox with its cases (each file field by its own rule, every problem listed at once) plus what an upload
// from a phone needs: a file over its size is cut off as it arrives, an aborted request leaves no temp file, and a refusal never stalls.
import { createWriteStream, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { MultipartError, multipartLimit, readMultipart, safeName, type FileRule, type MultipartOptions } from "./index.js";

// Every file the reader writes is counted, so a test can see that none is opened after a refusal.
vi.mock("node:fs", async (original) => {
  const fs = await original<typeof import("node:fs")>();
  return { ...fs, createWriteStream: vi.fn(fs.createWriteStream) };
});

const uploads = () => mkdtempSync(join(process.env.DATA_DIR!, "multipart-"));
const file = (name: string, bytes: number | Uint8Array, type = "application/octet-stream") =>
  new File([typeof bytes === "number" ? new Uint8Array(new ArrayBuffer(bytes)).fill(7) : (bytes as Uint8Array<ArrayBuffer>)], name, { type });

/** A multipart post, encoded up front, so a test that refuses it halfway doesn't cut off an encoder still writing. */
async function post(fields: Record<string, string>, files: [string, File][] = []): Promise<Request> {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  for (const [k, f] of files) fd.append(k, f);
  const encoded = new Response(fd);
  const body = await encoded.arrayBuffer();
  return new Request("http://test.invalid/upload", { method: "POST", body, headers: { "content-type": encoded.headers.get("content-type")! } });
}

const refused = async (p: Promise<unknown>): Promise<MultipartError> => {
  const e = await p.then(
    () => null,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(MultipartError);
  return e as MultipartError;
};

const BOUNDARY = "----kit";
const head = (name: string, extra = "") =>
  new TextEncoder().encode(
    `--${BOUNDARY}\r\ncontent-disposition: form-data; name="note"\r\n\r\nhi\r\n--${BOUNDARY}\r\ncontent-disposition: form-data; name="${name}"; filename="huge.bin"\r\ncontent-type: application/octet-stream\r\n\r\n${extra}`,
  );
const multipartHeaders = { "content-type": `multipart/form-data; boundary=${BOUNDARY}` };

const MB = 1024 * 1024;
const photo = (rule: Partial<FileRule> = {}): MultipartOptions["files"] => ({ photo: { label: "Photo", maxFiles: 1, maxFileBytes: MB, ...rule } });
const problemsOf = async (req: Request, opts: MultipartOptions) => {
  const m = await readMultipart(req, opts);
  await m.cleanup();
  return m.problems.map((p) => [p.field, p.code, p.message]);
};

test("fields and files arrive in order, with names, types and sizes, and cleanup removes them", async () => {
  const dir = uploads();
  const m = await readMultipart(
    await post({ a: "1", b: "2" }, [
      ["photo", file("a.jpg", 10, "image/jpeg")],
      ["photo", file("b.jpg", 20, "image/jpeg")],
      ["model", file("Part.STL", 5)],
    ]),
    { files: { ...photo({ maxFiles: 2, maxFileBytes: 100 }), model: { maxFiles: 1, maxFileBytes: 100, types: [".stl"] } }, tmpDir: dir },
  );
  expect(m.problems).toEqual([]);
  expect(m.fields).toEqual({ a: "1", b: "2" });
  expect(m.files.map((f) => [f.field, f.name, f.type, f.size])).toEqual([
    ["photo", "a.jpg", "image/jpeg", 10],
    ["photo", "b.jpg", "image/jpeg", 20],
    ["model", "Part.STL", "application/octet-stream", 5],
  ]);
  expect(readFileSync(m.files[1]!.path)).toHaveLength(20);
  expect(readdirSync(dir)).toHaveLength(1);
  await m.cleanup();
  expect(readdirSync(dir)).toEqual([]);
  await m.cleanup(); // twice is fine
});

test("a file of several chunks comes back byte for byte", async () => {
  const dir = uploads();
  const bytes = new Uint8Array(300_000).map((_, i) => (i * 31) % 251);
  const m = await readMultipart(await post({}, [["photo", file("scan.bin", bytes)]]), { files: photo(), tmpDir: dir });
  expect(m.files[0]!.size).toBe(bytes.byteLength);
  expect(new Uint8Array(readFileSync(m.files[0]!.path))).toEqual(bytes);
  await m.cleanup();
});

test("everyProblemAtOnce: what is wrong with each field is listed together, in the field's label", async () => {
  const dir = uploads();
  const files: MultipartOptions["files"] = {
    model: { label: "Model", types: [".stl", ".3mf"], maxFiles: 1, maxFileBytes: MB, required: true },
    photos: { label: "Photos", types: ["image/*"], maxFiles: 3, maxFileBytes: MB },
    sketch: { maxFiles: 1, maxFileBytes: MB, required: true },
  };
  const req = await post({}, [
    ["photos", file("sketch.pdf", 5, "application/pdf")],
    ["photos", file("empty.jpg", 0, "image/jpeg")],
    ["photos", file("ok.png", 5, "image/png")],
  ]);
  const m = await readMultipart(req, { files, tmpDir: dir });
  expect(m.problems.map((p) => [p.field, p.code, p.message])).toEqual([
    ["photos", "wrong_type", "Photos: sketch.pdf is not one of the accepted kinds (image/*)"],
    ["photos", "empty", "Photos: empty.jpg is empty"],
    ["model", "required", "Model is required"],
    ["sketch", "required", "sketch is required"],
  ]);
  expect(m.files.map((f) => f.name)).toEqual(["ok.png"]);
  await m.cleanup();
  expect(readdirSync(dir)).toEqual([]);
});

test("oversize: a file over its field's size is cut off as it arrives, the rest never read, and only the problem is the answer", async () => {
  const dir = uploads();
  let sent = 0;
  // A body that never ends: if the reader read it all, the test would time out.
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(head("photo"));
    },
    pull(c) {
      sent += 64 * 1024;
      c.enqueue(new Uint8Array(64 * 1024).fill(7));
    },
  });
  const req = new Request("http://test.invalid/upload", { method: "POST", body, headers: multipartHeaders, duplex: "half" } as RequestInit);
  // The whole post may be larger than one file: the field's own size cuts it off.
  const m = await readMultipart(req, {
    files: { photo: { label: "Photo", maxFiles: 1, maxFileBytes: MB }, other: { maxFiles: 5, maxFileBytes: 10 * MB } },
    tmpDir: dir,
  });
  expect(m.problems.map((p) => [p.code, p.message])).toEqual([["too_large", "Photo: huge.bin is larger than 1 MB"]]);
  expect(m.files).toEqual([]);
  expect(sent).toBeLessThan(3 * MB);
  await m.cleanup();
  expect(readdirSync(dir)).toEqual([]);
});

test("one file too many stops the post there", async () => {
  const two = await post({}, [
    ["photo", file("a.jpg", 5)],
    ["photo", file("b.jpg", 5)],
  ]);
  expect(await problemsOf(two, { files: photo(), tmpDir: uploads() })).toEqual([["photo", "too_many", "Photo: at most 1 file"]]);
});

test("a file for a field without a rule is a problem only when strict; an empty file input is no file", async () => {
  const req = () =>
    post({ a: "1" }, [
      ["other", file("x.bin", 1)],
      ["photo", file("", 0)],
    ]);
  expect(await problemsOf(await req(), { files: photo({ types: ["image/*"] }), tmpDir: uploads() })).toEqual([]);
  expect(await problemsOf(await req(), { files: photo(), strict: true, tmpDir: uploads() })).toEqual([
    ["other", "unexpected_field", "other is not a file field of this form"],
  ]);
});

test("types match by media type, wildcard or extension", async () => {
  const dir = uploads();
  expect(await problemsOf(await post({}, [["photo", file("a.jpg", 5, "image/jpeg")]]), { files: photo({ types: ["image/*"] }), tmpDir: dir })).toEqual([]);
  expect(await problemsOf(await post({}, [["photo", file("part.STL", 5)]]), { files: photo({ types: [".stl"] }), tmpDir: dir })).toEqual([]);
  expect(
    await problemsOf(await post({}, [["photo", file("a.pdf", 5, "application/pdf")]]), { files: photo({ types: ["image/jpeg", "image/png"] }), tmpDir: dir }),
  ).toEqual([["photo", "wrong_type", "Photo: a.pdf is not one of the accepted kinds (image/jpeg, image/png)"]]);
  expect(readdirSync(dir)).toEqual([]);
});

test("a declared content-length over what the rules allow is refused before anything is read", async () => {
  const dir = uploads();
  expect(multipartLimit({ files: photo() })).toBe(MB + 4096 + MB);
  const req = new Request("http://test.invalid/upload", {
    method: "POST",
    body: new Uint8Array(10),
    headers: { ...multipartHeaders, "content-length": String(50 * MB) },
  });
  const e = await refused(readMultipart(req, { files: photo(), tmpDir: dir }));
  expect([e.status, e.code]).toEqual([413, "too_large"]);
  expect(readdirSync(dir)).toEqual([]);
});

test("abortedRequestLeavesNoTempFile: the body breaking off halfway removes what was written", async () => {
  const dir = uploads();
  let n = 0;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(head("photo", "x".repeat(1000)));
    },
    async pull(c) {
      if (n++ < 2) {
        c.enqueue(new Uint8Array(4096).fill(7));
        await new Promise((r) => setTimeout(r, 20));
      } else c.error(new Error("connection reset"));
    },
  });
  const req = new Request("http://test.invalid/upload", { method: "POST", body, headers: multipartHeaders, duplex: "half" } as RequestInit);
  const e = await refused(readMultipart(req, { files: photo(), tmpDir: dir }));
  expect([e.status, e.code]).toEqual([400, "aborted"]);
  expect(readdirSync(dir)).toEqual([]);
});

test("abortedRequestLeavesNoTempFile: an abort signal on a body that just stops removes what was written too", async () => {
  const dir = uploads();
  const controller = new AbortController();
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(head("photo", "x".repeat(1000)));
      setTimeout(() => controller.abort(), 50);
    },
  });
  const req = new Request("http://test.invalid/upload", {
    method: "POST",
    body,
    headers: multipartHeaders,
    duplex: "half",
    signal: controller.signal,
  } as RequestInit);
  const e = await refused(readMultipart(req, { files: photo(), tmpDir: dir }));
  expect([e.status, e.code]).toEqual([400, "aborted"]);
  expect(readdirSync(dir)).toEqual([]);
});

test("abortedRequestLeavesNoTempFile: a request already aborted before it is read is refused at once", async () => {
  const dir = uploads();
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(head("photo", "x".repeat(1000)));
    },
  });
  const req = new Request("http://test.invalid/upload", {
    method: "POST",
    body,
    headers: multipartHeaders,
    duplex: "half",
    signal: AbortSignal.abort(),
  } as RequestInit);
  const e = await refused(readMultipart(req, { files: photo(), tmpDir: dir }));
  expect([e.status, e.code]).toEqual([400, "aborted"]);
  expect(readdirSync(dir)).toEqual([]);
}, 2000);

test("the default tmpDir is the system's temporary directory, and the folder made there is removed again", async () => {
  // TMPDIR points into the test's DATA_DIR, so the system's temporary directory is the test's own (conventions: code/tests-temp-dirs).
  const dir = uploads();
  vi.stubEnv("TMPDIR", dir);
  try {
    expect(tmpdir()).toBe(dir);
    const m = await readMultipart(await post({}, [["photo", file("a.jpg", 5)]]), { files: photo() });
    expect(m.files[0]!.path.startsWith(dir)).toBe(true);
    expect(readdirSync(dir)).toHaveLength(1);
    await m.cleanup();
    expect(readdirSync(dir)).toEqual([]);
  } finally {
    vi.unstubAllEnvs();
  }
});

test("a file's own name is kept without a path, control characters or quotes", () => {
  expect(safeName("C:\\Users\\a\\part.stl")).toBe("part.stl");
  expect(safeName("../../etc/passwd")).toBe("passwd");
  expect(safeName('a"b\u0001.stl')).toBe("ab.stl");
  expect(safeName("..")).toBe("file");
  expect(safeName("x".repeat(200))).toHaveLength(120);
});

test("everyRefusalCarriesItsCode: what is wrong with the post as a whole is thrown with its status and code", async () => {
  const dir = uploads();
  const opts = { files: photo({ maxFileBytes: 100 }), tmpDir: dir };
  const codeOf = async (req: Request) => {
    const e = await refused(readMultipart(req, opts));
    return [e.status, e.code];
  };
  expect(await codeOf(await post({ big: "x".repeat(MB + 1) }))).toEqual([413, "too_large"]);
  expect(await codeOf(new Request("http://test.invalid/upload", { method: "POST", body: "{}", headers: { "content-type": "application/json" } }))).toEqual([
    400,
    "not_multipart",
  ]);
  expect(await codeOf(new Request("http://test.invalid/upload", { method: "POST" }))).toEqual([400, "not_multipart"]);
  // Chunked (no content-length), and more than the whole post may be in one go: too large, not "aborted" (the cap tearing the body down is
  // no broken connection).
  const chunked = new ReadableStream<Uint8Array>({
    start(c) {
      c.enqueue(head("other"));
      c.enqueue(new Uint8Array(2 * MB).fill(7));
    },
  });
  expect(
    await codeOf(new Request("http://test.invalid/upload", { method: "POST", body: chunked, headers: multipartHeaders, duplex: "half" } as RequestInit)),
  ).toEqual([413, "too_large"]);
  expect(readdirSync(dir)).toEqual([]);
});

test("refusedFileDoesNotStall: a file refused as it starts answers at once, even with nothing else waking the event loop", async () => {
  // Stopping the post from inside busboy's own file event left the pipeline waiting for a write that never finished, until some unrelated
  // timer or I/O woke the process (an iPhone's HEIC upload hung until the request timed out). Each refusal here must answer by itself.
  const dir = uploads();
  const bytes = new Uint8Array(300_000).fill(7);
  for (let i = 0; i < 40; i++) {
    for (const [name, rule] of [
      ["IMG_0001.HEIC", { types: ["image/jpeg"] }],
      ["IMG_0002.jpg", { maxFileBytes: 1000 }],
    ] as [string, Partial<FileRule>][]) {
      const req = await post({}, [["photo", file(name, bytes, name.endsWith("HEIC") ? "image/heic" : "image/jpeg")]]);
      const started = performance.now();
      const got = await Promise.race([
        problemsOf(req, { files: photo(rule), tmpDir: dir }),
        new Promise<"stalled">((r) => setTimeout(() => r("stalled"), 1000)),
      ]);
      expect(got === "stalled" ? "stalled" : got[0]![1]).toBe(name.endsWith("HEIC") ? "wrong_type" : "too_large");
      expect(performance.now() - started).toBeLessThan(500);
    }
  }
  expect(readdirSync(dir)).toEqual([]);
}, 60_000);

test("noWriteAfterStop: once a post is stopped, a file that follows in the same chunk is never opened", async () => {
  const dir = uploads();
  const opened = vi.mocked(createWriteStream);
  opened.mockClear();
  const tooMany = await post({}, [
    ["photo", file("a.jpg", 5, "image/jpeg")],
    ["photo", file("b.jpg", 5, "image/jpeg")],
    ["photo", file("c.jpg", 5, "image/jpeg")],
  ]);
  expect((await problemsOf(tooMany, { files: photo(), tmpDir: dir })).map((p) => p[1])).toEqual(["too_many"]);
  // a.jpg is the only file ever opened.
  expect(opened).toHaveBeenCalledTimes(1);
  expect(readdirSync(dir)).toEqual([]);
});
