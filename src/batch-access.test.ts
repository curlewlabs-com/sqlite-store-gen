import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createTableStatement } from "./schema";
import { normalizeLocalSQLiteSpec } from "./spec";
import { databaseNeedsStatistics } from "./statistics";
import {
  loadExample,
  loadExampleRaw,
  operationNamed,
  render,
  sqlConstBody,
  tableNamed,
} from "./test-support";

// A consumer draining a queue walks it by key: head, then each successor. Rows waiting on
// a retry deadline stay in the walk rather than being filtered out by the read, so a held
// row cannot hide the rows behind it.
test("emitted successor reads return the next key across gaps and stop at the tail", async () => {
  const spec = await loadExample();
  const sources = render(spec);
  const table = spec.tables.find(
    (table) => table.spec.name === "pending_highlight",
  )!;
  const db = new Database(":memory:");
  try {
    db.exec(createTableStatement(table.spec));
    db.exec(`INSERT INTO pending_highlight (staged_at_ms, reader_id, book_isbn, excerpt,
      captured_at_ms, upload_attempts, retry_not_before_ms, row_version) VALUES
      (10, 'r', 'isbn', 'a', 10, 0, 0, 1),
      (30, 'r', 'isbn', 'b', 30, 0, 999999, 1),
      (50, 'r', 'isbn', 'c', 50, 0, 0, 1)`);
    const operation = table.operations.find((op) => op.spec.orderedSuccessor)!;
    const sql = sqlConstBody(sources.kotlin, operation.kotlinSqlConst);
    expect(sql.replace(/\s+/g, " ").trim()).toBe(
      sqlConstBody(sources.swift, operation.swiftSqlConst)
        .replace(/\s+/g, " ")
        .trim(),
    );
    const read = db.query<{ staged_at_ms: number }, [number]>(sql);
    expect(read.get(0)?.staged_at_ms).toBe(10);
    expect(read.get(10)?.staged_at_ms).toBe(30);
    expect(read.get(31)?.staged_at_ms).toBe(50);
    expect(read.get(50)).toBeNull();
  } finally {
    db.close();
  }
});

// The monotone MAX is what lets two processes extend one deadline without either
// shortening the other's, and its partial-column shape keeps it off sibling columns.
test("emitted maximum update never shortens a deadline or overwrites sibling state", async () => {
  const spec = await loadExample();
  const table = spec.tables.find(
    (table) => table.spec.name === "reader_profile",
  )!;
  const kotlin = render(spec).kotlin;
  const db = new Database(":memory:");
  try {
    db.exec(createTableStatement(table.spec));
    db.query(
      sqlConstBody(
        kotlin,
        table.operations.find((op) => op.category === "ensure")!.kotlinSqlConst,
      ),
    ).run("reader");
    db.exec(
      "UPDATE reader_profile SET books_finished = 3 WHERE reader_id = 'reader'",
    );
    const update = db.query(
      sqlConstBody(
        kotlin,
        table.operations.find((op) => op.spec.integerMaximum)!.kotlinSqlConst,
      ),
    );
    update.run(5000, "reader");
    update.run(1000, "reader");
    expect(
      db
        .query(
          "SELECT sync_not_before_ms, books_finished FROM reader_profile WHERE reader_id = 'reader'",
        )
        .get(),
    ).toEqual({ sync_not_before_ms: 5000, books_finished: 3 });
    expect(update.run(9000, "missing").changes).toBe(0);
  } finally {
    db.close();
  }
});

test("successor declarations reject residual filters and non-key ordering", async () => {
  for (const invalid of [
    "filter",
    "ordering",
    "operator",
    "brand",
    "head",
  ] as const) {
    const raw = await loadExampleRaw();
    const op = operationNamed(
      tableNamed(raw, "pending_highlight"),
      "read_successor_pending_highlight",
    );
    if (invalid === "filter")
      op.predicate!.push({
        column: "retry_not_before_ms",
        operator: "<",
        brand: "PendingHighlightRetryNotBeforeMs",
      });
    if (invalid === "ordering")
      op.orderedSuccessor!.column = "retry_not_before_ms";
    if (invalid === "operator") op.predicate![0]!.operator = ">=";
    if (invalid === "brand") delete op.predicate![0]!.brand;
    if (invalid === "head") op.orderedHead = { column: "staged_at_ms" };
    expect(() => normalizeLocalSQLiteSpec(raw)).toThrow(
      "orderedSuccessor requires",
    );
  }
});

test("integer maximum rejects nullable or text values and unkeyed writes", async () => {
  for (const invalid of ["nullable", "text", "predicate"] as const) {
    const raw = await loadExampleRaw();
    const table = tableNamed(raw, "reader_profile");
    const op = operationNamed(table, "extend_sync_deadline_reader_profile");
    if (invalid === "nullable")
      table.columns.find(
        (column) => column.name === op.setColumns![0],
      )!.nullable = true;
    if (invalid === "text") op.setColumns = ["display_name"];
    if (invalid === "predicate") op.predicate = [];
    expect(() => normalizeLocalSQLiteSpec(raw)).toThrow();
  }
});

// Planner statistics cost an ANALYZE on the store; they are owed only when some operation
// reads a range, and a spec with none must not pay for them.
test("range operations require statistics while primary-key heads alone do not", async () => {
  const raw = await loadExampleRaw();
  expect(databaseNeedsStatistics(normalizeLocalSQLiteSpec(raw))).toBe(true);
  for (const table of raw.tables) {
    table.operations = table.operations.filter(
      (op) =>
        !op.orderedSuccessor &&
        !op.deleteSummary &&
        !(op.predicate ?? []).some((term) => term.operator !== "="),
    );
    table.indexes = [];
    table.analyze = false;
  }
  for (const step of raw.migrations)
    step.statements = step.statements.filter(
      (sql) => !sql.startsWith("CREATE INDEX"),
    );
  expect(databaseNeedsStatistics(normalizeLocalSQLiteSpec(raw))).toBe(false);
});
