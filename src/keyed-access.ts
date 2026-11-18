// Constrains queue successor reads and monotone updates to a single keyed row.
import type {
  LocalSQLiteOperationSpec,
  LocalSQLiteOperationTableSpec,
} from "./operation";

export function validateOrderedSuccessor(
  table: LocalSQLiteOperationTableSpec,
  operation: LocalSQLiteOperationSpec,
): void {
  const column = operation.orderedSuccessor?.column;
  const key = table.columns.find((candidate) => candidate.name === column);
  const [term] = operation.predicate ?? [];
  if (
    table.primaryKey.length !== 1 ||
    table.primaryKey[0] !== column ||
    table.keyedBy !== column ||
    key?.sqliteType !== "INTEGER" ||
    operation.predicate?.length !== 1 ||
    term?.column !== column ||
    term?.operator !== ">" ||
    term?.brand !== key.brand ||
    operation.orderedHead !== undefined ||
    operation.boundedScanException !== undefined
  ) {
    throw new Error(
      `${operation.name}: orderedSuccessor requires only a branded integer primary-key > cursor, with no other predicate or ordering`,
    );
  }
}

export function validateIntegerMaximum(
  table: LocalSQLiteOperationTableSpec,
  operation: LocalSQLiteOperationSpec,
): void {
  if (operation.integerMaximum === undefined) return;
  const [columnName] = operation.setColumns ?? [];
  const column = table.columns.find(
    (candidate) => candidate.name === columnName,
  );
  const [term] = operation.predicate ?? [];
  const key = table.columns.find(
    (candidate) => candidate.name === table.primaryKey[0],
  );
  if (
    operation.integerMaximum !== true ||
    operation.setColumns?.length !== 1 ||
    column?.sqliteType !== "INTEGER" ||
    column.nullable ||
    table.primaryKey.length !== 1 ||
    operation.predicate?.length !== 1 ||
    term?.column !== key?.name ||
    term?.operator !== "=" ||
    (table.keyedBy !== undefined && term?.brand !== key?.brand) ||
    operation.guard !== undefined ||
    operation.boundedScanException !== undefined
  ) {
    throw new Error(
      `${operation.name}: integerMaximum requires a non-null integer column and an exact primary-key update without guards`,
    );
  }
}
