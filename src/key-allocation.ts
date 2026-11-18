// Transactional integer-key allocation for owner-sourced queue inserts. The key stays a
// plain integer primary key, so rows already stored keep theirs; a consumer that settles
// a row by key should also check its payload, because an emptied table can reuse a key
// after the caller's clock moves backward.
import type {
  NormalizedColumn,
  NormalizedOperation,
  NormalizedTable,
} from "./model";

export function validateKeyAllocation(tables: NormalizedTable[]): void {
  for (const table of tables) {
    const inserts = table.operations.filter(
      (op) => op.category === "insertForCurrentOwner",
    );
    if (!inserts.some((op) => op.spec.allocateKey !== undefined)) continue;
    if (table.keyedSlot?.sqliteType !== "INTEGER" || table.keyedSlot.nullable) {
      throw new Error(
        `${table.spec.name} allocated key must be a non-null integer primary key`,
      );
    }
    if (
      table.operations.some(
        (op) => op.category === "insert" || op.category === "ensure",
      ) ||
      inserts.some((op) => op.spec.allocateKey === undefined)
    ) {
      throw new Error(`${table.spec.name} every insert must allocate its key`);
    }
    for (const op of inserts) {
      const target = op.spec.allocateKey?.alsoSetColumn;
      if (target === undefined) continue;
      const column = op.coWrite?.setColumns.find(
        (column) => column.name === target,
      );
      if (column?.sqliteType !== "INTEGER" || column.nullable) {
        throw new Error(
          `${op.spec.name} allocated key co-write must name a non-null integer alsoSet column`,
        );
      }
    }
  }
}

// The key an allocating insert fills. validateKeyAllocation refuses allocateKey on a
// table with no keyed slot, so only a spec normalization did not produce reaches the throw.
export function allocatedKeyColumn(table: NormalizedTable): NormalizedColumn {
  if (table.keyedSlot === undefined) {
    throw new Error(
      `${table.spec.name} allocates a key but has no keyed slot; normalize the spec before rendering it`,
    );
  }
  return table.keyedSlot;
}

export function allocatedKeySql(table: NormalizedTable): string {
  const key = table.slotColumnName;
  // The reverse PK seek costs the same on a backlog as on an empty queue. The
  // supplied floor binds once; reusing its alias avoids rival bind positions.
  return `SELECT MAX(candidate, COALESCE((SELECT ${key} + 1
FROM ${table.spec.name} ORDER BY ${key} DESC LIMIT 1), candidate))
FROM (SELECT ? AS candidate)`;
}

export function swiftKeyAllocation(
  table: NormalizedTable,
  op: NormalizedOperation,
): string {
  if (op.spec.allocateKey === undefined) return "";
  const key = allocatedKeyColumn(table);
  const target = op.coWrite?.setColumns.find(
    (column) => column.name === op.spec.allocateKey?.alsoSetColumn,
  );
  return `
            let allocatedKey: ${key.brand} = try {
                let allocation = try prepare(sql: """
                    ${allocatedKeySql(table).replaceAll("\n", "\n                    ")}
                    """, operation: "allocate ${op.spec.name} key")
                defer { curlew_sqlite3_finalize(allocation) }
                try bindInt64(${key.fieldName}.value, at: 1, statement: allocation)
                let result = curlew_sqlite3_step(allocation)
                guard result == SQLITE_ROW else {
                    throw sqliteError(operation: "allocate key", resultCode: result, database: raw)
                }
                return ${key.brand}(value: curlew_sqlite3_column_int64(allocation, 0))
            }()${
              target === undefined
                ? ""
                : `
            let ${target.fieldName} = ${target.brand}(value: allocatedKey.value)`
            }`;
}

export function kotlinKeyAllocation(
  table: NormalizedTable,
  op: NormalizedOperation,
): string {
  if (op.spec.allocateKey === undefined) return "";
  const key = allocatedKeyColumn(table);
  const target = op.coWrite?.setColumns.find(
    (column) => column.name === op.spec.allocateKey?.alsoSetColumn,
  );
  return `
            val allocatedKey = withStatement("""
                ${allocatedKeySql(table).replaceAll("\n", "\n                ")}
                """, "allocate ${op.spec.name} key") { allocation ->
                bindInt64(${key.fieldName}.value, 1, allocation)
                check(stepRowOrDone(allocation, "allocate key")) { "Key allocation returned no row" }
                ${key.brand}(CurlewSQLite.nativeColumnInt64(allocation, 0))
            }${
              target === undefined
                ? ""
                : `
            val ${target.fieldName} = ${target.brand}(allocatedKey.value)`
            }`;
}
