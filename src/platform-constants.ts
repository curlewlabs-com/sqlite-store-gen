// Renders private Kotlin and Swift constants from one normalized store model.
// Platform class composition and connection behavior remain with their runtime owners.

import {
  VERSION_COLUMN,
  type LocalSQLiteSpec,
  type NormalizedOperation,
  type NormalizedTable,
} from "./model";
import {
  additiveColumnDdl,
  additiveColumns,
  createTableStatement,
  dropTableStatement,
  USER_VERSION_PRAGMA,
} from "./schema";
import {
  bootstrapSqlLiteral,
  columnListLines,
  columnSetLines,
  ensureValuesPlaceholder,
  indentBlock,
  migrationStatementLiteral,
  coWriteUpdateSql,
  ownerSourceReadSql,
  readTail,
  resetSetLines,
  updateWhereClause,
  whereClause,
} from "./sql";

import { createIndexStatement, indexSqlConstant } from "./indexes";
import { deleteSummarySql } from "./delete-summary";

export function kotlinGeneratedConstants(
  spec: LocalSQLiteSpec,
  busyTimeoutMillis: number,
): string[] {
  const consts: string[] = [
    `        private const val SINGLETON_ID = 1L`,
    `        private const val SCHEMA_VERSION = ${spec.schemaVersion}L`,
    `        private const val READ_SCHEMA_VERSION_SQL = "PRAGMA ${USER_VERSION_PRAGMA}"`,
    `        private const val SET_SCHEMA_VERSION_SQL = "PRAGMA ${USER_VERSION_PRAGMA} = ${spec.schemaVersion}"`,
    `        private const val SQLITE_SYNCHRONOUS_EXTRA = 3L`,
    `        private const val SQLITE_BUSY_TIMEOUT_MILLIS = ${busyTimeoutMillis}L`,
    `        private const val SQLITE_CACHE_SIZE = -2000L`,
    `        private const val SQLITE_VERSION_SQL = "SELECT sqlite_version()"`,
    `        private const val SQLITE_SOURCE_ID_SQL = "SELECT sqlite_source_id()"`,
    `        private const val CHANGES_SQL = "SELECT changes()"`,
  ];
  // BEGIN/COMMIT/ROLLBACK back the compare-and-set wrapper, the per-step
  // forward-migration transaction, and the baseline create. Unconditional because
  // the baseline create runs on every spec, ladder or no ladder.
  consts.push(
    `        private const val BEGIN_IMMEDIATE_SQL = "BEGIN IMMEDIATE"`,
  );
  consts.push(`        private const val COMMIT_SQL = "COMMIT"`);
  consts.push(`        private const val ROLLBACK_SQL = "ROLLBACK"`);
  const dropList = spec.obsoleteTables
    .map((name) => `"${dropTableStatement(name)}",`)
    .join("\n                ");
  consts.push(`        private val DROP_OBSOLETE_TABLES_SQL: List<String> =
            listOf(
                ${dropList}
            )`);
  if (spec.migrations.length > 0) {
    consts.push(kotlinForwardMigrationsConst(spec));
  }
  for (const table of spec.tables) consts.push(...kotlinTableSql(table));
  return consts;
}

// The ordered ladder as generated data: each step's statements already end with
// their user_version bump (normalizeLocalSQLiteMigrations), so
// runForwardMigrations executes
// the list verbatim inside one transaction.
function kotlinForwardMigrationsConst(spec: LocalSQLiteSpec): string {
  const steps = spec.migrations
    .map((step) => {
      const statements = step.statements
        .map(
          (statement) =>
            `                            ${migrationStatementLiteral(statement)},`,
        )
        .join("\n");
      return `                ForwardMigration(
                    toVersion = ${step.toVersion}L,
                    statements =
                        listOf(
${statements}
                        ),
                ),`;
    })
    .join("\n");
  return `        private val FORWARD_MIGRATIONS: List<ForwardMigration> =
            listOf(
${steps}
            )`;
}

function kotlinTableSql(table: NormalizedTable): string[] {
  const create = indentBlock(
    createTableStatement(table.spec, "    "),
    "            ",
  );
  const consts: string[] = [];
  consts.push(`        private val ${table.kotlinCreateConst} = """
${create}
            """`);
  for (const index of table.spec.indexes) {
    consts.push(`        private val ${indexSqlConstant(index, "kotlin")} = """
            ${createIndexStatement(table.spec.name, index).replace(" ON ", "\n            ON ")}
            """`);
  }
  for (const column of additiveColumns(table.spec)) {
    consts.push(`        private val ${table.kotlinAddColumnConst(column)} = """
            ALTER TABLE ${table.spec.name}
            ADD COLUMN ${additiveColumnDdl(table.spec, column)}
            """`);
  }
  if (
    table.kotlinBootstrapConst !== undefined &&
    table.bootstrapColumns !== undefined
  ) {
    const names = table.bootstrapColumns.map((column) => column.name);
    const values = table.bootstrapColumns.map(bootstrapSqlLiteral).join(", ");
    // One column per line, matching the ensure const this seed mirrors: the joined
    // form grows with the column count and trips each platform's 120-char lint the
    // next time the table gains one.
    consts.push(`        private val ${table.kotlinBootstrapConst} = """
            INSERT OR IGNORE INTO ${table.spec.name} (
${columnListLines(names, "                ")}
            )
            VALUES (${values})
            """`);
  }

  for (const operation of table.operations) {
    if (operation.category === "read") {
      const selectColumns = columnListLines(
        table.readColumns.map((column) => column.name),
        "                ",
      );
      consts.push(`        private val ${operation.kotlinSqlConst} = """
            SELECT
${selectColumns}
            FROM ${table.spec.name}
${readTail(operation, "            ")}
            """`);
      // The version-reader SQL is used only by the private version reader, which is
      // emitted only when an insert or compare-and-set reads the version back.
      if (table.emitsVersionReader) {
        consts.push(`        private val ${table.kotlinReadVersionConst} = """
            SELECT ${VERSION_COLUMN}
            FROM ${table.spec.name}
            WHERE ${table.slotColumnName} = ?
            """`);
      }
    } else if (operation.category === "insert") {
      consts.push(kotlinInsertSql(table, operation));
    } else if (operation.category === "insertForCurrentOwner") {
      consts.push(kotlinInsertSql(table, operation));
      consts.push(`        private val ${operation.kotlinOwnerReadConst} = """
${indentBlock(ownerSourceReadSql(operation), "            ")}
            """`);
      if (operation.coWrite !== undefined) {
        consts.push(`        private val ${operation.kotlinCoWriteConst} = """
${indentBlock(coWriteUpdateSql(operation), "            ")}
            """`);
      }
    } else if (operation.category === "ensure") {
      consts.push(kotlinEnsureSql(table, operation));
    } else if (operation.category === "clear") {
      if (operation.spec.deleteSummary !== undefined) {
        consts.push(
          `        private const val ${operation.kotlinSqlConst}_SUMMARY = "${deleteSummarySql(table, operation)}"`,
        );
      }
      consts.push(`        private val ${operation.kotlinSqlConst} = """
            DELETE FROM ${table.spec.name}
            WHERE ${whereClause(operation.effectivePredicate)}
            """`);
    } else if (operation.category === "casUpdate") {
      // Sets only the op's named columns - a CAS on the shared owner row must leave a
      // sibling consumer's column alone, exactly as the non-CAS columnSet does - plus
      // the version bump, which is the CAS contract rather than an optional extra.
      const setClause = [
        ...operation.setColumns.map((column) => `${column.name} = ?`),
        `${VERSION_COLUMN} = ${VERSION_COLUMN} + 1`,
      ].join(", ");
      consts.push(`        private val ${operation.kotlinSqlConst} = """
            UPDATE ${table.spec.name}
            SET ${setClause}
            WHERE ${whereClause(operation.effectivePredicate)}
            """`);
    } else if (operation.category === "columnSet") {
      // Partial column update: SET only the op's named columns (never row_version),
      // so a consumer's owner-scoped write leaves siblings' columns untouched.
      consts.push(`        private val ${operation.kotlinSqlConst} = """
            UPDATE ${table.spec.name}
${columnSetLines(operation, "            ", "                ")}
            WHERE ${updateWhereClause(table, operation)}
            """`);
    } else if (operation.category === "defaultsReset") {
      // Every settable column not flagged survivesReset, set to its declared default
      // as a literal - the derived column list is what makes a column added later
      // reset without an edit here.
      consts.push(`        private val ${operation.kotlinSqlConst} = """
            UPDATE ${table.spec.name}
            SET
${resetSetLines(operation, "                ")}
            WHERE ${whereClause(operation.effectivePredicate)}
            """`);
    } else {
      // Unreachable: every category above is handled. A category added without an
      // emitter throws here rather than falling through to a DELETE, which is what an
      // unguarded else would silently generate for it.
      throw new Error(
        `${operation.spec.name} has no Kotlin SQL emitter for category ${operation.category}`,
      );
    }
  }
  return consts;
}

function kotlinInsertSql(
  table: NormalizedTable,
  operation: NormalizedOperation,
): string {
  const placeholders = table.spec.columns
    .map((column) => (column.name === VERSION_COLUMN ? "1" : "?"))
    .join(", ");
  const doUpdate = [
    ...table.settableColumns.map(
      (column) => `                ${column.name} = excluded.${column.name}`,
    ),
    `                ${VERSION_COLUMN} = ${table.spec.name}.${VERSION_COLUMN} + 1`,
  ].join(",\n");
  // Column list one name per line - the Swift mirror's rationale, kept identical here
  // so the Kotlin and Swift INSERT text does not diverge over formatting alone.
  return `        private val ${operation.kotlinSqlConst} = """
            INSERT INTO ${table.spec.name} (
${columnListLines(
  table.spec.columns.map((column) => column.name),
  "                ",
)}
            )
            VALUES (${placeholders})${
              operation.spec.allocateKey === undefined
                ? `
            ON CONFLICT(${table.slotColumnName}) DO UPDATE SET
${doUpdate}`
                : ""
            }
            """`;
}

// INSERT OR IGNORE: create the owner's row at the initial version if absent, no-op
// on conflict (the row already exists) with no ON CONFLICT DO UPDATE clause, so an
// existing row's value and version are never touched. VALUES binds only the slot
// (the caller's owner); row_version and every settable column seed as reviewed
// literals (see ensureValuesPlaceholder), so the ensure method supplies no value
// bind beyond the slot.
function kotlinEnsureSql(
  table: NormalizedTable,
  operation: NormalizedOperation,
): string {
  const allColumns = table.spec.columns.map((column) => column.name).join(", ");
  const placeholders = table.spec.columns
    .map((column) => ensureValuesPlaceholder(table, column))
    .join(", ");
  return `        private val ${operation.kotlinSqlConst} = """
            INSERT OR IGNORE INTO ${table.spec.name} (
${columnListLines(allColumns.split(", "), "                ")}
            )
            VALUES (${placeholders})
            """`;
}

export function swiftGeneratedConstants(
  spec: LocalSQLiteSpec,
  busyTimeoutMillis: number,
): string {
  const consts: string[] = [
    `    private static let singletonID: Int64 = 1`,
    `    private static let schemaVersion: Int64 = ${spec.schemaVersion}`,
    `    private static let readSchemaVersionSQL = "PRAGMA ${USER_VERSION_PRAGMA}"`,
    `    private static let setSchemaVersionSQL = "PRAGMA ${USER_VERSION_PRAGMA} = ${spec.schemaVersion}"`,
    `    private static let sqliteSynchronousExtra: Int64 = 3`,
    `    private static let sqliteBusyTimeoutMillis: Int64 = ${busyTimeoutMillis}`,
    `    private static let sqliteCacheSize: Int64 = -2000`,
    `    private static let runtimeIdentitySQL = "SELECT sqlite_version(), sqlite_source_id()"`,
  ];
  // BEGIN/COMMIT/ROLLBACK back the compare-and-set wrapper, the per-step
  // forward-migration transaction, and the baseline create. Unconditional because
  // the baseline create runs on every spec, ladder or no ladder.
  consts.push(`    private static let beginImmediateSQL = "BEGIN IMMEDIATE"`);
  consts.push(`    private static let commitSQL = "COMMIT"`);
  consts.push(`    private static let rollbackSQL = "ROLLBACK"`);
  const dropList = spec.obsoleteTables
    .map((name) => `        "${dropTableStatement(name)}"`)
    .join(",\n");
  consts.push(`    private static let dropObsoleteTablesSQL: [String] = [
${dropList}
    ]`);
  if (spec.migrations.length > 0) {
    consts.push(swiftForwardMigrationsConst(spec));
  }
  for (const table of spec.tables) consts.push(...swiftTableSql(table));
  return consts.join("\n");
}

// The ordered ladder as generated data (mirror of kotlinForwardMigrationsConst):
// each step's statements already end with their user_version bump, so
// runForwardMigrations executes the list verbatim inside one transaction.
function swiftForwardMigrationsConst(spec: LocalSQLiteSpec): string {
  const steps = spec.migrations
    .map((step) => {
      const statements = step.statements
        .map(
          (statement) =>
            `                ${migrationStatementLiteral(statement)}`,
        )
        .join(",\n");
      return `        ForwardMigration(
            toVersion: ${step.toVersion},
            statements: [
${statements}
            ]
        )`;
    })
    .join(",\n");
  // A migration statement is reviewed static DDL that must reach SQLite byte-exact, so
  // it is emitted as one escaped literal and cannot be wrapped to satisfy line_length.
  // The exemption is scoped to this constant rather than the file.
  return `    // swiftlint:disable line_length - migration DDL is one exact literal per statement
    private static let forwardMigrations: [ForwardMigration] = [
${steps}
    ]
    // swiftlint:enable line_length`;
}

function swiftTableSql(table: NormalizedTable): string[] {
  const create = indentBlock(
    createTableStatement(table.spec, "  "),
    "        ",
  );
  const consts: string[] = [];
  consts.push(`    private static let ${table.swiftCreateConst} = """
${create}
        """`);
  for (const index of table.spec.indexes) {
    consts.push(`    private static let ${indexSqlConstant(index, "swift")} = """
        ${createIndexStatement(table.spec.name, index).replace(" ON ", "\n        ON ")}
        """`);
  }
  for (const column of additiveColumns(table.spec)) {
    consts.push(`    private static let ${table.swiftAddColumnConst(column)} = """
        ALTER TABLE ${table.spec.name}
        ADD COLUMN ${additiveColumnDdl(table.spec, column)}
        """`);
  }
  if (
    table.swiftBootstrapConst !== undefined &&
    table.bootstrapColumns !== undefined
  ) {
    const names = table.bootstrapColumns.map((column) => column.name);
    const values = table.bootstrapColumns.map(bootstrapSqlLiteral);
    // One column and one value per line, matching the ensure const this seed mirrors:
    // either list joined on one line grows with the column count and trips the 120-char
    // line-length lint the next time the table gains one.
    consts.push(`    private static let ${table.swiftBootstrapConst} = """
        INSERT OR IGNORE INTO ${table.spec.name} (
${columnListLines(names, "          ")}
        )
        VALUES (
${columnListLines(values, "          ")}
        )
        """`);
  }

  for (const operation of table.operations) {
    if (operation.category === "read") {
      const selectColumns = columnListLines(
        table.readColumns.map((column) => column.name),
        "          ",
      );
      consts.push(`    private static let ${operation.swiftSqlConst} = """
        SELECT
${selectColumns}
        FROM ${table.spec.name}
${readTail(operation, "        ")}
        """`);
      // The version-reader SQL is used only by the private version reader, which is
      // emitted only when an insert or compare-and-set reads the version back.
      if (table.emitsVersionReader) {
        consts.push(`    private static let ${table.swiftReadVersionConst} = """
        SELECT ${VERSION_COLUMN}
        FROM ${table.spec.name}
        WHERE ${table.slotColumnName} = ?
        """`);
      }
    } else if (operation.category === "insert") {
      consts.push(swiftInsertSql(table, operation));
    } else if (operation.category === "insertForCurrentOwner") {
      consts.push(swiftInsertSql(table, operation));
      consts.push(`    private static let ${operation.swiftOwnerReadConst} = """
${indentBlock(ownerSourceReadSql(operation), "        ")}
        """`);
      if (operation.coWrite !== undefined) {
        consts.push(`    private static let ${operation.swiftCoWriteConst} = """
${indentBlock(coWriteUpdateSql(operation), "        ")}
        """`);
      }
    } else if (operation.category === "ensure") {
      consts.push(swiftEnsureSql(table, operation));
    } else if (operation.category === "clear") {
      if (operation.spec.deleteSummary !== undefined) {
        consts.push(
          `    private static let ${operation.swiftSqlConst}Summary = """
        ${deleteSummarySql(table, operation).replace(" FROM ", "\n        FROM ")}
        """`,
        );
      }
      consts.push(`    private static let ${operation.swiftSqlConst} = """
        DELETE FROM ${table.spec.name}
        WHERE ${whereClause(operation.effectivePredicate)}
        """`);
    } else if (operation.category === "casUpdate") {
      // Sets only the op's named columns, plus the version bump the CAS contract
      // owns - see the Kotlin twin for why a full-row CAS is wrong on a shared row.
      const setClause = [
        ...operation.setColumns.map((column) => `${column.name} = ?`),
        `${VERSION_COLUMN} = ${VERSION_COLUMN} + 1`,
      ].join(", ");
      consts.push(`    private static let ${operation.swiftSqlConst} = """
        UPDATE ${table.spec.name}
        SET ${setClause}
        WHERE ${whereClause(operation.effectivePredicate)}
        """`);
    } else if (operation.category === "columnSet") {
      // Partial column update: SET only the op's named columns (never row_version),
      // so a consumer's owner-scoped write leaves siblings' columns untouched.
      consts.push(`    private static let ${operation.swiftSqlConst} = """
        UPDATE ${table.spec.name}
${columnSetLines(operation, "        ", "          ")}
        WHERE ${updateWhereClause(table, operation)}
        """`);
    } else if (operation.category === "defaultsReset") {
      // Derived column list - see the Kotlin twin.
      consts.push(`    private static let ${operation.swiftSqlConst} = """
        UPDATE ${table.spec.name}
        SET
${resetSetLines(operation, "          ")}
        WHERE ${whereClause(operation.effectivePredicate)}
        """`);
    } else {
      // Unreachable: every category above is handled. A category added without an
      // emitter throws here rather than falling through to a DELETE, which is what an
      // unguarded else would silently generate for it.
      throw new Error(
        `${operation.spec.name} has no Swift SQL emitter for category ${operation.category}`,
      );
    }
  }
  return consts;
}

function swiftInsertSql(
  table: NormalizedTable,
  operation: NormalizedOperation,
): string {
  const placeholders = table.spec.columns
    .map((column) => (column.name === VERSION_COLUMN ? "1" : "?"))
    .join(", ");
  const doUpdate = [
    ...table.settableColumns.map(
      (column) => `          ${column.name} = excluded.${column.name}`,
    ),
    `          ${VERSION_COLUMN} = ${table.spec.name}.${VERSION_COLUMN} + 1`,
  ].join(",\n");
  // Column list one name per line, for the reason columnListLines carries: joined on
  // one line it grows with the table's name and column count until it re-trips the
  // Swift 120-char lint, which is what a long table name did here. SQLite ignores the
  // newlines.
  return `    private static let ${operation.swiftSqlConst} = """
        INSERT INTO ${table.spec.name} (
${columnListLines(
  table.spec.columns.map((column) => column.name),
  "          ",
)}
        )
        VALUES (${placeholders})${
          operation.spec.allocateKey === undefined
            ? `
        ON CONFLICT(${table.slotColumnName}) DO UPDATE SET
${doUpdate}`
            : ""
        }
        """`;
}

// INSERT OR IGNORE mirror of kotlinEnsureSql: create-if-absent with no ON CONFLICT
// clause, so an existing row is never touched. VALUES binds only the slot; the
// row_version and every settable column seed as reviewed literals (see
// ensureValuesPlaceholder), keeping the Kotlin and Swift ensure VALUES identical.
function swiftEnsureSql(
  table: NormalizedTable,
  operation: NormalizedOperation,
): string {
  const allColumns = table.spec.columns.map((column) => column.name).join(", ");
  const placeholders = table.spec.columns.map((column) =>
    ensureValuesPlaceholder(table, column),
  );
  // Values one per line, as the column list is: the joined VALUES list grows with the
  // column count and trips the Swift 120-char lint on a wide table.
  return `    private static let ${operation.swiftSqlConst} = """
        INSERT OR IGNORE INTO ${table.spec.name} (
${columnListLines(allColumns.split(", "), "          ")}
        )
        VALUES (
${columnListLines(placeholders, "          ")}
        )
        """`;
}
