// Database-wide statistics policy follows the operations' access paths, so a
// declared range cannot silently remain on the primary-key-only open path.
import type { LocalSQLiteSpec, NormalizedTable } from "./model";

export function tableNeedsStatistics(table: NormalizedTable): boolean {
  return (
    table.spec.analyze ||
    table.spec.indexes.length > 0 ||
    table.spec.uniqueKeys.length > 0 ||
    table.operations.some(
      (operation) =>
        operation.spec.orderedSuccessor !== undefined ||
        operation.effectivePredicate.some((term) => term.operator !== "=") ||
        operation.spec.boundedScanException !== undefined,
    )
  );
}

export function databaseNeedsStatistics(spec: LocalSQLiteSpec): boolean {
  return spec.tables.some(tableNeedsStatistics);
}
