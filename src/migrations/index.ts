// The schema of an app's SQLite database as an ordered list of migrations, applied at open. Each runs exactly once, in its own transaction,
// and the database records how many have run in `PRAGMA user_version`. A migration that has shipped is never edited, because databases out
// there have already run it: a change to the schema is a new migration at the end of the list. The list is plain SQL, so it does not depend
// on the library that runs the queries. The kit holds the runner; each app keeps its own list in `backend/db/migrations.ts`.
export type Migration = { name: string; sql: string };

/** What a migration needs of a connection: better-sqlite3 has it, and so does any other SQLite driver. */
export type Connection = { exec(sql: string): unknown; prepare(sql: string): { get(): unknown } };

/**
 * Brings the database up to the last migration and returns how many ran. A failing migration is rolled back and
 * thrown, so the app refuses to open on a half-migrated database; one newer than this release knows is refused too.
 */
export function migrate(db: Connection, migrations: Migration[]): number {
  const version = () => (db.prepare("pragma user_version").get() as { user_version: number }).user_version;
  let ran = 0;
  for (;;) {
    // The version is read under the write lock, so two processes opening the same file at once never run one twice.
    db.exec("begin immediate");
    const current = version();
    if (current >= migrations.length) {
      db.exec("rollback");
      if (current > migrations.length)
        throw new Error(`the database is at schema version ${current}, newer than this release knows (${migrations.length}); a downgrade is not supported`);
      return ran;
    }
    const m = migrations[current]!;
    try {
      db.exec(m.sql);
      db.exec(`pragma user_version = ${current + 1}`);
      db.exec("commit");
      ran++;
    } catch (e) {
      // SQLite may have rolled back by itself already (a full disk, say); the migration's own error is the one to report.
      try {
        db.exec("rollback");
      } catch {
        // nothing left to roll back
      }
      throw new Error(`migration ${current + 1} (${m.name}) failed: ${(e as Error).message}`, { cause: e });
    }
  }
}
