// Files kept in the app's own SQLite database, moved from noticebox (its files and file_chunks tables, ADR 0007 there): each file a row
// with its owner (the record it came with, in the app's own words: a submission, an order), its field, name, media type and size, and
// its bytes in chunks of a megabyte, so neither writing nor reading a large file holds it in memory whole. The app writes a record's
// files in the same transaction as the record (the store's calls are synchronous and run on the app's own connection), and removes them
// with it. The tables are the app's, made by its own migrations (apps keep their schema; the kit only runs them): `FILES_SCHEMA` is what
// they must come to.
import { closeSync, openSync, readSync } from "node:fs";
import { randomBytes } from "node:crypto";

/** The tables FileStore reads and writes, as an app's migration makes them (an app may add a foreign key on `owner` to its records). */
export const FILES_SCHEMA = `
create table files (
  id text primary key,
  owner text not null,
  field text not null,
  name text not null,
  type text not null,
  size integer not null
);
create index files_by_owner on files (owner, id);
create table file_chunks (
  file_id text not null references files (id),
  seq integer not null,
  data blob not null,
  primary key (file_id, seq)
) without rowid;
`;

/** How large the chunks of a file are in the database. */
export const CHUNK_BYTES = 1024 * 1024;

/** A stored file, without its bytes. */
export type StoredFile = { id: string; owner: string; field: string; name: string; type: string; size: number };

/** A file to store: its bytes, or the temporary file that holds them (next-app-kit/multipart's files). */
export type NewFile = { field: string; name: string; type: string } & ({ data: Uint8Array } | { path: string; size: number });

/** What the store needs of a connection: better-sqlite3 has it. */
export type FilesConnection = {
  prepare(sql: string): { run(...params: unknown[]): { changes: number | bigint }; get(...params: unknown[]): unknown; all(...params: unknown[]): unknown[] };
};

/** A file's bytes in chunks, read from memory or from its temporary file one chunk at a time. */
function* chunksOf(f: NewFile): Generator<Uint8Array> {
  if ("data" in f) {
    for (let at = 0; at < f.data.byteLength; at += CHUNK_BYTES) yield f.data.subarray(at, at + CHUNK_BYTES);
    return;
  }
  const fd = openSync(f.path, "r");
  try {
    for (;;) {
      const buf = Buffer.allocUnsafe(CHUNK_BYTES);
      const n = readSync(fd, buf, 0, CHUNK_BYTES, null);
      if (n === 0) return;
      yield buf.subarray(0, n);
    }
  } finally {
    closeSync(fd);
  }
}

const newId = () => randomBytes(9).toString("base64url");
const marks = (n: number) => Array.from({ length: n }, () => "?").join(", ");

/** The files of the app's records, on its own connection. Every call is synchronous, so it joins whatever transaction the app is in. */
export class FileStore {
  constructor(private readonly db: FilesConnection) {}

  /** Stores `owner`'s new files in the order given; call it inside the transaction that writes the owner. */
  add(owner: string, files: NewFile[]): StoredFile[] {
    const insertFile = this.db.prepare("insert into files (id, owner, field, name, type, size) values (?, ?, ?, ?, ?, ?)");
    const insertChunk = this.db.prepare("insert into file_chunks (file_id, seq, data) values (?, ?, ?)");
    return files.map((f) => {
      const id = newId();
      const size = "data" in f ? f.data.byteLength : f.size;
      insertFile.run(id, owner, f.field, f.name, f.type, size);
      let seq = 0;
      for (const data of chunksOf(f)) insertChunk.run(id, seq++, data);
      return { id, owner, field: f.field, name: f.name, type: f.type, size };
    });
  }

  /** `owner`'s files, without their bytes, in the order they came. */
  of(owner: string): StoredFile[] {
    return this.db.prepare("select id, owner, field, name, type, size from files where owner = ? order by rowid").all(owner) as StoredFile[];
  }

  /** One file, without its bytes. */
  get(id: string): StoredFile | undefined {
    return this.db.prepare("select id, owner, field, name, type, size from files where id = ?").get(id) as StoredFile | undefined;
  }

  /** The `seq`th chunk of a file's bytes (from 0), or undefined past the last. */
  chunk(id: string, seq: number): Uint8Array | undefined {
    return (this.db.prepare("select data from file_chunks where file_id = ? and seq = ?").get(id, seq) as { data: Uint8Array } | undefined)?.data;
  }

  /**
   * Removes the files of `owners`, bytes and all, and returns how many went; `keep` names fields whose files stay (an app that removes
   * the personal part of a record and keeps the rest). Call it inside the transaction that changes the owners.
   */
  remove(owners: string[], opts: { keep?: string[] } = {}): number {
    if (owners.length === 0) return 0;
    const keep = opts.keep ?? [];
    const which = `select id from files where owner in (${marks(owners.length)})${keep.length ? ` and field not in (${marks(keep.length)})` : ""}`;
    this.db.prepare(`delete from file_chunks where file_id in (${which})`).run(...owners, ...keep);
    return Number(this.db.prepare(`delete from files where id in (${which})`).run(...owners, ...keep).changes);
  }
}
