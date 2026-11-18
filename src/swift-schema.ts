// Renders Swift's generated schema metadata and version-gated lifecycle methods.
// Connection establishment and runtime integrity classification remain separate owners.

import type { LocalSQLiteSpec } from "./model";
import { databaseNeedsStatistics, tableNeedsStatistics } from "./statistics";
import { indexSqlConstant } from "./indexes";
import { additiveColumns } from "./schema";

export function swiftSchemaEnum(spec: LocalSQLiteSpec): string {
  const metadata = spec.tables
    .map((table) => {
      const pk = table.spec.primaryKey
        .map((column) => `"${column}"`)
        .join(", ");
      return `LocalSQLiteTableMetadata(
            name: "${table.spec.name}",
            primaryKey: [${pk}],
            declaredIndexes: [${table.spec.indexes
              .map(
                (index) => `LocalSQLiteIndexMetadata(
                name: "${index.name}",
                columns: [${index.columns.map((column) => `"${column}"`).join(", ")}], unique: false
            )`,
              )
              .join(", ")}],
            analyze: ${tableNeedsStatistics(table) ? "true" : "false"}
        )`;
    })
    .join(",\n        ");
  const analyzeTargets = spec.tables
    .filter(tableNeedsStatistics)
    .map((table) => `        "${table.spec.name}"`)
    .join(",\n");
  return `enum LocalSQLiteGeneratedSchema {
    static let requiresPlannerStatistics = ${databaseNeedsStatistics(spec)}
    static let tables: [LocalSQLiteTableMetadata] = [
        ${metadata}
    ]
    static let analyzeTargets: [String] = [
${analyzeTargets}
    ]
}`;
}

function swiftSchemaMigrationHelpers(): string {
  return `    private func ensureColumn(
        table: String,
        column: String,
        sql: String
    ) throws {
        try assertNotMainThread(operation: "ensure column")
        if try columnExists(table: table, column: column) { return }
        try execute(sql: sql, operation: "add \\(table).\\(column)")
    }

    private func columnExists(table: String, column: String) throws -> Bool {
        try assertNotMainThread(operation: "check column")
        // Generated schema names come from the reviewed local-SQLite spec; PRAGMA
        // table_info does not accept bound identifiers.
        let statement = try prepare(sql: "PRAGMA table_info(\\(table))", operation: "check column")
        defer { curlew_sqlite3_finalize(statement) }
        while true {
            let result = curlew_sqlite3_step(statement)
            if result == SQLITE_DONE { return false }
            guard result == SQLITE_ROW else {
                throw sqliteError(operation: "check column", resultCode: result, database: raw)
            }
            guard let name = curlew_sqlite3_column_text(statement, 1) else {
                throw LocalSQLiteGeneratedError.unexpectedResult(
                    operation: "check column",
                    detail: "column name was null"
                )
            }
            if String(cString: name) == column { return true }
        }
    }`;
}

// The version-gated open dispatcher (mirror of kotlinCreateSchema). Reads PRAGMA
// user_version - the durable ledger - and returns immediately when the store is already
// current; an untracked store takes the baseline create, a below-current store climbs
// the ladder, a newer store is the abnormal downgrade handleNewerSchema refuses.
function swiftCreateSchema(spec: LocalSQLiteSpec): string {
  const olderBranch =
    spec.migrations.length > 0
      ? `        if current == 0 {
            try createBaseline()
            return
        }
        try runForwardMigrations(fromVersion: current)`
      : `        // No forward-migration ladder yet: schemaVersion is the floor, so a
        // below-current store can only be version 0 - a fresh install or a
        // pre-versioning store - reconciled to the baseline.
        try createBaseline()`;
  return `    func createSchema() throws {
        try assertNotMainThread(operation: "create schema")
        let current = try readSchemaVersion()
        if current == Self.schemaVersion { return }
        if current > Self.schemaVersion {
            try handleNewerSchema()
            return
        }
${olderBranch}
    }`;
}

function swiftSchemaVersionHelpers(spec: LocalSQLiteSpec): string {
  const createLiveTables = spec.tables
    .map((table) => {
      const lines = [
        `        try execute(sql: Self.${table.swiftCreateConst}, operation: "create ${table.spec.name}")`,
      ];
      for (const column of additiveColumns(table.spec)) {
        lines.push(
          `        try ensureColumn(
            table: ${JSON.stringify(table.spec.name)},
            column: ${JSON.stringify(column.name)},
            sql: Self.${table.swiftAddColumnConst(column)}
        )`,
        );
      }
      for (const index of table.spec.indexes) {
        lines.push(
          `        try execute(
            sql: Self.${indexSqlConstant(index, "swift")},
            operation: "create ${index.name}"
        )`,
        );
      }
      // Seed the declared singleton tombstone right after creating the table so
      // the row exists from the first open onward. INSERT OR IGNORE is a no-op
      // once the row exists and never touches its version.
      if (table.swiftBootstrapConst !== undefined) {
        lines.push(
          `        try execute(sql: Self.${table.swiftBootstrapConst}, operation: "bootstrap ${table.spec.name}")`,
        );
      }
      return lines.join("\n");
    })
    .join("\n");

  const members: string[] = [];
  members.push(`    private func readSchemaVersion() throws -> Int64 {
        try assertNotMainThread(operation: "read schema version")
        return try guardedConnection.readPragmaInt64(sql: Self.readSchemaVersionSQL)
    }`);
  members.push(`    private func setSchemaVersion() throws {
        try execute(sql: Self.setSchemaVersionSQL, operation: "set schema version")
    }`);
  members.push(`    private func dropObsoleteTables() throws {
        try assertNotMainThread(operation: "drop obsolete tables")
        // Reclaim any table this build no longer owns before creating the live tables,
        // so an older build's at-rest rows are freed. This is the one-time
        // untracked->baseline cleanup: it runs on the baseline create and is recorded by
        // the version stamp, not re-run on a steady-state open.
        for sql in Self.dropObsoleteTablesSQL {
            try execute(sql: sql, operation: "drop obsolete table")
        }
    }`);
  members.push(`    private func createLiveTables() throws {
        try assertNotMainThread(operation: "create live tables")
${createLiveTables}
    }`);
  members.push(`    private func createBaseline() throws {
        try assertNotMainThread(operation: "create baseline")
        // Fresh or pre-versioning store: reclaim obsolete tables, create the live
        // tables at the current shape (the additive reconcile patches a
        // pre-versioning store that predates a column), then stamp the version.
        //
        // One transaction, re-reading the version inside it for the reason a ladder step
        // does: the reconcile is an ALTER TABLE ... ADD COLUMN, which is not idempotent,
        // and competing openers can read the same untracked store before either commits.
        // Wrapping the whole create also puts the shape and the stamp that records it in
        // one commit, so a process killed here leaves no half-created store behind.
        try execute(sql: Self.beginImmediateSQL, operation: "begin baseline")
        do {
            let onDisk = try readSchemaVersion()
            if onDisk != Self.schemaVersion {
                guard onDisk == 0 else {
                    throw LocalSQLiteGeneratedError.unexpectedResult(
                        operation: "create baseline",
                        detail: "store at \\(onDisk) is neither untracked nor current"
                    )
                }
                try dropObsoleteTables()
                try createLiveTables()
                try setSchemaVersion()
            }
            try execute(sql: Self.commitSQL, operation: "commit baseline")
        } catch {
            try? execute(sql: Self.rollbackSQL, operation: "rollback baseline")
            throw error
        }
        try optimizePlannerStatistics(atOpen: true)
    }`);
  members.push(swiftHandleNewerSchema());
  if (spec.migrations.length > 0) {
    members.push(swiftForwardMigrationType());
    members.push(swiftRunForwardMigrations());
  }
  return members.join("\n\n");
}

function swiftHandleNewerSchema(): string {
  return `    private func handleNewerSchema() throws {
        try assertNotMainThread(operation: "handle newer schema")
        // The store was written by a NEWER build - a downgrade / rollback that should
        // never happen in normal operation. This build cannot safely read a shape it
        // does not know and will not guess, so it refuses the open by throwing the
        // dedicated .newerSchema error. The consumer catches that distinct case and
        // resets the app's state, so the next launch starts from an empty store. A
        // distinct case is required so this unrecoverable state
        // is not mistaken for an ordinary open failure (which fails closed).
        let observed = try readSchemaVersion()
        throw LocalSQLiteGeneratedError.newerSchema(
            onDisk: observed,
            supported: Self.schemaVersion
        )
    }`;
}

function swiftForwardMigrationType(): string {
  return `    private struct ForwardMigration {
        let toVersion: Int64
        let statements: [String]
    }`;
}

// Each step runs inside BEGIN IMMEDIATE with its trailing user_version bump as the
// last statement, so a step commits atomically: a crash mid-ladder leaves
// user_version at the last committed step and the next open resumes there. The
// re-read inside that transaction is what makes the step's decision binding rather
// than advisory - the version the climb was planned from is read before any lock is
// held, so it is stale the moment a peer opener commits.
function swiftRunForwardMigrations(): string {
  return `    private func runForwardMigrations(fromVersion: Int64) throws {
        try assertNotMainThread(operation: "run forward migrations")
        for migration in Self.forwardMigrations where migration.toVersion > fromVersion {
            try execute(sql: Self.beginImmediateSQL, operation: "begin migration \\(migration.toVersion)")
            do {
                // fromVersion was read before this lock, and a peer opener - another
                // process on the same file, or another connection in this one - can
                // commit this very step in between. Re-reading here decides again under
                // the write lock: ALTER TABLE ... ADD COLUMN is not idempotent, so a step
                // applied twice fails the open on a store that is already correct.
                let onDisk = try readSchemaVersion()
                if onDisk < migration.toVersion {
                    guard onDisk == migration.toVersion - 1 else {
                        throw LocalSQLiteGeneratedError.unexpectedResult(
                            operation: "migrate to \\(migration.toVersion)",
                            detail: "store at \\(onDisk) cannot take this step"
                        )
                    }
                    for sql in migration.statements {
                        try execute(sql: sql, operation: "migrate to \\(migration.toVersion)")
                    }
                }
                try execute(sql: Self.commitSQL, operation: "commit migration \\(migration.toVersion)")
            } catch {
                try? execute(sql: Self.rollbackSQL, operation: "rollback migration \\(migration.toVersion)")
                throw error
            }
            try optimizePlannerStatistics(atOpen: false)
        }
        let reached = try readSchemaVersion()
        guard reached == Self.schemaVersion else {
            throw LocalSQLiteGeneratedError.unexpectedResult(
                operation: "run forward migrations",
                detail: "left schema at \\(reached), expected \\(Self.schemaVersion)"
            )
        }
    }`;
}

export function swiftSchemaMembers(spec: LocalSQLiteSpec): string[] {
  return [
    swiftCreateSchema(spec),
    swiftSchemaVersionHelpers(spec),
    swiftSchemaMigrationHelpers(),
    `    #if DEBUG
    func optimizePlannerStatisticsForTesting(atOpen: Bool) throws {
        try optimizePlannerStatistics(atOpen: atOpen)
    }
    #endif

    private func optimizePlannerStatistics(atOpen: Bool) throws {
        guard LocalSQLiteGeneratedSchema.requiresPlannerStatistics else { return }
        // Acquire write intent before optimize can read: upgrading its read lock
        // can return BUSY without spending the busy budget. This transaction owns
        // only statistics; the preceding schema commit must survive its failure.
        try execute(sql: Self.beginImmediateSQL, operation: "begin planner statistics")
        do {
            try execute(
                sql: atOpen ? "PRAGMA optimize=0x10002" : "PRAGMA optimize",
                operation: "optimize planner statistics"
            )
            try execute(sql: Self.commitSQL, operation: "commit planner statistics")
        } catch {
            try? execute(sql: Self.rollbackSQL, operation: "rollback planner statistics")
            throw error
        }
    }`,
  ];
}
