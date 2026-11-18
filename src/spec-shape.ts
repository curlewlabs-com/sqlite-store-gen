// Owns the run-time type checks of a spec's table, column and operation fields. A spec
// arrives as JSON, which the TypeScript interfaces describe but do not enforce, so each
// field normalization reads is checked here to have its declared type first. Without
// this a mistyped field is read as whatever JavaScript makes of it: a misspelled
// `sqliteType` is given an integer type, a string `nullable` reads as true, and a
// fractional default is emitted as the literal of an INTEGER column.

import type { LocalSQLiteTableSpec } from "./model";
import type { LocalSQLiteOperationSpec } from "./operation";
import type { LocalSQLiteColumnSpec } from "./schema";

const SNAKE_CASE_NAME = /^[a-z][a-z0-9_]*$/;
// A brand is emitted as a Kotlin value class and a Swift struct of that name.
const BRAND_NAME = /^[A-Z][A-Za-z0-9]*$/;
const SQLITE_TYPES: readonly string[] = ["INTEGER", "TEXT"];
const OPERATION_KINDS: readonly string[] = [
  "read",
  "insert",
  "insertForCurrentOwner",
  "ensure",
  "update",
  "casUpdate",
  "delete",
  "resetToDefaults",
];
const PREDICATE_OPERATORS: readonly string[] = [
  "=",
  "<>",
  ">",
  "<",
  ">=",
  "<=",
];
// Every field of a bounded scan exception is the record that admits an unindexed
// operation, so none may be missing or empty.
const BOUNDED_SCAN_EXCEPTION_FIELDS: readonly string[] = [
  "hardRowBound",
  "caller",
  "ordering",
  "diagnostic",
];

function shown(value: unknown): string {
  return value === undefined ? "nothing" : JSON.stringify(value);
}

function requireString(value: unknown, what: string): void {
  if (typeof value !== "string") {
    throw new Error(`${what} must be a string (got ${shown(value)})`);
  }
}

function requireBoolean(value: unknown, what: string): void {
  if (typeof value !== "boolean") {
    throw new Error(`${what} must be a boolean (got ${shown(value)})`);
  }
}

function requireMatch(value: unknown, pattern: RegExp, what: string): void {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new Error(`${what} must match ${pattern} (got ${shown(value)})`);
  }
}

function requireOneOf(
  value: unknown,
  allowed: readonly string[],
  what: string,
): void {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new Error(
      `${what} must be one of ${allowed.join(", ")} (got ${shown(value)})`,
    );
  }
}

function requireArray(value: unknown, what: string): void {
  if (!Array.isArray(value)) {
    throw new Error(`${what} must be an array (got ${shown(value)})`);
  }
}

export function validateTableShape(table: LocalSQLiteTableSpec): void {
  requireMatch(table.name, SNAKE_CASE_NAME, "a table name");
  requireString(table.doc, `${table.name} doc`);
  requireBoolean(table.analyze, `${table.name} analyze`);
  requireArray(table.primaryKey, `${table.name} primaryKey`);
  requireArray(table.uniqueKeys, `${table.name} uniqueKeys`);
  requireArray(table.indexes, `${table.name} indexes`);
  requireArray(table.columns, `${table.name} columns`);
  requireArray(table.operations, `${table.name} operations`);
  if (table.keyedBy !== undefined) {
    requireString(table.keyedBy, `${table.name} keyedBy`);
  }
  if (table.operationBrands !== undefined) {
    requireMatch(
      table.operationBrands.expectedVersion,
      BRAND_NAME,
      `${table.name} operationBrands.expectedVersion`,
    );
  }
  for (const column of table.columns) {
    validateColumnShape(table.name, column);
  }
  for (const operation of table.operations) {
    validateOperationShape(table.name, operation);
  }
}

function validateColumnShape(
  tableName: string,
  column: LocalSQLiteColumnSpec,
): void {
  requireMatch(column.name, SNAKE_CASE_NAME, `a ${tableName} column name`);
  const what = `${tableName}.${column.name}`;
  requireOneOf(column.sqliteType, SQLITE_TYPES, `${what} sqliteType`);
  requireBoolean(column.nullable, `${what} nullable`);
  requireMatch(column.brand, BRAND_NAME, `${what} brand`);
  if (column.check !== undefined) {
    requireString(column.check, `${what} check`);
  }
  // The type a default must have for its column is normalizeColumn's check; what is
  // left here is the one an INTEGER column adds, a whole number SQLite can store.
  if (
    column.sqliteType === "INTEGER" &&
    typeof column.default === "number" &&
    !Number.isSafeInteger(column.default)
  ) {
    throw new Error(
      `${what} default must be an integer within 2^53 for an INTEGER column (got ${column.default})`,
    );
  }
}

function validateOperationShape(
  tableName: string,
  operation: LocalSQLiteOperationSpec,
): void {
  requireMatch(
    operation.name,
    SNAKE_CASE_NAME,
    `a ${tableName} operation name`,
  );
  requireOneOf(operation.kind, OPERATION_KINDS, `${operation.name} kind`);
  if (operation.predicate !== undefined) {
    requireArray(operation.predicate, `${operation.name} predicate`);
    for (const term of operation.predicate) {
      const what = `${operation.name} predicate term on ${shown(term.column)}`;
      requireString(term.column, `${operation.name} predicate column`);
      requireOneOf(term.operator, PREDICATE_OPERATORS, `${what} operator`);
      if (term.brand !== undefined) {
        requireMatch(term.brand, BRAND_NAME, `${what} brand`);
      }
    }
  }
  const exception: unknown = operation.boundedScanException;
  if (exception !== undefined) {
    const what = `${operation.name} boundedScanException`;
    if (typeof exception !== "object" || exception === null) {
      throw new Error(`${what} must be an object (got ${shown(exception)})`);
    }
    for (const key of Object.keys(exception)) {
      if (!BOUNDED_SCAN_EXCEPTION_FIELDS.includes(key)) {
        throw new Error(`${what} declares unknown field ${key}`);
      }
    }
    for (const field of BOUNDED_SCAN_EXCEPTION_FIELDS) {
      const value: unknown = (exception as Record<string, unknown>)[field];
      if (typeof value !== "string" || value.trim() === "") {
        throw new Error(
          `${what} must declare a non-empty ${field} (got ${shown(value)})`,
        );
      }
    }
  }
}
