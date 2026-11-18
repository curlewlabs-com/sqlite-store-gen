import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import type { LocalSQLitePredicateTerm } from "./operation";
import { createTableStatement } from "./schema";
import { normalizeLocalSQLiteSpec } from "./spec";
import {
  addSingletonCasTable,
  cloneSpec,
  loadExample,
  loadExampleRaw,
  operationNamed,
  render,
  sqlConstBody,
  tableNamed,
} from "./test-support";

async function fresh() {
  return cloneSpec(await loadExampleRaw());
}

describe("row ownership and compare-and-set spec", () => {
  test("rejects a compare-and-set table without an expected-version brand", async () => {
    // The CAS surface takes the caller's observed version as a typed brand; with no
    // operationBrands.expectedVersion there is no type to give that parameter, so
    // generation must fail rather than emit invalid source.
    const invalid = await fresh();
    delete addSingletonCasTable(invalid).operationBrands;

    expect(() => normalizeLocalSQLiteSpec(invalid)).toThrow(
      "operationBrands.expectedVersion",
    );
  });

  // Every one of these produces a working-looking update that is not a compare-and-set,
  // which is why the version term is not something a spec can write at all. A wrong or
  // missing brand falls through to a plain column set, where an unbranded term binds the
  // fixed SINGLETON_ID slot - `row_version = 1`, no expected-version parameter, no bump. A
  // non-equality operator keeps the CAS pre-read but widens the UPDATE's own match.
  const authoredVersionTerms: {
    label: string;
    term: LocalSQLitePredicateTerm;
  }[] = [
    { label: "no brand", term: { column: "row_version", operator: "=" } },
    {
      label: "the wrong brand",
      term: {
        column: "row_version",
        operator: "=",
        brand: "ExpectedSyncCursorRowVersionTypo",
      },
    },
    {
      label: "a non-equality operator",
      term: {
        column: "row_version",
        operator: ">",
        brand: "ExpectedSyncCursorRowVersion",
      },
    },
    {
      label: "the exact brand the generator would synthesize",
      term: {
        column: "row_version",
        operator: "=",
        brand: "ExpectedSyncCursorRowVersion",
      },
    },
  ];

  for (const { label, term } of authoredVersionTerms) {
    test(`rejects a predicate that writes its own row_version term with ${label}`, async () => {
      const invalid = await fresh();
      const table = addSingletonCasTable(invalid);
      const cas = table.operations[table.operations.length - 1]!;
      cas.predicate = [...(cas.predicate ?? []), term];

      expect(() => normalizeLocalSQLiteSpec(invalid)).toThrow(
        "row_version must not appear in a predicate",
      );
    });
  }

  // The slot term is the other half a spec could supply, and the CAS emitters cannot
  // defend against a malformed one because they read the predicate as given: an
  // owner-keyed slot term missing its brand drops out of the key columns, and any extra
  // branded term joins them. Both generate and are wrong, so the predicate is the
  // generator's alone.
  test("rejects an owner-keyed casUpdate whose slot term lost its brand", async () => {
    const invalid = await fresh();
    operationNamed(
      tableNamed(invalid, "reader_profile"),
      "compare_and_set_books_finished_reader_profile",
    ).predicate = [{ column: "reader_id", operator: "=" }];

    expect(() => normalizeLocalSQLiteSpec(invalid)).toThrow(
      "a casUpdate must not declare a predicate",
    );
  });

  test("rejects a casUpdate carrying a branded term beyond its slot", async () => {
    const invalid = await fresh();
    operationNamed(
      tableNamed(invalid, "reader_profile"),
      "compare_and_set_books_finished_reader_profile",
    ).predicate = [
      { column: "reader_id", operator: "=", brand: "ReaderProfileReaderId" },
      {
        column: "display_name",
        operator: "=",
        brand: "ReaderProfileDisplayName",
      },
    ];

    expect(() => normalizeLocalSQLiteSpec(invalid)).toThrow(
      "a casUpdate must not declare a predicate",
    );
  });

  // A physical compare-and-set delete would let stale writers reason about absence and
  // reopen the insert-on-absent resurrection a tombstone closes. There is no `casDelete`
  // kind, so the only way to reach for one is a versioned delete predicate - which the
  // version-term ban refuses.
  test("leaves a compare-and-set delete unexpressible", async () => {
    const invalid = await fresh();
    addSingletonCasTable(invalid).operations.push({
      name: "compare_and_set_delete_sync_cursor",
      kind: "delete",
      predicate: [
        { column: "singleton_id", operator: "=" },
        {
          column: "row_version",
          operator: "=",
          brand: "ExpectedSyncCursorRowVersion",
        },
      ],
    });

    expect(() => normalizeLocalSQLiteSpec(invalid)).toThrow(
      "row_version must not appear in a predicate",
    );
  });

  // The synthesized term IS the compare-and-set, so its shape is the invariant: an
  // equality on row_version after the slot, alongside the version bump in the SET
  // clause. A CAS that lost any of them would still generate and still compile.
  test("synthesizes the compare-and-set version term the spec cannot write", async () => {
    const raw = await fresh();
    addSingletonCasTable(raw);
    const sources = render(normalizeLocalSQLiteSpec(raw));
    const combined = `${sources.kotlin}\n${sources.swift}`;

    expect(combined).toContain(
      "SET cursor_token = ?, row_version = row_version + 1",
    );
    expect(combined).toContain("WHERE singleton_id = ? AND row_version = ?");
    // The owner-keyed shape binds the caller's owner where the singleton binds its slot.
    expect(combined).toContain("WHERE reader_id = ? AND row_version = ?");
  });

  test("bootstraps a compare-and-set singleton before first write", async () => {
    const raw = await fresh();
    addSingletonCasTable(raw);
    const sources = render(normalizeLocalSQLiteSpec(raw));
    // A bootstrapped singleton means a compare-and-set write is always an update over a
    // present row, never an insert-on-absent. Every column is named, and the slot is the
    // literal 1: a bootstrap has no caller to bind it.
    expect(sources.kotlin.replace(/\s+/g, " ")).toContain(
      "INSERT OR IGNORE INTO sync_cursor ( singleton_id, cursor_token, row_version ) VALUES (1, '', 1)",
    );
  });

  test("rejects a bootstrapRow that is present but not exactly true", async () => {
    // The spec is JSON, so a wrong shape would otherwise read as "no bootstrap": the
    // table renders with no seed, the row stays absent, and every reader falls back to
    // its own default, from a spec edit that looked accepted.
    for (const shape of [{ theme: "dark" }, "true", 1, false, null]) {
      const invalid = await fresh();
      (
        tableNamed(invalid, "app_settings") as { bootstrapRow?: unknown }
      ).bootstrapRow = shape;
      expect(() => normalizeLocalSQLiteSpec(invalid)).toThrow(
        "bootstrapRow must be exactly true when present",
      );
    }
  });

  test("rejects a survivesReset that is not a boolean", async () => {
    // The same silent-ignore shape, where it is dangerous: a truthy non-boolean like "no"
    // would read as protective and exempt the column from the reset.
    const invalid = await fresh();
    const column = tableNamed(invalid, "app_settings").columns.find(
      (candidate) => candidate.name === "theme",
    )!;
    (column as { survivesReset?: unknown }).survivesReset = "no";

    expect(() => normalizeLocalSQLiteSpec(invalid)).toThrow(
      "theme survivesReset must be a boolean",
    );
  });

  test("rejects a declared unique key, which nothing emits either", async () => {
    // No table-level UNIQUE(...) is ever emitted, so a declared unique key would buy index
    // coverage it does not have and imply a uniqueness the database does not enforce.
    const invalid = await fresh();
    tableNamed(invalid, "app_settings").uniqueKeys = [["theme"]];

    expect(() => normalizeLocalSQLiteSpec(invalid)).toThrow(
      "app_settings declares uniqueKeys but no UNIQUE constraint is ever emitted",
    );
  });

  test("rejects a bootstrap on a table with a column that declares no default", async () => {
    // The bootstrap derives every value from the column spec, so an undefaulted column
    // has nothing to seed it at; rejecting here keeps the seeded row a complete one.
    const invalid = await fresh();
    const table = addSingletonCasTable(invalid);
    delete table.columns.find((column) => column.name === "cursor_token")!
      .default;

    expect(() => normalizeLocalSQLiteSpec(invalid)).toThrow(
      "declares bootstrapRow but column cursor_token has no default to seed it at",
    );
  });

  // The bootstrap and a ladder seeding step write the same row on paths different stores
  // take - a fresh install the bootstrap, an upgraded store the step. Drift between them
  // leaves the two seeded differently while each satisfies every CHECK.
  test("pins the seeding ladder step against the generated bootstrap statement", async () => {
    // The step is HISTORICAL: it names only the columns that existed at its version, and
    // the later ALTERs' DEFAULTs backfill the rest on the upgrade path. So the step's
    // values PLUS those defaults are what must equal the bootstrap.
    const spec = await loadExample();
    const kotlin = render(spec).kotlin;
    const collapse = (sql: string) => sql.replace(/\s+/g, " ").trim();
    const seededValues = (sql: string): Map<string, string> => {
      const columns = sql
        .slice(sql.indexOf("(") + 1, sql.indexOf(")"))
        .split(",")
        .map((column) => column.trim());
      const values = sql
        .slice(
          sql.indexOf("VALUES (") + "VALUES (".length,
          sql.lastIndexOf(")"),
        )
        .split(",")
        .map((value) => value.trim());
      expect(columns.length).toBe(values.length);
      return new Map(columns.map((column, index) => [column, values[index]!]));
    };

    const seedingStep = spec.migrations.find((step) =>
      step.statements.some((statement) =>
        statement.startsWith("INSERT OR IGNORE INTO app_settings"),
      ),
    )!;
    const seeded = seededValues(
      collapse(
        seedingStep.statements.find((statement) =>
          statement.startsWith("INSERT OR IGNORE INTO app_settings"),
        )!,
      ),
    );
    const bootstrap = seededValues(
      collapse(sqlConstBody(kotlin, "BOOTSTRAP_SETTINGS_SQL")),
    );

    const backfilled = new Map<string, string>();
    for (const step of spec.migrations) {
      if (step.toVersion <= seedingStep.toVersion) continue;
      for (const statement of step.statements) {
        const alter =
          /^\s*ALTER TABLE app_settings\s+ADD COLUMN\s+(\w+)[\s\S]*\sDEFAULT\s+(\S+)\s*$/i.exec(
            collapse(statement),
          );
        if (alter) backfilled.set(alter[1]!, alter[2]!);
      }
    }

    expect([...seeded.keys(), ...backfilled.keys()].sort()).toEqual(
      [...bootstrap.keys()].sort(),
    );
    for (const [column, value] of bootstrap) {
      expect(seeded.get(column) ?? backfilled.get(column)).toBe(value);
    }
  });

  test("rejects a compare-and-set update that declares no setColumns", async () => {
    // A CAS without a column list would mean "set every settable column", which on a
    // shared owner row clobbers siblings. Requiring the list makes that unexpressible.
    const invalid = await fresh();
    delete operationNamed(
      tableNamed(invalid, "reader_profile"),
      "compare_and_set_books_finished_reader_profile",
    ).setColumns;

    expect(() => normalizeLocalSQLiteSpec(invalid)).toThrow(
      "must declare a non-empty setColumns",
    );
  });

  test("rejects an owner-key column that declares a singleton check", async () => {
    // The owner key is bound to the caller's owner value, so a `= 1` check would reject
    // every real owner: the table was not meant to be owner-keyed.
    const invalid = await fresh();
    tableNamed(invalid, "reader_profile").columns.find(
      (column) => column.name === "reader_id",
    )!.check = "reader_id = 1";

    expect(() => normalizeLocalSQLiteSpec(invalid)).toThrow(
      "must not declare a check",
    );
  });

  test("rejects an ensure settable column that declares no default", async () => {
    // ensure is INSERT OR IGNORE and must fully specify the new row; a settable column
    // with no default has no value to seed, so the INSERT would omit it.
    const invalid = await fresh();
    tableNamed(invalid, "reader_profile").columns.push({
      name: "favourite_genre",
      sqliteType: "TEXT",
      nullable: false,
      brand: "ReaderProfileFavouriteGenre",
    });

    expect(() => normalizeLocalSQLiteSpec(invalid)).toThrow(
      "settable columns lacking a default: favourite_genre",
    );
  });

  test("seeds ensure settable columns at their declared defaults as literals", async () => {
    // A text default must remain a literal even when it contains a quote; otherwise the
    // ensure either needs an unsupplied bind or cannot run.
    const spec = await fresh();
    const table = tableNamed(spec, "reader_profile");
    table.columns.push({
      name: "shelf_label",
      sqliteType: "TEXT",
      nullable: false,
      brand: "ReaderProfileShelfLabel",
      default: "reader's shelf",
    });

    const normalized = normalizeLocalSQLiteSpec(spec);
    const ensure = normalized.tables
      .find((candidate) => candidate.spec.name === table.name)!
      .operations.find((operation) => operation.category === "ensure")!;
    const sources = render(normalized);
    for (const [content, constName] of [
      [sources.kotlin, ensure.kotlinSqlConst],
      [sources.swift, ensure.swiftSqlConst],
    ] as const) {
      const db = new Database(":memory:");
      try {
        db.run(createTableStatement(table));
        db.query(sqlConstBody(content, constName)).run("reader");
        expect(
          db
            .query(
              "SELECT books_finished, shelf_label, row_version FROM reader_profile WHERE reader_id = 'reader'",
            )
            .get(),
        ).toEqual({
          books_finished: 0,
          shelf_label: "reader's shelf",
          row_version: 1,
        });
      } finally {
        db.close();
      }
    }
  });

  test("rejects an ensure default whose JSON type mismatches the column", async () => {
    // The default is emitted as a SQL literal, so a string default on an INTEGER column
    // would seed a quoted value into an integer slot.
    const invalid = await fresh();
    tableNamed(invalid, "reader_profile").columns.push({
      name: "sample_flag",
      sqliteType: "INTEGER",
      nullable: false,
      brand: "ReaderProfileSampleFlag",
      default: "yes",
    });

    expect(() => normalizeLocalSQLiteSpec(invalid)).toThrow(
      "default must be a number for an INTEGER column",
    );
  });

  test("emits an owner-keyed non-CAS column set that writes only its named column", async () => {
    // A consumer's owner-scoped write to its own column SETs only that column, keyed by
    // the bound owner, with no version bump - it must not touch a sibling's column or
    // advance a version a compare-and-set reader compares against.
    const sources = render(await loadExample());
    const combined = `${sources.kotlin}\n${sources.swift}`.replace(/\s+/g, " ");

    expect(combined).toContain(
      "UPDATE reader_profile SET display_name = ? WHERE reader_id = ?",
    );
    expect(sources.kotlin).toContain("fun setDisplayNameReaderProfile(");
    expect(sources.swift).toContain("func setDisplayNameReaderProfile(");
    // The operations surface also carries the setter under its short name, taking the
    // database and forwarding to the method above.
    expect(sources.kotlin).toContain("fun setDisplayName(");
    expect(sources.swift).toContain("func setDisplayName(");
  });

  test("rejects a non-compare-and-set update that declares no setColumns", async () => {
    // Without setColumns there is no SET clause to emit, so generation fails rather than
    // emit an empty or whole-row update.
    const invalid = await fresh();
    tableNamed(invalid, "reader_profile").operations.push({
      name: "touch_reader_profile",
      kind: "update",
      predicate: [
        { column: "reader_id", operator: "=", brand: "ReaderProfileReaderId" },
      ],
    });

    expect(() => normalizeLocalSQLiteSpec(invalid)).toThrow(
      "must declare a non-empty setColumns",
    );
  });

  test("rejects a column set that targets the key or row_version", async () => {
    // Naming row_version would let a blind write reset the CAS generation, and naming the
    // owner key would rewrite the row's identity.
    const invalid = await fresh();
    tableNamed(invalid, "reader_profile").operations.push({
      name: "set_version_reader_profile",
      kind: "update",
      setColumns: ["row_version"],
      predicate: [
        { column: "reader_id", operator: "=", brand: "ReaderProfileReaderId" },
      ],
    });

    expect(() => normalizeLocalSQLiteSpec(invalid)).toThrow(
      "must not include the key or row_version",
    );
  });
});
