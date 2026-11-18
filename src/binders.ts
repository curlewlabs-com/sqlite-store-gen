// The emitted parameter binders, every platform - the one place that decides how a host
// value reaches a SQLite parameter, including the null form a nullable column needs.
//
// The bodies and the NAME PICKERS live together because they have to agree: an emitter
// writes `bindOptionalText(...)` into a statement and something else has to have emitted a
// `bindOptionalText`. Split across the files that invariant is maintained by hand and
// breaks at codegen time on whichever spec first declares the shape nobody wired; together
// it is one edit.
//
// What the optional pair buys is the thing a substituted value would destroy: a nil has to
// reach SQLite as a real NULL, because the reader tests the STORED TYPE, and a "" or a 0
// written in its place is indistinguishable from one the caller meant. The non-optional
// binders are unchanged from before nullability existed.

import type { NormalizedColumn } from "./model";

// The emitted binder a column's value goes through, per platform.
export function swiftBinder(column: NormalizedColumn): string {
  if (column.swiftType === "String") {
    return column.nullable ? "bindOptionalText" : "bindText";
  }
  return column.nullable ? "bindOptionalInt64" : "bindInt64";
}

export function kotlinBinder(column: NormalizedColumn): string {
  if (column.kotlinType === "String") {
    return column.nullable ? "bindOptionalText" : "bindText";
  }
  return column.nullable ? "bindOptionalInt64" : "bindInt64";
}

// The value expression a bind reads off a branded parameter: `x.value` when the column is
// NOT NULL, `x?.value` when it is nullable - which is what the optional binders above take,
// so nil reaches `bind_null` rather than a substituted zero or empty string.
export function brandedBindValue(
  column: NormalizedColumn,
  fieldExpression: string,
): string {
  return column.nullable
    ? `${fieldExpression}?.value`
    : `${fieldExpression}.value`;
}

export const KOTLIN_BINDERS = `    private fun bindText(
        value: String,
        index: Int,
        statement: Long,
    ) {
        val result = CurlewSQLite.bindText(statement, index, value)
        if (result != CurlewSQLite.OK) throw sqliteError("bind text parameter $index", result)
    }

    private fun bindInt64(
        value: Long,
        index: Int,
        statement: Long,
    ) {
        val result = CurlewSQLite.nativeBindInt64(statement, index, value)
        if (result != CurlewSQLite.OK) throw sqliteError("bind int64 parameter $index", result)
    }

    // The nullable columns' binders, mirroring Swift's pair. A null reaches SQLite as a
    // real NULL rather than as a substituted "" or 0, which is what keeps absent readable
    // back off the row: the reader tests the stored type, and a substituted value would be
    // indistinguishable from one the caller meant.
    private fun bindOptionalText(
        value: String?,
        index: Int,
        statement: Long,
    ) {
        if (value == null) return bindNull(index, statement)
        bindText(value, index, statement)
    }

    private fun bindOptionalInt64(
        value: Long?,
        index: Int,
        statement: Long,
    ) {
        if (value == null) return bindNull(index, statement)
        bindInt64(value, index, statement)
    }

    private fun bindNull(
        index: Int,
        statement: Long,
    ) {
        val result = CurlewSQLite.nativeBindNull(statement, index)
        if (result != CurlewSQLite.OK) throw sqliteError("bind null parameter $index", result)
    }`;

export const SWIFT_BINDERS = `    private func bindText(_ value: String, at index: Int32, statement: OpaquePointer) throws {
        try assertNotMainThread(operation: "bind text parameter \\(index)")
        let transient = unsafeBitCast(-1, to: sqlite3_destructor_type.self)
        let result = value.withCString { valuePointer in
            curlew_sqlite3_bind_text(statement, index, valuePointer, -1, transient)
        }
        guard result == SQLITE_OK else {
            throw sqliteError(operation: "bind text parameter \\(index)", resultCode: result, database: raw)
        }
    }

    private func bindInt64(_ value: Int64, at index: Int32, statement: OpaquePointer) throws {
        try assertNotMainThread(operation: "bind int64 parameter \\(index)")
        let result = curlew_sqlite3_bind_int64(statement, index, value)
        guard result == SQLITE_OK else {
            throw sqliteError(operation: "bind int64 parameter \\(index)", resultCode: result, database: raw)
        }
    }

    // The nullable columns' binders. A nil reaches SQLite as a real NULL rather than as a
    // substituted "" or 0, which is what keeps absent readable back off the row: the
    // reader tests the stored type, and a substituted value would be indistinguishable
    // from one the caller meant.
    private func bindOptionalText(
        _ value: String?, at index: Int32, statement: OpaquePointer
    ) throws {
        guard let value else { return try bindNull(at: index, statement: statement) }
        try bindText(value, at: index, statement: statement)
    }

    private func bindOptionalInt64(
        _ value: Int64?, at index: Int32, statement: OpaquePointer
    ) throws {
        guard let value else { return try bindNull(at: index, statement: statement) }
        try bindInt64(value, at: index, statement: statement)
    }

    private func bindNull(at index: Int32, statement: OpaquePointer) throws {
        try assertNotMainThread(operation: "bind null parameter \\(index)")
        let result = curlew_sqlite3_bind_null(statement, index)
        guard result == SQLITE_OK else {
            throw sqliteError(operation: "bind null parameter \\(index)", resultCode: result, database: raw)
        }
    }`;
