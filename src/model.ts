// Defines the authored local-SQLite spec and the resolved generator model.
// The spec and table compilers produce this state for the platform renderers.

import type { LocalSQLiteChannelSpec, NormalizedChannel } from "./channel";
import type {
  LocalSQLiteOperationSpec,
  LocalSQLiteOperationTableSpec,
  LocalSQLitePredicateTerm,
} from "./operation";
import type {
  LocalSQLiteColumnSpec,
  LocalSQLiteMigrationStep,
  NormalizedMigrationStep,
  SQLiteColumnType,
} from "./schema";

export interface LocalSQLiteTableSpec extends LocalSQLiteOperationTableSpec {
  doc: string;
  analyze: boolean;
  operationBrands?: { expectedVersion: string };
  // Seed this table's singleton row on the baseline create, INSERT OR IGNORE, at the
  // same values `ensure` uses: the slot column and `row_version` at 1, every other
  // column at its declared default. Values are derived rather than authored here, so
  // the ensure and reset seeders cannot disagree and a new column needs no edit but its own.
  //
  // Seeding here rather than at each caller is what lets an accessor be only what it
  // says it is: the row exists before any operation runs, so a reader needs no
  // ordering discipline, a write cannot be lost to a not-yet-created row, and a
  // compare-and-set is always an update of an existing row rather than an
  // insert-on-absent a stale write could use to resurrect a cleared value.
  //
  // It runs on the baseline create only. A store already stamped at a version returns
  // early from the version gate and never reaches that path, so adding a bootstrap to
  // a table that already ships owes a ladder step seeding the same row.
  bootstrapRow?: boolean;
}

export interface LocalSQLiteRawSpec {
  version: number;
  // The on-device DB schema version stamped into PRAGMA user_version. The provider's
  // first tracked baseline is version 1; each later schema change increments it and
  // adds the matching migrations[] step.
  schemaVersion: number;
  // Ordered forward-migration ladder (toVersion 2..schemaVersion, contiguous).
  // Empty until the schema first evolves; a fresh install never runs it.
  migrations: LocalSQLiteMigrationStep[];
  tables: LocalSQLiteTableSpec[];
  // Tables from an older schema shape that this build must reclaim: the baseline create
  // (untracked -> the current schemaVersion) drops each on the way to the live tables, so
  // an older build's at-rest rows are freed. A one-time untracked->baseline cleanup
  // recorded by the version stamp, not re-run per open (see createSchema).
  obsoleteTables: string[];
  // The Dart/native method-channel surface. Declared rather than derived from the
  // tables above: the channel is a projection of the operation set (one row read
  // can back several per-column reads), and its strings are a contract with every
  // shipped build, so a column rename must not be able to move one.
  channel: LocalSQLiteChannelSpec;
}

// ---------------------------------------------------------------------------
// Normalized model - the per-table naming the Kotlin/Swift renderers consume.
// `typePrefix` (PascalCase of the full table name, e.g. ReaderProfile) names the
// row type, the operations object, the cursor mapper, and the CAS result type.
// `noun` (the table's terminal slug segment, e.g. profile) names the per-table SQL
// constants, the private version reader, and its diagnostics. The noun is an
// intrinsic per-table label rather than a disambiguator, so a table keeps it even
// when it is the only one.
// ---------------------------------------------------------------------------

// `columnSet` is an owner-keyed, non-CAS update that writes only its named columns
// (`setColumns`), never the whole row - so a consumer's write to its own column
// cannot clobber a sibling consumer's column on the shared owner-keyed row. It is the
// plain-update sibling of `casUpdate`, and which one a spec gets is decided by the
// declared `kind` alone. `columnSet` and `casUpdate` write only `setColumns`; the difference is that
// `casUpdate` gates the write on the caller's observed version and advances it, which
// is what orders concurrent writers from different processes against one another.
//
// `defaultsReset` is the derived-column sibling of `columnSet`: it sets every settable
// column not flagged `survivesReset` to that column's declared default, emitted as the
// same reviewed literal the `ensure` seeds rather than bound. Nothing about it is
// authored per-operation, so the emitted UPDATE binds only the row key.
export type OperationCategory =
  | "read"
  | "insert"
  | "insertForCurrentOwner"
  | "ensure"
  | "clear"
  | "casUpdate"
  | "columnSet"
  | "defaultsReset";

export interface NormalizedColumn {
  name: string;
  sqliteType: SQLiteColumnType;
  nullable: boolean;
  brand: string;
  check: string | undefined;
  // The reviewed constant an `ensure` seeds this column at (see LocalSQLiteColumnSpec);
  // undefined when the column declares none.
  defaultValue: string | number | undefined;
  // Whether the column opts out of the table's resetToDefaults (see
  // LocalSQLiteColumnSpec.survivesReset); false when the column declares nothing.
  survivesReset: boolean;
  fieldName: string;
  kotlinType: "String" | "Long";
  swiftType: "String" | "Int64";
}

// A resolved `ownerFrom`: which singleton row supplies which of this table's columns,
// with every identifier already checked against the source table's own spec. Resolved in
// a second pass over the whole spec, because a per-table normalization cannot see the
// table it reads from.
export interface NormalizedOwnerSource {
  tableName: string;
  slotColumnName: string;
  valueColumnName: string;
  intoColumn: NormalizedColumn;
}

// A resolved `alsoSet`: the singleton table a second write lands on inside the insert's
// own transaction, and which of its columns that write sets. Resolved in the same second
// pass `ownerFrom` is, and for the same reason - a per-table normalization cannot see the
// table it writes to.
export interface NormalizedCoWrite {
  tableName: string;
  slotColumnName: string;
  setColumns: NormalizedColumn[];
}

export interface NormalizedOperation {
  spec: LocalSQLiteOperationSpec;
  category: OperationCategory;
  // The predicate the emitters render and bind: the spec's authored terms, plus the
  // generator-synthesized compare-and-set term on a `casUpdate`. A spec cannot write
  // a version term itself (see rejectAuthoredVersionTerms), so this is the only
  // place one exists - render or bind `spec.predicate` and a CAS loses its version
  // check silently.
  effectivePredicate: LocalSQLitePredicateTerm[];
  dbMethod: string;
  apiMethod: string;
  kotlinSqlConst: string;
  swiftSqlConst: string;
  // The owner-read statement an `insertForCurrentOwner` runs first, inside its
  // transaction. A second constant rather than a second operation, because the read is
  // not reachable on its own - it exists only as this insert's first half.
  kotlinOwnerReadConst: string;
  swiftOwnerReadConst: string;
  // The private Swift function that runs the owner read. Named per operation because the
  // read is emitted beside its own insert rather than shared.
  swiftOwnerReadName: string;
  // The resolved, validated target columns of an update op - `columnSet` or
  // `casUpdate` (empty for every other category). The emitters bind these before the
  // predicate keys.
  setColumns: NormalizedColumn[];
  // The derived target columns of a `defaultsReset` - every settable column not
  // flagged `survivesReset`, in declared order (empty for every other category). Kept
  // apart from `setColumns` because these are NOT bound: each renders its declared
  // default as a SQL literal in the SET clause, so the emitted statement binds only
  // the row key.
  resetColumns: NormalizedColumn[];
  // The resolved `ownerFrom` of an `insertForCurrentOwner` (undefined everywhere else).
  ownerSource: NormalizedOwnerSource | undefined;
  // The resolved `alsoSet` of an `insertForCurrentOwner` that declares one (undefined
  // everywhere else, including on the inserts that do not).
  coWrite: NormalizedCoWrite | undefined;
  // The SQL constant for that second write, and the private Swift function that runs it. A
  // per-operation constant rather than a second operation, on the same terms the owner
  // read's is: the statement is not reachable on its own - it exists only as this insert's
  // second half - and giving it an operation would put a caller-callable marker write
  // beside the atomic one it exists to replace.
  kotlinCoWriteConst: string;
  swiftCoWriteConst: string;
  swiftCoWriteName: string;
}

export interface NormalizedBootstrapColumn {
  name: string;
  sqliteType: SQLiteColumnType;
  value: string | number;
}

export interface NormalizedTable {
  spec: LocalSQLiteTableSpec;
  columnNames: Set<string>;
  typePrefix: string;
  noun: string;
  pascalNoun: string;
  screamNoun: string;
  slotColumnName: string;
  allColumns: NormalizedColumn[];
  // The caller-supplied key column for an owner-keyed table (its brand is the key
  // type bound in place of SINGLETON_ID), or undefined for a fixed singleton.
  keyedSlot: NormalizedColumn | undefined;
  valueColumns: NormalizedColumn[];
  // The columns a `read` selects, and so the fields the row type carries. Normally the
  // value columns alone - a keyed read binds the key, so echoing it back would hand the
  // caller the argument it just passed. A table with an `orderedHead` read leads with the
  // key instead: that caller did not supply one, and it needs the key it got back to
  // delete the row it just consumed.
  readColumns: NormalizedColumn[];
  settableColumns: NormalizedColumn[];
  versionColumn: NormalizedColumn;
  rowType: string;
  cursorFn: string;
  versionReader: string;
  // The private row_version reader is emitted only when a compare-and-set reads the
  // version back before matching. An insert returns the version its upsert's RETURNING
  // hands back, so a table without a compare-and-set never reads it, and emitting it
  // would leave an unused private function.
  emitsVersionReader: boolean;
  kotlinReadVersionConst: string;
  swiftReadVersionConst: string;
  kotlinCreateConst: string;
  swiftCreateConst: string;
  kotlinAddColumnConst: (column: LocalSQLiteColumnSpec) => string;
  swiftAddColumnConst: (column: LocalSQLiteColumnSpec) => string;
  bootstrapColumns: NormalizedBootstrapColumn[] | undefined;
  kotlinBootstrapConst: string | undefined;
  swiftBootstrapConst: string | undefined;
  hasCas: boolean;
  casResultType: string | undefined;
  expectedVersionBrand: string | undefined;
  operations: NormalizedOperation[];
}

export interface LocalSQLiteSpec {
  version: number;
  // The on-device schema version this build stamps and gates against; see the raw
  // spec's schemaVersion.
  schemaVersion: number;
  // Ordered forward-migration ladder (may be empty). Each step's statements
  // include its trailing user_version bump.
  migrations: NormalizedMigrationStep[];
  tables: NormalizedTable[];
  obsoleteTables: string[];
  // The method-channel surface every platform's channel code is generated from.
  channel: NormalizedChannel;
  // Whether anything emits a BEGIN IMMEDIATE unit - a compare-and-set, an
  // `insertForCurrentOwner`, or an exact-owner delete with its summary. Each of those
  // operation families requires the shared transaction helpers.
  anyTransaction: boolean;
}

export const VERSION_COLUMN = "row_version";
