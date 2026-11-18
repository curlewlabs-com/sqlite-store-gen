import { describe, expect, test } from "bun:test";
import { normalizeLocalSQLiteSpec } from "./spec";
import {
  cloneSpec,
  loadExample,
  loadExampleRaw,
  NON_READ_OPERATIONS,
  operationNamed,
  PREDICATE_FREE_KINDS,
  render,
  tableNamed,
} from "./test-support";

async function fresh() {
  return cloneSpec(await loadExampleRaw());
}

function primaryKeyOf(
  spec: Awaited<ReturnType<typeof fresh>>,
  table: string,
): string {
  const [column] = tableNamed(spec, table).primaryKey;
  if (column === undefined) throw new Error(`${table} declares no primary key`);
  return column;
}

const BOUNDED_SCAN = {
  hardRowBound: "one row per highlight staged since the last upload",
  caller: "the highlight upload pass",
  ordering: "staged_at_ms ASC",
  diagnostic: "logs the rows uploaded per pass",
};

describe("operation spec validation", () => {
  test("validates an operation predicate against its own table's columns", async () => {
    // An operation must be validated against its own table's columns, so it cannot
    // borrow a column another table (or a retired one) declares.
    const invalid = await fresh();
    tableNamed(invalid, "reader_profile").operations = [
      {
        name: "read_reader_profile_by_theme",
        kind: "read",
        predicate: [{ column: "theme", operator: "=" }],
      },
    ];

    expect(() => normalizeLocalSQLiteSpec(invalid)).toThrow(
      "read_reader_profile_by_theme references unknown predicate column theme",
    );
  });

  // The guard is what turns a claim into one statement, so what it emits is pinned
  // exactly: the caller's SET bind, the bound key, and then the literal the row must still
  // hold. The guard contributes no `?`, which is the property that lets it sit on the
  // very column the statement is setting.
  test("compiles an update's guard into the WHERE as a literal, binding nothing", async () => {
    const sources = render(await loadExample());

    // On every platform rather than one: a guard that reached one language's statement and
    // not the other's would leave the two disagreeing about whether the claim is atomic.
    for (const output of [sources.kotlin, sources.swift]) {
      expect(output.replace(/\s+/g, " ")).toContain(
        "UPDATE app_settings SET tour_shown = ? WHERE singleton_id = ? AND tour_shown = 0",
      );
    }
  });

  test("rejects a guard on a column the operation's predicate already binds", async () => {
    // A bound term already fixes the value the caller asked for. A literal beside it either
    // restates that or silently overrides a caller whose signature still takes the argument.
    const invalid = await fresh();
    tableNamed(invalid, "app_settings").operations.push({
      name: "claim_singleton_app_settings",
      kind: "update",
      setColumns: ["tour_shown"],
      predicate: [{ column: "singleton_id", operator: "=" }],
      guard: [{ column: "singleton_id", value: 1 }],
    });

    expect(() => normalizeLocalSQLiteSpec(invalid)).toThrow(
      "claim_singleton_app_settings guards singleton_id, which its predicate already binds",
    );
  });

  test("rejects a guard whose literal is the wrong type for its column", async () => {
    // Silent without the check: a TEXT literal against an INTEGER column compares unequal
    // forever, so the update matches no row and every caller is declined - which reads
    // exactly like a one-shot that has already been spent.
    const invalid = await fresh();
    tableNamed(invalid, "app_settings").operations.push({
      name: "claim_tour_as_text_app_settings",
      kind: "update",
      setColumns: ["tour_shown"],
      predicate: [{ column: "singleton_id", operator: "=" }],
      guard: [{ column: "tour_shown", value: "0" }],
    });

    expect(() => normalizeLocalSQLiteSpec(invalid)).toThrow(
      "claim_tour_as_text_app_settings guards tour_shown with a string but the column is INTEGER",
    );
  });

  // The co-write's rejections, one per way a declaration can look right and emit something
  // else. Each is silent without its check: a misdeclared `alsoSet` either emits nothing
  // (the wrong kind never reads it) or an UPDATE that binds the wrong slot, and either way
  // the row and the pointer at it can land separately - the failure the co-write removes.
  test("rejects an alsoSet on a kind whose emitters never render one", async () => {
    // The one that fails OPEN: an update reads no alsoSet, so the second write silently
    // does not happen and the caller believes the pair is atomic.
    const invalid = await fresh();
    tableNamed(invalid, "app_settings").operations.push({
      name: "set_with_also_set_app_settings",
      kind: "update",
      setColumns: ["theme"],
      predicate: [{ column: "singleton_id", operator: "=" }],
      alsoSet: { table: "signed_in_reader", setColumns: ["reader_id"] },
    });

    expect(() => normalizeLocalSQLiteSpec(invalid)).toThrow(
      "set_with_also_set_app_settings declares alsoSet but is a update",
    );
  });

  test("rejects an alsoSet against a table the spec does not declare", async () => {
    const invalid = await fresh();
    operationNamed(
      tableNamed(invalid, "pending_highlight"),
      "stage_pending_highlight",
    ).alsoSet = { table: "app_preferences", setColumns: ["theme"] };

    expect(() => normalizeLocalSQLiteSpec(invalid)).toThrow(
      "stage_pending_highlight also-sets unknown table app_preferences",
    );
  });

  test("rejects an alsoSet aimed at the inserting table itself", async () => {
    // The columns wanted are the insert's own, so this is a column list, not a second
    // write racing the same row inside one transaction.
    const invalid = await fresh();
    operationNamed(
      tableNamed(invalid, "pending_highlight"),
      "stage_pending_highlight",
    ).alsoSet = { table: "pending_highlight", setColumns: ["upload_attempts"] };

    expect(() => normalizeLocalSQLiteSpec(invalid)).toThrow(
      "also-sets its own table pending_highlight",
    );
  });

  test("rejects an alsoSet against an owner-keyed table", async () => {
    // The emitted UPDATE keys the target on its singleton slot, which an owner-keyed table
    // has no fixed value for - so it would bind a key nothing is, and match no row.
    const invalid = await fresh();
    operationNamed(
      tableNamed(invalid, "pending_highlight"),
      "stage_pending_highlight",
    ).alsoSet = { table: "reader_profile", setColumns: ["display_name"] };

    expect(() => normalizeLocalSQLiteSpec(invalid)).toThrow(
      "also-sets owner-keyed table reader_profile",
    );
  });

  test("rejects an alsoSet that sets no columns", async () => {
    const invalid = await fresh();
    operationNamed(
      tableNamed(invalid, "pending_highlight"),
      "stage_pending_highlight",
    ).alsoSet = { table: "app_settings", setColumns: [] };

    expect(() => normalizeLocalSQLiteSpec(invalid)).toThrow(
      "declares an alsoSet on app_settings with no setColumns",
    );
  });

  test("rejects an alsoSet naming a column its target cannot set", async () => {
    // The slot and the version are not settable, so aiming at one would emit an UPDATE
    // against the key it also binds in the WHERE.
    const invalid = await fresh();
    operationNamed(
      tableNamed(invalid, "pending_highlight"),
      "stage_pending_highlight",
    ).alsoSet = { table: "app_settings", setColumns: ["singleton_id"] };

    expect(() => normalizeLocalSQLiteSpec(invalid)).toThrow(
      "also-sets singleton_id, which is not a settable column of app_settings",
    );
  });

  test("rejects a guard on a kind whose emitters never render one", async () => {
    // A read has no row to refuse; a guard there would read as a claim while nothing
    // about the emitted SELECT is one.
    const invalid = await fresh();
    tableNamed(invalid, "app_settings").operations.push({
      name: "read_guarded_app_settings",
      kind: "read",
      predicate: [{ column: "singleton_id", operator: "=" }],
      guard: [{ column: "tour_shown", value: 0 }],
    });

    expect(() => normalizeLocalSQLiteSpec(invalid)).toThrow(
      "read_guarded_app_settings declares guard but is a read",
    );
  });

  test("rejects a predicate without key or index coverage", async () => {
    // display_name is a real column but neither a key nor an index, so a predicate on it
    // is an unindexed scan the generator must reject.
    const invalid = await fresh();
    tableNamed(invalid, "reader_profile").operations = [
      {
        name: "read_reader_profile_by_display_name",
        kind: "read",
        predicate: [{ column: "display_name", operator: "=" }],
      },
    ];

    expect(() => normalizeLocalSQLiteSpec(invalid)).toThrow(
      "read_reader_profile_by_display_name predicate is not covered",
    );
  });

  // `orderedHead` is admitted as KEYED access rather than as a bounded scan, so the
  // conditions that make it one are proved at generation rather than left to the author.
  // In every case below the wrong declaration emits source that READS correct.

  test("rejects an orderedHead that does not order by the primary key", async () => {
    // `ORDER BY <column> ASC LIMIT 1` differs from the correct statement by the column name
    // alone, so a wrong ordering column still reads as a head read while asking for an
    // order the key's own b-tree does not satisfy - and a cost that now grows with the
    // rows stored, which is what the shape is exempt from a row bound for not having.
    const invalid = await fresh();
    operationNamed(
      tableNamed(invalid, "pending_highlight"),
      "read_head_pending_highlight",
    ).orderedHead = { column: "reader_id" };

    expect(() => normalizeLocalSQLiteSpec(invalid)).toThrow(
      "orders by reader_id, which is not pending_highlight's single-column primary key",
    );
  });

  test("rejects an orderedHead that also declares a predicate", async () => {
    // The head read renders the ORDER BY in PLACE OF the WHERE while its parameters still
    // come from the predicate - so the pair emits a method that takes a key and binds it
    // against a statement with no placeholder for it.
    const invalid = await fresh();
    operationNamed(
      tableNamed(invalid, "pending_highlight"),
      "read_head_pending_highlight",
    ).predicate = [
      {
        column: "staged_at_ms",
        operator: "=",
        brand: "PendingHighlightStagedAtMs",
      },
    ];

    expect(() => normalizeLocalSQLiteSpec(invalid)).toThrow(
      "declares an orderedHead and a predicate",
    );
  });

  test("rejects an orderedHead that also declares a bounded scan exception", async () => {
    // The exception's `hardRowBound` is a reviewed claim about how many rows an unindexed
    // operation may touch. Accepting it beside a head would record that claim for a read
    // whose cost does not depend on it.
    const invalid = await fresh();
    operationNamed(
      tableNamed(invalid, "pending_highlight"),
      "read_head_pending_highlight",
    ).boundedScanException = BOUNDED_SCAN;

    expect(() => normalizeLocalSQLiteSpec(invalid)).toThrow(
      "declares an orderedHead and a bounded scan exception",
    );
  });

  // Every non-read kind, not one representative: kinds that return early from the
  // access-path checks were once accepting an orderedHead silently, because the early
  // return skipped the whole declaration rather than just the predicate.
  test("rejects an orderedHead on every operation kind that is not a read", async () => {
    for (const [table, operation, kind] of NON_READ_OPERATIONS) {
      const invalid = await fresh();
      // The table's own primary key, so the ONLY thing wrong is the kind.
      operationNamed(tableNamed(invalid, table), operation).orderedHead = {
        column: primaryKeyOf(invalid, table),
      };

      expect(() => normalizeLocalSQLiteSpec(invalid)).toThrow(
        `${operation} declares orderedHead but is a ${kind}`,
      );
    }
  });

  test("rejects a bounded scan exception on a kind with no predicate to except", async () => {
    // A kind that authors no predicate has nothing to except, so the declaration records a
    // reviewed row bound for an operation that never scans - coverage claimed, not had.
    for (const [table, operation, kind] of NON_READ_OPERATIONS.filter(
      ([, , candidate]) => PREDICATE_FREE_KINDS.includes(candidate),
    )) {
      const invalid = await fresh();
      operationNamed(
        tableNamed(invalid, table),
        operation,
      ).boundedScanException = BOUNDED_SCAN;

      expect(() => normalizeLocalSQLiteSpec(invalid)).toThrow(
        `${operation} declares boundedScanException but is a ${kind}`,
      );
    }
  });

  test("rejects a predicate on a kind whose emitters bind no WHERE", async () => {
    // An insert's predicate is never rendered or bound, so it was not even checked against
    // the table's columns. It reads as scoping the write while the INSERT touches the row.
    const invalid = await fresh();
    operationNamed(
      tableNamed(invalid, "signed_in_reader"),
      "insert_or_replace_signed_in_reader",
    ).predicate = [{ column: "no_such_column", operator: "=" }];

    expect(() => normalizeLocalSQLiteSpec(invalid)).toThrow(
      "insert_or_replace_signed_in_reader declares predicate but is a insert",
    );
  });

  test("rejects setColumns on a read", async () => {
    // On a read `setColumns` is inert, and it reads as a claim that the read is scoped to
    // those columns - the one thing a row read is not.
    const invalid = await fresh();
    operationNamed(
      tableNamed(invalid, "app_settings"),
      "read_app_settings",
    ).setColumns = ["theme"];

    expect(() => normalizeLocalSQLiteSpec(invalid)).toThrow(
      "read_app_settings declares setColumns but is a read",
    );
  });

  test("rejects an orderedHead on a table with no keyedBy", async () => {
    // A fixed singleton holds one row whose key the caller already knows, so a head read
    // there is a keyed read written the long way.
    const invalid = await fresh();
    tableNamed(invalid, "app_settings").operations.push({
      name: "read_head_app_settings",
      kind: "read",
      orderedHead: { column: "singleton_id" },
    });

    expect(() => normalizeLocalSQLiteSpec(invalid)).toThrow(
      "declares an orderedHead on singleton table app_settings",
    );
  });

  // `ownerFrom` is the source of the owner an `insertForCurrentOwner` records under,
  // resolved inside the insert's own transaction rather than passed by the caller. Each
  // rejection below covers a declaration that would emit a transaction reading as
  // owner-scoped without being one; the caller passes no owner either way.

  test("rejects an ownerFrom that sources an owner-keyed table", async () => {
    // The owner read binds SINGLETON_ID as the source's slot, which an owner-keyed table
    // has no fixed value for - so the insert would take its owner from whatever row that
    // bind happened to match.
    const invalid = await fresh();
    operationNamed(
      tableNamed(invalid, "pending_highlight"),
      "stage_pending_highlight",
    ).ownerFrom = {
      table: "reader_profile",
      column: "display_name",
      into: "reader_id",
    };

    expect(() => normalizeLocalSQLiteSpec(invalid)).toThrow(
      "sources its owner from owner-keyed table reader_profile",
    );
  });

  test("rejects an ownerFrom whose target is not TEXT", async () => {
    // The owner is bound with the binder the TARGET column's type picks, so a non-TEXT
    // target emits an integer bind against a String.
    const invalid = await fresh();
    operationNamed(
      tableNamed(invalid, "pending_highlight"),
      "stage_pending_highlight",
    ).ownerFrom = {
      table: "signed_in_reader",
      column: "reader_id",
      into: "upload_attempts",
    };

    expect(() => normalizeLocalSQLiteSpec(invalid)).toThrow(
      "source and target must be TEXT",
    );
  });

  test("rejects an ownerFrom whose source column is not TEXT", async () => {
    // The half that emits working code: reading row_version through the text accessor
    // into a TEXT column compiles everywhere and commits a version number as the owner.
    const invalid = await fresh();
    operationNamed(
      tableNamed(invalid, "pending_highlight"),
      "stage_pending_highlight",
    ).ownerFrom = {
      table: "signed_in_reader",
      column: "row_version",
      into: "reader_id",
    };

    expect(() => normalizeLocalSQLiteSpec(invalid)).toThrow(
      "source and target must be TEXT",
    );
  });

  test("rejects an ownerFrom on an operation that is not an insertForCurrentOwner", async () => {
    // Only the owner-sourced insert emits the owner read, so an ownerFrom anywhere else is
    // inert while it reads as a declaration that the operation is owner-scoped.
    const invalid = await fresh();
    operationNamed(
      tableNamed(invalid, "pending_highlight"),
      "delete_pending_highlight",
    ).ownerFrom = {
      table: "signed_in_reader",
      column: "reader_id",
      into: "reader_id",
    };

    expect(() => normalizeLocalSQLiteSpec(invalid)).toThrow(
      "declares ownerFrom but is a delete",
    );
  });

  test("rejects an insertForCurrentOwner that declares no ownerFrom", async () => {
    const invalid = await fresh();
    delete operationNamed(
      tableNamed(invalid, "pending_highlight"),
      "stage_pending_highlight",
    ).ownerFrom;

    expect(() => normalizeLocalSQLiteSpec(invalid)).toThrow(
      "is an insertForCurrentOwner and must declare ownerFrom",
    );
  });

  test("rejects an ownerFrom whose target is not a settable column", async () => {
    // row_version is the generator's own literal, so filling it from the owner would leave
    // the caller supplying the owner column itself - every part of the shape except the one
    // that makes the owner and the row one fact.
    const invalid = await fresh();
    operationNamed(
      tableNamed(invalid, "pending_highlight"),
      "stage_pending_highlight",
    ).ownerFrom = {
      table: "signed_in_reader",
      column: "reader_id",
      into: "row_version",
    };

    expect(() => normalizeLocalSQLiteSpec(invalid)).toThrow(
      "fills row_version, which is not a settable column of pending_highlight",
    );
  });

  // The inserts bind the key first and the other columns after it in declared order, so
  // a key declared later would put each value in its neighbour's column - silently,
  // where the two share a type, as an integer key and an integer timestamp do.
  test("rejects a table whose primary key is not its first column", async () => {
    const invalid = await fresh();
    const queue = tableNamed(invalid, "pending_highlight");
    const captured = queue.columns.findIndex(
      (column) => column.name === "captured_at_ms",
    );
    queue.columns.unshift(...queue.columns.splice(captured, 1));

    expect(() => normalizeLocalSQLiteSpec(invalid)).toThrow(
      "pending_highlight must declare its primary key staged_at_ms as its first column",
    );
  });

  // An unbranded term takes no argument and binds the fixed singleton slot, so on any
  // other column it becomes `<column> = 1`: a read of the wrong row, or an update or
  // delete of whichever row holds that key.
  test("rejects an unbranded predicate term anywhere but a singleton's slot", async () => {
    for (const [table, operation] of [
      ["reader_profile", "read_reader_profile"],
      ["reader_profile", "delete_reader_profile"],
      ["pending_highlight", "delete_pending_highlight"],
    ] as const) {
      const invalid = await fresh();
      delete operationNamed(tableNamed(invalid, table), operation)
        .predicate![0]!.brand;

      expect(() => normalizeLocalSQLiteSpec(invalid)).toThrow(
        `${operation} predicate term on`,
      );
    }
  });

  // A text default or guard value lands inside Kotlin and Swift string literals, where `$`
  // is a Kotlin template, a backslash an escape, and three quotes the literal's end: each
  // would emit source that does not compile, or compiles to a different value.
  test("rejects a text default or guard value the generated literals cannot carry", async () => {
    for (const value of ["$theme", "a\\b", 'x"""y', "tab\there"]) {
      const withDefault = await fresh();
      tableNamed(withDefault, "app_settings").columns.find(
        (column) => column.name === "theme",
      )!.default = value;
      expect(() => normalizeLocalSQLiteSpec(withDefault)).toThrow(
        "Column theme default",
      );

      const withGuard = await fresh();
      tableNamed(withGuard, "app_settings").operations.push({
        name: "claim_theme_app_settings",
        kind: "update",
        setColumns: ["theme"],
        predicate: [{ column: "singleton_id", operator: "=" }],
        guard: [{ column: "theme", value }],
      });
      expect(() => normalizeLocalSQLiteSpec(withGuard)).toThrow(
        "claim_theme_app_settings guard on theme",
      );
    }
  });

  test("rejects an obsolete-table entry that names any live table", async () => {
    // Dropping a live table would delete stored rows on every open; the reclamation list
    // is strictly for tables this build no longer owns. Every live table is refused, not
    // just the first.
    for (const liveTable of [
      "app_settings",
      "signed_in_reader",
      "reader_profile",
      "pending_highlight",
    ]) {
      const invalid = await fresh();
      invalid.obsoleteTables = [liveTable];
      expect(() => normalizeLocalSQLiteSpec(invalid)).toThrow(
        `obsoleteTables must not include the live table ${liveTable}`,
      );
    }
  });

  test("rejects a non-snake-case obsolete-table name", async () => {
    // The name is interpolated straight into the generated DROP statement, so a
    // non-identifier entry must fail generation rather than emit arbitrary SQL.
    const invalid = await fresh();
    invalid.obsoleteTables = ["DROP TABLE students"];

    expect(() => normalizeLocalSQLiteSpec(invalid)).toThrow(
      "must be a snake_case table name",
    );
  });
});
