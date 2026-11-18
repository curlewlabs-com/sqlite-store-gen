// Fixtures and helpers the test suites share: the example spec, cloned and looked up by
// name, and a stand-in for the CurlewSQLite module so generated Swift can be type-checked
// on its own.

import { fileURLToPath } from "node:url";
import type { LocalSQLiteOperationSpec } from "./operation";
import type {
  LocalSQLiteRawSpec,
  LocalSQLiteSpec,
  LocalSQLiteTableSpec,
} from "./model";
import {
  renderLocalSQLiteSources,
  type LocalSQLiteRenderedSources,
} from "./render";
import { loadRawLocalSQLiteSpec, normalizeLocalSQLiteSpec } from "./spec";

export const EXAMPLE_SPEC_PATH = fileURLToPath(
  new URL("../example/spec.json", import.meta.url),
);

export const EXAMPLE_OPTIONS = {
  kotlinPackage: "org.example.reader.storage",
  databaseFileName: "reader.sqlite3",
  notice: "// Generated file. Do not edit by hand.",
};

export function loadExampleRaw(): Promise<LocalSQLiteRawSpec> {
  return loadRawLocalSQLiteSpec(EXAMPLE_SPEC_PATH);
}

export async function loadExample(): Promise<LocalSQLiteSpec> {
  return normalizeLocalSQLiteSpec(await loadExampleRaw());
}

export function render(spec: LocalSQLiteSpec): LocalSQLiteRenderedSources {
  return renderLocalSQLiteSources(spec, EXAMPLE_OPTIONS);
}

export function renderRaw(raw: LocalSQLiteRawSpec): LocalSQLiteRenderedSources {
  return render(normalizeLocalSQLiteSpec(raw));
}

export function cloneSpec(spec: LocalSQLiteRawSpec): LocalSQLiteRawSpec {
  return JSON.parse(JSON.stringify(spec)) as LocalSQLiteRawSpec;
}

export function tableNamed(
  spec: LocalSQLiteRawSpec,
  name: string,
): LocalSQLiteTableSpec {
  const table = spec.tables.find((candidate) => candidate.name === name);
  if (table === undefined) {
    throw new Error(`test fixture is missing table ${name}`);
  }
  return table;
}

export function operationNamed(
  table: LocalSQLiteTableSpec,
  name: string,
): LocalSQLiteOperationSpec {
  const operation = table.operations.find(
    (candidate) => candidate.name === name,
  );
  if (operation === undefined) {
    throw new Error(`test fixture is missing operation ${name}`);
  }
  return operation;
}

// The SQL text of a named generated constant, without its triple-quote delimiters.
// Throws rather than returning empty on a miss, so a renamed constant fails the test
// that reads it instead of silently comparing "" against "".
export function sqlConstBody(rendered: string, constName: string): string {
  const declaration = `${constName} = """`;
  const start = rendered.indexOf(declaration);
  if (start < 0) throw new Error(`no generated constant named ${constName}`);
  const bodyStart = start + declaration.length;
  const end = rendered.indexOf('"""', bodyStart);
  if (end < 0) throw new Error(`unterminated constant ${constName}`);
  return rendered.slice(bodyStart, end);
}

// A fixed-singleton compare-and-set table, beside the example's owner-keyed one, so both
// slot shapes the CAS emitters handle are exercised.
export function addSingletonCasTable(
  spec: LocalSQLiteRawSpec,
): LocalSQLiteTableSpec {
  const table: LocalSQLiteTableSpec = {
    name: "sync_cursor",
    doc: "Synthetic singleton fixture for compare-and-set coverage.",
    primaryKey: ["singleton_id"],
    uniqueKeys: [],
    indexes: [],
    analyze: false,
    columns: [
      {
        name: "singleton_id",
        sqliteType: "INTEGER",
        nullable: false,
        brand: "SyncCursorSlotId",
        check: "singleton_id = 1",
      },
      {
        name: "cursor_token",
        sqliteType: "TEXT",
        nullable: false,
        brand: "SyncCursorToken",
        // The bootstrap seeds every non-key column at its declared default, so a
        // bootstrapped table cannot leave one undefaulted.
        default: "",
      },
      {
        name: "row_version",
        sqliteType: "INTEGER",
        nullable: false,
        brand: "StoredSyncCursorRowVersion",
        check: "row_version >= 1",
      },
    ],
    operationBrands: { expectedVersion: "ExpectedSyncCursorRowVersion" },
    bootstrapRow: true,
    operations: [
      {
        name: "read_sync_cursor",
        kind: "read",
        predicate: [{ column: "singleton_id", operator: "=" }],
      },
      { name: "insert_or_replace_sync_cursor", kind: "insert" },
      {
        name: "compare_and_set_update_sync_cursor",
        kind: "casUpdate",
        setColumns: ["cursor_token"],
      },
    ],
  };
  spec.tables.unshift(table);
  return table;
}

// A synthetic two-step ladder over the example's tables, so the multi-step cases below -
// ordering, contiguity, a runner resuming mid-ladder - are driven by a fixture this file
// controls rather than by whatever shape the example's own ladder has. Its baseline drops
// what only a ladder step can introduce (indexes, and the counted cleanup that reads one).
export function withSchemaMigrations(
  spec: LocalSQLiteRawSpec,
): LocalSQLiteRawSpec {
  for (const table of spec.tables) {
    table.indexes = [];
    table.analyze = false;
    table.operations = table.operations.filter(
      (operation) =>
        operation.deleteSummary === undefined &&
        operation.orderedSuccessor === undefined &&
        !(operation.predicate ?? []).some((term) => term.operator !== "="),
    );
  }
  // The ladder has to end at the baseline's columns, so the profile declares what the
  // two steps add.
  const profile = tableNamed(spec, "reader_profile");
  for (const [name, brand] of [
    ["reading_goal", "ReaderProfileReadingGoal"],
    ["streak_days", "ReaderProfileStreakDays"],
  ] as const) {
    profile.columns.splice(profile.columns.length - 1, 0, {
      name,
      sqliteType: "INTEGER",
      nullable: false,
      brand,
      default: 0,
    });
  }
  spec.schemaVersion = 3;
  spec.migrations = [
    {
      toVersion: 2,
      doc: "Synthetic: add a reading goal.",
      statements: [
        "ALTER TABLE reader_profile ADD COLUMN reading_goal INTEGER NOT NULL DEFAULT 0",
      ],
    },
    {
      toVersion: 3,
      doc: "Synthetic: add a streak counter.",
      statements: [
        "ALTER TABLE reader_profile ADD COLUMN streak_days INTEGER NOT NULL DEFAULT 0",
      ],
    },
  ];
  return spec;
}

// One example operation per non-read kind, so a case that must hold for "every kind that
// is not a read" is a loop rather than a representative. A kind added to the generator
// with no entry here is invisible to those loops - the generator's own
// `Record<OperationKind, ...>` is what fails in that case, not this list.
export const NON_READ_OPERATIONS = [
  ["signed_in_reader", "insert_or_replace_signed_in_reader", "insert"],
  ["pending_highlight", "stage_pending_highlight", "insertForCurrentOwner"],
  ["reader_profile", "ensure_reader_profile", "ensure"],
  ["reader_profile", "set_display_name_reader_profile", "update"],
  [
    "reader_profile",
    "compare_and_set_books_finished_reader_profile",
    "casUpdate",
  ],
  ["reader_profile", "delete_reader_profile", "delete"],
  ["app_settings", "reset_to_defaults_app_settings", "resetToDefaults"],
] as const satisfies readonly (readonly [string, string, string])[];

// The kinds that author no predicate, and so have no scan for a bounded-scan exception to
// excuse. The complement - read, update, delete, resetToDefaults - all reach the
// index-coverage check, which is the only thing that reads the exception.
export const PREDICATE_FREE_KINDS: readonly string[] = [
  "insert",
  "insertForCurrentOwner",
  "ensure",
  "casUpdate",
];

// The CurlewSQLite symbols the generated Swift uses, stubbed so the file can be
// `swiftc -typecheck`ed on its own. It catches generator bugs a parse passes and a real
// typecheck rejects (a missing argument label, an empty-collection guard); the native
// test project is the full compile against the real module.
export const CURLEW_SQLITE_STUB = `typealias sqlite3_destructor_type = @convention(c) (UnsafeMutableRawPointer?) -> Void

let SQLITE_OK: Int32 = 0
let SQLITE_ROW: Int32 = 100
let SQLITE_DONE: Int32 = 101
let SQLITE_OPEN_READWRITE: Int32 = 0x0002
let SQLITE_OPEN_CREATE: Int32 = 0x0004
let SQLITE_OPEN_FULLMUTEX: Int32 = 0x0001_0000
let SQLITE_BUSY: Int32 = 5
let SQLITE_LOCKED: Int32 = 6
let SQLITE_CORRUPT: Int32 = 11
let SQLITE_NOTADB: Int32 = 26
let SQLITE_NULL: Int32 = 5

func curlew_sqlite3_open_v2(_ path: UnsafePointer<CChar>, _ db: UnsafeMutablePointer<OpaquePointer?>, _ flags: Int32, _ vfs: UnsafePointer<CChar>?) -> Int32 { 0 }
func curlew_sqlite3_close_v2(_ db: OpaquePointer?) -> Int32 { 0 }
func curlew_sqlite3_prepare_v2(_ db: OpaquePointer, _ sql: UnsafePointer<CChar>, _ n: Int32, _ stmt: UnsafeMutablePointer<OpaquePointer?>, _ tail: UnsafePointer<UnsafePointer<CChar>?>?) -> Int32 { 0 }
func curlew_sqlite3_finalize(_ stmt: OpaquePointer?) -> Int32 { 0 }
func curlew_sqlite3_step(_ stmt: OpaquePointer) -> Int32 { 0 }
func curlew_sqlite3_column_text(_ stmt: OpaquePointer, _ i: Int32) -> UnsafePointer<UInt8>? { nil }
func curlew_sqlite3_column_int64(_ stmt: OpaquePointer, _ i: Int32) -> Int64 { 0 }
func curlew_sqlite3_column_type(_ stmt: OpaquePointer, _ i: Int32) -> Int32 { 0 }
func curlew_sqlite3_bind_text(_ stmt: OpaquePointer, _ i: Int32, _ v: UnsafePointer<CChar>, _ n: Int32, _ d: sqlite3_destructor_type?) -> Int32 { 0 }
func curlew_sqlite3_bind_int64(_ stmt: OpaquePointer, _ i: Int32, _ v: Int64) -> Int32 { 0 }
func curlew_sqlite3_bind_null(_ stmt: OpaquePointer, _ i: Int32) -> Int32 { 0 }
func curlew_sqlite3_changes(_ db: OpaquePointer) -> Int32 { 0 }
func curlew_sqlite3_errmsg(_ db: OpaquePointer?) -> UnsafePointer<CChar>? { nil }
func curlew_sqlite3_extended_errcode(_ db: OpaquePointer?) -> Int32 { 0 }
func curlew_sqlite3_db_config_defensive(_ db: OpaquePointer, _ on: Int32, _ out: UnsafeMutablePointer<Int32>) -> Int32 { 0 }

enum CurlewSQLiteProviderIdentity {
    static func validateRuntimeIdentity(version: String, sourceID: String) throws {}
}`;
