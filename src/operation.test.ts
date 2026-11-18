import { describe, expect, test } from "bun:test";
import {
  validateLocalSQLiteOperation,
  type LocalSQLiteOperationSpec,
  type LocalSQLiteOperationTableSpec,
} from "./operation";

function table(): LocalSQLiteOperationTableSpec {
  return {
    name: "shelf_slot",
    primaryKey: ["shelf_id"],
    uniqueKeys: [],
    indexes: [],
    keyedBy: "shelf_id",
    columns: [
      {
        name: "shelf_id",
        sqliteType: "TEXT",
        nullable: false,
        brand: "ShelfId",
      },
      {
        name: "row_version",
        sqliteType: "INTEGER",
        nullable: false,
        brand: "RowVersion",
      },
      {
        name: "reserved",
        sqliteType: "INTEGER",
        nullable: false,
        brand: "Reserved",
        default: 0,
      },
    ],
    operations: [],
  };
}

function validate(operation: LocalSQLiteOperationSpec): void {
  const subject = table();
  validateLocalSQLiteOperation(
    subject,
    new Set(subject.columns.map((column) => column.name)),
    operation,
  );
}

describe("operation contract", () => {
  test("accepts a keyed update with an unbound literal guard", () => {
    expect(() =>
      validate({
        name: "reserve_shelf_slot",
        kind: "update",
        predicate: [{ column: "shelf_id", operator: "=", brand: "ShelfId" }],
        setColumns: ["reserved"],
        guard: [{ column: "reserved", value: 0 }],
      }),
    ).not.toThrow();
  });

  test("rejects an optional declaration its operation kind never reads", () => {
    // An inert declaration is more dangerous than an invalid one: it reads as a
    // behavior guarantee while every renderer silently ignores it.
    expect(() =>
      validate({
        name: "read_shelf_slot",
        kind: "read",
        predicate: [{ column: "shelf_id", operator: "=", brand: "ShelfId" }],
        setColumns: ["reserved"],
      }),
    ).toThrow("whose emitters never read it");
  });

  test("rejects a predicate with no emitted index coverage", () => {
    // A predicate can be syntactically valid and still force a table scan; only a key
    // the schema compiler actually emits may discharge that access-path gate.
    expect(() =>
      validate({
        name: "read_by_reserved_shelf_slot",
        kind: "read",
        predicate: [{ column: "reserved", operator: "=" }],
      }),
    ).toThrow("predicate is not covered by an emitted key or index");
  });

  test("accepts an ordered head only on the keyed primary-key order", () => {
    expect(() =>
      validate({
        name: "read_head_shelf_slot",
        kind: "read",
        orderedHead: { column: "shelf_id" },
      }),
    ).not.toThrow();
  });
});
