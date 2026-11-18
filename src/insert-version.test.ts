import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTableStatement } from "./schema";
import {
  loadExample,
  loadExampleRaw,
  render,
  sqlConstBody,
  tableNamed,
} from "./test-support";

// The method body of a generated function, from its declaration to the next one.
function methodBody(source: string, declaration: string): string {
  const start = source.indexOf(declaration);
  if (start < 0) throw new Error(`no generated method ${declaration}`);
  const next = source.indexOf("\n    fun ", start + 1);
  const nextSwift = source.indexOf("\n    func ", start + 1);
  const ends = [next, nextSwift].filter((index) => index > 0);
  return source.slice(start, Math.min(...ends));
}

// An insert returns the row's version. It used to read that back with a second statement
// after its upsert committed, so a write from another connection in between made the
// returned version that writer's. The upsert now returns the version itself.
describe("an insert's returned version", () => {
  test("the generated insert runs one statement and reads no version back", async () => {
    const { kotlin, swift } = render(await loadExample());
    const kotlinInsert = methodBody(
      kotlin,
      "fun insertOrReplaceSignedInReader(",
    );
    const swiftInsert = methodBody(
      swift,
      "func insertOrReplaceSignedInReader(",
    );

    expect(kotlinInsert.split("withStatement(").length - 1).toBe(1);
    expect(swiftInsert.split("prepare(").length - 1).toBe(1);
    for (const body of [kotlinInsert, swiftInsert]) {
      expect(body).not.toContain("readStoredReaderVersion");
    }
  });

  // Run against a real SQLite, with the statement each platform emits: the version it
  // returns is the row's stored version on the insert arm and on the conflict arm, and a
  // second connection writing right after it cannot change what it returned.
  test("the upsert returns the version it stored, on either arm", async () => {
    const { kotlin, swift } = render(await loadExample());
    const raw = await loadExampleRaw();
    const directory = mkdtempSync(join(tmpdir(), "sqlite-store-gen-insert-"));
    try {
      const path = join(directory, "reader.sqlite3");
      const setup = new Database(path);
      setup.run(createTableStatement(tableNamed(raw, "signed_in_reader")));
      setup.close();

      for (const sql of [
        sqlConstBody(kotlin, "INSERT_OR_REPLACE_READER_SQL"),
        sqlConstBody(swift, "insertOrReplaceReaderSQL"),
      ]) {
        const first = new Database(path);
        const second = new Database(path);
        try {
          first.run("DELETE FROM signed_in_reader");
          const upsert = (database: Database, reader: string) =>
            database
              .query<{ row_version: number }, [number, string]>(sql)
              .get(1, reader)?.row_version;
          const stored = (database: Database) =>
            database
              .query<{ row_version: number }, []>(
                "SELECT row_version FROM signed_in_reader WHERE singleton_id = 1",
              )
              .get()?.row_version;

          // Insert arm: no row yet.
          expect(upsert(first, "reader-1")).toBe(1);
          expect(stored(first)).toBe(1);
          // Conflict arm: the row exists and its version advances.
          expect(upsert(first, "reader-2")).toBe(2);
          expect(stored(first)).toBe(2);

          // Another connection writes right after. The value the first upsert returned is
          // still its own write's; a read-back at this point, which is what the second
          // statement used to be, would have answered the other writer's version.
          const returned = upsert(first, "reader-3");
          expect(upsert(second, "reader-4")).toBe(4);
          expect(returned).toBe(3);
          expect(stored(first)).toBe(4);
        } finally {
          first.close();
          second.close();
        }
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
