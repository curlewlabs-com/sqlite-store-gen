// Compiles the schema portion of generated-operation-spec.json into baseline
// and additive DDL plus the validated forward-migration ladder consumed by the
// Swift and Kotlin renderers. Migration SQL stays byte-exact because it is the
// on-device upgrade contract.

import { Database } from "bun:sqlite";
import { verifyIndexParity, type LocalSQLiteIndexSpec } from "./indexes";

export type SQLiteColumnType = "INTEGER" | "TEXT";
export interface LocalSQLiteColumnSpec {
  name: string;
  sqliteType: SQLiteColumnType;
  nullable: boolean;
  brand: string;
  check?: string;
  // The reviewed constant an `ensure` (create-if-absent) seeds this column at when
  // it creates a missing owner's row - the not-yet-written state a consumer later
  // sets. Required on every settable column of a table that declares an `ensure`
  // (see normalizeLocalSQLiteTable): the ensure must fully specify the new row,
  // and this value is emitted as a SQL literal in its VALUES, never bound. A TEXT
  // column takes a string, an INTEGER column a number.
  default?: string | number;
  // Opts this column out of the table's `resetToDefaults` operation, which otherwise
  // covers every settable column. Absent means the column resets - the exception is
  // what a spec author must declare, so a column added later is reset without anyone
  // touching the operation, and a value that has to survive is a reviewed choice at
  // its own declaration site rather than an omission from a list kept elsewhere.
  //
  // Per-column rather than per-operation because a table may declare at most one
  // `resetToDefaults` (see normalizeLocalSQLiteTable), so there is exactly one reset
  // for the flag to name. Meaningful only on a settable column of a table that
  // declares that operation; anywhere else it is rejected rather than ignored,
  // because a flag that reads as protective while governing nothing is worse than no
  // flag.
  survivesReset?: boolean;
}

export interface LocalSQLiteSchemaTableSpec {
  indexes?: LocalSQLiteIndexSpec[];
  name: string;
  primaryKey: string[];
  columns: LocalSQLiteColumnSpec[];
}

// One ordered forward-migration step. `toVersion` is the on-device schema
// version this step advances the store to; `statements` is reviewed static DDL
// applied in order inside one transaction, after which the generator appends the
// matching `PRAGMA user_version` bump so the step commits atomically (a crash
// mid-ladder resumes at the last committed version). Statements carry no runtime
// data - no bind placeholders - and are emitted as private constants, never
// reachable from the public operation API. The ladder covers only version-to-version evolution of an
// existing store; a fresh install creates the latest baseline directly and never runs
// a step.
export interface LocalSQLiteMigrationStep {
  toVersion: number;
  statements: string[];
  doc: string;
}

// A forward-migration step whose `statements` already end with the generated
// `PRAGMA user_version = <toVersion>` bump, so the renderer runs the list verbatim
// inside one transaction and the version advances only on commit.
export interface NormalizedMigrationStep {
  toVersion: number;
  statements: string[];
}

const VERSION_COLUMN = "row_version";
// The DB header slot the on-device schema version is stamped into. Free to read
// (it lives in page 1's header), so the steady-state open gates on it without a
// table scan.
export const USER_VERSION_PRAGMA = "user_version";

// Validates the schema version and the forward-migration ladder - including each
// step's reviewed static-DDL statements - and returns the ladder with each step's
// trailing user_version bump appended. The ladder must be contiguous
// 2..schemaVersion so a store at any tracked version can climb to the current one
// step at a time; a fresh install (user_version 0) never runs it (it creates the
// latest baseline directly), so schemaVersion 1 carries no steps.
//
// The per-statement checks here read a statement's characters, never what it names;
// replayMigrationLadder below is where the names are checked, against the store shape
// the step will meet.
export function normalizeLocalSQLiteMigrations(
  schemaVersion: number,
  migrations: LocalSQLiteMigrationStep[],
  tables: LocalSQLiteSchemaTableSpec[],
  obsoleteTables: readonly string[],
): NormalizedMigrationStep[] {
  if (
    !Number.isInteger(schemaVersion) ||
    schemaVersion < 1 ||
    schemaVersion > 0x7fffffff
  ) {
    throw new Error(
      `schemaVersion must be an integer in [1, 2147483647] (got ${schemaVersion})`,
    );
  }
  if (!Array.isArray(migrations)) {
    throw new Error("migrations must be an array of forward-migration steps");
  }
  if (migrations.length !== schemaVersion - 1) {
    throw new Error(
      `migrations must cover toVersion 2..${schemaVersion} (${schemaVersion - 1} step(s)); got ${migrations.length}`,
    );
  }
  const steps = migrations.map((step, index): NormalizedMigrationStep => {
    const expectedToVersion = index + 2;
    if (step.toVersion !== expectedToVersion) {
      throw new Error(
        `migration step ${index} must declare toVersion ${expectedToVersion} (got ${step.toVersion}); the ladder is contiguous 2..${schemaVersion}`,
      );
    }
    if (typeof step.doc !== "string" || step.doc.trim() === "") {
      throw new Error(`migration step ${step.toVersion} must declare a doc`);
    }
    if (!Array.isArray(step.statements) || step.statements.length === 0) {
      throw new Error(
        `migration step ${step.toVersion} must declare at least one statement`,
      );
    }
    for (const statement of step.statements) {
      if (typeof statement !== "string" || statement.trim() === "") {
        throw new Error(
          `migration step ${step.toVersion} has an empty statement`,
        );
      }
      // Migrations carry no runtime data and are reviewed static DDL we author, so a
      // statement is held to a strict shape rather than SQL-parsed. Any SQLite bind
      // sigil is forbidden - a bound value would be runtime data the closed surface
      // must not supply. Rejecting '?', ':', '@', '$' wholesale covers every bind form
      // (positional '?'/'?NNN', numbered ':1'/'@1', named ':name'/'@name'/'$name')
      // without a leaky tokenizer; '$' would also interpolate into the generated Kotlin
      // string literal. Our DDL never needs these characters - a statement that does is
      // a deliberate generator change, not a silent bypass.
      for (const sigil of ["?", ":", "@", "$"]) {
        if (statement.includes(sigil)) {
          throw new Error(
            `migration step ${step.toVersion} statement must not contain a bind sigil ('${sigil}'): ${statement}`,
          );
        }
      }
      // No SQL comments: each step carries a `doc` field, and a leading comment would
      // otherwise hide transaction control ('-- x\nCOMMIT') or a second statement from
      // the checks below.
      if (statement.includes("--") || statement.includes("/*")) {
        throw new Error(
          `migration step ${step.toVersion} statement must not contain a SQL comment (use the step's doc): ${statement}`,
        );
      }
      // One statement per array element. The runners execute each element as a
      // single statement - Android's execSQL takes one, and iOS's sqlite3_prepare_v2
      // compiles only the FIRST statement of the string and silently drops the tail -
      // so an embedded ';' would run partially, and differently, across platforms.
      if (statement.includes(";")) {
        throw new Error(
          `migration step ${step.toVersion} statement must be a single statement with no ';': ${statement}`,
        );
      }
      // The generator owns transaction control: it wraps each step in a single
      // BEGIN IMMEDIATE ... COMMIT. With comments banned above, a transaction-control
      // keyword can only appear at the statement start, so this start-anchored check
      // catches every case - a step that opened or closed its own transaction would
      // nest or prematurely commit the generated one.
      if (
        /^\s*(BEGIN|COMMIT|END|ROLLBACK|SAVEPOINT|RELEASE)\b/i.test(statement)
      ) {
        throw new Error(
          `migration step ${step.toVersion} statement must not contain transaction control (the generator wraps each step in BEGIN IMMEDIATE/COMMIT): ${statement}`,
        );
      }
      // The generator owns the version bump so it is always the atomic last
      // statement of the step; a hand-written user_version write in the spec would
      // double it or bump out of order.
      if (statement.toLowerCase().includes(USER_VERSION_PRAGMA)) {
        throw new Error(
          `migration step ${step.toVersion} must not write ${USER_VERSION_PRAGMA}; the generator appends the version bump`,
        );
      }
    }
    return {
      toVersion: step.toVersion,
      statements: [
        ...step.statements,
        `PRAGMA ${USER_VERSION_PRAGMA} = ${step.toVersion}`,
      ],
    };
  });
  // The authored statements, not the returned ones: the version bump appended above is
  // the generator's own and is not part of the vocabulary a step may write.
  replayMigrationLadder(migrations, tables, obsoleteTables);
  return steps;
}

// The one statement that drops a retired table, on every path that drops one: the
// baseline create's obsolete-table drop and a ladder step's retirement. A ladder drop is
// recognized only by equality with this text for an `obsoleteTables` name, never by
// reading a table name out of the statement, because what the drop deletes is rows.
export function dropTableStatement(table: string): string {
  return `DROP TABLE IF EXISTS ${table}`;
}

// The statement vocabulary a ladder step may use, and what the replay makes of each
// form. An allowlist rather than an open surface because the replay's verdict is only
// as good as its model of what a statement does to the store: an unclassified form
// would run for effects nothing here accounts for, and the first thing it broke would
// be the replay's own answer about every step after it.
type MigrationStatementForm =
  // Shape. Absence is asserted by the replay itself rather than by SQLite - see
  // replayMigrationLadder, where the `IF NOT EXISTS` these statements carry is what
  // makes a re-create silent instead of an error.
  | { kind: "createTable"; table: string }
  | { kind: "createIndex"; table: string }
  // Shape. A column the store already has is what SQLite refuses outright, with the
  // same `duplicate column name` an author error surfaces on a device.
  | { kind: "addColumn"; table: string; column: string }
  // Data. Seeds a singleton row onto a store that never reaches the baseline create's
  // bootstrap. `OR IGNORE` resolves a conflict by dropping the row, so what the replay
  // takes from one is that its names resolve, not that its values land.
  | { kind: "seedRow"; table: string }
  // Data. Rewrites a value on a shape every store at this version already holds.
  | { kind: "setValue"; table: string }
  // Shape. Retires a table a tracked store already holds: the `obsoleteTables` drop
  // runs only on the baseline create, so a store stamped past the table's creating
  // step would otherwise keep it, rows included, for good. Matched exactly against
  // `dropTableStatement` of an `obsoleteTables` name, so a fresh install and an
  // upgraded store agree that the table is gone, and a live table cannot be named.
  | { kind: "dropTable"; table: string };

// Recognizes one allowlisted form, or rejects the statement.
//
// Start-anchored, one variant per form, and `\w+` identifiers only: a
// schema-qualified (`main.t`) or quoted (`"t"`) name, SQLite's `ADD` without `COLUMN`,
// a bare `INSERT` where the seeding form is `INSERT OR IGNORE` - each fails to match
// and is rejected rather than guessed at. A form the ladder genuinely needs (a
// `DROP INDEX`) is a deliberate generator change that owes its own
// classification above, which is the point of naming them rather than matching a
// leading keyword. Anchoring is what keeps a keyword inside a string literal or an
// identifier from reading as the statement's form; a comment cannot hide one either,
// because normalizeLocalSQLiteMigrations rejects comments and embedded `;` before
// this runs.
//
// The ways a real statement can differ from these patterns, and what each does. Leading whitespace and
// newlines inside a statement: matched, since every live CREATE and seeding INSERT is
// written multi-line. Keyword case: matched, though the spec writes them upper. A
// comment, a bind sigil, or a second `;`-joined statement: unreachable, rejected in
// normalizeLocalSQLiteMigrations above. Every other difference - a quoted or
// qualified identifier, an alias variant, an unlisted form - fails closed on the
// throw below.
// The captured names are used for nothing but the replay's own bookkeeping (which
// tables it seeds, and its seed and replay checks), so a mis-capture cannot pass a
// statement: it builds the wrong starting shape and SQLite refuses the ladder over it.
// The drop is the exception that proves the rule: its name decides what is deleted, so
// it is not captured at all - the statement has to equal the generated drop of a
// validated `obsoleteTables` entry, and any other text is an unlisted form.
function classifyMigrationStatement(
  toVersion: number,
  statement: string,
  obsoleteTables: readonly string[],
): MigrationStatementForm {
  const createdIndex =
    /^\s*CREATE\s+INDEX\s+[a-z][a-z0-9_]*\s+ON\s+([a-z][a-z0-9_]*)\s*\(\s*[a-z][a-z0-9_]*(?:\s*,\s*[a-z][a-z0-9_]*)*\s*\)\s*$/i.exec(
      statement,
    );
  if (createdIndex?.[1] !== undefined) {
    return { kind: "createIndex", table: createdIndex[1] };
  }
  const createdTable = /^\s*CREATE TABLE (?:IF NOT EXISTS )?(\w+)\s*\(/i.exec(
    statement,
  )?.[1];
  if (createdTable !== undefined) {
    return { kind: "createTable", table: createdTable };
  }
  const added = /^\s*ALTER TABLE (\w+)\s+ADD COLUMN\s+(\w+)\s/i.exec(statement);
  const alteredTable = added?.[1];
  const addedColumn = added?.[2];
  if (alteredTable !== undefined && addedColumn !== undefined) {
    return { kind: "addColumn", table: alteredTable, column: addedColumn };
  }
  const seededTable = /^\s*INSERT OR IGNORE INTO (\w+)\s*\(/i.exec(
    statement,
  )?.[1];
  if (seededTable !== undefined) {
    return { kind: "seedRow", table: seededTable };
  }
  const setTable = /^\s*UPDATE (\w+)\s+SET\s/i.exec(statement)?.[1];
  if (setTable !== undefined) {
    return { kind: "setValue", table: setTable };
  }
  const retiredTable = obsoleteTables.find(
    (table) => statement === dropTableStatement(table),
  );
  if (retiredTable !== undefined) {
    return { kind: "dropTable", table: retiredTable };
  }
  throw new Error(
    `migration step ${toVersion} statement is not an allowlisted form ` +
      `(CREATE TABLE, CREATE INDEX, ALTER TABLE ... ADD COLUMN, INSERT OR IGNORE INTO, ` +
      `UPDATE ... SET, or exactly DROP TABLE IF EXISTS <an obsoleteTables entry>): ${statement}`,
  );
}

// Replays the ladder against a real in-memory SQLite, so a step whose DDL assumes a
// shape its own version does not have fails at generation rather than on a device.
// The runtime half of that failure class - competing openers racing a climb - is fixed by
// each step re-reading user_version inside its own transaction; this is the
// author-error half, which no runtime guard can see.
//
// SQLite itself decides, rather than a SQL matcher here: the question is whether a
// statement runs against a given store, and what answers it exactly is the engine that
// will run it. That covers a
// duplicate column, a table or column the step's version does not have, and anything
// SQLite will not compile - none of which a pattern over the statement text decides,
// and the first of which arrives verbatim in the message a device would report. What
// stays this function's own is the question
// SQLite's answer does not model: `CREATE TABLE IF NOT EXISTS` is a silent no-op on a
// table that already exists, so a step re-creating one is checked here instead.
//
// Where the ladder's starting shape comes from, and what that costs. Nothing records
// the pre-ladder one: version 1 predates every step, so the replay takes the ladder's own declarations as the definition - a table the ladder
// creates is absent before that step, a column it adds is absent before its step, and
// what remains is the current baseline. The replay is therefore exact for every
// contradiction INSIDE the ladder (competing steps introducing the same thing, a step naming
// something a later step introduces, a name that never exists at all) and blind to a
// first introduction that was already true at version 1, which nothing in the spec
// records. That the ladder's cumulative effect ends at the baseline is a separate
// question, checked by the replay's comparison with the baseline.
//
// What executing decides is bounded twice more, and neither bound is closed here. The
// replay's store carries shape and almost no rows, and SQLite accepts an added NOT NULL
// column with no DEFAULT on a table with no rows while refusing it on one with rows -
// so that error, fatal to an open on any device whose store is not empty, passes here.
// An added column therefore carries a DEFAULT; a spec's own tests are where that is held. And a seeding step reports only that its names resolve, for the reason its
// form above states.
function replayMigrationLadder(
  steps: LocalSQLiteMigrationStep[],
  tables: LocalSQLiteSchemaTableSpec[],
  obsoleteTables: readonly string[],
): void {
  const classified = steps.map((step) => ({
    toVersion: step.toVersion,
    statements: step.statements.map((statement) => ({
      statement,
      form: classifyMigrationStatement(
        step.toVersion,
        statement,
        obsoleteTables,
      ),
    })),
  }));

  const createdAt = new Map<string, number>();
  const ladderColumns = new Map<string, Set<string>>();
  for (const step of classified) {
    for (const { form } of step.statements) {
      // First creator wins, so a second CREATE reads as the duplicate it is instead of
      // moving the version the ordering check below reports.
      if (form.kind === "createTable" && !createdAt.has(form.table)) {
        createdAt.set(form.table, step.toVersion);
      }
      if (form.kind === "addColumn") {
        const columns = ladderColumns.get(form.table) ?? new Set<string>();
        columns.add(form.column);
        ladderColumns.set(form.table, columns);
      }
    }
  }

  const database = new Database(":memory:");
  try {
    for (const table of tables) {
      if (createdAt.has(table.name)) {
        continue;
      }
      const added = ladderColumns.get(table.name) ?? new Set<string>();
      const before = table.columns.filter((column) => !added.has(column.name));
      try {
        database.run(createTableStatementFor(table, before));
      } catch (error) {
        throw new Error(
          `cannot rebuild the shape ${table.name} had before the ladder ` +
            `(${error instanceof Error ? error.message : String(error)}); the ladder ` +
            `adds to a table it never creates, so nothing is left to add to`,
        );
      }
    }

    for (const step of classified) {
      for (const { statement, form } of step.statements) {
        const creator = createdAt.get(form.table);
        if (creator !== undefined && creator > step.toVersion) {
          throw new Error(
            `migration step ${step.toVersion} names table ${form.table}, which the ` +
              `ladder does not create until step ${creator}: ${statement}`,
          );
        }
        if (form.kind === "createTable" && tableExists(database, form.table)) {
          throw new Error(
            `migration step ${step.toVersion} creates table ${form.table}, which a ` +
              `store at version ${step.toVersion - 1} already has: ${statement}`,
          );
        }
        // `IF EXISTS` makes a drop of a table the store never had silent, for the
        // reason `IF NOT EXISTS` makes a re-create silent above.
        if (form.kind === "dropTable" && !tableExists(database, form.table)) {
          throw new Error(
            `migration step ${step.toVersion} drops table ${form.table}, which a ` +
              `store at version ${step.toVersion - 1} does not have: ${statement}`,
          );
        }
        try {
          database.run(statement);
        } catch (error) {
          throw new Error(
            `migration step ${step.toVersion} does not run against the shape a ` +
              `store at version ${step.toVersion - 1} has ` +
              `(${error instanceof Error ? error.message : String(error)}): ` +
              statement,
          );
        }
      }
    }
    if (steps.length > 0) {
      verifyTableParity(database, tables);
      verifyIndexParity(database, tables);
    }
  } finally {
    database.close();
  }
}

// The ladder has to end at the baseline's table set, not only at its shape per table. Each
// check above judges one statement against the store it meets, so a step that re-creates a
// table an earlier step dropped passes all of them, and an upgraded store would then hold
// a table a fresh install never creates - with nothing in the generated operations to
// notice, since none of them names it.
function verifyTableParity(
  database: Database,
  tables: LocalSQLiteSchemaTableSpec[],
): void {
  const expected = new Set(tables.map((table) => table.name));
  const actual = database
    .query<{ name: string }, []>(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    )
    .all()
    .map((table) => table.name);
  for (const name of actual) {
    if (!expected.has(name)) {
      throw new Error(
        `the ladder leaves table ${name}, which the baseline does not create`,
      );
    }
  }
}

// `sqlite_schema` rather than a PRAGMA because the table name is a bound value here,
// where a `PRAGMA table_info(<name>)` would have to be interpolated.
function tableExists(database: Database, name: string): boolean {
  return (
    database
      .query("SELECT 1 FROM sqlite_schema WHERE type = 'table' AND name = ?")
      .get(name) !== null
  );
}

// SQL literal for a static, spec-declared value (a bootstrap-row cell or an ensure
// per-column default): a TEXT value is single-quoted with any embedded quote
// doubled; an INTEGER value is emitted bare. These are reviewed constants, never
// runtime data.
export function staticSqlLiteral(
  sqliteType: SQLiteColumnType,
  value: string | number,
): string {
  if (sqliteType === "TEXT") {
    return `'${String(value).replace(/'/g, "''")}'`;
  }
  return String(value);
}

function columnDdl(
  table: LocalSQLiteSchemaTableSpec,
  column: LocalSQLiteColumnSpec,
): string {
  const check = column.check !== undefined ? ` CHECK (${column.check})` : "";
  if (table.primaryKey.includes(column.name)) {
    return `${column.name} ${column.sqliteType} PRIMARY KEY${check}`;
  }
  const notNull = column.nullable ? "" : " NOT NULL";
  return `${column.name} ${column.sqliteType}${notNull}${check}`;
}

// The baseline `CREATE TABLE` for a live table, as one statement at a caller-chosen
// column indent. The Kotlin and Swift emitters render this, and a ladder step that creates a
// table must match it - a hand-authored step is not compared against the column spec
// anywhere else, so drift would leave upgraded stores and fresh installs on different
// on-disk shapes. Exported so the generator test can pin that equality.
export function createTableStatement(
  table: LocalSQLiteSchemaTableSpec,
  columnIndent = "    ",
): string {
  return createTableStatementFor(table, table.columns, columnIndent);
}

// The same statement over an explicit column list, which is what lets the ladder replay
// render the shape a table had before the ladder's own ALTERs added to it.
function createTableStatementFor(
  table: LocalSQLiteSchemaTableSpec,
  columns: LocalSQLiteColumnSpec[],
  columnIndent = "    ",
): string {
  const rendered = columns
    .map((column) => `${columnIndent}${columnDdl(table, column)}`)
    .join(",\n");
  return `CREATE TABLE IF NOT EXISTS ${table.name} (\n${rendered}\n) STRICT`;
}

export function additiveColumnDdl(
  table: LocalSQLiteSchemaTableSpec,
  column: LocalSQLiteColumnSpec,
): string {
  if (column.default === undefined) {
    throw new Error(
      `${table.name}.${column.name} cannot be migrated additively without a default`,
    );
  }
  return `${columnDdl(table, column)} DEFAULT ${staticSqlLiteral(
    column.sqliteType,
    column.default,
  )}`;
}

export function additiveColumns(
  table: LocalSQLiteSchemaTableSpec,
): LocalSQLiteColumnSpec[] {
  return table.columns.filter(
    (column) =>
      !table.primaryKey.includes(column.name) &&
      column.name !== VERSION_COLUMN &&
      column.default !== undefined,
  );
}
