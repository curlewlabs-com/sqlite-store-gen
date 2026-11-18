import { describe, expect, test } from "bun:test";
import {
  createTableStatement,
  normalizeLocalSQLiteMigrations,
  type LocalSQLiteMigrationStep,
  type LocalSQLiteSchemaTableSpec,
} from "./schema";

function currentTable(): LocalSQLiteSchemaTableSpec {
  return {
    name: "shelf_state",
    primaryKey: ["singleton_id"],
    columns: [
      {
        name: "singleton_id",
        sqliteType: "INTEGER",
        nullable: false,
        brand: "SingletonId",
      },
      {
        name: "row_version",
        sqliteType: "INTEGER",
        nullable: false,
        brand: "RowVersion",
      },
      {
        name: "enabled",
        sqliteType: "INTEGER",
        nullable: false,
        brand: "Enabled",
        default: 0,
      },
    ],
  };
}

function migration(
  toVersion: number,
  statements: string[],
): LocalSQLiteMigrationStep {
  return { toVersion, statements, doc: "Exercises the migration compiler." };
}

describe("schema compiler", () => {
  test("compiles a contiguous ladder and appends its atomic version stamp", () => {
    const steps = normalizeLocalSQLiteMigrations(
      2,
      [
        migration(2, [
          "ALTER TABLE shelf_state ADD COLUMN enabled INTEGER NOT NULL DEFAULT 0",
        ]),
      ],
      [currentTable()],
      [],
    );

    expect(steps).toEqual([
      {
        toVersion: 2,
        statements: [
          "ALTER TABLE shelf_state ADD COLUMN enabled INTEGER NOT NULL DEFAULT 0",
          "PRAGMA user_version = 2",
        ],
      },
    ]);
    expect(createTableStatement(currentTable())).toContain(
      "singleton_id INTEGER PRIMARY KEY",
    );
  });

  test("rejects a statement form the replay cannot model", () => {
    // An unclassified form must fail closed; otherwise every later replay
    // verdict could be based on a store shape the compiler never recorded.
    expect(() =>
      normalizeLocalSQLiteMigrations(
        2,
        [migration(2, ["DROP TABLE shelf_state"])],
        [currentTable()],
        [],
      ),
    ).toThrow("is not an allowlisted form");
  });

  test("lets SQLite reject a column introduced twice", () => {
    // The classifier only identifies the form. Real SQLite decides whether the
    // ordered statements can execute against the shape produced by earlier steps.
    expect(() =>
      normalizeLocalSQLiteMigrations(
        3,
        [
          migration(2, [
            "ALTER TABLE shelf_state ADD COLUMN enabled INTEGER NOT NULL DEFAULT 0",
          ]),
          migration(3, [
            "ALTER TABLE shelf_state ADD COLUMN enabled INTEGER NOT NULL DEFAULT 0",
          ]),
        ],
        [currentTable()],
        [],
      ),
    ).toThrow("duplicate column name: enabled");
  });

  // The steps a table retirement takes: a ladder step created it, so a store stamped
  // past that step already holds it and only another step can remove it.
  const createRetired = migration(2, [
    "CREATE TABLE IF NOT EXISTS retired_reading_list (a INTEGER PRIMARY KEY) STRICT",
  ]);
  const dropRetired = migration(3, [
    "DROP TABLE IF EXISTS retired_reading_list",
  ]);

  test("compiles a drop of a table obsoleteTables names", () => {
    const steps = normalizeLocalSQLiteMigrations(
      3,
      [createRetired, dropRetired],
      [currentTable()],
      ["retired_reading_list"],
    );

    expect(steps[1]!.statements).toEqual([
      "DROP TABLE IF EXISTS retired_reading_list",
      "PRAGMA user_version = 3",
    ]);
  });

  test("rejects a drop of a table obsoleteTables does not name", () => {
    // Guards the live-row loss: a drop is only safe for a table this build no longer
    // owns, and obsoleteTables is where the spec says so - it already refuses a live
    // table. It also keeps the fresh-install path, which drops only obsoleteTables,
    // agreeing with the ladder.
    expect(() =>
      normalizeLocalSQLiteMigrations(
        3,
        [createRetired, dropRetired],
        [currentTable()],
        [],
      ),
    ).toThrow("is not an allowlisted form");
  });

  test("rejects a drop written any way but the generated one", () => {
    // The drop's table decides which rows are deleted, so it is never read out of the
    // statement: only the exact text `dropTableStatement` produces for an obsoleteTables
    // name is a drop. A variant SQLite would accept just as well - lower case, a quoted
    // or schema-qualified name - is refused rather than interpreted.
    for (const variant of [
      "drop table if exists retired_reading_list",
      'DROP TABLE IF EXISTS "retired_reading_list"',
      "DROP TABLE IF EXISTS main.retired_reading_list",
      "DROP TABLE retired_reading_list",
    ]) {
      expect(() =>
        normalizeLocalSQLiteMigrations(
          3,
          [createRetired, migration(3, [variant])],
          [currentTable()],
          ["retired_reading_list"],
        ),
      ).toThrow("is not an allowlisted form");
    }
  });

  test("rejects a drop of a table the store does not have yet", () => {
    // `IF EXISTS` turns this into a silent no-op on a device, so a misspelled or
    // misordered drop would leave the table and its rows in place with every open
    // succeeding. The replay is the only place it is visible.
    expect(() =>
      normalizeLocalSQLiteMigrations(
        2,
        [migration(2, ["DROP TABLE IF EXISTS retired_reading_list"])],
        [currentTable()],
        ["retired_reading_list"],
      ),
    ).toThrow(
      "drops table retired_reading_list, which a store at version 1 does not have",
    );
  });

  test("rejects a ladder that re-creates a table it retired", () => {
    // Each statement is legal against the store it meets - the drop finds the table, the
    // re-create finds it gone - so only the ladder's end state shows that an upgraded
    // store would hold a table a fresh install never creates.
    expect(() =>
      normalizeLocalSQLiteMigrations(
        4,
        [createRetired, dropRetired, migration(4, createRetired.statements)],
        [currentTable()],
        ["retired_reading_list"],
      ),
    ).toThrow(
      "the ladder leaves table retired_reading_list, which the baseline does not create",
    );
  });
});
