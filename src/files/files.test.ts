// next-app-kit/files, moved from noticebox with its cases: a form's post read by each file field's own rule with every problem listed at
// once, files kept in chunks in the app's database and removed with their owner (or all but the fields an app keeps), and a stored file
// served as a download unless it is a common photo, with a signed link that runs out.
import { mkdtempSync, readdirSync } from "node:fs";
import { join } from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { describe, expect, test } from "vitest";
import { migrate } from "../migrations/index.js";
import { CHUNK_BYTES, FileStore, fileResponse, filesMigration, readUpload, signedFileUrl, signedFor, type FieldRule } from "./index.js";

const tmp = () => mkdtempSync(join(process.env.DATA_DIR!, "files-"));
const file = (name: string, bytes: number, type = "application/octet-stream") => new File([new Uint8Array(bytes).fill(7)], name, { type });

async function post(fields: Record<string, string>, files: [string, File][] = []): Promise<Request> {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.append(k, v);
  for (const [k, f] of files) fd.append(k, f);
  const encoded = new Response(fd);
  return new Request("http://test.invalid/f", {
    method: "POST",
    body: await encoded.arrayBuffer(),
    headers: { "content-type": encoded.headers.get("content-type")! },
  });
}

const MB = 1024 * 1024;
const rules: Record<string, FieldRule> = {
  model: { label: "Model", accept: [".stl", ".3mf"], maxFiles: 1, maxBytes: MB, required: true },
  photos: { label: "Photos", accept: ["image/*"], maxFiles: 3, maxBytes: MB },
};

describe("readUpload", () => {
  test("takes each field's files by its own rule, in order, and cleanup removes them", async () => {
    const dir = tmp();
    const u = await readUpload(
      await post({ name: "Ada" }, [
        ["model", file("Part.STL", 10)],
        ["photos", file("a.jpg", 5, "image/jpeg")],
        ["photos", file("b.png", 6, "image/png")],
      ]),
      { rules, limit: 10 * MB, tmpDir: dir },
    );
    if (typeof u === "string") throw new Error(u);
    expect(u.problems).toEqual([]);
    expect(u.fields).toEqual({ name: "Ada" });
    expect(u.files.map((f) => [f.field, f.name, f.type, f.size])).toEqual([
      ["model", "Part.STL", "application/octet-stream", 10],
      ["photos", "a.jpg", "image/jpeg", 5],
      ["photos", "b.png", "image/png", 6],
    ]);
    await u.cleanup();
    expect(readdirSync(dir)).toEqual([]);
  });

  test("lists what is wrong with every field at once, in each field's label", async () => {
    const u = await readUpload(
      await post({}, [
        ["photos", file("sketch.pdf", 5, "application/pdf")],
        ["photos", file("empty.jpg", 0, "image/jpeg")],
      ]),
      {
        rules,
        limit: 10 * MB,
        tmpDir: tmp(),
      },
    );
    if (typeof u === "string") throw new Error(u);
    expect(u.problems.map((p) => [p.field, p.code, p.message])).toEqual([
      ["photos", "wrong_type", "Photos: sketch.pdf is not one of the accepted kinds (image/*)"],
      ["photos", "empty", "Photos: empty.jpg is empty"],
      ["model", "required", "Model is required"],
    ]);
  });

  test("a file past its field's size or one too many stops the post there", async () => {
    const big = await readUpload(await post({}, [["model", file("huge.stl", MB + 1)]]), { rules, limit: 10 * MB, tmpDir: tmp() });
    if (typeof big === "string") throw new Error(big);
    expect(big.problems.map((p) => p.message)).toEqual(["Model: huge.stl is larger than 1 MB"]);
    const many = await readUpload(
      await post({}, [
        ["model", file("a.stl", 1)],
        ["model", file("b.stl", 1)],
      ]),
      { rules, limit: 10 * MB, tmpDir: tmp() },
    );
    if (typeof many === "string") throw new Error(many);
    expect(many.problems.map((p) => [p.code, p.message])).toEqual([["too_many", "Model: at most 1 file"]]);
  });

  test("a file for a field without a rule is a problem only when strict; an empty file input is no file", async () => {
    const req = () =>
      post({}, [
        ["model", file("a.stl", 1)],
        ["other", file("x.bin", 1)],
        ["photos", new File([], "")],
      ]);
    const loose = await readUpload(await req(), { rules, limit: 10 * MB, tmpDir: tmp() });
    const strict = await readUpload(await req(), { rules, limit: 10 * MB, tmpDir: tmp(), strict: true });
    if (typeof loose === "string" || typeof strict === "string") throw new Error("not read");
    expect(loose.problems).toEqual([]);
    expect(strict.problems.map((p) => p.message)).toEqual(["other is not a file field of this form"]);
  });

  test("a post over the limit is too large and one that isn't multipart is not a form, with nothing left behind", async () => {
    const dir = tmp();
    expect(await readUpload(await post({}, [["model", file("a.stl", 2000)]]), { rules, limit: 1000, tmpDir: dir })).toBe("too large");
    expect(
      await readUpload(new Request("http://test.invalid/f", { method: "POST", body: "{}", headers: { "content-type": "application/json" } }), {
        rules,
        limit: 1000,
        tmpDir: dir,
      }),
    ).toBe("not a form");
    expect(readdirSync(dir)).toEqual([]);
  });
});

function store() {
  const db = new BetterSqlite3(":memory:");
  migrate(db, [filesMigration]);
  return { db, files: new FileStore(db) };
}

describe("FileStore", () => {
  test("keeps a file in chunks, from memory or its temporary file, in the owner's order", async () => {
    const { files } = store();
    const big = { model: { ...rules.model!, maxBytes: 2 * MB } };
    const u = await readUpload(await post({}, [["model", file("a.stl", CHUNK_BYTES + 5)]]), { rules: big, limit: 10 * MB, tmpDir: tmp() });
    if (typeof u === "string") throw new Error(u);
    const [a] = files.add("s1", u.files);
    const [b] = files.add("s1", [{ field: "photos", name: "b.png", type: "image/png", data: new Uint8Array([1, 2, 3]) }]);
    await u.cleanup();
    expect(files.of("s1").map((f) => [f.name, f.size])).toEqual([
      ["a.stl", CHUNK_BYTES + 5],
      ["b.png", 3],
    ]);
    expect(files.chunk(a!.id, 0)!.byteLength).toBe(CHUNK_BYTES);
    expect(files.chunk(a!.id, 1)!.byteLength).toBe(5);
    expect(files.chunk(a!.id, 2)).toBeUndefined();
    expect(files.get(b!.id)).toEqual({ id: b!.id, owner: "s1", field: "photos", name: "b.png", type: "image/png", size: 3 });
  });

  test("removes an owner's files with their bytes, or all but the fields kept, and joins the app's transaction", () => {
    const { db, files } = store();
    const data = new Uint8Array([1]);
    files.add("s1", [
      { field: "model", name: "a.stl", type: "x/y", data },
      { field: "photos", name: "b.png", type: "image/png", data },
    ]);
    files.add("s2", [{ field: "model", name: "c.stl", type: "x/y", data }]);
    expect(files.remove(["s1"], { keep: ["model"] })).toBe(1);
    expect(files.of("s1").map((f) => f.name)).toEqual(["a.stl"]);
    expect(() =>
      db.transaction(() => {
        files.remove(["s1", "s2"]);
        throw new Error("no");
      })(),
    ).toThrow("no");
    expect(files.of("s2")).toHaveLength(1);
    expect(files.remove(["s1", "s2"])).toBe(2);
    expect(db.prepare("select count(*) as n from file_chunks").get()).toEqual({ n: 0 });
  });
});

describe("serving", () => {
  const signer = (now = new Date("2026-11-27T10:00:00Z")) => ({ secret: "s".repeat(40), purpose: "test file link", now: () => now });

  test("a stranger's file is a sandboxed download; only a common photo is shown inline, never SVG", async () => {
    const { files } = store();
    const [svg, png] = files.add("s1", [
      { field: "f", name: "x.svg", type: "image/svg+xml", data: new TextEncoder().encode("<svg/>") },
      { field: "f", name: "Bild ä.png", type: "image/png", data: new Uint8Array([1, 2]) },
    ]);
    const s = fileResponse(files, svg!, { inline: true });
    expect(s.headers.get("content-type")).toBe("application/octet-stream");
    expect(s.headers.get("content-disposition")).toMatch(/^attachment;/);
    expect(s.headers.get("x-content-type-options")).toBe("nosniff");
    expect(s.headers.get("content-security-policy")).toBe("default-src 'none'; sandbox");
    expect(await s.text()).toBe("<svg/>");
    const p = fileResponse(files, png!, { inline: true });
    expect(p.headers.get("content-type")).toBe("image/png");
    expect(p.headers.get("content-disposition")).toBe(`inline; filename="Bild _.png"; filename*=UTF-8''Bild%20%C3%A4.png`);
    expect(new Uint8Array(await p.arrayBuffer())).toEqual(new Uint8Array([1, 2]));
  });

  test("a signed link works for its file until it runs out, and for no other file", () => {
    const { url, expires_at } = signedFileUrl(signer(), "https://app.test/files/abc?inline=1", "abc", 15);
    expect(expires_at).toBe("2026-11-27T10:15:00.000Z");
    const params = new URL(url).searchParams;
    expect(params.get("inline")).toBe("1");
    expect(signedFor(signer(), "abc", params)).toBe(true);
    expect(signedFor(signer(), "abd", params)).toBe(false);
    expect(signedFor({ ...signer(), purpose: "another app" }, "abc", params)).toBe(false);
    expect(signedFor(signer(new Date("2026-11-27T10:15:01Z")), "abc", params)).toBe(false);
  });
});
