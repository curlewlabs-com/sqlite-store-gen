// Renders Swift database methods and typed statement binds from the normalized
// local-SQLite operation contract.

import { toCamelCase } from "./names";
import {
  VERSION_COLUMN,
  type NormalizedOperation,
  type NormalizedTable,
} from "./model";
import type { LocalSQLitePredicateTerm } from "./operation";
import { brandedBindValue, swiftBinder } from "./binders";
import {
  brandedReadParams,
  columnByName,
  keyedSlotParams,
  ownerSourcedInsertBinds,
  ownerSourcedInsertParams,
  ownerSourcedInsertResultType,
  swiftValueType,
} from "./sql";
import { swiftKeyAllocation } from "./key-allocation";
import { SWIFT_LINE_LIMIT } from "./swift-layout";

import { swiftDeleteSummary } from "./delete-summary";

function swiftPrepare(
  constExpr: string,
  operationLabel: string,
  indent: number,
): string {
  const pad = " ".repeat(indent);
  const single = `${pad}let statement = try prepare(sql: Self.${constExpr}, operation: "${operationLabel}")`;
  if (single.length <= SWIFT_LINE_LIMIT) return single;
  return `${pad}let statement = try prepare(
${pad}    sql: Self.${constExpr},
${pad}    operation: "${operationLabel}"
${pad})`;
}

// Owner-keyed, non-CAS partial-column update mirroring kotlinColumnSetMethod: binds
// its setColumns in order, then the predicate keys, and returns whether a row
// matched (changes() == 1) - false when no row keys to the current owner. It touches
// neither the version nor a sibling consumer's column on the shared owner row.
function swiftColumnSetMethod(
  table: NormalizedTable,
  operation: NormalizedOperation,
): string {
  const predicate = operation.effectivePredicate;
  const params = [
    ...operation.setColumns.map(
      (column) => `        ${column.fieldName}: ${swiftValueType(column)}`,
    ),
    ...predicate
      .filter((term) => term.brand !== undefined)
      .map(
        (term) =>
          `        ${toCamelCase(term.parameter ?? term.column)}: ${term.brand}`,
      ),
  ].join(",\n");
  const prepare = swiftPrepare(
    operation.swiftSqlConst,
    `prepare ${operation.spec.name}`,
    8,
  );
  const setCount = operation.setColumns.length;
  const binds = [
    ...operation.setColumns.map(
      (column, index) =>
        `        try ${swiftBinder(column)}(${brandedBindValue(column, column.fieldName)}, at: ${index + 1}, statement: statement)`,
    ),
    ...predicate.map((term, index) => {
      const position = setCount + index + 1;
      if (term.brand === undefined) {
        return `        try bindInt64(Self.singletonID, at: ${position}, statement: statement)`;
      }
      const column = columnByName(table, term.column);
      return `        try ${column.swiftType === "String" ? "bindText" : "bindInt64"}(${toCamelCase(term.parameter ?? term.column)}.value, at: ${position}, statement: statement)`;
    }),
  ].join("\n");
  return `    func ${operation.dbMethod}(
${params}
    ) throws -> Bool {
        try assertNotMainThread(operation: "${operation.spec.name}")
${prepare}
        defer { curlew_sqlite3_finalize(statement) }
${binds}
        try stepDone(
            statement: statement, operation: "execute ${operation.spec.name}", isWrite: true
        )
        let changedRows = curlew_sqlite3_changes(raw)
        guard changedRows == 0 || changedRows == 1 else {
            throw LocalSQLiteGeneratedError.unexpectedResult(
                operation: "execute ${operation.spec.name}",
                detail: "operation changed \\(changedRows) rows"
            )
        }
        return changedRows == 1
    }`;
}

export function swiftOperationMethod(
  table: NormalizedTable,
  operation: NormalizedOperation,
): string {
  switch (operation.category) {
    case "read":
      return swiftReadMethod(table, operation);
    case "insert":
      return swiftInsertMethod(table, operation);
    case "insertForCurrentOwner":
      return swiftOwnerSourcedInsertMethod(table, operation);
    case "ensure":
      return swiftEnsureMethod(table, operation);
    case "clear":
      return operation.spec.deleteSummary === undefined
        ? swiftClearMethod(table, operation)
        : swiftDeleteSummary(table, operation);
    case "casUpdate":
      return swiftCasUpdateMethod(table, operation);
    case "columnSet":
      return swiftColumnSetMethod(table, operation);
    case "defaultsReset":
      return swiftDefaultsResetMethod(table, operation);
  }
}

// Mirrors kotlinDefaultsResetMethod: one UPDATE returning the keyed row to its declared
// defaults, binding only the predicate because every value in the SET clause is a
// literal. Same 0-or-1 ceiling and Bool result as a keyed clear; an absent row is a
// correct no-op, already being in the state the reset writes.
function swiftDefaultsResetMethod(
  table: NormalizedTable,
  operation: NormalizedOperation,
): string {
  const predicate = operation.effectivePredicate;
  const prepare = swiftPrepare(
    operation.swiftSqlConst,
    `prepare ${operation.spec.name}`,
    8,
  );
  return `    func ${operation.dbMethod}(${brandedReadParams(predicate)}) throws -> Bool {
        try assertNotMainThread(operation: "${operation.spec.name}")
${prepare}
        defer { curlew_sqlite3_finalize(statement) }
${swiftPredicateBinds(table, predicate, 8)}
        try stepDone(
            statement: statement, operation: "execute ${operation.spec.name}", isWrite: true
        )
        let changedRows = curlew_sqlite3_changes(raw)
        guard changedRows == 0 || changedRows == 1 else {
            throw LocalSQLiteGeneratedError.unexpectedResult(
                operation: "execute ${operation.spec.name}",
                detail: "operation changed \\(changedRows) rows"
            )
        }
        return changedRows == 1
    }`;
}

// INSERT OR IGNORE create-if-absent, mirroring the Kotlin ensure: seed the owner's
// row at version 1 if absent, no-op if present, returning whether a row was created
// (changes() == 1) - the same 0-or-1 changes() read the singleton clear uses.
function swiftEnsureMethod(
  table: NormalizedTable,
  operation: NormalizedOperation,
): string {
  const prepare = swiftPrepare(
    operation.swiftSqlConst,
    `prepare ${operation.spec.name}`,
    8,
  );
  const params = keyedSlotParams(table)
    .map((column) => `${column.fieldName}: ${column.brand}`)
    .join(", ");
  return `    func ${operation.dbMethod}(${params}) throws -> Bool {
        try assertNotMainThread(operation: "${operation.spec.name}")
${prepare}
        defer { curlew_sqlite3_finalize(statement) }
${swiftSlotBind(table, 1, 8)}
        try stepDone(
            statement: statement, operation: "execute ${operation.spec.name}", isWrite: true
        )
        let changedRows = curlew_sqlite3_changes(raw)
        guard changedRows == 0 || changedRows == 1 else {
            throw LocalSQLiteGeneratedError.unexpectedResult(
                operation: "execute ${operation.spec.name}",
                detail: "operation changed \\(changedRows) rows"
            )
        }
        return changedRows == 1
    }`;
}

// Typed statement binds for a predicate, one `?` per term in order: a branded
// term binds the caller's key value (text or int by column type), an unbranded
// term the singleton slot constant.
function swiftPredicateBinds(
  table: NormalizedTable,
  predicate: LocalSQLitePredicateTerm[],
  indent: number,
): string {
  const pad = " ".repeat(indent);
  return predicate
    .map((term, index) => {
      const position = index + 1;
      if (term.brand === undefined) {
        return `${pad}try bindInt64(Self.singletonID, at: ${position}, statement: statement)`;
      }
      const column = columnByName(table, term.column);
      const binder = column.swiftType === "String" ? "bindText" : "bindInt64";
      return `${pad}try ${binder}(${column.fieldName}.value, at: ${position}, statement: statement)`;
    })
    .join("\n");
}

// The slot bind at `position`: the caller-supplied owner value for an owner-keyed
// table, or the singleton slot constant otherwise.
function swiftSlotBind(
  table: NormalizedTable,
  position: number,
  indent: number,
): string {
  const pad = " ".repeat(indent);
  const keyed = table.keyedSlot;
  if (keyed === undefined) {
    return `${pad}try bindInt64(Self.singletonID, at: ${position}, statement: statement)`;
  }
  const binder = keyed.swiftType === "String" ? "bindText" : "bindInt64";
  return `${pad}try ${binder}(${keyed.fieldName}.value, at: ${position}, statement: statement)`;
}

function swiftReadMethod(
  table: NormalizedTable,
  operation: NormalizedOperation,
): string {
  const predicate = operation.effectivePredicate;
  const params = brandedReadParams(predicate);
  const prepare = swiftPrepare(
    operation.swiftSqlConst,
    `prepare ${operation.spec.name}`,
    8,
  );
  // A head read binds nothing - its key is the ORDER BY, not a `?` - so the bind block
  // collapses along with the blank line that separates it from the prepare, which would
  // otherwise leave the two consecutive blank lines SwiftLint rejects.
  const binds = swiftPredicateBinds(table, predicate, 8);
  const bindBlock = binds === "" ? "" : `\n${binds}`;
  // NOT NULL text columns only. A nullable one must NOT join the guard: `column_text`
  // answers NULL for it legitimately, and the guard's else-arm throws a `sqliteError`
  // carrying `SQLITE_ROW` - so a row holding a real NULL would come back as a database
  // error rather than as the row it is. Nullable columns decode in `rowInit` below, where
  // NULL is a value rather than a failed binding.
  const textColumns = table.readColumns.filter(
    (column) => column.swiftType === "String" && !column.nullable,
  );
  const guard = textColumns
    .map((column) => {
      const selectIndex = table.readColumns.indexOf(column);
      return `              let ${column.fieldName}Bytes = curlew_sqlite3_column_text(statement, ${selectIndex})`;
    })
    .join(",\n");
  // A row with text value columns extends the SQLITE_ROW guard with their byte
  // bindings; a row with none (an integer-only row) is a plain
  // check - the text-binding form's trailing comma with no bindings is invalid
  // Swift (`guard cond, else`).
  const rowGuard =
    textColumns.length === 0
      ? "        guard stepResult == SQLITE_ROW else {"
      : `        guard stepResult == SQLITE_ROW,\n${guard} else {`;
  const rowInit = table.readColumns
    .map((column, index) => {
      // A nullable column carries its own presence test into the initializer, so the
      // brand is constructed only for a value that is there. Text tests the pointer
      // `column_text` already returns; an integer has to ask `column_type`, because
      // `column_int64` answers 0 for a SQL NULL and for a stored zero alike. The type
      // read comes BEFORE any `column_text` call on that column, per SQLite's rule that
      // a text conversion may rewrite the reported type.
      if (column.nullable) {
        // Always multi-line, where a NOT NULL column inlines when it fits. The single-line
        // form of these two would be the longest expression the reader emits - a brand, a
        // shim call, and a closure or a ternary on one line - so a fits-or-wraps rule here
        // decides the layout off the column NAME rather than off anything meaningful, and
        // the wrapped branch is then the one nothing exercises until a long name arrives.
        if (column.swiftType === "String") {
          return `            ${column.fieldName}: curlew_sqlite3_column_text(statement, ${index}).map {
                ${column.brand}(value: String(cString: $0))
            }`;
        }
        return `            ${column.fieldName}: curlew_sqlite3_column_type(statement, ${index}) == SQLITE_NULL
                ? nil
                : ${column.brand}(value: curlew_sqlite3_column_int64(statement, ${index}))`;
      }
      const value =
        column.swiftType === "String"
          ? `String(cString: ${column.fieldName}Bytes)`
          : `curlew_sqlite3_column_int64(statement, ${index})`;
      const singleLine = `            ${column.fieldName}: ${column.brand}(value: ${value})`;
      if (singleLine.length <= SWIFT_LINE_LIMIT) return singleLine;
      return `            ${column.fieldName}: ${column.brand}(
                value: ${value}
            )`;
    })
    .join(",\n");
  // Inline when it fits and wrapped when it does not, the same shape `rowInit` above
  // uses: this line carries the operation name, so it grows with the table's name and
  // an unconditional single line trips the Swift 120-char lint on a long one.
  const stepThrow = `            let error = sqliteError(operation: "execute ${operation.spec.name}", resultCode: stepResult, database: raw)`;
  const stepThrowBlock =
    stepThrow.length <= SWIFT_LINE_LIMIT
      ? stepThrow
      : `            let error = sqliteError(
                operation: "execute ${operation.spec.name}",
                resultCode: stepResult,
                database: raw
            )`;
  // Inline when it fits and wrapped when it does not, the same rule the version reader's
  // signature takes: a keyed read's signature carries the method name, the key's brand and
  // the row type at once, so the widest of the three-name combinations overflows the Swift
  // 120-char lint while a head read on the same table stays well inside it.
  const inlineSignature = `    func ${operation.dbMethod}(${params}) throws -> ${table.rowType}? {`;
  const signature =
    params === "" || inlineSignature.length <= SWIFT_LINE_LIMIT
      ? inlineSignature
      : `    func ${operation.dbMethod}(\n        ${params}\n    ) throws -> ${table.rowType}? {`;
  return `${signature}
        try assertNotMainThread(operation: "${operation.spec.name}")
${prepare}
        defer { curlew_sqlite3_finalize(statement) }
${bindBlock}
        // The read's own lock event. SHARED is taken on this step and held to finalize, so
        // the span closes here and the duplicate-row step below re-acquires nothing. The
        // prepare above is outside it on every platform - see LocalSQLiteStoreSpan.
        let spanStart = readSpanStart()
        let stepResult = curlew_sqlite3_step(statement)
        if stepResult == SQLITE_DONE {
            recordReadSpan(spanStart, lostBudget: false)
            return nil
        }
${rowGuard}
${stepThrowBlock}
            if Self.isSQLiteBusy(error) {
                recordReadSpan(spanStart, lostBudget: true)
            }
            throw error
        }
        recordReadSpan(spanStart, lostBudget: false)
        let row = ${table.rowType}(
${rowInit}
        )
        guard curlew_sqlite3_step(statement) == SQLITE_DONE else {
            throw LocalSQLiteGeneratedError.unexpectedResult(
                operation: "execute ${operation.spec.name}",
                detail: "primary-key lookup returned more than one row"
            )
        }
        return row
    }`;
}

// The Swift mirror of kotlinOwnerSourcedInsertMethod: the owner read and the insert run
// as one BEGIN IMMEDIATE unit, so the pair commits as one fact against a peer process.
// The `alsoSet` statement, emitted beside its insert rather than as an operation: it is not
// reachable on its own, and a caller-callable version of it would be the non-atomic write
// the co-write exists to replace.
function swiftCoWriteMethod(operation: NormalizedOperation): string {
  const coWrite = operation.coWrite;
  if (coWrite === undefined) return "";
  const params = coWrite.setColumns
    .map((column) => `        ${column.fieldName}: ${swiftValueType(column)}`)
    .join(",\n");
  const binds = coWrite.setColumns
    .map(
      (column, index) =>
        `        try ${swiftBinder(column)}(${brandedBindValue(
          column,
          column.fieldName,
        )}, at: ${index + 1}, statement: statement)`,
    )
    .join("\n");
  return `
    private func ${operation.swiftCoWriteName}(
${params}
    ) throws {
${swiftPrepare(operation.swiftCoWriteConst, `prepare ${operation.spec.name} also-set`, 8)}
        defer { curlew_sqlite3_finalize(statement) }
${binds}
        try bindInt64(Self.singletonID, at: ${coWrite.setColumns.length + 1}, statement: statement)
        try stepDone(
            statement: statement,
            operation: "execute ${operation.spec.name} also-set",
            isWrite: true
        )
        guard curlew_sqlite3_changes(raw) == 1 else {
            throw LocalSQLiteGeneratedError.unexpectedResult(
                operation: "execute ${operation.spec.name} also-set",
                detail: "operation changed an unexpected row count"
            )
        }
    }
`;
}

function swiftOwnerSourcedInsertMethod(
  table: NormalizedTable,
  operation: NormalizedOperation,
): string {
  const resultType = ownerSourcedInsertResultType(table);
  const params = ownerSourcedInsertParams(table, operation)
    .map((column) => `        ${column.fieldName}: ${swiftValueType(column)}`)
    .join(",\n");
  const prepare = swiftPrepare(
    operation.swiftSqlConst,
    `prepare ${operation.spec.name}`,
    12,
  );
  const binds = ownerSourcedInsertBinds(table, operation)
    .map(({ column, expression }, index) => {
      // The owner is read inside this transaction and bound as a plain non-null string;
      // `validateNullableColumns` rejects a nullable `into` column, so the owner arm never
      // needs the optional binder.
      const binder = expression === "owner" ? "bindText" : swiftBinder(column);
      const value =
        expression === "owner"
          ? "owner"
          : brandedBindValue(
              column,
              operation.spec.allocateKey !== undefined &&
                column.name === table.slotColumnName
                ? "allocatedKey"
                : column.fieldName,
            );
      return `            try ${binder}(${value}, at: ${index + 1}, statement: statement)`;
    })
    .join("\n");
  // The optional second write, inside the same unit and after the insert, so an insert that
  // throws takes it with it. Its changed-row count is checked like the insert's: the target
  // is a schema-seeded singleton, so zero rows is an unexpected result rather than a quiet
  // no-op a caller would read as success.
  const coWrite =
    operation.coWrite === undefined
      ? ""
      : `
            try ${operation.swiftCoWriteName}(
${operation.coWrite.setColumns
  .map((column) => `                ${column.fieldName}: ${column.fieldName}`)
  .join(",\n")}
            )`;
  return `    func ${operation.dbMethod}(
${params}
    ) throws -> ${resultType} {
        try assertNotMainThread(operation: "${operation.spec.name}")
        return try withImmediateTransaction(
            operation: "${operation.spec.name}", busy: .busy
        ) {
            let owner = try ${operation.swiftOwnerReadName}()
            guard !owner.isEmpty else { return .noCurrentOwner }${swiftKeyAllocation(table, operation)}
${prepare}
            defer { curlew_sqlite3_finalize(statement) }
${binds}
            try stepDone(
                statement: statement, operation: "execute ${operation.spec.name}", isWrite: true
            )
            guard curlew_sqlite3_changes(raw) == 1 else {
                throw LocalSQLiteGeneratedError.unexpectedResult(
                    operation: "execute ${operation.spec.name}",
                    detail: "operation changed an unexpected row count"
                )
            }${coWrite}
            return .recorded${operation.spec.allocateKey === undefined ? "" : "(key: allocatedKey)"}
        }
    }
${swiftCoWriteMethod(operation)}
    private func ${operation.swiftOwnerReadName}() throws -> String {
${swiftPrepare(operation.swiftOwnerReadConst, `prepare ${operation.spec.name} owner read`, 8)}
        defer { curlew_sqlite3_finalize(statement) }
        try bindInt64(Self.singletonID, at: 1, statement: statement)
        let stepResult = curlew_sqlite3_step(statement)
        if stepResult == SQLITE_DONE { return "" }
        guard stepResult == SQLITE_ROW,
              let ownerBytes = curlew_sqlite3_column_text(statement, 0) else {
            throw sqliteError(
                operation: "execute ${operation.spec.name} owner read",
                resultCode: stepResult,
                database: raw
            )
        }
        return String(cString: ownerBytes)
    }`;
}

function swiftInsertMethod(
  table: NormalizedTable,
  operation: NormalizedOperation,
): string {
  const insertColumns = [...keyedSlotParams(table), ...table.settableColumns];
  const params = insertColumns
    .map((column) => `        ${column.fieldName}: ${swiftValueType(column)}`)
    .join(",\n");
  const prepare = swiftPrepare(
    operation.swiftSqlConst,
    `prepare ${operation.spec.name}`,
    8,
  );
  const bindLines = [
    swiftSlotBind(table, 1, 8),
    ...table.settableColumns.map(
      (column, index) =>
        `        try ${swiftBinder(column)}(${brandedBindValue(column, column.fieldName)}, at: ${index + 2}, statement: statement)`,
    ),
  ].join("\n");
  // Swift call sites need the argument label; the keyed version reader takes the key
  // column's own label, so pass `key: key` under that name (a singleton reader takes
  // none). Kotlin is positional and passes the bare field name.
  const versionArg =
    table.keyedSlot === undefined
      ? ""
      : `${table.keyedSlot.fieldName}: ${table.keyedSlot.fieldName}`;
  return `    func ${operation.dbMethod}(
${params}
    ) throws -> ${table.versionColumn.brand} {
        try assertNotMainThread(operation: "${operation.spec.name}")
${prepare}
        defer { curlew_sqlite3_finalize(statement) }

${bindLines}
        try stepDone(
            statement: statement, operation: "execute ${operation.spec.name}", isWrite: true
        )
        guard curlew_sqlite3_changes(raw) == 1 else {
            throw LocalSQLiteGeneratedError.unexpectedResult(
                operation: "execute ${operation.spec.name}",
                detail: "operation changed an unexpected row count"
            )
        }
        guard let rowVersion = try ${table.versionReader}(${versionArg}) else {
            throw LocalSQLiteGeneratedError.unexpectedResult(
                operation: "execute ${operation.spec.name}",
                detail: "operation did not leave a row"
            )
        }
        return rowVersion
    }`;
}

function swiftClearMethod(
  table: NormalizedTable,
  operation: NormalizedOperation,
): string {
  const predicate = operation.effectivePredicate;
  const params = brandedReadParams(predicate);
  const prepare = swiftPrepare(
    operation.swiftSqlConst,
    `prepare ${operation.spec.name}`,
    8,
  );
  // A bounded-scan delete touches 0..N rows and returns the affected count; a
  // keyed clear touches at most one row and reports only whether that row existed.
  if (operation.spec.boundedScanException !== undefined) {
    return `    func ${operation.dbMethod}(${params}) throws -> Int64 {
        try assertNotMainThread(operation: "${operation.spec.name}")
${prepare}
        defer { curlew_sqlite3_finalize(statement) }
${swiftPredicateBinds(table, predicate, 8)}
        try stepDone(
            statement: statement, operation: "execute ${operation.spec.name}", isWrite: true
        )
        return Int64(curlew_sqlite3_changes(raw))
    }`;
  }
  const inlineSignature = `    func ${operation.dbMethod}(${params}) throws -> Bool {`;
  const signature =
    inlineSignature.length <= SWIFT_LINE_LIMIT
      ? inlineSignature
      : `    func ${operation.dbMethod}(\n        ${params.replaceAll(", ", ",\n        ")}\n    ) throws -> Bool {`;
  return `${signature}
        try assertNotMainThread(operation: "${operation.spec.name}")
${prepare}
        defer { curlew_sqlite3_finalize(statement) }
${swiftPredicateBinds(table, predicate, 8)}
        try stepDone(
            statement: statement, operation: "execute ${operation.spec.name}", isWrite: true
        )
        let changedRows = curlew_sqlite3_changes(raw)
        guard changedRows == 0 || changedRows == 1 else {
            throw LocalSQLiteGeneratedError.unexpectedResult(
                operation: "execute ${operation.spec.name}",
                detail: "operation changed \\(changedRows) rows"
            )
        }
        return changedRows == 1
    }`;
}

// Compare-and-set update, mirroring kotlinCasUpdateMethod: binds `setColumns` first,
// then the predicate terms in declared order (row_version -> expectedVersion, a
// branded non-version term -> the caller's key, an unbranded term -> the singleton
// slot), so one emitter serves the fixed-singleton and owner-keyed slot shapes.
function swiftCasUpdateMethod(
  table: NormalizedTable,
  operation: NormalizedOperation,
): string {
  const predicate = operation.effectivePredicate;
  const keyColumns = predicate
    .filter(
      (term) => term.brand !== undefined && term.column !== VERSION_COLUMN,
    )
    .map((term) => columnByName(table, term.column));
  const params = [
    ...operation.setColumns.map(
      (column) => `        ${column.fieldName}: ${swiftValueType(column)}`,
    ),
    ...keyColumns.map(
      (column) => `        ${column.fieldName}: ${column.brand}`,
    ),
    `        expectedVersion: ${table.expectedVersionBrand}`,
  ].join(",\n");
  const prepare = swiftPrepare(
    operation.swiftSqlConst,
    `prepare ${operation.spec.name}`,
    12,
  );
  const setCount = operation.setColumns.length;
  const binds = [
    ...operation.setColumns.map(
      (column, index) =>
        `            try ${swiftBinder(column)}(${brandedBindValue(column, column.fieldName)}, at: ${index + 1}, statement: statement)`,
    ),
    ...predicate.map((term, index) => {
      const position = setCount + index + 1;
      if (term.column === VERSION_COLUMN) {
        return `            try bindInt64(expectedVersion.value, at: ${position}, statement: statement)`;
      }
      if (term.brand === undefined) {
        return `            try bindInt64(Self.singletonID, at: ${position}, statement: statement)`;
      }
      const column = columnByName(table, term.column);
      return `            try ${column.swiftType === "String" ? "bindText" : "bindInt64"}(${column.fieldName}.value, at: ${position}, statement: statement)`;
    }),
  ].join("\n");
  const versionReaderArgs = keyColumns
    .map((column) => `${column.fieldName}: ${column.fieldName}`)
    .join(", ");
  return `    func ${operation.dbMethod}(
${params}
    ) throws -> ${table.casResultType} {
        try assertNotMainThread(operation: "${operation.spec.name}")
        return try withImmediateTransaction(
            operation: "${operation.spec.name}", busy: .busy
        ) {
            guard let observedVersion = try ${table.versionReader}(${versionReaderArgs}) else {
                return .missing
            }
            guard observedVersion.value == expectedVersion.value else {
                return .stale(observedVersion: observedVersion)
            }
${prepare}
            defer { curlew_sqlite3_finalize(statement) }

${binds}
            try stepDone(
                statement: statement, operation: "execute ${operation.spec.name}", isWrite: true
            )
            guard curlew_sqlite3_changes(raw) == 1 else {
                throw LocalSQLiteGeneratedError.unexpectedResult(
                    operation: "execute ${operation.spec.name}",
                    detail: "operation changed an unexpected row count after matching the version"
                )
            }
            return .applied
        }
    }`;
}

export function swiftVersionReader(table: NormalizedTable): string {
  const keyed = table.keyedSlot;
  const prepare = swiftPrepare(
    table.swiftReadVersionConst,
    `prepare read ${table.noun} row_version`,
    8,
  );
  // A keyed table's version reader takes the owner param; the inline signature can
  // overflow SwiftLint's line limit (the stored-version return brand is long), so
  // wrap the param when it does. A singleton takes no param and stays inline.
  const inlineSignature = `    private func ${table.versionReader}(${keyed === undefined ? "" : `${keyed.fieldName}: ${keyed.brand}`}) throws -> ${table.versionColumn.brand}? {`;
  const signature =
    keyed === undefined || inlineSignature.length <= SWIFT_LINE_LIMIT
      ? inlineSignature
      : `    private func ${table.versionReader}(\n        ${keyed.fieldName}: ${keyed.brand}\n    ) throws -> ${table.versionColumn.brand}? {`;
  return `${signature}
        try assertNotMainThread(operation: "read ${table.noun} row_version")
${prepare}
        defer { curlew_sqlite3_finalize(statement) }
${swiftSlotBind(table, 1, 8)}
        let stepResult = curlew_sqlite3_step(statement)
        if stepResult == SQLITE_DONE {
            return nil
        }
        guard stepResult == SQLITE_ROW else {
            throw sqliteError(operation: "execute read ${table.noun} row_version", resultCode: stepResult, database: raw)
        }
        return ${table.versionColumn.brand}(value: curlew_sqlite3_column_int64(statement, 0))
    }`;
}
