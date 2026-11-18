import { describe, expect, test } from "bun:test";
import {
  kotlinOperationMethod,
  kotlinOperationsObject,
} from "./kotlin-operation";
import { swiftOperationsEnum } from "./swift-api";
import { swiftOperationMethod } from "./swift-operation";
import { loadExample } from "./test-support";

async function stage() {
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
  return { queue, insert };
}

// A producer must not choose the owner its row is recorded under. The generated database
// method reads that owner inside the write transaction, while the public wrapper exposes
// only the values the caller genuinely owns.
describe("owner-sourced insert renderers", () => {
  test("Kotlin keeps the insert atomic and the owner out of its public API", async () => {
    const { queue, insert } = await stage();
    const method = kotlinOperationMethod(queue, insert);
    expect(method).toContain(
      "return withImmediateTransaction(PendingHighlightInsertResult.Busy)",
    );
    expect(method).toContain(
      'withStatement(READ_OWNER_FOR_STAGE_HIGHLIGHT_SQL, "read current owner")',
    );
    expect(method).toContain("bindText(owner, 2, statement)");

    // Scoped to the insert's own parameter list: the table's owner-scoped delete takes
    // an owner, so the type name appears elsewhere in the object.
    const api = kotlinOperationsObject(queue);
    const start = api.indexOf(
      "fun stage(\n        database: GeneratedLocalSQLiteDatabase,",
    );
    expect(start).toBeGreaterThanOrEqual(0);
    const signature = api.slice(start, api.indexOf(")", start));
    expect(signature).toContain("stagedAtMs: PendingHighlightStagedAtMs,");
    expect(signature).not.toContain("readerId");
  });

  test("Swift keeps the insert atomic and the owner out of its public API", async () => {
    const { queue, insert } = await stage();
    const method = swiftOperationMethod(queue, insert);
    expect(method).toContain("return try withImmediateTransaction(");
    expect(method).toContain("let owner = try readOwnerForStageHighlight()");
    expect(method).toContain(
      "try bindText(owner, at: 2, statement: statement)",
    );

    const api = swiftOperationsEnum(queue);
    const start = api.indexOf(
      "static func stage(\n        database: GeneratedLocalSQLiteDatabase,",
    );
    expect(start).toBeGreaterThanOrEqual(0);
    const signature = api.slice(start, api.indexOf(")", start));
    expect(signature).toContain("stagedAtMs: PendingHighlightStagedAtMs,");
    expect(signature).not.toContain("readerId");
  });
});
