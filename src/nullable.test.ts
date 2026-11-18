import { describe, expect, test } from "bun:test";
import { normalizeLocalSQLiteSpec } from "./spec";
import { cloneSpec, loadExampleRaw, tableNamed } from "./test-support";

// Where a nullable column may not appear. Each case is a shape that would GENERATE -
// nothing downstream reads `nullable` on these paths - and then mean something other than
// what the spec says, so the rejection is the whole contract. The example's highlight
// queue carries a nullable margin note, and each case is one edit away from it.
describe("nullable-column contract", () => {
  const withQueue = async () => {
    const spec = cloneSpec(await loadExampleRaw());
    return { spec, table: tableNamed(spec, "pending_highlight") };
  };
  const column = (
    table: Awaited<ReturnType<typeof withQueue>>["table"],
    name: string,
  ) => {
    const found = table.columns.find((candidate) => candidate.name === name);
    if (found === undefined) throw new Error(`fixture lost column ${name}`);
    return found;
  };

  test("accepts the fixture as declared", async () => {
    // The baseline every rejection below is a single edit away from, so a case that
    // throws proves its own edit rather than some unrelated defect in the fixture.
    const { spec } = await withQueue();
    expect(() => normalizeLocalSQLiteSpec(spec)).not.toThrow();
  });

  // SQL equality against NULL is NULL, never true, so a keyed read or update on a
  // nullable column returns nothing for a row that is sitting right there.
  test("rejects a predicate on a nullable column", async () => {
    const { spec, table } = await withQueue();
    table.operations.push({
      name: "read_by_margin_note_pending_highlight",
      kind: "read",
      predicate: [
        {
          column: "margin_note",
          operator: "=",
          brand: "PendingHighlightMarginNote",
        },
      ],
    });

    expect(() => normalizeLocalSQLiteSpec(spec)).toThrow(
      "predicates on nullable column margin_note",
    );
  });

  test("rejects a guard on a nullable column", async () => {
    const { spec, table } = await withQueue();
    table.operations.push({
      name: "claim_note_pending_highlight",
      kind: "update",
      setColumns: ["upload_attempts"],
      predicate: [
        {
          column: "staged_at_ms",
          operator: "=",
          brand: "PendingHighlightStagedAtMs",
        },
      ],
      guard: [{ column: "margin_note", value: "" }],
    });

    expect(() => normalizeLocalSQLiteSpec(spec)).toThrow(
      "guards on nullable column margin_note",
    );
  });

  // A key that can be absent does not identify a row, and SQLite will not refuse it for
  // us: only INTEGER PRIMARY KEY (the rowid alias) rejects a NULL, so a nullable TEXT key
  // would be admitted and then collide with every other absent one.
  test("rejects a nullable primary key", async () => {
    const { spec, table } = await withQueue();
    column(table, "staged_at_ms").nullable = true;

    expect(() => normalizeLocalSQLiteSpec(spec)).toThrow("in the primary key");
  });

  test("rejects a nullable row_version", async () => {
    const { spec, table } = await withQueue();
    column(table, "row_version").nullable = true;

    expect(() => normalizeLocalSQLiteSpec(spec)).toThrow(
      "row_version is nullable",
    );
  });

  // Bootstrap, ensure and reset-to-defaults write every settable column as a reviewed SQL
  // literal, and a nullable column has none: its not-yet-written state is NULL itself,
  // which is why it may not also declare a default.
  test("rejects a nullable column that declares a default", async () => {
    const { spec, table } = await withQueue();
    column(table, "margin_note").default = "";

    expect(() => normalizeLocalSQLiteSpec(spec)).toThrow(
      "nullable and declares a default",
    );
  });

  test("rejects a nullable column on a table that seeds its row", async () => {
    const { spec } = await withQueue();
    // The settings row's reset would refuse the column first, so the fixture drops it and
    // the column flag that only a reset reads: what is left is the bootstrap alone.
    const settings = tableNamed(spec, "app_settings");
    settings.operations = settings.operations.filter(
      (operation) => operation.kind !== "resetToDefaults",
    );
    for (const each of settings.columns) delete each.survivesReset;
    settings.columns.splice(1, 0, {
      name: "nickname",
      sqliteType: "TEXT",
      nullable: true,
      brand: "AppSettingsNickname",
    });

    expect(() => normalizeLocalSQLiteSpec(spec)).toThrow(
      "declares bootstrapRow",
    );
  });

  test("rejects a nullable column beside a defaults-writing operation", async () => {
    const { spec, table } = await withQueue();
    table.operations.push({
      name: "reset_pending_highlight",
      kind: "resetToDefaults",
      predicate: [
        {
          column: "staged_at_ms",
          operator: "=",
          brand: "PendingHighlightStagedAtMs",
        },
      ],
    });

    expect(() => normalizeLocalSQLiteSpec(spec)).toThrow(
      "writes every settable column as a declared-default literal",
    );
  });

  // The owner read returns a plain non-null string and an empty one already means "nobody
  // to record for", so a nullable target adds a second way to say absent that no caller
  // distinguishes - and the emitted bind has no optional to carry it.
  test("rejects an owner-sourced insert into a nullable column", async () => {
    const { spec, table } = await withQueue();
    column(table, "reader_id").nullable = true;

    expect(() => normalizeLocalSQLiteSpec(spec)).toThrow(
      "sources nullable column reader_id",
    );
  });
});
