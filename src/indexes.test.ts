import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createIndexStatement, verifyIndexParity } from "./indexes";
import { createTableStatement } from "./schema";
import { normalizeLocalSQLiteSpec } from "./spec";
import { loadExampleRaw, tableNamed } from "./test-support";

const INDEX_STEP = 4;

test("fresh baseline index definitions agree with the executable ladder", async () => {
  const raw = await loadExampleRaw();
  normalizeLocalSQLiteSpec(raw);
  const db = new Database(":memory:");
  try {
    for (const table of raw.tables) {
      db.run(createTableStatement(table));
      for (const index of table.indexes)
        db.run(createIndexStatement(table.name, index));
    }
    verifyIndexParity(db, raw.tables);
  } finally {
    db.close();
  }
});

// An index on a shipped table arrives by a ladder step. A step that builds it with the
// columns in another order, or leaves it out, would give an upgraded store a different
// index than a fresh install - correct on one device, scanning on the next.
test("missing or misordered ladder indexes fail rather than silently accepting fresh-only coverage", async () => {
  for (const mutate of [
    (sql: string) =>
      sql.replace("(reader_id, captured_at_ms)", "(captured_at_ms, reader_id)"),
    (_sql: string) => "UPDATE signed_in_reader SET reader_id = ''",
  ]) {
    const raw = await loadExampleRaw();
    const step = raw.migrations.find(
      (migration) => migration.toVersion === INDEX_STEP,
    )!;
    const index = step.statements.findIndex((sql) =>
      sql.startsWith("CREATE INDEX"),
    );
    step.statements[index] = mutate(step.statements[index]!);
    expect(() => normalizeLocalSQLiteSpec(raw)).toThrow(
      "index shape differs from baseline",
    );
  }
});

// The same index built on the wrong table runs cleanly when that table has the same
// columns, so only the comparison against the baseline can catch it: an upgraded
// store would carry the index on a table no read uses it for, and scan the one it was
// written for.
test("a ladder index built on the wrong table fails even when that table has the same columns", async () => {
  const raw = await loadExampleRaw();
  const step = raw.migrations.find(
    (migration) => migration.toVersion === INDEX_STEP,
  )!;
  const shadow = structuredClone(tableNamed(raw, "pending_highlight"));
  shadow.name = "pending_highlight_shadow";
  shadow.indexes = [];
  shadow.operations = [];
  raw.tables.push(shadow);
  const create = step.statements.findIndex((sql) =>
    sql.startsWith("CREATE TABLE IF NOT EXISTS pending_highlight ("),
  );
  step.statements.splice(
    create + 1,
    0,
    step.statements[create]!.replace(
      "CREATE TABLE IF NOT EXISTS pending_highlight (",
      "CREATE TABLE IF NOT EXISTS pending_highlight_shadow (",
    ),
  );
  const index = step.statements.findIndex((sql) =>
    sql.startsWith("CREATE INDEX"),
  );
  step.statements[index] = step.statements[index]!.replace(
    "ON pending_highlight (",
    "ON pending_highlight_shadow (",
  );
  expect(() => normalizeLocalSQLiteSpec(raw)).toThrow(
    "index shape differs from baseline",
  );
});

test("an index cannot refer to a future column or hide a repeated introduction", async () => {
  const raw = await loadExampleRaw();
  const step = raw.migrations.find((migration) => migration.toVersion === 2)!;
  step.statements.unshift(
    "CREATE INDEX idx_future ON app_settings (words_per_minute)",
  );
  expect(() => normalizeLocalSQLiteSpec(raw)).toThrow("no such column");

  const again = await loadExampleRaw();
  const indexStep = again.migrations.find(
    (migration) => migration.toVersion === INDEX_STEP,
  )!;
  indexStep.statements.push(
    indexStep.statements.find((sql) => sql.startsWith("CREATE INDEX"))!,
  );
  expect(() => normalizeLocalSQLiteSpec(again)).toThrow("already exists");
});

test("index declarations reject unbuilt options, invalid columns, name collisions and missing statistics", async () => {
  for (const index of [
    { name: "bad-name", columns: ["reader_id"] },
    { name: "signed_in_reader", columns: ["reader_id"] },
    { name: "idx_probe", columns: [] },
    { name: "idx_probe", columns: ["missing"] },
    { name: "idx_probe", columns: ["reader_id", "reader_id"] },
    { name: "idx_probe", columns: ["reader_id"], unique: true },
  ]) {
    const raw = await loadExampleRaw();
    tableNamed(raw, "pending_highlight").indexes = [index];
    expect(() => normalizeLocalSQLiteSpec(raw)).toThrow();
  }
  const raw = await loadExampleRaw();
  const queue = tableNamed(raw, "pending_highlight");
  queue.analyze = false;
  expect(() => normalizeLocalSQLiteSpec(raw)).toThrow(
    "require planner statistics",
  );
  queue.analyze = true;
  const profile = tableNamed(raw, "reader_profile");
  profile.analyze = true;
  profile.indexes = [
    { name: "idx_pending_highlight_reader_captured", columns: ["reader_id"] },
  ];
  expect(() => normalizeLocalSQLiteSpec(raw)).toThrow("duplicate index name");
});

test("counted cleanup cannot widen its exact-owner scope or summarize a nullable observation", async () => {
  for (const change of [
    "operator",
    "column",
    "brand",
    "nullable",
    "exception",
  ] as const) {
    const raw = await loadExampleRaw();
    const table = tableNamed(raw, "pending_highlight");
    const op = table.operations.find((op) => op.deleteSummary)!;
    switch (change) {
      case "operator":
        op.predicate![0]!.operator = "<>";
        break;
      case "column":
        op.deleteSummary!.observedAtColumn = "reader_id";
        break;
      case "brand":
        delete op.predicate![0]!.brand;
        break;
      case "nullable":
        table.columns.find((col) => col.name === "captured_at_ms")!.nullable =
          true;
        break;
      case "exception":
        op.boundedScanException = {
          hardRowBound: "none",
          caller: "test",
          ordering: "set",
          diagnostic: "test",
        };
        break;
    }
    expect(() => normalizeLocalSQLiteSpec(raw)).toThrow(
      "deleteSummary requires",
    );
  }
});

// The counted cleanup is the one shape allowed to rest on an index prefix. An ordinary
// operation on the same predicate must not inherit that, or a per-row read or write
// would quietly become a scan of every row the owner has.
test("ordinary owner-only operations cannot borrow counted cleanup prefix coverage", async () => {
  for (const kind of ["read", "update", "delete"] as const) {
    const raw = await loadExampleRaw();
    const table = tableNamed(raw, "pending_highlight");
    const operation = table.operations.find(
      (candidate) => candidate.deleteSummary,
    )!;
    delete operation.deleteSummary;
    operation.kind = kind;
    if (kind === "update") operation.setColumns = ["retry_not_before_ms"];
    expect(() => normalizeLocalSQLiteSpec(raw)).toThrow(
      "predicate is not covered by an emitted key or index",
    );
  }
});
