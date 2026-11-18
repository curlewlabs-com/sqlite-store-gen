import { expect, test } from "bun:test";
import { normalizeLocalSQLiteSpec } from "./spec";
import { loadExampleRaw, operationNamed, tableNamed } from "./test-support";

// An alias is a second name for a bound value. One that collides with a set value, a
// runtime binding the emitters use, or is not a valid identifier would compile to a
// statement that binds the wrong value, or not compile at all.
test("predicate aliases cannot shadow the new value or runtime bindings", async () => {
  for (const alias of [
    "retry_not_before_ms",
    "changed_rows",
    "bad-name",
    "await",
  ]) {
    const raw = await loadExampleRaw();
    const operation = operationNamed(
      tableNamed(raw, "pending_highlight"),
      "admit_retry_pending_highlight",
    );
    operation.predicate![1]!.parameter = alias;
    expect(() => normalizeLocalSQLiteSpec(raw)).toThrow();
  }
});

test("predicate alias stays on the approved branded update seam", async () => {
  const raw = await loadExampleRaw();
  const operation = operationNamed(
    tableNamed(raw, "pending_highlight"),
    "delete_pending_highlight",
  );
  operation.predicate![0]!.parameter = "old_key";
  expect(() => normalizeLocalSQLiteSpec(raw)).toThrow();
});
