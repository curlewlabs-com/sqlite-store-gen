// Compiles language-neutral local-SQLite SQL fragments and operation
// parameter shapes consumed by the Kotlin and Swift renderers.

import { toCamelCase } from "./names";
import {
  VERSION_COLUMN,
  type NormalizedBootstrapColumn,
  type NormalizedColumn,
  type NormalizedOperation,
  type NormalizedCoWrite,
  type NormalizedOwnerSource,
  type NormalizedTable,
} from "./model";
import type {
  LocalSQLiteGuardTerm,
  LocalSQLitePredicateTerm,
} from "./operation";
import {
  staticSqlLiteral,
  type LocalSQLiteColumnSpec,
  type SQLiteColumnType,
} from "./schema";

export function bootstrapSqlLiteral(column: NormalizedBootstrapColumn): string {
  return staticSqlLiteral(column.sqliteType, column.value);
}

// A migration statement emitted as a double-quoted string literal that is valid in
// Kotlin and Swift. normalizeLocalSQLiteMigrations already forbids the
// characters that
// would break this (a bind '?', a Kotlin-interpolating '$'); JSON.stringify escapes
// the remainder (embedded quotes, backslashes, newlines) the same way Kotlin and
// Swift accept.
export function migrationStatementLiteral(statement: string): string {
  return JSON.stringify(statement);
}

// The VALUES entry for a column in an `ensure` INSERT OR IGNORE: the slot binds the
// caller's owner (`?`), row_version seeds at the literal 1, and every settable
// column seeds its reviewed per-column default as a literal (never a bind - the
// ensure method supplies only the slot). The table compiler has already required a
// default on every settable column of an ensure table; the throw here is a
// defensive invariant, not a reachable spec error.
export function ensureValuesPlaceholder(
  table: NormalizedTable,
  column: LocalSQLiteColumnSpec,
): string {
  if (column.name === VERSION_COLUMN) {
    return "1";
  }
  if (column.name === table.slotColumnName) {
    return "?";
  }
  if (column.default === undefined) {
    throw new Error(
      `${table.spec.name} ensure column ${column.name} has no default`,
    );
  }
  return staticSqlLiteral(column.sqliteType, column.default);
}

// The SET clause of a `resetToDefaults`, one assignment per line at `indent`: each
// derived target column assigned its declared default as a reviewed literal, never a
// bind, so the emitted statement's only parameter is the row key. One per line for the
// reason columnListLines gives - the joined form grows with the column count and
// re-trips each platform's 120-char lint the next time the table gains a column, which
// is the same edit this operation exists to cover for free.
//
// `row_version` is deliberately absent: the reset is a plain update like `columnSet`,
// and a version bump exists to order concurrent cross-process writers - a property of a
// compare-and-set tenant, not of returning a row to its seeded state.
//
// resolveResetColumns has already required a default on every target; the throw here is
// a defensive invariant, not a reachable spec error.
export function resetSetLines(
  operation: NormalizedOperation,
  indent: string,
): string {
  const assignments = operation.resetColumns.map((column) => {
    if (column.defaultValue === undefined) {
      throw new Error(
        `${operation.spec.name} reset column ${column.name} has no default`,
      );
    }
    return `${column.name} = ${staticSqlLiteral(column.sqliteType, column.defaultValue)}`;
  });
  return assignments
    .map(
      (assignment, i) =>
        `${indent}${assignment}${i < assignments.length - 1 ? "," : ""}`,
    )
    .join("\n");
}

// The bound terms first, then any guard literals. Order is the emitted text's only, not
// the planner's, but keeping the binds contiguous and leading is what lets a reader match
// the `?`s against the bind sequence the emitters generate from `effectivePredicate`
// alone - the guards contribute no binds at all.
export function whereClause(
  predicate: LocalSQLitePredicateTerm[],
  guard: LocalSQLiteGuardTerm[] = [],
  columnTypes: Map<string, SQLiteColumnType> = new Map(),
): string {
  const bound = predicate.map((term) => `${term.column} ${term.operator} ?`);
  const guarded = guard.map((term) => {
    const sqliteType = columnTypes.get(term.column);
    if (sqliteType === undefined) {
      throw new Error(`guard references unknown column ${term.column}`);
    }
    return `${term.column} = ${staticSqlLiteral(sqliteType, term.value)}`;
  });
  return [...bound, ...guarded].join(" AND ");
}

// The WHERE an update renders: its bound predicate, plus any guard literals resolved
// against the table's own column types. The Kotlin and Swift emitters call this rather than
// `whereClause` directly, so a guard cannot reach one language's statement and not the
// other's - the failure that would make Kotlin and Swift disagree about whether a claim
// is atomic.
export function updateWhereClause(
  table: NormalizedTable,
  operation: NormalizedOperation,
): string {
  return whereClause(
    operation.effectivePredicate,
    operation.spec.guard ?? [],
    new Map(table.allColumns.map((column) => [column.name, column.sqliteType])),
  );
}

// Everything a read's SELECT carries after its FROM, at the caller's indent: the keyed
// WHERE, or - for an `orderedHead` read - the primary-key seek that replaces it. The Kotlin
// and Swift emitters render this so they cannot disagree about which shape a read got.
//
// `ORDER BY <pk> ASC LIMIT 1` reports as a scan and does not read like one:
// validateOrderedHead has already proved the column is the table's single-column primary
// key, so the ordering is one the key's own b-tree already satisfies - no sorter runs,
// and the statement halts after the first row. The Android and iOS native suites read the plan back and
// assert the sorter's absence rather than taking that on faith.
export function readTail(
  operation: NormalizedOperation,
  indent: string,
): string {
  const successor = operation.spec.orderedSuccessor;
  if (successor !== undefined) {
    return `${indent}WHERE ${whereClause(operation.effectivePredicate)}\n${indent}ORDER BY ${successor.column} ASC\n${indent}LIMIT 1`;
  }
  const orderedHead = operation.spec.orderedHead;
  if (orderedHead !== undefined) {
    return `${indent}ORDER BY ${orderedHead.column} ASC\n${indent}LIMIT 1`;
  }
  return `${indent}WHERE ${whereClause(operation.effectivePredicate)}`;
}

// Resolves a predicate term's column so a bind can pick the right type-specific
// binder. Validation has already proved the column exists on the table.
export function columnByName(
  table: NormalizedTable,
  name: string,
): NormalizedColumn {
  const column = table.allColumns.find((candidate) => candidate.name === name);
  if (column === undefined) {
    throw new Error(`${table.spec.name} has no column ${name}`);
  }
  return column;
}

// Renders a SQL column list, or the VALUES list beside one, one entry per line at
// `indent`. Width-independent by
// construction: a joined single line grows with the column count and re-trips the Swift
// 120-char lint every time a table gains a column. The width must remain stable as a
// table grows; SQLite ignores the newlines.
export function columnListLines(names: string[], indent: string): string {
  return names
    .map((name, i) => `${indent}${name}${i < names.length - 1 ? "," : ""}`)
    .join("\n");
}

// Prefixes every line of a multi-line SQL block with `indent`, so a shared statement
// renders at each platform emitter's own nesting depth.
export function indentBlock(block: string, indent: string): string {
  return block
    .split("\n")
    .map((line) => `${indent}${line}`)
    .join("\n");
}

// The declared type of a nullable column wherever it is named as a value: an OPTIONAL
// brand, never an optional inside the brand. The brand keeps meaning "a value of this
// column's type", and the optionality sits outside it, so a caller writes
// `pushId: nil` for absent and cannot construct a brand that means nothing. Every
// platform takes the same shape, which is why the Swift and Kotlin helpers sit together
// here rather than one per renderer.
//
// Only the value positions are optional. A predicate term never reaches these -
// `validateNullableColumns` rejects a predicate or guard on a nullable column, because
// SQL equality against NULL matches nothing.
export function swiftValueType(column: NormalizedColumn): string {
  return column.nullable ? `${column.brand}?` : column.brand;
}

export function kotlinValueType(column: NormalizedColumn): string {
  return column.nullable ? `${column.brand}?` : column.brand;
}

export function brandedReadParams(
  predicate: LocalSQLitePredicateTerm[],
): string {
  return predicate
    .filter((term) => term.brand !== undefined)
    .map(
      (term) => `${toCamelCase(term.parameter ?? term.column)}: ${term.brand}`,
    )
    .join(", ");
}
// Method parameters for an owner-keyed table lead with the slot key; a singleton
// binds SINGLETON_ID and takes no slot parameter.
export function keyedSlotParams(table: NormalizedTable): NormalizedColumn[] {
  return table.keyedSlot === undefined ? [] : [table.keyedSlot];
}
// An `insertForCurrentOwner` reads the source's owner and then inserts with it inside
// BEGIN IMMEDIATE. The Kotlin and Swift emitters render these statements so the
// platforms cannot disagree about what the insert commits.
//
// A transaction rather than one clever `INSERT ... SELECT`, and that is a legibility
// call rather than a correctness one - the transaction and the single statement are atomic. What the transaction buys is that
// the guarantee is written down instead of deduced from SQLite's statement semantics, and
// that "no current owner" is a value the code branches on rather than zero selected
// rows. It is also the shape every other decision that depends on state read first
// takes here (the compare-and-set update), so a reader meets one pattern instead of
// two.
export function ownerSourceReadSql(operation: NormalizedOperation): string {
  const source = requireOwnerSource(operation);
  return `SELECT ${source.valueColumnName}
FROM ${source.tableName}
WHERE ${source.slotColumnName} = ?`;
}

// The second write an `insertForCurrentOwner` may run inside its own transaction: an
// UPDATE against another singleton table, keyed on that table's own slot. The Kotlin
// and Swift emitters render this so the platforms cannot disagree about what it commits.
export function coWriteUpdateSql(operation: NormalizedOperation): string {
  const coWrite = requireCoWrite(operation);
  const assignments = coWrite.setColumns
    .map((column) => `${column.name} = ?`)
    .join(",\n    ");
  return `UPDATE ${coWrite.tableName}
SET ${assignments}
WHERE ${coWrite.slotColumnName} = ?`;
}

export function requireCoWrite(
  operation: NormalizedOperation,
): NormalizedCoWrite {
  const coWrite = operation.coWrite;
  if (coWrite === undefined) {
    throw new Error(
      `${operation.spec.name} has no resolved co-write; resolveCoWrites must run before emission`,
    );
  }
  return coWrite;
}

export function requireOwnerSource(
  operation: NormalizedOperation,
): NormalizedOwnerSource {
  const source = operation.ownerSource;
  if (source === undefined) {
    throw new Error(
      `${operation.spec.name} has no resolved owner source; resolveOwnerSources must run before emission`,
    );
  }
  return source;
}

// The columns an `insertForCurrentOwner` binds from the caller: every settable column
// except the one the transaction fills from the source row, plus the key. The sourced
// column is still bound - by the read's result, at its declared position - so the bind
// order below follows the table's own column order rather than this list.
export function ownerSourcedInsertParams(
  table: NormalizedTable,
  operation: NormalizedOperation,
): NormalizedColumn[] {
  const into = requireOwnerSource(operation).intoColumn.name;
  return [
    ...keyedSlotParams(table),
    ...table.settableColumns.filter((column) => column.name !== into),
    // The co-write's own columns, last and in declared order, so the caller passes what
    // the row takes before what the second statement takes. They are a different table's
    // columns, so they cannot collide with the names above.
    ...(operation.coWrite?.setColumns ?? []).filter(
      (column) => column.name !== operation.spec.allocateKey?.alsoSetColumn,
    ),
  ];
}

// Bind positions for the insert, in the statement's own column order: the sourced column
// takes the owner the transaction just read, every other takes its caller parameter.
export function ownerSourcedInsertBinds(
  table: NormalizedTable,
  operation: NormalizedOperation,
): { column: NormalizedColumn; expression: "owner" | "param" }[] {
  const into = requireOwnerSource(operation).intoColumn.name;
  const bound = [...keyedSlotParams(table), ...table.settableColumns];
  return bound.map((column) => ({
    column,
    expression: column.name === into ? "owner" : "param",
  }));
}

// The result an `insertForCurrentOwner` hands back. RECORDED, NO_OWNER, and BUSY rather
// than a Bool, because the caller's answers are genuinely different: it recorded, there was no
// current owner to record for, or the write lost the contention budget. Collapsing the
// last two would tell a fail-open caller that there is no current owner when the truth is that
// the store was busy.
export function hasOwnerSourcedInsert(table: NormalizedTable): boolean {
  return table.operations.some(
    (operation) => operation.category === "insertForCurrentOwner",
  );
}

export function ownerSourcedInsertResultType(table: NormalizedTable): string {
  return `${table.typePrefix}InsertResult`;
}

// The Swift copy of a column-set UPDATE puts its `SET` this far in, and generated Swift is
// held to the same 120-char line_length lint as hand-written Swift. The Kotlin copy sits
// deeper, but ktlint does not read the generated Kotlin.
const SWIFT_SET_LINE_PREFIX = "        SET ";
const SWIFT_LINE_LIMIT = 120;

// The SET clause of a column-set UPDATE: `SET a = ?, b = ?` on one line where the Swift
// copy fits the lint, else `SET` alone with one assignment per line under it. The joined
// form grows with the operation's columns, and wrapping only past the limit leaves every statement that
// fits byte-identical. Decided once, on the linted Swift line, so the Kotlin and Swift
// copies of a statement always take the same shape.
export function columnSetLines(
  operation: NormalizedOperation,
  setIndent: string,
  assignmentIndent: string,
): string {
  const assignments = operation.setColumns.map((column) =>
    operation.spec.integerMaximum
      ? `${column.name} = MAX(${column.name}, ?)`
      : `${column.name} = ?`,
  );
  const joined = assignments.join(", ");
  if (SWIFT_SET_LINE_PREFIX.length + joined.length <= SWIFT_LINE_LIMIT) {
    return `${setIndent}SET ${joined}`;
  }
  return [
    `${setIndent}SET`,
    ...assignments.map(
      (assignment, i) =>
        `${assignmentIndent}${assignment}${i < assignments.length - 1 ? "," : ""}`,
    ),
  ].join("\n");
}
