// The runner: migrations apply in order, each once, a failure rolls back only that migration, and a database newer than the code is refused.
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import Database from "better-sqlite3";
import { expect, test } from "vitest";
import { migrate, type Migration } from "./index.js";

const LIST: Migration[] = [
  { name: "first", sql: "create table a (x integer);" },
  { name: "second", sql: "create table b (x integer); insert into b values (1);" },
];

const open = () => new Database(join(mkdtempSync(join(process.env.DATA_DIR!, "migrations-")), "test.sqlite"));
const version = (db: Database.Database) => (db.prepare("pragma user_version").get() as { user_version: number }).user_version;
const tables = (db: Database.Database) =>
  (db.prepare("select name from sqlite_master where type = 'table' and name not like 'sqlite_%' order by name").all() as { name: string }[]).map((t) => t.name);

test("appliesInOrder", () => {
  const db = open();
  const order: string[] = [];
  const spy: Migration[] = LIST.map((m) => ({
    ...m,
    get sql() {
      order.push(m.name);
      return m.sql;
    },
  }));
  expect(migrate(db, spy)).toBe(2);
  expect(order).toEqual(["first", "second"]);
  expect(tables(db)).toEqual(["a", "b"]);
  expect(version(db)).toBe(2);
  db.close();
});

test("eachOnce", () => {
  const db = open();
  expect(migrate(db, LIST)).toBe(2);
  expect(migrate(db, LIST)).toBe(0);
  const longer = [...LIST, { name: "later", sql: "create table later (x)" }];
  expect(migrate(db, longer)).toBe(1);
  expect(migrate(db, longer)).toBe(0);
  expect(db.prepare("select count(*) as n from b").get()).toEqual({ n: 1 });
  db.close();
});

test("failureRollsBackThatMigration", () => {
  const db = open();
  migrate(db, LIST);
  const broken: Migration[] = [...LIST, { name: "half done", sql: "create table half (x); insert into nowhere values (1);" }];
  expect(() => migrate(db, broken)).toThrow(/migration 3 \(half done\).*nowhere/);
  expect(db.prepare("select name from sqlite_master where name = 'half'").get()).toBeUndefined();
  expect(version(db)).toBe(2);
  db.close();
});

test("refusesDatabaseNewerThanCode", () => {
  const db = open();
  db.exec("pragma user_version = 3");
  expect(() => migrate(db, LIST)).toThrow(/newer than this release knows/);
  db.close();
});
