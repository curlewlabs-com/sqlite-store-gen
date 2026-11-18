import { describe, expect, test } from "bun:test";
import {
  ownerSourceReadSql,
  ownerSourcedInsertBinds,
  whereClause,
} from "./sql";
import { loadExample } from "./test-support";

describe("SQL compiler", () => {
  test("keeps guard literals out of the bound predicate sequence", () => {
    // A guard contributes SQL but no parameter. Treating it as a bound term would shift
    // every later bind position and make the Kotlin and Swift statements act on the wrong
    // values while retaining valid SQL.
    expect(
      whereClause(
        [{ column: "shelf_id", operator: "=", brand: "ShelfId" }],
        [{ column: "reserved", value: 0 }],
        new Map([["reserved", "INTEGER"]]),
      ),
    ).toBe("shelf_id = ? AND reserved = 0");
  });

  test("compiles the owner read and the binds of an owner-sourced insert from one resolution", async () => {
    const spec = await loadExample();
    const queue = spec.tables.find(
      (table) => table.spec.name === "pending_highlight",
    );
    const insert = queue?.operations.find(
      (operation) => operation.category === "insertForCurrentOwner",
    );
    if (queue === undefined || insert === undefined) {
      throw new Error("example spec is missing the owner-sourced insert");
    }

    expect(ownerSourceReadSql(insert)).toBe(`SELECT reader_id
FROM signed_in_reader
WHERE singleton_id = ?`);
    expect(
      ownerSourcedInsertBinds(queue, insert).map(({ column, expression }) => [
        column.name,
        expression,
      ]),
    ).toEqual([
      ["staged_at_ms", "param"],
      ["reader_id", "owner"],
      ["book_isbn", "param"],
      ["excerpt", "param"],
      ["margin_note", "param"],
      ["page_number", "param"],
      ["captured_at_ms", "param"],
      ["upload_attempts", "param"],
      ["retry_not_before_ms", "param"],
    ]);
  });
});
