import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { allocatedKeySql } from "./key-allocation";
import { normalizeLocalSQLiteSpec } from "./spec";
import {
  loadExample,
  loadExampleRaw,
  operationNamed,
  tableNamed,
} from "./test-support";

// A producer's clock can repeat a millisecond or step backwards. The allocated key treats
// the proposed key as a floor and always lands past the backlog, so neither a repeat nor
// a rollback overwrites or reorders a row already waiting.
test("allocation keeps same-millisecond observations and clock rollback behind the backlog", async () => {
  const table = (await loadExample()).tables.find(
    (table) => table.spec.name === "pending_highlight",
  )!;
  const db = new Database(":memory:");
  try {
    db.run(
      "CREATE TABLE pending_highlight (staged_at_ms INTEGER PRIMARY KEY) STRICT",
    );
    const allocate = db.query<{ key: number }, [number]>(
      `SELECT (${allocatedKeySql(table)}) AS key`,
    );
    const insert = db.query("INSERT INTO pending_highlight VALUES (?)");
    const stage = db.transaction((candidate: number) => {
      const key = allocate.get(candidate)!.key;
      insert.run(key);
      return key;
    });
    expect(stage(1000)).toBe(1000);
    expect(stage(1000)).toBe(1001);
    expect(stage(500)).toBe(1002);
    expect(stage(2000)).toBe(2000);
  } finally {
    db.close();
  }
});

test("allocated inserts reject an unallocated sibling writer", async () => {
  // An insert beside the allocator that takes its key as given would silently revive
  // the overwrite the allocation exists to prevent.
  const raw = await loadExampleRaw();
  const table = tableNamed(raw, "pending_highlight");
  table.operations.push({
    name: "stage_unallocated_pending_highlight",
    kind: "insertForCurrentOwner",
    ownerFrom: {
      table: "signed_in_reader",
      column: "reader_id",
      into: "reader_id",
    },
  });
  expect(() => normalizeLocalSQLiteSpec(raw)).toThrow(
    "every insert must allocate",
  );
});

test("allocation rejects an unbound co-write target", async () => {
  const raw = await loadExampleRaw();
  operationNamed(
    tableNamed(raw, "pending_highlight"),
    "stage_pending_highlight",
  ).allocateKey = { alsoSetColumn: "unknown_column" };
  expect(() => normalizeLocalSQLiteSpec(raw)).toThrow("allocated key co-write");
});
