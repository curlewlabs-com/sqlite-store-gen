// Owns the plain-column index declarations used by baseline DDL and ladder parity.
// Unique, partial and expression indexes have no authored shape here.
import { toCamelCase } from "./names";
import type { Database } from "bun:sqlite";
import type { LocalSQLiteSchemaTableSpec } from "./schema";

export interface LocalSQLiteIndexSpec {
  name: string;
  columns: string[];
}

export function validateIndexes(tables: LocalSQLiteSchemaTableSpec[]): void {
  const names = new Set(tables.map((table) => table.name));
  for (const table of tables) {
    for (const index of table.indexes ?? []) {
      if (
        typeof index.name !== "string" ||
        !/^[a-z][a-z0-9_]*$/.test(index.name) ||
        index.name.startsWith("sqlite_") ||
        names.has(index.name)
      ) {
        throw new Error(`Invalid or duplicate index name ${index.name}`);
      }
      names.add(index.name);
      if (
        Object.keys(index).some((key) => key !== "name" && key !== "columns") ||
        !Array.isArray(index.columns) ||
        index.columns.length === 0 ||
        new Set(index.columns).size !== index.columns.length ||
        index.columns.some(
          (name) => !table.columns.some((column) => column.name === name),
        )
      ) {
        throw new Error(
          `${index.name} requires distinct existing plain columns`,
        );
      }
    }
  }
}

export function createIndexStatement(
  table: string,
  index: LocalSQLiteIndexSpec,
): string {
  return `CREATE INDEX ${index.name} ON ${table} (${index.columns.join(", ")})`;
}

export function verifyIndexParity(
  database: Database,
  tables: LocalSQLiteSchemaTableSpec[],
): void {
  const expected = tables.flatMap((table) =>
    (table.indexes ?? []).map((index) => ({
      name: index.name,
      table: table.name,
      columns: index.columns,
    })),
  );
  const actual = database
    .query<{ name: string; tbl_name: string }, []>(
      "SELECT name, tbl_name FROM sqlite_schema WHERE type = 'index' AND sql IS NOT NULL ORDER BY name",
    )
    .all()
    .map((index) => ({
      name: index.name,
      table: index.tbl_name,
      columns: database
        .query<{ name: string }, [string]>(
          "SELECT name FROM pragma_index_info(?) ORDER BY seqno",
        )
        .all(index.name)
        .map((column) => column.name),
    }));
  expected.sort((left, right) => left.name.localeCompare(right.name));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Migration index shape differs from baseline: ${JSON.stringify(actual)}; expected ${JSON.stringify(expected)}`,
    );
  }
}

export function indexSqlConstant(
  index: LocalSQLiteIndexSpec,
  platform: "kotlin" | "swift",
): string {
  return platform === "kotlin"
    ? `${index.name.toUpperCase()}_SQL`
    : `${toCamelCase(index.name)}SQL`;
}
