// Multipart uploads, moved from noticebox (its multipart tests, generalised from forms to maxFileBytes / maxFiles / types) plus what an
// upload from a phone needs: a file over its size is cut off as it arrives and answers 413, and an aborted request leaves no temp file.
import { mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { MultipartError, readMultipart, safeName } from "./index.js";

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

test("fields and files arrive in order, with names, types and sizes, and cleanup removes them", async () => {
  const dir = uploads();
  const m = await readMultipart(
    await post({ a: "1", b: "2" }, [
      ["photo", file("a.jpg", 10, "image/jpeg")],
      ["photo", file("b.jpg", 20, "image/jpeg")],
    ]),
    {
      maxFileBytes: 100,
      maxFiles: 2,
      tmpDir: dir,
    },
  );
  expect(m.fields).toEqual({ a: "1", b: "2" });
  expect(m.files.map((f) => [f.field, f.name, f.type, f.size])).toEqual([
    ["photo", "a.jpg", "image/jpeg", 10],
    ["photo", "b.jpg", "image/jpeg", 20],
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
  const m = await readMultipart(await post({}, [["photo", file("scan.bin", bytes)]]), { maxFileBytes: 400_000, maxFiles: 1, tmpDir: dir });
  expect(m.files[0]!.size).toBe(bytes.byteLength);
  expect(new Uint8Array(readFileSync(m.files[0]!.path))).toEqual(bytes);
  await m.cleanup();
});

test("oversizeRefused413: a file over maxFileBytes is cut off as it arrives, answers 413, and leaves nothing", async () => {
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
  const e = await refused(readMultipart(req, { maxFileBytes: 1024 * 1024, maxFiles: 1, tmpDir: dir }));
  expect([e.status, e.code]).toEqual([413, "too_large"]);
  expect(e.message).toMatch(/huge\.bin is larger than 1 MB/);
  expect(sent).toBeLessThan(3 * 1024 * 1024);
  expect(readdirSync(dir)).toEqual([]);
});

test("a declared content-length over what the limits allow is refused before anything is read", async () => {
  const dir = uploads();
  const req = new Request("http://test.invalid/upload", {
    method: "POST",
    body: new Uint8Array(10),
    headers: { ...multipartHeaders, "content-length": String(50 * 1024 * 1024) },
  });
  const e = await refused(readMultipart(req, { maxFileBytes: 1000, maxFiles: 1, tmpDir: dir }));
  expect(e.status).toBe(413);
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
  const e = await refused(readMultipart(req, { maxFileBytes: 1024 * 1024, maxFiles: 1, tmpDir: dir }));
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
  const e = await refused(readMultipart(req, { maxFileBytes: 1024 * 1024, maxFiles: 1, tmpDir: dir }));
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
  const e = await refused(readMultipart(req, { maxFileBytes: 1024 * 1024, maxFiles: 1, tmpDir: dir }));
  expect([e.status, e.code]).toEqual([400, "aborted"]);
  expect(readdirSync(dir)).toEqual([]);
}, 2000);

test("more files than maxFiles, a body that is not multipart, and an empty file are 400 and leave nothing", async () => {
  const dir = uploads();
  const two = await post({}, [
    ["photo", file("a.jpg", 5)],
    ["photo", file("b.jpg", 5)],
  ]);
  expect((await refused(readMultipart(two, { maxFileBytes: 100, maxFiles: 1, tmpDir: dir }))).message).toMatch(/at most 1 file/);
  const plain = new Request("http://test.invalid/upload", { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
  expect((await refused(readMultipart(plain, { maxFileBytes: 100, maxFiles: 1, tmpDir: dir }))).status).toBe(400);
  const empty = await post({}, [["photo", file("a.jpg", 0)]]);
  const e = await refused(readMultipart(empty, { maxFileBytes: 100, maxFiles: 1, tmpDir: dir }));
  expect([e.status, e.message]).toEqual([400, "a.jpg is empty"]);
  expect(readdirSync(dir)).toEqual([]);
});

test("types: a file of another declared type is refused with 400, by media type, wildcard or extension", async () => {
  const dir = uploads();
  const opts = { maxFileBytes: 100, maxFiles: 1, tmpDir: dir };
  const ok = await readMultipart(await post({}, [["photo", file("a.jpg", 5, "image/jpeg")]]), { ...opts, types: ["image/*"] });
  await ok.cleanup();
  const e = await refused(readMultipart(await post({}, [["photo", file("a.pdf", 5, "application/pdf")]]), { ...opts, types: ["image/jpeg", "image/png"] }));
  expect([e.status, e.message]).toEqual([400, "a.pdf is not one of the accepted kinds (image/jpeg, image/png)"]);
  const byExt = await readMultipart(await post({}, [["photo", file("part.STL", 5)]]), { ...opts, types: [".stl"] });
  await byExt.cleanup();
  expect(readdirSync(dir)).toEqual([]);
});

test("a file input left empty sends a part without a name or bytes: no file", async () => {
  const dir = uploads();
  const m = await readMultipart(await post({ a: "1" }, [["photo", file("", 0)]]), { maxFileBytes: 100, maxFiles: 1, tmpDir: dir, types: ["image/*"] });
  expect(m.files).toEqual([]);
  expect(m.fields).toEqual({ a: "1" });
  await m.cleanup();
});

test("the default tmpDir is the system's temporary directory, and the folder made there is removed again", async () => {
  // TMPDIR points into the test's DATA_DIR, so the system's temporary directory is the test's own (conventions: code/tests-temp-dirs).
  const dir = uploads();
  vi.stubEnv("TMPDIR", dir);
  try {
    expect(tmpdir()).toBe(dir);
    const m = await readMultipart(await post({}, [["photo", file("a.jpg", 5)]]), { maxFileBytes: 100, maxFiles: 1 });
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

test("everyRefusalCarriesItsCode: an app tells refusals apart by code, never by message", async () => {
  const dir = uploads();
  const opts = { maxFileBytes: 100, maxFiles: 1, tmpDir: dir, types: ["image/jpeg"] };
  const codeOf = async (req: Request) => {
    const e = await refused(readMultipart(req, opts));
    return [e.status, e.code];
  };
  expect(await codeOf(await post({}, [["photo", file("a.jpg", 101, "image/jpeg")]]))).toEqual([413, "too_large"]);
  expect(await codeOf(await post({ big: "x".repeat(70 * 1024) }))).toEqual([413, "too_large"]);
  expect(await codeOf(await post({}, [["photo", file("a.heic", 5, "image/heic")]]))).toEqual([400, "wrong_type"]);
  expect(
    await codeOf(
      await post({}, [
        ["photo", file("a.jpg", 5, "image/jpeg")],
        ["photo", file("b.jpg", 5, "image/jpeg")],
      ]),
    ),
  ).toEqual([400, "too_many"]);
  expect(await codeOf(await post({}, [["photo", file("a.jpg", 0, "image/jpeg")]]))).toEqual([400, "empty"]);
  expect(await codeOf(new Request("http://test.invalid/upload", { method: "POST", body: "{}", headers: { "content-type": "application/json" } }))).toEqual([
    400,
    "not_multipart",
  ]);
  expect(await codeOf(new Request("http://test.invalid/upload", { method: "POST" }))).toEqual([400, "not_multipart"]);
  expect(readdirSync(dir)).toEqual([]);
});
