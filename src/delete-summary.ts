// Compiles exact-owner deletion with its observation summary as one transaction.
// The summary leaves the generated layer only after its matching DELETE commits.
//
// The owner is the operation's single predicate column, so the spec names it once, where
// every other operation names its key; validateDeleteSummary holds it to the owner shape.
import type {
  NormalizedColumn,
  NormalizedOperation,
  NormalizedTable,
} from "./model";
import type {
  LocalSQLiteOperationSpec,
  LocalSQLiteOperationTableSpec,
} from "./operation";

export function validateDeleteSummary(
  table: LocalSQLiteOperationTableSpec,
  operation: LocalSQLiteOperationSpec,
): void {
  const summary = operation.deleteSummary;
  if (summary === undefined) return;
  const predicate = operation.predicate ?? [];
  const owner = table.columns.find(
    (column) => column.name === predicate[0]?.column,
  );
  const timestamp = table.columns.find(
    (column) => column.name === summary.observedAtColumn,
  );
  if (
    Object.keys(summary).some((key) => key !== "observedAtColumn") ||
    operation.boundedScanException !== undefined ||
    predicate.length !== 1 ||
    owner === undefined ||
    predicate[0]?.operator !== "=" ||
    predicate[0].brand !== owner.brand ||
    owner.sqliteType !== "TEXT" ||
    owner.nullable ||
    timestamp?.sqliteType !== "INTEGER" ||
    timestamp.nullable
  ) {
    throw new Error(
      `${operation.name} deleteSummary requires an exact bound nonnullable owner and nonnullable observation timestamp`,
    );
  }
}

export function deleteSummarySql(
  table: NormalizedTable,
  operation: NormalizedOperation,
  summary: NonNullable<LocalSQLiteOperationSpec["deleteSummary"]>,
): string {
  return `SELECT COUNT(*), MIN(${summary.observedAtColumn}) FROM ${table.spec.name} WHERE ${deleteSummaryOwner(table, operation).name} = ?`;
}

// The column validateDeleteSummary admitted as the owner. Normalization refuses a
// deleteSummary without one, so only a spec it did not produce reaches the throw.
function deleteSummaryOwner(
  table: NormalizedTable,
  operation: NormalizedOperation,
): NormalizedColumn {
  const ownerColumnName = operation.spec.predicate?.[0]?.column;
  const owner = table.allColumns.find(
    (column) => column.name === ownerColumnName,
  );
  if (owner === undefined) {
    throw new Error(
      `${operation.spec.name} deleteSummary has no owner column; normalize the spec before rendering it`,
    );
  }
  return owner;
}

export function kotlinDeleteSummary(
  table: NormalizedTable,
  operation: NormalizedOperation,
): string {
  const { brand, fieldName: owner } = deleteSummaryOwner(table, operation);
  return `    fun ${operation.dbMethod}(${owner}: ${brand}): LocalSQLiteDeleteResult {
        assertNotMainThread("${operation.spec.name}")
        return withImmediateTransaction<LocalSQLiteDeleteResult>(LocalSQLiteDeleteResult.Busy) {
            val summary = withStatement(${operation.kotlinSqlConst}_SUMMARY, "summarize ${operation.spec.name}") { statement ->
                bindText(${owner}.value, 1, statement)
                check(stepRowOrDone(statement, "summarize ${operation.spec.name}"))
                val count = CurlewSQLite.nativeColumnInt64(statement, 0)
                val oldest = if (count == 0L) null else CurlewSQLite.nativeColumnInt64(statement, 1)
                LocalSQLiteDeleteResult.Committed(count, oldest)
            }
            withStatement(${operation.kotlinSqlConst}, "${operation.spec.name}") { statement ->
                bindText(${owner}.value, 1, statement)
                stepDone(statement, "${operation.spec.name}", isWrite = true)
                check(readChanges() == summary.count) { "Owner cleanup count changed inside transaction" }
            }
            summary
        }
    }`;
}

export function swiftDeleteSummary(
  table: NormalizedTable,
  operation: NormalizedOperation,
): string {
  const { brand, fieldName: owner } = deleteSummaryOwner(table, operation);
  return `    func ${operation.dbMethod}(
        ${owner}: ${brand}
    ) throws -> LocalSQLiteDeleteResult {
        try assertNotMainThread(operation: "${operation.spec.name}")
        return try withImmediateTransaction(
            operation: "${operation.spec.name}", busy: .busy
        ) {
            let summary = try ${operation.dbMethod}Summary(${owner}: ${owner})
            let statement = try prepare(
                sql: Self.${operation.swiftSqlConst}, operation: "${operation.spec.name}"
            )
            defer { curlew_sqlite3_finalize(statement) }
            try bindText(${owner}.value, at: 1, statement: statement)
            try stepDone(statement: statement, operation: "${operation.spec.name}", isWrite: true)
            guard Int64(curlew_sqlite3_changes(raw)) == summary.count else {
                throw LocalSQLiteGeneratedError.unexpectedResult(
                    operation: "${operation.spec.name}",
                    detail: "Owner cleanup count changed inside transaction"
                )
            }
            return .committed(count: summary.count, oldestObservedAtMs: summary.oldest)
        }
    }

    private func ${operation.dbMethod}Summary(
        ${owner}: ${brand}
    ) throws -> (count: Int64, oldest: Int64?) {
        let statement = try prepare(
            sql: Self.${operation.swiftSqlConst}Summary, operation: "summarize owner cleanup"
        )
        defer { curlew_sqlite3_finalize(statement) }
        try bindText(${owner}.value, at: 1, statement: statement)
        let result = curlew_sqlite3_step(statement)
        guard result == SQLITE_ROW else {
            throw sqliteError(operation: "summarize owner cleanup", resultCode: result, database: raw)
        }
        let count = curlew_sqlite3_column_int64(statement, 0)
        let oldest: Int64? = count == 0 ? nil : curlew_sqlite3_column_int64(statement, 1)
        return (count, oldest)
    }`;
}

export const kotlinDeleteResult = `sealed interface LocalSQLiteDeleteResult {
    data class Committed(val count: Long, val oldestObservedAtMs: Long?) : LocalSQLiteDeleteResult
    data object Busy : LocalSQLiteDeleteResult
}`;

export const swiftDeleteResult = `enum LocalSQLiteDeleteResult: Equatable, Sendable {
    case committed(count: Int64, oldestObservedAtMs: Int64?)
    case busy
}`;
