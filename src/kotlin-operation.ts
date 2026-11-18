// Renders Kotlin database methods and public operation wrappers from the
// normalized local-SQLite operation contract.

import { toCamelCase } from "./names";
import {
  VERSION_COLUMN,
  type NormalizedColumn,
  type NormalizedOperation,
  type NormalizedTable,
} from "./model";
import type { LocalSQLitePredicateTerm } from "./operation";
import { brandedBindValue, kotlinBinder } from "./binders";
import {
  brandedReadParams,
  columnByName,
  keyedSlotParams,
  kotlinValueType,
  ownerSourcedInsertBinds,
  ownerSourcedInsertParams,
  ownerSourcedInsertResultType,
} from "./sql";

import { kotlinKeyAllocation } from "./key-allocation";
import { kotlinDeleteSummary } from "./delete-summary";

// ktlint's standard:function-signature rule keeps a member signature inline
// when it fits and wraps one parameter per line otherwise. Generated Kotlin is
// excluded from ktlint, but mirroring that rule keeps its review shape aligned
// with the hand-written tree.
const KOTLIN_LINE_LIMIT = 120;

// Owner-keyed, non-CAS partial-column update: binds its setColumns in order, then
// the predicate keys, and returns whether a row matched (changes() == 1) - false
// when no row keys to the current owner (fails closed). It touches neither the
// version nor a sibling consumer's column on the shared owner row.
function kotlinColumnSetMethod(
  table: NormalizedTable,
  operation: NormalizedOperation,
): string {
  const predicate = operation.effectivePredicate;
  const keyColumns = predicate
    .filter((term) => term.brand !== undefined)
    .map((term) => ({
      ...columnByName(table, term.column),
      fieldName: toCamelCase(term.parameter ?? term.column),
      brand: term.brand!,
    }));
  const signature = kotlinBlockSignature(
    operation.dbMethod,
    [...operation.setColumns, ...keyColumns],
    "Boolean",
  );
  const setCount = operation.setColumns.length;
  const binds = [
    ...operation.setColumns.map((column, index) =>
      kotlinColumnBind(column, column.fieldName, index + 1, 16),
    ),
    ...predicate.map((term, index) => {
      const position = setCount + index + 1;
      if (term.brand === undefined) {
        return kotlinBind("Long", "SINGLETON_ID", position, 16);
      }
      const column = columnByName(table, term.column);
      return kotlinBind(
        column.kotlinType,
        `${toCamelCase(term.parameter ?? term.column)}.value`,
        position,
        16,
      );
    }),
  ].join("\n");
  return `${signature}
${kotlinCountedWrite(operation, binds)}
    }`;
}

// The body every counted write shares: bind, step, read changes(), and hold the row count
// to the 0-or-1 ceiling the operation's key guarantees.
//
// changes() is read on the connection after the step because sqlite3_step reports
// completion rather than the affected-row count. Insert and update shapes use this sequence,
// matching the Swift emitter.
function kotlinCountedWrite(
  operation: NormalizedOperation,
  binds: string,
): string {
  return `        assertNotMainThread("${operation.spec.name}")
        val changedRows =
            withStatement(${operation.kotlinSqlConst}, "${operation.spec.name}") { statement ->
${binds}
                stepDone(statement, "${operation.spec.name}", isWrite = true)
                readChanges()
            }
        check(changedRows == 0L || changedRows == 1L) {
            "Generated ${operation.spec.name} changed $changedRows rows"
        }
        return changedRows == 1L`;
}

export function kotlinOperationMethod(
  table: NormalizedTable,
  operation: NormalizedOperation,
): string {
  switch (operation.category) {
    case "read":
      return kotlinReadMethod(table, operation);
    case "insert":
      return kotlinInsertMethod(table, operation);
    case "insertForCurrentOwner":
      return kotlinOwnerSourcedInsertMethod(table, operation);
    case "ensure":
      return kotlinEnsureMethod(table, operation);
    case "clear":
      return operation.spec.deleteSummary === undefined
        ? kotlinClearMethod(table, operation)
        : kotlinDeleteSummary(table, operation);
    case "casUpdate":
      return kotlinCasUpdateMethod(table, operation);
    case "columnSet":
      return kotlinColumnSetMethod(table, operation);
    case "defaultsReset":
      return kotlinDefaultsResetMethod(table, operation);
  }
}

// Returns the keyed row to its declared defaults in one UPDATE. Every value in the SET
// clause is a literal, so the statement binds only the predicate and the signature
// takes no value at all - a caller cannot pass the "wrong" reset. Same 0-or-1 ceiling
// and Boolean result as a keyed clear: at most one row, reporting whether it existed.
// An absent row is a correct no-op, since a row that was never seeded is already in the
// state the reset writes.
function kotlinDefaultsResetMethod(
  table: NormalizedTable,
  operation: NormalizedOperation,
): string {
  const predicate = operation.effectivePredicate;
  return `    fun ${operation.dbMethod}(${brandedReadParams(predicate)}): Boolean {
${kotlinCountedWrite(operation, kotlinPredicateBinds(table, predicate, 16))}
    }`;
}

// INSERT OR IGNORE create-if-absent: seed the owner's row at version 1 if none
// exists, no-op (never a version bump or value overwrite) if one does. Returns
// whether a row was created (changes() == 1) - the same 0-or-1 changes() read the
// singleton clear uses. No version read-back: the row is guaranteed present after,
// but ensure exists to establish existence, not to report the version.
function kotlinEnsureMethod(
  table: NormalizedTable,
  operation: NormalizedOperation,
): string {
  const ensureParams = keyedSlotParams(table);
  return `${kotlinBlockSignature(operation.dbMethod, ensureParams, "Boolean")}
${kotlinCountedWrite(operation, kotlinSlotStatementBind(table, 1, 16))}
    }`;
}

// Branded predicate params as one-per-line signature entries (trailing comma), and
// their bare argument names - the signature and forwarding forms an Operations wrapper needs to accept
// a caller's key and forward it to the database method.
function brandedReadParamLines(
  predicate: LocalSQLitePredicateTerm[],
  indent: number,
): string {
  const pad = " ".repeat(indent);
  return predicate
    .filter((term) => term.brand !== undefined)
    .map(
      (term) =>
        `${pad}${toCamelCase(term.parameter ?? term.column)}: ${term.brand},`,
    )
    .join("\n");
}

function brandedReadArgNames(predicate: LocalSQLitePredicateTerm[]): string {
  return predicate
    .filter((term) => term.brand !== undefined)
    .map((term) => toCamelCase(term.parameter ?? term.column))
    .join(", ");
}

// Branded INTEGER keys bind as integers and branded TEXT keys bind as text; an
// unbranded term is the fixed singleton slot. Typed binds keep predicate matching
// independent of SQLite's text-affinity coercion.
// One bind, in the emitted layer's parameter order (value, index, statement) - which is
// the Swift twin's order too, so the Kotlin and Swift files bind identically.
function kotlinBind(
  kotlinType: "String" | "Long",
  valueExpr: string,
  position: number,
  indent: number,
): string {
  const binder = kotlinType === "String" ? "bindText" : "bindInt64";
  return `${" ".repeat(indent)}${binder}(${valueExpr}, ${position}, statement)`;
}

// The bind for one of a table's own value columns, which is where nullability lands: the
// binder and the value expression come off the column, so a nullable one binds
// `x?.value` through the optional binder and a NOT NULL one is unchanged.
function kotlinColumnBind(
  column: NormalizedColumn,
  fieldExpression: string,
  position: number,
  indent: number,
): string {
  return `${" ".repeat(indent)}${kotlinBinder(column)}(${brandedBindValue(column, fieldExpression)}, ${position}, statement)`;
}

// The typed bind for the slot column at `position`: the caller-supplied owner value for
// an owner-keyed table, or the SINGLETON_ID constant otherwise.
function kotlinSlotStatementBind(
  table: NormalizedTable,
  position: number,
  indent: number,
): string {
  const keyed = table.keyedSlot;
  if (keyed === undefined) {
    return kotlinBind("Long", "SINGLETON_ID", position, indent);
  }
  return kotlinBind(
    keyed.kotlinType,
    `${keyed.fieldName}.value`,
    position,
    indent,
  );
}

// The predicate binds of a read, in declared order, starting at `position`. Each
// value uses its declared SQLite representation rather than relying on affinity
// coercion.
function kotlinReadBinds(
  table: NormalizedTable,
  predicate: LocalSQLitePredicateTerm[],
  indent: number,
): string {
  return predicate
    .map((term, index) => {
      if (term.brand === undefined) {
        return kotlinBind("Long", "SINGLETON_ID", index + 1, indent);
      }
      const column = columnByName(table, term.column);
      return kotlinBind(
        column.kotlinType,
        `${column.fieldName}.value`,
        index + 1,
        indent,
      );
    })
    .join("\n");
}

function kotlinReadMethod(
  table: NormalizedTable,
  operation: NormalizedOperation,
): string {
  const predicate = operation.effectivePredicate;
  const params = brandedReadParams(predicate);
  const binds = kotlinReadBinds(table, predicate, 12);
  return `    fun ${operation.dbMethod}(${params}): ${table.rowType}? {
        assertNotMainThread("${operation.spec.name}")
        return withStatement(${operation.kotlinSqlConst}, "${operation.spec.name}") { statement ->
${binds}
            if (!stepFirstRow(statement, "${operation.spec.name}")) return@withStatement null
            val row = ${table.cursorFn}(statement)
            check(!stepRowOrDone(statement, "${operation.spec.name}")) {
                "Generated ${operation.spec.name} returned more than one row"
            }
            row
        }
    }`;
}

export function kotlinVersionReader(table: NormalizedTable): string {
  const keyed = table.keyedSlot;
  const params =
    keyed === undefined ? "" : `${keyed.fieldName}: ${keyed.brand}`;
  return `    private fun ${table.versionReader}(${params}): ${table.versionColumn.brand}? {
        assertNotMainThread("read ${table.noun} row_version")
        return withStatement(${table.kotlinReadVersionConst}, "read ${table.noun} row_version") { statement ->
${kotlinSlotStatementBind(table, 1, 12)}
            if (!stepRowOrDone(statement, "read ${table.noun} row_version")) {
                return@withStatement null
            }
            ${table.versionColumn.brand}(CurlewSQLite.nativeColumnInt64(statement, 0))
        }
    }`;
}

// Emits a member-function signature ending in ` {`, inline when it fits within
// KOTLIN_LINE_LIMIT and one-parameter-per-line (trailing comma) otherwise -
// matching ktlint's standard:function-signature wrapping so generated Kotlin
// follows the hand-written tree's review shape even though lint excludes it.
function kotlinBlockSignature(
  methodName: string,
  params: NormalizedColumn[],
  returnType: string,
): string {
  const inline = `    fun ${methodName}(${params.map((column) => `${column.fieldName}: ${kotlinValueType(column)}`).join(", ")}): ${returnType} {`;
  if (inline.length <= KOTLIN_LINE_LIMIT) {
    return inline;
  }
  const wrapped = params
    .map((column) => `        ${column.fieldName}: ${kotlinValueType(column)},`)
    .join("\n");
  return `    fun ${methodName}(\n${wrapped}\n    ): ${returnType} {`;
}

function kotlinInsertMethod(
  table: NormalizedTable,
  operation: NormalizedOperation,
): string {
  const insertParams = [...keyedSlotParams(table), ...table.settableColumns];
  const bindLines = [
    kotlinSlotStatementBind(table, 1, 12),
    ...table.settableColumns.map((column, index) =>
      kotlinColumnBind(column, column.fieldName, index + 2, 12),
    ),
  ].join("\n");
  return `${kotlinBlockSignature(operation.dbMethod, insertParams, table.versionColumn.brand)}
        assertNotMainThread("${operation.spec.name}")
        return withStatement(${operation.kotlinSqlConst}, "${operation.spec.name}") { statement ->
${bindLines}
            // The version comes back from the write itself, so no other writer's version
            // can land between the upsert and the value returned.
            val rowVersion =
                stepWriteReturningLong(statement, "${operation.spec.name}")
                    ?: error("Generated ${operation.spec.name} did not leave a row")
            check(readChanges() == 1L) {
                "Generated ${operation.spec.name} changed an unexpected row count"
            }
            ${table.versionColumn.brand}(rowVersion)
        }
    }`;
}

// Read the source's owner and insert with it, as one BEGIN IMMEDIATE unit. That is the
// difference from `kotlinInsertMethod`, and the reason the row's write is one fact: no
// repoint of the owner can land between reading it and recording the row, across
// processes as well as inside one, which a lock held by the caller cannot promise.
//
// An empty owner is the source's parked state and an absent row its never-written one;
// each means there is nobody to record for, so each returns NoCurrentOwner without
// inserting.
// The `alsoSet` statement, inside the same transaction and after the insert, so an insert
// that throws takes it with it. Its changed-row count is checked like the insert's: the
// target is a schema-seeded singleton, so zero rows is an unexpected result rather than a
// quiet no-op a caller would read as success.
function kotlinCoWriteBlock(operation: NormalizedOperation): string {
  const coWrite = operation.coWrite;
  if (coWrite === undefined) return "";
  const binds = coWrite.setColumns
    .map((column, index) =>
      kotlinColumnBind(column, column.fieldName, index + 1, 16),
    )
    .join("\n");
  return `
            withStatement(${operation.kotlinCoWriteConst}, "${operation.spec.name} also-set") { statement ->
${binds}
                bindInt64(SINGLETON_ID, ${coWrite.setColumns.length + 1}, statement)
                stepDone(statement, "${operation.spec.name} also-set", isWrite = true)
                check(readChanges() == 1L) {
                    "Generated ${operation.spec.name} also-set changed an unexpected row count"
                }
            }`;
}

function kotlinOwnerSourcedInsertMethod(
  table: NormalizedTable,
  operation: NormalizedOperation,
): string {
  const resultType = ownerSourcedInsertResultType(table);
  const params = ownerSourcedInsertParams(table, operation);
  const binds = ownerSourcedInsertBinds(table, operation)
    .map(({ column, expression }, index) =>
      // The owner is read inside this transaction and bound as a plain non-null string;
      // `validateNullableColumns` rejects a nullable `into` column, so the owner arm never
      // needs the optional binder.
      expression === "owner"
        ? kotlinBind("String", "owner", index + 1, 16)
        : kotlinColumnBind(
            column,
            operation.spec.allocateKey !== undefined &&
              column.name === table.slotColumnName
              ? "allocatedKey"
              : column.fieldName,
            index + 1,
            16,
          ),
    )
    .join("\n");
  return `${kotlinBlockSignature(operation.dbMethod, params, resultType)}
        assertNotMainThread("${operation.spec.name}")
        return withImmediateTransaction(${resultType}.Busy) {
            val owner =
                withStatement(${operation.kotlinOwnerReadConst}, "read current owner") { statement ->
                    bindInt64(SINGLETON_ID, 1, statement)
                    // An empty owner is the source's parked state and an absent row its
                    // never-written state. Either means NoCurrentOwner. A failed read or
                    // NULL owner instead throws rather than being recorded as
                    // "no current owner" - which would drop the row.
                    if (stepRowOrDone(statement, "read current owner")) {
                        requiredText(statement, 0, "read current owner")
                    } else {
                        ""
                    }
                }
            if (owner.isEmpty()) {
                return@withImmediateTransaction ${resultType}.NoCurrentOwner
            }${kotlinKeyAllocation(table, operation)}
            withStatement(${operation.kotlinSqlConst}, "${operation.spec.name}") { statement ->
${binds}
                stepDone(statement, "${operation.spec.name}", isWrite = true)
                check(readChanges() == 1L) {
                    "Generated ${operation.spec.name} changed an unexpected row count"
                }
            }${kotlinCoWriteBlock(operation)}
            ${resultType}.Recorded${operation.spec.allocateKey === undefined ? "" : "(allocatedKey)"}
        }
    }`;
}

// Typed statement binds for a delete predicate, one `?` per term in order: a
// branded term binds the caller's key value, an unbranded term the SINGLETON_ID
// constant.
// Typed statement binds for a predicate, one `?` per term from position 1 - the Kotlin
// twin of swiftPredicateBinds. Serves every operation whose statement takes no value
// binds ahead of the key: a keyed clear and a defaults reset, whose SET clause is all
// literals.
function kotlinPredicateBinds(
  table: NormalizedTable,
  predicate: LocalSQLitePredicateTerm[],
  indent: number,
): string {
  return predicate
    .map((term, index) => {
      const position = index + 1;
      if (term.brand === undefined) {
        return kotlinBind("Long", "SINGLETON_ID", position, indent);
      }
      const column = columnByName(table, term.column);
      return kotlinBind(
        column.kotlinType,
        `${column.fieldName}.value`,
        position,
        indent,
      );
    })
    .join("\n");
}

function kotlinClearMethod(
  table: NormalizedTable,
  operation: NormalizedOperation,
): string {
  const predicate = operation.effectivePredicate;
  const params = brandedReadParams(predicate);
  // A bounded-scan delete touches 0..N rows, so it returns the affected count for
  // the caller to log, with no one-row ceiling. A keyed clear touches at most one
  // row and reports only whether that row existed.
  if (operation.spec.boundedScanException !== undefined) {
    return `    fun ${operation.dbMethod}(${params}): Long {
        assertNotMainThread("${operation.spec.name}")
        return withStatement(${operation.kotlinSqlConst}, "${operation.spec.name}") { statement ->
${kotlinPredicateBinds(table, predicate, 12)}
            stepDone(statement, "${operation.spec.name}", isWrite = true)
            readChanges()
        }
    }`;
  }
  return `    fun ${operation.dbMethod}(${params}): Boolean {
${kotlinCountedWrite(operation, kotlinPredicateBinds(table, predicate, 16))}
    }`;
}

// Compare-and-set update. Re-reads the keyed row's version inside one BEGIN
// IMMEDIATE, applies the mutation only on a match, and otherwise returns stale (with
// the observed version) or missing. Binds `setColumns` first, then the effective
// predicate in order: a branded non-version term binds the caller's key (the owner
// value on an owner-keyed table), an unbranded term is the fixed singleton slot, and
// the trailing generator-synthesized row_version term binds the caller's
// expectedVersion. That term-driven walk is what makes the same emitter serve either
// slot shape - the owner key is a bound value, so no identifier is interpolated
// either way.
function kotlinCasUpdateMethod(
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
      (column) => `        ${column.fieldName}: ${kotlinValueType(column)},`,
    ),
    ...keyColumns.map(
      (column) => `        ${column.fieldName}: ${column.brand},`,
    ),
    `        expectedVersion: ${table.expectedVersionBrand},`,
  ].join("\n");
  const setCount = operation.setColumns.length;
  const binds = [
    ...operation.setColumns.map((column, index) =>
      kotlinColumnBind(column, column.fieldName, index + 1, 20),
    ),
    ...predicate.map((term, index) => {
      const position = setCount + index + 1;
      if (term.column === VERSION_COLUMN) {
        return kotlinBind("Long", "expectedVersion.value", position, 20);
      }
      if (term.brand === undefined) {
        return kotlinBind("Long", "SINGLETON_ID", position, 20);
      }
      const column = columnByName(table, term.column);
      return kotlinBind(
        column.kotlinType,
        `${column.fieldName}.value`,
        position,
        20,
      );
    }),
  ].join("\n");
  const versionReaderArgs = keyColumns
    .map((column) => `${column.fieldName} = ${column.fieldName}`)
    .join(", ");
  return `    fun ${operation.dbMethod}(
${params}
    ): ${table.casResultType} =
        withImmediateTransaction(${table.casResultType}.Busy) {
            val observedVersion = ${table.versionReader}(${versionReaderArgs})
            if (observedVersion == null) {
                return@withImmediateTransaction ${table.casResultType}.Missing
            }
            if (observedVersion.value != expectedVersion.value) {
                return@withImmediateTransaction ${table.casResultType}.Stale(observedVersion)
            }
            val changedRows =
                withStatement(${operation.kotlinSqlConst}, "${operation.spec.name}") { statement ->
${binds}
                    stepDone(statement, "${operation.spec.name}", isWrite = true)
                    readChanges()
                }
            check(changedRows == 1L) {
                "Generated ${operation.spec.name} changed $changedRows rows " +
                    "after matching the version"
            }
            ${table.casResultType}.Applied
        }`;
}

export function kotlinOperationsObject(table: NormalizedTable): string {
  const methods = table.operations
    .map((operation) => kotlinApiMethod(table, operation))
    .join("\n\n");
  return `object ${table.typePrefix}Operations {
${methods}
}`;
}

function kotlinApiMethod(
  table: NormalizedTable,
  operation: NormalizedOperation,
): string {
  const predicate = operation.effectivePredicate;
  // Assembles the parameter list: `database` first, then each pre-rendered block of
  // `name: Brand,` lines. Empty blocks are dropped rather than interpolated - a
  // singleton operation binds its `singleton_id` slot internally and so contributes no
  // lines, and a blank line inside a parameter list is not Spotless/ktlint-clean.
  const paramList = (...blocks: string[]): string =>
    [
      "        database: GeneratedLocalSQLiteDatabase,",
      ...blocks.filter((block) => block !== ""),
    ].join("\n");
  switch (operation.category) {
    case "read": {
      if (brandedReadParams(predicate) === "") {
        return `    fun ${operation.apiMethod}(database: GeneratedLocalSQLiteDatabase): ${table.rowType}? = database.${operation.dbMethod}()`;
      }
      return `    fun ${operation.apiMethod}(
        database: GeneratedLocalSQLiteDatabase,
${brandedReadParamLines(predicate, 8)}
    ): ${table.rowType}? = database.${operation.dbMethod}(${brandedReadArgNames(predicate)})`;
    }
    case "insert": {
      const insertColumns = [
        ...keyedSlotParams(table),
        ...table.settableColumns,
      ];
      const insertParams = insertColumns
        .map(
          (column) =>
            `        ${column.fieldName}: ${kotlinValueType(column)},`,
        )
        .join("\n");
      const insertArgs = insertColumns
        .map((column) => column.fieldName)
        .join(", ");
      return `    fun ${operation.apiMethod}(
        database: GeneratedLocalSQLiteDatabase,
${insertParams}
    ): ${table.versionColumn.brand} = database.${operation.dbMethod}(${insertArgs})`;
    }
    case "insertForCurrentOwner": {
      const columns = ownerSourcedInsertParams(table, operation);
      return `    fun ${operation.apiMethod}(
${paramList(columns.map((column) => `        ${column.fieldName}: ${kotlinValueType(column)},`).join("\n"))}
    ): ${ownerSourcedInsertResultType(table)} = database.${operation.dbMethod}(${columns.map((column) => column.fieldName).join(", ")})`;
    }
    case "ensure": {
      const ensureColumns = keyedSlotParams(table);
      const ensureParams = ensureColumns
        .map((column) => `        ${column.fieldName}: ${column.brand},`)
        .join("\n");
      const ensureArgs = ensureColumns
        .map((column) => column.fieldName)
        .join(", ");
      if (ensureParams === "") {
        return `    fun ${operation.apiMethod}(database: GeneratedLocalSQLiteDatabase): Boolean = database.${operation.dbMethod}()`;
      }
      return `    fun ${operation.apiMethod}(
${paramList(ensureParams)}
    ): Boolean = database.${operation.dbMethod}(${ensureArgs})`;
    }
    case "clear":
      if (operation.spec.deleteSummary !== undefined) {
        return `    fun ${operation.apiMethod}(
${paramList(brandedReadParamLines(predicate, 8))}
    ): LocalSQLiteDeleteResult = database.${operation.dbMethod}(${brandedReadArgNames(predicate)})`;
      }
      // A bounded-scan delete takes the caller's key and returns the affected
      // count; a keyed clear takes its predicate key and returns whether that one
      // row was present.
      if (operation.spec.boundedScanException !== undefined) {
        return `    fun ${operation.apiMethod}(
        database: GeneratedLocalSQLiteDatabase,
${brandedReadParamLines(predicate, 8)}
    ): Long = database.${operation.dbMethod}(${brandedReadArgNames(predicate)})`;
      }
      if (brandedReadParams(predicate) === "") {
        return `    fun ${operation.apiMethod}(database: GeneratedLocalSQLiteDatabase): Boolean = database.${operation.dbMethod}()`;
      }
      return `    fun ${operation.apiMethod}(
${paramList(brandedReadParamLines(predicate, 8))}
    ): Boolean = database.${operation.dbMethod}(${brandedReadArgNames(predicate)})`;
    case "casUpdate": {
      // Same shape as columnSet plus the trailing expectedVersion: the set columns,
      // then the branded key terms (the owner value on an owner-keyed table, nothing
      // on a singleton, whose slot the database method binds internally).
      const casSetParamLines = operation.setColumns
        .map(
          (column) =>
            `        ${column.fieldName}: ${kotlinValueType(column)},`,
        )
        .join("\n");
      const casKeyParamLines = predicate
        .filter(
          (term) => term.brand !== undefined && term.column !== VERSION_COLUMN,
        )
        .map(
          (term) =>
            `        ${toCamelCase(term.parameter ?? term.column)}: ${term.brand},`,
        )
        .join("\n");
      const casCallArgs = [
        ...operation.setColumns.map((column) => column.fieldName),
        ...predicate
          .filter(
            (term) =>
              term.brand !== undefined && term.column !== VERSION_COLUMN,
          )
          .map((term) => toCamelCase(term.parameter ?? term.column)),
        "expectedVersion",
      ].join(", ");
      return `    fun ${operation.apiMethod}(
${paramList(casSetParamLines, casKeyParamLines, `        expectedVersion: ${table.expectedVersionBrand},`)}
    ): ${table.casResultType} = database.${operation.dbMethod}(${casCallArgs})`;
    }
    case "columnSet": {
      const setParamLines = operation.setColumns
        .map(
          (column) =>
            `        ${column.fieldName}: ${kotlinValueType(column)},`,
        )
        .join("\n");
      const keyArgs = brandedReadArgNames(predicate);
      const callArgs = [
        ...operation.setColumns.map((column) => column.fieldName),
        keyArgs,
      ]
        .filter((arg) => arg.length > 0)
        .join(", ");
      return `    fun ${operation.apiMethod}(
${paramList(setParamLines, brandedReadParamLines(predicate, 8))}
    ): Boolean = database.${operation.dbMethod}(${callArgs})`;
    }
    case "defaultsReset":
      // Takes the row key and nothing else: the values are compiled into the
      // statement, so there is no argument a caller could get wrong.
      if (brandedReadParams(predicate) === "") {
        return `    fun ${operation.apiMethod}(database: GeneratedLocalSQLiteDatabase): Boolean = database.${operation.dbMethod}()`;
      }
      return `    fun ${operation.apiMethod}(
${paramList(brandedReadParamLines(predicate, 8))}
    ): Boolean = database.${operation.dbMethod}(${brandedReadArgNames(predicate)})`;
  }
}
