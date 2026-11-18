import { describe, expect, test } from "bun:test";
import { createTableStatement, dropTableStatement } from "./schema";
import { normalizeLocalSQLiteSpec } from "./spec";
import {
  cloneSpec,
  loadExample,
  loadExampleRaw,
  render,
  withSchemaMigrations,
} from "./test-support";

describe("schema migration spec", () => {
  test("reconstructs each table's baseline shape from its ladder CREATE plus later ALTERs", async () => {
    // A ladder step's DDL is hand-authored while the baseline create is generated from
    // the column spec, and nothing else compares them: drift would leave an upgraded
    // store and a fresh install disagreeing on the on-disk shape of the same table,
    // with only the upgraded or fresh-install shape matching what the generated operations bind.
    //
    // Compared per column rather than per statement, because fresh-install and upgrade paths legitimately
    // differ in column ORDER - a fresh install gets a column inline from the baseline
    // create, an upgraded store gets it appended by ALTER ADD COLUMN. Every generated
    // statement binds by name, so order is immaterial; a column present on one path and
    // absent on the other is not.
    const spec = await loadExample();
    const collapse = (sql: string) => sql.replace(/\s+/g, " ").trim();
    // Split a CREATE body on top-level commas only, so a CHECK (x IN (0, 1)) stays whole.
    const columnDefs = (createSql: string): Map<string, string> => {
      const body = createSql.slice(
        createSql.indexOf("(") + 1,
        createSql.lastIndexOf(")"),
      );
      const parts: string[] = [];
      let depth = 0;
      let current = "";
      for (const character of body) {
        if (character === "(") depth += 1;
        if (character === ")") depth -= 1;
        if (character === "," && depth === 0) {
          parts.push(current);
          current = "";
          continue;
        }
        current += character;
      }
      parts.push(current);
      return new Map(
        parts
          .map(collapse)
          .filter((part) => part.length > 0)
          .map((part) => [part.split(" ")[0]!, part] as const),
      );
    };

    const baselineByTable = new Map(
      spec.tables.map((table) => [
        table.spec.name,
        columnDefs(createTableStatement(table.spec)),
      ]),
    );

    const ladderCreates = new Map<
      string,
      { version: number; columns: Map<string, string> }
    >();
    const ladderAlters: {
      version: number;
      table: string;
      column: string;
      definition: string;
    }[] = [];
    const ladderDrops = new Set<string>();
    for (const step of spec.migrations) {
      for (const statement of step.statements) {
        const retired = spec.obsoleteTables.find(
          (table) => statement === dropTableStatement(table),
        );
        if (retired !== undefined) {
          ladderDrops.add(retired);
          continue;
        }
        const create = /^\s*CREATE TABLE (?:IF NOT EXISTS )?(\w+)/i.exec(
          statement,
        );
        if (create) {
          ladderCreates.set(create[1]!, {
            version: step.toVersion,
            columns: columnDefs(statement),
          });
          continue;
        }
        const alter = /^\s*ALTER TABLE (\w+)\s+ADD COLUMN\s+([\s\S]+)$/i.exec(
          statement,
        );
        if (alter) {
          const definition = collapse(alter[2]!);
          ladderAlters.push({
            version: step.toVersion,
            table: alter[1]!,
            column: definition.split(" ")[0]!,
            definition,
          });
        }
      }
    }
    // A ladder that touched no table would pass everything below vacuously.
    expect(ladderCreates.size + ladderAlters.length).toBeGreaterThan(0);

    // SQLite requires a non-NULL DEFAULT on an added NOT NULL column, while the
    // baseline create carries none - every generated insert names every column, and
    // `ensure` seeds the declared defaults explicitly. So an ALTER definition is the
    // baseline's plus that trailing DEFAULT: compare modulo it, and require it on the
    // adds that need it, because an added NOT NULL column without one fails at runtime
    // rather than at codegen.
    //
    // Required on NOT NULL adds ONLY, which is the whole of the reason above. A
    // nullable add needs no default - SQLite gives every existing row NULL, which for
    // these columns is the value that means "nobody reported", so a DEFAULT NULL would
    // be a synonym written to satisfy a check rather than to say anything.
    const withoutDefault = (definition: string) =>
      definition.replace(/\s+DEFAULT\s+.*$/i, "").trim();
    for (const alter of ladderAlters) {
      if (/\sNOT NULL(\s|$)/i.test(alter.definition)) {
        expect(alter.definition).toMatch(/\sDEFAULT\s/i);
      }
      expect(baselineByTable.get(alter.table)?.get(alter.column)).toBe(
        withoutDefault(alter.definition),
      );
    }

    for (const [table, created] of ladderCreates) {
      // A table a later step retires has no baseline to reach: every store ends
      // without it, which the replay in normalizeLocalSQLiteMigrations already
      // establishes. It still has to be retired on the fresh-install path too.
      if (ladderDrops.has(table)) {
        expect(baselineByTable.has(table)).toBe(false);
        continue;
      }
      const baseline = baselineByTable.get(table);
      expect(baseline).toBeDefined();
      const laterAlters = ladderAlters.filter(
        (alter) => alter.table === table && alter.version > created.version,
      );
      // The dangerous edit this catches: adding a new column to an EARLIER step's
      // CREATE as well as giving it its own ALTER step. A store climbing from before
      // that step would then run the CREATE and the ALTER and fail on a duplicate column.
      for (const alter of laterAlters) {
        expect(created.columns.has(alter.column)).toBe(false);
      }
      // Replaying the CREATE and every later ALTER must reproduce the baseline exactly:
      // same column set, same definition for each.
      const reconstructed = new Map(created.columns);
      for (const alter of laterAlters) {
        reconstructed.set(alter.column, alter.definition);
      }
      expect([...reconstructed.keys()].sort()).toEqual(
        [...baseline!.keys()].sort(),
      );
      for (const [name, definition] of reconstructed) {
        expect(withoutDefault(definition)).toBe(baseline!.get(name)!);
      }
    }
  });

  test("renders the ordered forward-migration ladder on every platform", async () => {
    const raw = withSchemaMigrations(cloneSpec(await loadExampleRaw()));
    const { kotlin, swift } = render(normalizeLocalSQLiteSpec(raw));
    const combined = `${kotlin}\n${swift}`;

    // A below-current store climbs the ladder rather than reconciling to the baseline.
    expect(kotlin).toContain("runForwardMigrations(current)");
    expect(swift).toContain("try runForwardMigrations(fromVersion: current)");
    // Each step carries its DDL followed by its own user_version bump, so it commits
    // atomically and a crash mid-ladder resumes at the last committed version.
    expect(combined).toContain(
      "ALTER TABLE reader_profile ADD COLUMN reading_goal INTEGER NOT NULL DEFAULT 0",
    );
    expect(combined).toContain("PRAGMA user_version = 2");
    expect(combined).toContain("PRAGMA user_version = 3");
    // The final baseline stamp advances to the ladder's top version.
    expect(kotlin).toContain(
      'private const val SET_SCHEMA_VERSION_SQL = "PRAGMA user_version = 3"',
    );
    expect(swift).toContain(
      'private static let setSchemaVersionSQL = "PRAGMA user_version = 3"',
    );
    // Each step runs inside the same BEGIN IMMEDIATE transaction wrapper the CAS path
    // uses.
    expect(kotlin).toContain(
      'execute(BEGIN_IMMEDIATE_SQL, "begin migration ${migration.toVersion}")',
    );
    expect(swift).toContain(
      'try execute(sql: Self.beginImmediateSQL, operation: "begin migration',
    );
  });

  test("rejects a schema version below 1", async () => {
    const invalid = cloneSpec(await loadExampleRaw());
    invalid.schemaVersion = 0;
    expect(() => normalizeLocalSQLiteSpec(invalid)).toThrow(
      "schemaVersion must be an integer",
    );
  });

  test("rejects a ladder that does not cover 2..schemaVersion", async () => {
    const invalid = cloneSpec(await loadExampleRaw());
    // Bumping schemaVersion without adding the matching step is the mistake that
    // silently strands upgraders: the ladder stops one short of the bumped
    // version, so it cannot climb a store stamped at the old one.
    //
    // One past the current version rather than a fixed number: a stale constant would name
    // a version the ladder already covers, so nothing
    // throws and the test fails loudly on the assertion below.
    const nextVersion = invalid.schemaVersion + 1;
    invalid.schemaVersion = nextVersion;
    expect(() => normalizeLocalSQLiteSpec(invalid)).toThrow(
      `migrations must cover toVersion 2..${nextVersion}`,
    );
  });

  test("rejects a non-contiguous migration toVersion", async () => {
    const invalid = withSchemaMigrations(cloneSpec(await loadExampleRaw()));
    // A gap (2 then 4) would leave a v2 store with no step to climb to v3.
    invalid.migrations[1]!.toVersion = 4;
    expect(() => normalizeLocalSQLiteSpec(invalid)).toThrow(
      "must declare toVersion 3",
    );
  });

  test("rejects a migration statement with a bind placeholder", async () => {
    const invalid = withSchemaMigrations(cloneSpec(await loadExampleRaw()));
    // Migrations carry no runtime data; a bind would mean the step depends on a
    // value the closed generated layer must not supply at run time.
    invalid.migrations[0]!.statements = [
      "UPDATE reader_profile SET books_finished = ?",
    ];
    expect(() => normalizeLocalSQLiteSpec(invalid)).toThrow(
      "must not contain a bind sigil",
    );
  });

  test("rejects a migration statement that writes user_version", async () => {
    const invalid = withSchemaMigrations(cloneSpec(await loadExampleRaw()));
    // The generator owns the version bump so it is always the atomic last statement;
    // a hand-written one would double-bump or bump out of order.
    invalid.migrations[0]!.statements = ["PRAGMA user_version = 9"];
    expect(() => normalizeLocalSQLiteSpec(invalid)).toThrow(
      "must not write user_version",
    );
  });

  test("rejects a migration statement with a named bind parameter", async () => {
    const invalid = withSchemaMigrations(cloneSpec(await loadExampleRaw()));
    // ':name' / '@name' are SQLite named binds - the same run-time-data dependency the
    // positional '?' guard rejects, so close them too.
    invalid.migrations[0]!.statements = [
      "UPDATE reader_profile SET books_finished = :count",
    ];
    expect(() => normalizeLocalSQLiteSpec(invalid)).toThrow(
      "must not contain a bind sigil",
    );
  });

  test("rejects a migration statement with a numbered named bind", async () => {
    const invalid = withSchemaMigrations(cloneSpec(await loadExampleRaw()));
    // SQLite also accepts numeric named binds (':1' / '@1'); the sigil is rejected
    // wholesale so a digit after ':' / '@' cannot slip past an identifier-shaped regex.
    invalid.migrations[0]!.statements = [
      "UPDATE reader_profile SET books_finished = :1",
    ];
    expect(() => normalizeLocalSQLiteSpec(invalid)).toThrow(
      "must not contain a bind sigil",
    );
  });

  test("rejects a migration statement with a leading SQL comment", async () => {
    const invalid = withSchemaMigrations(cloneSpec(await loadExampleRaw()));
    // Comments are banned so a leading one cannot hide transaction control or a second
    // statement from the checks that follow ('-- x\nCOMMIT' would otherwise bypass the
    // start-anchored transaction-control guard).
    invalid.migrations[0]!.statements = ["-- reset the ladder\nCOMMIT"];
    expect(() => normalizeLocalSQLiteSpec(invalid)).toThrow(
      "must not contain a SQL comment",
    );
  });

  test("rejects a migration statement with an embedded second statement", async () => {
    const invalid = withSchemaMigrations(cloneSpec(await loadExampleRaw()));
    // The runners execute one statement per array element; iOS's sqlite3_prepare_v2
    // compiles only the first and silently drops the tail, so a ';'-joined pair would
    // run partially and differently per platform.
    invalid.migrations[0]!.statements = [
      "ALTER TABLE reader_profile ADD COLUMN a INTEGER NOT NULL DEFAULT 0; " +
        "DROP TABLE signed_in_reader",
    ];
    expect(() => normalizeLocalSQLiteSpec(invalid)).toThrow(
      "must be a single statement",
    );
  });

  test("rejects a migration statement that opens its own transaction", async () => {
    const invalid = withSchemaMigrations(cloneSpec(await loadExampleRaw()));
    // The generator wraps each step in one BEGIN IMMEDIATE/COMMIT; a step that runs its
    // own transaction control would nest or prematurely commit the generated one.
    invalid.migrations[0]!.statements = ["COMMIT"];
    expect(() => normalizeLocalSQLiteSpec(invalid)).toThrow(
      "must not contain transaction control",
    );
  });

  test("rejects a step that re-adds a column an earlier step added", async () => {
    const invalid = withSchemaMigrations(cloneSpec(await loadExampleRaw()));
    // The author-error twin of the race the version re-read inside each step's own
    // transaction fixed: there the loser of a race replayed a step a peer had already
    // applied, and a later open succeeds; here the step is simply wrong, so every open
    // on every device fails - with the same `duplicate column name`, which is why
    // nothing at run time tells the two apart. Only this one is visible before any
    // store exists, and the replay is what sees it.
    invalid.migrations[1]!.statements = [...invalid.migrations[0]!.statements];
    expect(() => normalizeLocalSQLiteSpec(invalid)).toThrow(
      "duplicate column name: reading_goal",
    );
  });

  test("rejects a step that re-creates a table an earlier step created", async () => {
    const invalid = withSchemaMigrations(cloneSpec(await loadExampleRaw()));
    // The `IF NOT EXISTS` every ladder CREATE carries is why the replay checks this
    // itself rather than reading SQLite's verdict: a second create is a silent no-op,
    // so any column it declares that the first did not simply never exists. The table
    // is synthetic so that what the fixture exercises does not move when the example's
    // tables do.
    const create =
      "CREATE TABLE IF NOT EXISTS replayed_shelf (a INTEGER PRIMARY KEY) STRICT";
    invalid.migrations[0]!.statements = [create];
    invalid.migrations[1]!.statements = [create];
    expect(() => normalizeLocalSQLiteSpec(invalid)).toThrow(
      "creates table replayed_shelf, which a store at version 2 already has",
    );
  });

  test("rejects a step that names a table a later step creates", async () => {
    const invalid = withSchemaMigrations(cloneSpec(await loadExampleRaw()));
    // Reported against the step that names the table, not the one that creates it: a
    // ladder is climbed in order, so the step out of place is the earlier one, and
    // SQLite's own `no such table` would name it without saying what makes it wrong.
    invalid.migrations[0]!.statements = [
      "ALTER TABLE replayed_shelf ADD COLUMN b INTEGER NOT NULL DEFAULT 0",
    ];
    invalid.migrations[1]!.statements = [
      "CREATE TABLE IF NOT EXISTS replayed_shelf (a INTEGER PRIMARY KEY) STRICT",
    ];
    expect(() => normalizeLocalSQLiteSpec(invalid)).toThrow(
      "step 2 names table replayed_shelf, which the ladder does not create until step 3",
    );
  });

  test("rejects a data step naming a column its own version lacks", async () => {
    const invalid = withSchemaMigrations(cloneSpec(await loadExampleRaw()));
    // A statement is historical, so
    // one naming a column a later step adds runs on a store that does not have it yet
    // and fails the open. Shape-neutral forms are checked for exactly this - what they
    // name has to exist at the version they run at.
    invalid.migrations[0]!.statements = [
      "UPDATE reader_profile SET streak_days = 1",
    ];
    expect(() => normalizeLocalSQLiteSpec(invalid)).toThrow(
      "no such column: streak_days",
    );
  });

  test("rejects a migration statement outside the allowlisted forms", async () => {
    const invalid = withSchemaMigrations(cloneSpec(await loadExampleRaw()));
    // A row delete is not rejected because deleting is wrong but because the ladder has
    // no classification for it, and a form the replay mis-models makes every verdict
    // after it worthless. Adding one is a generator change, not a spec change.
    invalid.migrations[0]!.statements = ["DELETE FROM reader_profile"];
    expect(() => normalizeLocalSQLiteSpec(invalid)).toThrow(
      "is not an allowlisted form",
    );
  });

  // The example's ladder creates the highlight queue in one step, and nothing after that
  // step names its columns, so every per-statement check passes a CREATE that drops or
  // changes one. An upgraded store would then lack what a fresh install has, and the
  // first generated statement naming the column would fail on that device alone.
  test("rejects a ladder whose tables end with columns the baseline does not declare", async () => {
    const createsQueue = (sql: string) =>
      sql.startsWith("CREATE TABLE IF NOT EXISTS pending_highlight (");
    for (const [change, from, to] of [
      ["drops", "    margin_note TEXT,\n", ""],
      ["retypes", "excerpt TEXT NOT NULL", "excerpt INTEGER NOT NULL"],
      ["relaxes", "excerpt TEXT NOT NULL", "excerpt TEXT"],
      [
        "adds",
        "    excerpt TEXT NOT NULL,\n",
        "    excerpt TEXT NOT NULL,\n    tag TEXT,\n",
      ],
    ] as const) {
      const invalid = cloneSpec(await loadExampleRaw());
      const step = invalid.migrations.find((migration) =>
        migration.statements.some(createsQueue),
      )!;
      const index = step.statements.findIndex(createsQueue);
      const changed = step.statements[index]!.replace(from, to);
      expect(changed, change).not.toBe(step.statements[index]);
      step.statements[index] = changed;
      expect(() => normalizeLocalSQLiteSpec(invalid), change).toThrow(
        "the ladder leaves table pending_highlight with columns",
      );
    }
  });
});
