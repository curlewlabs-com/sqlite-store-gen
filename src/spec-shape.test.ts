import { describe, expect, test } from "bun:test";
import type { LocalSQLiteRawSpec } from "./model";
import { normalizeLocalSQLiteSpec } from "./spec";
import {
  cloneSpec,
  loadExampleRaw,
  operationNamed,
  tableNamed,
} from "./test-support";

async function fresh(): Promise<LocalSQLiteRawSpec> {
  return cloneSpec(await loadExampleRaw());
}

// Sets a field the TypeScript interfaces would not admit, as a JSON spec can.
function setField(target: object, field: string, value: unknown): void {
  (target as Record<string, unknown>)[field] = value;
}

function column(spec: LocalSQLiteRawSpec, table: string, name: string) {
  const found = tableNamed(spec, table).columns.find(
    (candidate) => candidate.name === name,
  );
  if (found === undefined) throw new Error(`no column ${table}.${name}`);
  return found;
}

// Each shape here used to be read as whatever JavaScript made of it rather than refused.
describe("spec field types", () => {
  test("refuses a fractional or unsafe default on an INTEGER column", async () => {
    // A fractional default was emitted as the literal 250.5 into an INTEGER column's
    // seed, which a STRICT table refuses on the open that runs it.
    for (const value of [250.5, 2 ** 53]) {
      const spec = await fresh();
      column(spec, "app_settings", "words_per_minute").default = value;
      expect(() => normalizeLocalSQLiteSpec(spec)).toThrow(
        `app_settings.words_per_minute default must be an integer within 2^53 for an INTEGER column (got ${value})`,
      );
    }
  });

  test("refuses a misspelled sqliteType", async () => {
    // Every type other than TEXT was read as INTEGER, so a `"text"` column took an
    // integer in the generated API.
    const spec = await fresh();
    setField(
      column(spec, "signed_in_reader", "reader_id"),
      "sqliteType",
      "text",
    );
    expect(() => normalizeLocalSQLiteSpec(spec)).toThrow(
      'signed_in_reader.reader_id sqliteType must be one of INTEGER, TEXT (got "text")',
    );
  });

  test("refuses a nullable that is not a boolean", async () => {
    // `"false"` is truthy, so the column was emitted nullable.
    const spec = await fresh();
    setField(
      column(spec, "signed_in_reader", "reader_id"),
      "nullable",
      "false",
    );
    expect(() => normalizeLocalSQLiteSpec(spec)).toThrow(
      'signed_in_reader.reader_id nullable must be a boolean (got "false")',
    );
  });

  test("refuses a brand that is not a type name", async () => {
    const spec = await fresh();
    column(spec, "signed_in_reader", "reader_id").brand = "reader id";
    expect(() => normalizeLocalSQLiteSpec(spec)).toThrow(
      "signed_in_reader.reader_id brand must match",
    );
  });

  test("refuses an analyze flag that is not a boolean", async () => {
    // Emitted verbatim into the generated schema's statistics flag.
    const spec = await fresh();
    setField(tableNamed(spec, "app_settings"), "analyze", "yes");
    expect(() => normalizeLocalSQLiteSpec(spec)).toThrow(
      'app_settings analyze must be a boolean (got "yes")',
    );
  });

  test("refuses an unknown operation kind or predicate operator", async () => {
    // An unknown kind reached normalization with no category to emit it as.
    const kind = await fresh();
    setField(
      operationNamed(tableNamed(kind, "app_settings"), "read_app_settings"),
      "kind",
      "select",
    );
    expect(() => normalizeLocalSQLiteSpec(kind)).toThrow(
      'read_app_settings kind must be one of read, insert, insertForCurrentOwner, ensure, update, casUpdate, delete, resetToDefaults (got "select")',
    );

    const operator = await fresh();
    const [term] = operationNamed(
      tableNamed(operator, "app_settings"),
      "read_app_settings",
    ).predicate!;
    setField(term!, "operator", "==");
    expect(() => normalizeLocalSQLiteSpec(operator)).toThrow(
      'read_app_settings predicate term on "singleton_id" operator must be one of',
    );
  });

  // The exception is what admits an operation no index covers, so it must carry the row
  // bound, caller, ordering and diagnostic it exists to record. An empty object, or one
  // missing a field, admitted the scan with none of them.
  test("refuses a bounded scan exception missing any of its fields", async () => {
    const bounded = {
      hardRowBound: "one row per staged highlight",
      caller: "the upload pass",
      ordering: "staged_at_ms ASC",
      diagnostic: "logs the rows read per pass",
    };
    const cases: [object, string][] = [
      [{}, "must declare a non-empty hardRowBound (got nothing)"],
      [
        { ...bounded, caller: " " },
        'must declare a non-empty caller (got " ")',
      ],
      [
        { ...bounded, diagnostic: 1 },
        "must declare a non-empty diagnostic (got 1)",
      ],
      [{ ...bounded, note: "x" }, "declares unknown field note"],
    ];
    for (const [exception, message] of cases) {
      const spec = await fresh();
      const read = operationNamed(
        tableNamed(spec, "app_settings"),
        "read_app_settings",
      );
      setField(read, "boundedScanException", exception);
      expect(() => normalizeLocalSQLiteSpec(spec)).toThrow(
        `read_app_settings boundedScanException ${message}`,
      );
    }
  });
});
