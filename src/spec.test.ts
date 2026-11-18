import { describe, expect, test } from "bun:test";
import { normalizeLocalSQLiteTable } from "./table";
import { loadExample, loadExampleRaw, tableNamed } from "./test-support";

describe("spec compiler", () => {
  test("resolves an owner-sourced insert across normalized tables", async () => {
    // The owner read and the target insert must be one resolved contract; leaving the
    // source as unchecked authored text would generate an owner-scoped transaction
    // whose owner read and insert could silently disagree.
    const spec = await loadExample();
    const queue = spec.tables.find(
      (table) => table.spec.name === "pending_highlight",
    );
    const insert = queue?.operations.find(
      (operation) => operation.category === "insertForCurrentOwner",
    );

    expect(insert?.ownerSource?.tableName).toBe("signed_in_reader");
    expect(insert?.ownerSource?.slotColumnName).toBe("singleton_id");
    expect(insert?.ownerSource?.valueColumnName).toBe("reader_id");
    expect(insert?.ownerSource?.intoColumn.name).toBe("reader_id");
  });

  test("normalizes a table without the root compiler or renderers", async () => {
    const table = normalizeLocalSQLiteTable(
      tableNamed(await loadExampleRaw(), "reader_profile"),
    );

    expect(table.keyedSlot?.name).toBe("reader_id");
    expect(
      table.operations
        .find(
          (operation) =>
            operation.spec.name === "set_display_name_reader_profile",
        )
        ?.setColumns.map((column) => column.name),
    ).toEqual(["display_name"]);
  });
});
