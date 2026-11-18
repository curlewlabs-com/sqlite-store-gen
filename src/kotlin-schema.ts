// Renders Kotlin's generated schema metadata and version-gated lifecycle methods.
// Connection establishment and runtime integrity classification remain separate owners.

import type { LocalSQLiteSpec } from "./model";
import { databaseNeedsStatistics, tableNeedsStatistics } from "./statistics";
import { indexSqlConstant } from "./indexes";
import { additiveColumns } from "./schema";

export function kotlinSchemaObject(spec: LocalSQLiteSpec): string {
  const metadata = spec.tables
    .map((table) => {
      const pk = table.spec.primaryKey
        .map((column) => `"${column}"`)
        .join(", ");
      return `LocalSQLiteTableMetadata(
                name = "${table.spec.name}",
                primaryKey = listOf(${pk}),
                declaredIndexes = listOf(${table.spec.indexes.map((index) => `LocalSQLiteIndexMetadata("${index.name}", listOf(${index.columns.map((column) => `"${column}"`).join(", ")}), false)`).join(", ")}),
                analyze = ${tableNeedsStatistics(table)},
            )`;
    })
    .join(",\n            ");
  const analyzeTargets = spec.tables
    .filter(tableNeedsStatistics)
    .map((table) => `"${table.spec.name}"`)
    .join(", ");
  return `object LocalSQLiteGeneratedSchema {
    const val requiresPlannerStatistics: Boolean = ${databaseNeedsStatistics(spec)}
    val tables: List<LocalSQLiteTableMetadata> =
        listOf(
            ${metadata},
        )
    val analyzeTargets: List<String> = listOf(${analyzeTargets})
}`;
}

function kotlinSchemaMigrationHelpers(): string {
  return `    private fun ensureColumn(
        table: String,
        column: String,
        sql: String,
    ) {
        assertNotMainThread("ensure column")
        if (columnExists(table, column)) return
        execute(sql, "add $table.$column")
    }

    private fun columnExists(
        table: String,
        column: String,
    ): Boolean {
        assertNotMainThread("check column")
        // Generated schema names come from the reviewed local-SQLite spec; PRAGMA
        // table_info does not accept bound identifiers.
        return withStatement("PRAGMA table_info($table)", "check column") { statement ->
            // Column 1 is table_info's name column. Positional because the shape of
            // table_info's result is SQLite's, fixed by its documentation.
            var hasRow = stepFirstRow(statement, "check column")
            while (hasRow) {
                if (CurlewSQLite.columnText(statement, 1) == column) return@withStatement true
                hasRow = stepRowOrDone(statement, "check column")
            }
            false
        }
    }`;
}

// The version-gated open dispatcher. PRAGMA user_version is the durable ledger of what
// has already run: reading it (a header int, no table scan) tells the open which
// one-time transitions are still owed. An already-current store returns immediately -
// its obsolete-drop / create / migrations all ran on the way to the current stamp, so
// re-running them would be redundant work the ledger already records as done. An
// untracked store (version 0) takes the baseline create (drop obsoletes once, create,
// stamp); a below-current store climbs the forward ladder; a newer store is an abnormal
// downgrade the open refuses (handleNewerSchema). Nothing here maintains correctness by
// re-running on every open - the stamp records it, so no step is required per open.
//
// **This read holds no lock, so it selects a branch rather than deciding one.** It is
// what keeps the steady-state open free - taking a write lock to learn there is nothing
// to do would charge every open for a transition that already ran - and the branches it
// selects each re-read the version inside their own write transaction before acting. A
// peer opener committing between the preflight and transactional reads is ordinary, not exceptional on iOS,
// where an app and its extensions can open one shared file. Android holds one
// connection per process, so arranging a peer there needs a second process and it has
// none; the two-read shape is the same code on Android and iOS.
function kotlinCreateSchema(spec: LocalSQLiteSpec): string {
  const olderBranch =
    spec.migrations.length > 0
      ? `        if (current == 0L) {
            createBaseline()
            return
        }
        runForwardMigrations(current)`
      : `        // No forward-migration ladder yet: SCHEMA_VERSION is the floor, so a
        // below-current store can only be version 0 - a fresh install or a
        // pre-versioning store - reconciled to the baseline.
        createBaseline()`;
  return `    fun createSchema() {
        assertNotMainThread("create schema")
        val current = readSchemaVersion()
        if (current == SCHEMA_VERSION) return
        if (current > SCHEMA_VERSION) {
            handleNewerSchema()
            return
        }
${olderBranch}
    }`;
}

// createBaseline / createLiveTables / dropObsoleteTables / handleNewerSchema and
// the version read/stamp, plus the forward-migration runner when the ladder is
// non-empty. These run only off the steady-state path (a below-current, newer, or
// untracked store), so the per-open cost of an already-current store is one header
// read.
function kotlinSchemaVersionHelpers(spec: LocalSQLiteSpec): string {
  const createLiveTables = spec.tables
    .map((table) => {
      const lines = [
        `        execute(${table.kotlinCreateConst}, "create ${table.spec.name}")`,
      ];
      for (const column of additiveColumns(table.spec)) {
        lines.push(
          `        ensureColumn(${JSON.stringify(table.spec.name)}, ${JSON.stringify(
            column.name,
          )}, ${table.kotlinAddColumnConst(column)})`,
        );
      }
      for (const index of table.spec.indexes) {
        lines.push(
          `        execute(${indexSqlConstant(index, "kotlin")}, "create ${index.name}")`,
        );
      }
      // Seed the declared singleton tombstone right after creating the table so
      // the row exists from the first open onward. INSERT OR IGNORE is a no-op
      // once the row exists and never touches its version.
      if (table.kotlinBootstrapConst !== undefined) {
        lines.push(
          `        execute(${table.kotlinBootstrapConst}, "bootstrap ${table.spec.name}")`,
        );
      }
      return lines.join("\n");
    })
    .join("\n");

  const members: string[] = [];
  members.push(
    `    private fun readSchemaVersion(): Long = readPragmaLongOn(raw, READ_SCHEMA_VERSION_SQL)`,
  );
  members.push(`    private fun setSchemaVersion() {
        assertNotMainThread("set schema version")
        execute(SET_SCHEMA_VERSION_SQL, "set schema version")
    }`);
  members.push(`    private fun dropObsoleteTables() {
        assertNotMainThread("drop obsolete tables")
        // Reclaim any table this build no longer owns before creating the live tables,
        // so an older build's at-rest rows are freed. This is the one-time
        // untracked->baseline cleanup: it runs on the baseline create and is recorded by
        // the version stamp, not re-run on a steady-state open.
        for (sql in DROP_OBSOLETE_TABLES_SQL) {
            execute(sql, "drop obsolete table")
        }
    }`);
  members.push(`    private fun createLiveTables() {
        assertNotMainThread("create live tables")
${createLiveTables}
    }`);
  members.push(`    private fun createBaseline() {
        assertNotMainThread("create baseline")
        // Fresh or pre-versioning store: reclaim obsolete tables, create the live
        // tables at the current shape (the additive reconcile patches a
        // pre-versioning store that predates a column), then stamp the version.
        //
        // One transaction, re-reading the version inside it for the reason a ladder step
        // does: the reconcile is an ALTER TABLE ... ADD COLUMN, which is not idempotent,
        // and competing openers can read the same untracked store before either commits.
        // Wrapping the whole create also puts the shape and the stamp that records it in
        // one commit, so a process killed here leaves no half-created store behind.
        execute(BEGIN_IMMEDIATE_SQL, "begin baseline")
        try {
            val onDisk = readSchemaVersion()
            if (onDisk != SCHEMA_VERSION) {
                check(onDisk == 0L) { "Store at $onDisk is neither untracked nor current" }
                dropObsoleteTables()
                createLiveTables()
                setSchemaVersion()
            }
            execute(COMMIT_SQL, "commit baseline")
        } catch (e: RuntimeException) {
            execute(ROLLBACK_SQL, "rollback baseline")
            throw e
        }
        optimizePlannerStatistics(atOpen = true)
    }`);
  members.push(kotlinHandleNewerSchema());
  if (spec.migrations.length > 0) {
    members.push(kotlinForwardMigrationType());
    members.push(kotlinRunForwardMigrations());
  }
  return members.join("\n\n");
}

function kotlinHandleNewerSchema(): string {
  return `    private fun handleNewerSchema() {
        assertNotMainThread("handle newer schema")
        // The store was written by a NEWER build - a downgrade / rollback that should
        // never happen in normal operation. This build cannot safely read a shape it
        // does not know and will not guess, so it refuses the open by throwing the
        // dedicated LocalSQLiteNewerSchemaException. The consumer catches that distinct
        // type and resets the app's state, so the next launch starts from an empty store.
        // A distinct type is required so this unrecoverable
        // state is not mistaken for an ordinary open failure (which fails closed).
        val observed = readSchemaVersion()
        throw LocalSQLiteNewerSchemaException(onDiskVersion = observed, supportedVersion = SCHEMA_VERSION)
    }`;
}

function kotlinForwardMigrationType(): string {
  return `    private data class ForwardMigration(
        val toVersion: Long,
        val statements: List<String>,
    )`;
}

// Each step runs inside BEGIN IMMEDIATE with its trailing user_version bump as the
// last statement, so a step commits atomically: a crash mid-ladder leaves
// user_version at the last committed step and the next open resumes there. The
// re-read inside that transaction is what makes the step's decision binding rather
// than advisory - see swiftRunForwardMigrations' twin.
function kotlinRunForwardMigrations(): string {
  return `    private fun runForwardMigrations(fromVersion: Long) {
        assertNotMainThread("run forward migrations")
        for (migration in FORWARD_MIGRATIONS) {
            if (migration.toVersion <= fromVersion) continue
            execute(BEGIN_IMMEDIATE_SQL, "begin migration \${migration.toVersion}")
            try {
                // fromVersion was read before this lock, and a peer opener - another
                // process on the same file, or another connection in this one - can
                // commit this very step in between. Re-reading here decides again under
                // the write lock: ALTER TABLE ... ADD COLUMN is not idempotent, so a step
                // applied twice fails the open on a store that is already correct.
                val onDisk = readSchemaVersion()
                if (onDisk < migration.toVersion) {
                    check(onDisk == migration.toVersion - 1) {
                        "Store at $onDisk cannot take migration \${migration.toVersion}"
                    }
                    for (sql in migration.statements) {
                        execute(sql, "migrate to \${migration.toVersion}")
                    }
                }
                execute(COMMIT_SQL, "commit migration \${migration.toVersion}")
            } catch (e: RuntimeException) {
                execute(ROLLBACK_SQL, "rollback migration \${migration.toVersion}")
                throw e
            }
            optimizePlannerStatistics(atOpen = false)
        }
        val reached = readSchemaVersion()
        check(reached == SCHEMA_VERSION) {
            "Forward migrations left schema at $reached, expected $SCHEMA_VERSION"
        }
    }`;
}

export function kotlinSchemaMembers(spec: LocalSQLiteSpec): string[] {
  return [
    kotlinCreateSchema(spec),
    kotlinSchemaVersionHelpers(spec),
    kotlinSchemaMigrationHelpers(),
    `    internal fun optimizePlannerStatisticsForTesting(atOpen: Boolean) {
        optimizePlannerStatistics(atOpen)
    }

    private fun optimizePlannerStatistics(atOpen: Boolean) {
        if (!LocalSQLiteGeneratedSchema.requiresPlannerStatistics) return
        // Acquire write intent before optimize can read: upgrading its read lock
        // can return BUSY without spending the busy budget. This transaction owns
        // only statistics; the preceding schema commit must survive its failure.
        execute(BEGIN_IMMEDIATE_SQL, "begin planner statistics")
        try {
            execute(
                if (atOpen) "PRAGMA optimize=0x10002" else "PRAGMA optimize",
                "optimize planner statistics",
            )
            execute(COMMIT_SQL, "commit planner statistics")
        } catch (e: RuntimeException) {
            try {
                execute(ROLLBACK_SQL, "rollback planner statistics")
            } catch (rollback: RuntimeException) {
                e.addSuppressed(rollback)
            }
            throw e
        }
    }`,
  ];
}
