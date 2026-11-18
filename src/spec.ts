// Compiles a spec file into the cross-table model consumed by the channel and native
// platform renderers.

import { readFile } from "node:fs/promises";
import { normalizeLocalSQLiteChannel } from "./channel";
import { validateLocalSQLiteOperation } from "./operation";
import { normalizeLocalSQLiteMigrations } from "./schema";
import {
  type LocalSQLiteRawSpec,
  type LocalSQLiteSpec,
  type NormalizedTable,
} from "./model";
import { normalizeLocalSQLiteTable, terminalNoun } from "./table";

import { validateKeyAllocation } from "./key-allocation";

import { validateIndexes } from "./indexes";

import { validateTableShape } from "./spec-shape";

const SUPPORTED_SPEC_VERSION = 3;

export function normalizeLocalSQLiteSpec(
  raw: LocalSQLiteRawSpec,
): LocalSQLiteSpec {
  if (raw.version !== SUPPORTED_SPEC_VERSION) {
    throw new Error(`Unsupported local SQLite spec version ${raw.version}`);
  }
  if (!Array.isArray(raw.tables) || raw.tables.length === 0) {
    throw new Error("Local SQLite spec must declare at least one table");
  }

  for (const table of raw.tables) {
    validateTableShape(table);
  }

  const liveTableNames = new Set<string>();
  const nouns = new Set<string>();
  for (const table of raw.tables) {
    if (liveTableNames.has(table.name)) {
      throw new Error(`Duplicate table ${table.name}`);
    }
    liveTableNames.add(table.name);
    // The noun labels a table's SQL constants and version reader; a collision
    // would emit duplicate constants and private readers under the same name.
    const noun = terminalNoun(table.name);
    if (nouns.has(noun)) {
      throw new Error(
        `Table ${table.name} derives noun "${noun}" already used by another table`,
      );
    }
    nouns.add(noun);
  }

  validateObsoleteTables(raw.obsoleteTables, liveTableNames);

  validateIndexes(raw.tables);
  const tables = raw.tables.map(normalizeLocalSQLiteTable);
  for (const table of tables) {
    for (const operation of table.spec.operations) {
      validateLocalSQLiteOperation(table.spec, table.columnNames, operation);
    }
  }
  resolveOwnerSources(tables);
  resolveCoWrites(tables);
  validateKeyAllocation(tables);

  // After the tables rather than before them: the ladder is replayed against the
  // shapes they declare, and only a normalized table says what the store a step
  // meets actually holds.
  const migrations = normalizeLocalSQLiteMigrations(
    raw.schemaVersion,
    raw.migrations,
    tables.map((table) => table.spec),
    raw.obsoleteTables,
  );

  const anyCas = tables.some((table) => table.hasCas);
  const anyTransaction =
    anyCas ||
    tables.some((table) =>
      table.operations.some(
        (operation) =>
          operation.category === "insertForCurrentOwner" ||
          operation.spec.deleteSummary !== undefined,
      ),
    );

  return {
    version: raw.version,
    schemaVersion: raw.schemaVersion,
    migrations,
    tables,
    obsoleteTables: raw.obsoleteTables,
    channel: normalizeLocalSQLiteChannel(raw.channel),
    anyTransaction,
  };
}

const OBSOLETE_TABLE_NAME_PATTERN = /^[a-z][a-z0-9_]*$/;

function validateObsoleteTables(
  obsoleteTables: string[],
  liveTableNames: Set<string>,
): void {
  if (!Array.isArray(obsoleteTables)) {
    throw new Error("obsoleteTables must be an array of table names");
  }
  const seen = new Set<string>();
  for (const name of obsoleteTables) {
    if (typeof name !== "string" || !OBSOLETE_TABLE_NAME_PATTERN.test(name)) {
      throw new Error(
        `obsoleteTables entry ${JSON.stringify(name)} must be a snake_case table name`,
      );
    }
    // Dropping a live table would delete production rows on every open;
    // obsoleteTables is strictly for schemas this build no longer owns.
    if (liveTableNames.has(name)) {
      throw new Error(`obsoleteTables must not include the live table ${name}`);
    }
    if (seen.has(name)) {
      throw new Error(`Duplicate obsolete table ${name}`);
    }
    seen.add(name);
  }
}

// Resolves every `insertForCurrentOwner`'s `ownerFrom` against the table it names, and
// rejects each way of getting it wrong - all of which would otherwise emit a transaction
// that reads as owner-scoped and is not one.
//
// The source must be a FIXED SINGLETON: the emitted owner read binds `SINGLETON_ID`, so
// an owner-keyed source would need a key this insert has no way to supply, and the read
// would silently answer from whichever row that bind happened to match. The value column
// must be TEXT and so must the target, because the owner is read through the text
// accessor and bound with the binder the TARGET column's type picks - so a non-TEXT
// target emits `bindLong`/`bindInt64` against a String and breaks the native build,
// while a non-TEXT source compiles and records that column's text form as the owner. And
// the target must be a settable column of the inserting table, because `into` names the
// column the transaction fills INSTEAD of from a caller parameter: aim it outside that
// set and the emitted insert keeps the owner read, keeps the no-current-owner branch, and
// still binds the caller's own value into the column the source was meant to fill.
function resolveOwnerSources(tables: NormalizedTable[]): void {
  const byName = new Map(tables.map((table) => [table.spec.name, table]));
  for (const table of tables) {
    for (const operation of table.operations) {
      const ownerFrom = operation.spec.ownerFrom;
      if (operation.category !== "insertForCurrentOwner") {
        if (ownerFrom !== undefined) {
          throw new Error(
            `${operation.spec.name} declares ownerFrom but is a ${operation.spec.kind}; only insertForCurrentOwner sources a column from another table`,
          );
        }
        continue;
      }
      if (ownerFrom === undefined) {
        throw new Error(
          `${operation.spec.name} is an insertForCurrentOwner and must declare ownerFrom`,
        );
      }
      const source = byName.get(ownerFrom.table);
      if (source === undefined) {
        throw new Error(
          `${operation.spec.name} sources its owner from unknown table ${ownerFrom.table}`,
        );
      }
      if (source.keyedSlot !== undefined) {
        throw new Error(
          `${operation.spec.name} sources its owner from owner-keyed table ${ownerFrom.table}; the emitted SELECT keys the source on its singleton slot, which an owner-keyed table has no fixed value for`,
        );
      }
      const valueColumn = source.allColumns.find(
        (column) => column.name === ownerFrom.column,
      );
      if (valueColumn === undefined) {
        throw new Error(
          `${operation.spec.name} sources unknown column ${ownerFrom.column} from ${ownerFrom.table}`,
        );
      }
      const intoColumn = table.settableColumns.find(
        (column) => column.name === ownerFrom.into,
      );
      if (intoColumn === undefined) {
        throw new Error(
          `${operation.spec.name} fills ${ownerFrom.into}, which is not a settable column of ${table.spec.name}`,
        );
      }
      if (
        valueColumn.sqliteType !== "TEXT" ||
        intoColumn.sqliteType !== "TEXT"
      ) {
        throw new Error(
          `${operation.spec.name} assigns ${ownerFrom.table}.${ownerFrom.column} to ${ownerFrom.into}; source and target must be TEXT, because a non-TEXT target binds a String through an integer binder (a native build failure) and a non-TEXT source records that column's text form as the owner`,
        );
      }
      operation.ownerSource = {
        tableName: source.spec.name,
        slotColumnName: source.slotColumnName,
        valueColumnName: valueColumn.name,
        intoColumn,
      };
    }
  }
}

// Resolves each `alsoSet` against the table it names, in the same second pass
// `resolveOwnerSources` runs and for the same reason: a per-table normalization cannot see
// the table it writes to.
//
// The rejections mirror the owner source's, because the emitted statement keys the target
// on its singleton slot exactly as that read does - an owner-keyed target has no fixed
// value to bind there. What is new is the target-is-not-this-table check: a co-write
// against the inserting table would make the source insert and co-write race the
// same row inside a shared transaction, which belongs in the insert's column list
// rather than a later write.
function resolveCoWrites(tables: NormalizedTable[]): void {
  const byName = new Map(tables.map((table) => [table.spec.name, table]));
  for (const table of tables) {
    for (const operation of table.operations) {
      const alsoSet = operation.spec.alsoSet;
      if (alsoSet === undefined) continue;
      const target = byName.get(alsoSet.table);
      if (target === undefined) {
        throw new Error(
          `${operation.spec.name} also-sets unknown table ${alsoSet.table}`,
        );
      }
      if (target.spec.name === table.spec.name) {
        throw new Error(
          `${operation.spec.name} also-sets its own table ${alsoSet.table}; a second write to the row being inserted is a column on that insert, not a statement beside it`,
        );
      }
      if (target.keyedSlot !== undefined) {
        throw new Error(
          `${operation.spec.name} also-sets owner-keyed table ${alsoSet.table}; the emitted UPDATE keys the target on its singleton slot, which an owner-keyed table has no fixed value for`,
        );
      }
      if (alsoSet.setColumns.length === 0) {
        throw new Error(
          `${operation.spec.name} declares an alsoSet on ${alsoSet.table} with no setColumns; an UPDATE that sets nothing is a statement with no effect inside a transaction that pays for it`,
        );
      }
      const setColumns = alsoSet.setColumns.map((name) => {
        const column = target.settableColumns.find(
          (candidate) => candidate.name === name,
        );
        if (column === undefined) {
          throw new Error(
            `${operation.spec.name} also-sets ${name}, which is not a settable column of ${alsoSet.table}`,
          );
        }
        return column;
      });
      operation.coWrite = {
        tableName: target.spec.name,
        slotColumnName: target.slotColumnName,
        setColumns,
      };
    }
  }
}

export async function loadRawLocalSQLiteSpec(
  path: string,
): Promise<LocalSQLiteRawSpec> {
  return JSON.parse(await readFile(path, "utf-8")) as LocalSQLiteRawSpec;
}

export async function loadLocalSQLiteSpec(
  path: string,
): Promise<LocalSQLiteSpec> {
  return normalizeLocalSQLiteSpec(await loadRawLocalSQLiteSpec(path));
}
