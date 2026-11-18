import { describe, expect, test } from "bun:test";
import type { LocalSQLiteColumnSpec } from "./schema";
import { normalizeLocalSQLiteSpec } from "./spec";
import {
  cloneSpec,
  loadExampleRaw,
  operationNamed,
  renderRaw,
  tableNamed,
} from "./test-support";

async function fresh() {
  return cloneSpec(await loadExampleRaw());
}

// Each brand is declared once across the generated types, so each column takes its own.
function textColumn(name: string): LocalSQLiteColumnSpec {
  return {
    name,
    sqliteType: "TEXT",
    nullable: false,
    brand: `SignedInReader${name.replace(/(^|_)([a-z0-9])/g, (_, __, c: string) => c.toUpperCase())}`,
  };
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

// Each shape below used to normalize and then emit Kotlin or Swift that does not compile.
// Refusing it here names the spec entry; the compiler would have named a line of output.
describe("derived identifier checks", () => {
  test("refuses two operations whose names derive one method on a table", async () => {
    // `set_theme_app_settings` loses its table suffix and becomes `setTheme`, which is
    // what `set_theme` becomes too: one operations object would declare it twice.
    const spec = await fresh();
    tableNamed(spec, "app_settings").operations.push({
      name: "set_theme",
      kind: "update",
      predicate: [{ column: "singleton_id", operator: "=" }],
      setColumns: ["theme"],
    });

    expect(() => normalizeLocalSQLiteSpec(spec)).toThrow(
      "operation set_theme and operation set_theme_app_settings both derive setTheme in AppSettings's operations",
    );
  });

  test("refuses two tables' operations that derive one database method", async () => {
    // Every table's operations are methods of the one generated database class.
    const spec = await fresh();
    const read = operationNamed(
      tableNamed(spec, "app_settings"),
      "read_app_settings",
    );
    tableNamed(spec, "signed_in_reader").operations.push({
      ...read,
      predicate: [{ column: "singleton_id", operator: "=" }],
    });

    expect(() => normalizeLocalSQLiteSpec(spec)).toThrow(
      "both derive readAppSettings in the generated database class",
    );
  });

  test("refuses an index whose SQL constant is an operation's", async () => {
    // An index's constant is its name, upper-cased; an operation's is its verb and the
    // table's noun. `read_reader` collides with the signed-in reader's read.
    const spec = await fresh();
    const table = tableNamed(spec, "signed_in_reader");
    table.analyze = true;
    table.indexes.push({ name: "read_reader", columns: ["reader_id"] });

    expect(() => normalizeLocalSQLiteSpec(spec)).toThrow(
      "both derive READ_READER_SQL in the generated Kotlin SQL constants",
    );
  });

  test("refuses two columns whose fields derive one name", async () => {
    // `note_1` and `note1` are both `note1` once camel-cased.
    const spec = await fresh();
    tableNamed(spec, "signed_in_reader").columns.push(
      { ...textColumn("note_1"), brand: "SignedInReaderFirstNote" },
      { ...textColumn("note1"), brand: "SignedInReaderOtherNote" },
    );

    expect(() => normalizeLocalSQLiteSpec(spec)).toThrow(
      "column signed_in_reader.note1 and column signed_in_reader.note_1 both derive note1 in SignedInReaderRow's fields",
    );
  });

  test("refuses a brand declared twice, or named like a generated type", async () => {
    // Each brand is declared as a Kotlin value class and a Swift struct of its name.
    const twice = await fresh();
    tableNamed(twice, "signed_in_reader").columns.push({
      ...textColumn("nickname"),
      brand: "SignedInReaderId",
    });
    expect(() => normalizeLocalSQLiteSpec(twice)).toThrow(
      "column signed_in_reader.nickname's brand and column signed_in_reader.reader_id's brand both derive SignedInReaderId in the generated type names",
    );

    const rowType = await fresh();
    tableNamed(rowType, "signed_in_reader").columns.push({
      ...textColumn("nickname"),
      brand: "SignedInReaderRow",
    });
    expect(() => normalizeLocalSQLiteSpec(rowType)).toThrow(
      "column signed_in_reader.nickname's brand and table signed_in_reader both derive SignedInReaderRow in the generated type names",
    );
  });

  test("refuses a column whose field is a Kotlin or a Swift keyword", async () => {
    const kotlin = await fresh();
    tableNamed(kotlin, "signed_in_reader").columns.push(textColumn("when"));
    expect(() => normalizeLocalSQLiteSpec(kotlin)).toThrow(
      'column signed_in_reader.when derives the identifier "when", which is a Kotlin keyword',
    );

    for (const keyword of ["default", "precedencegroup"]) {
      const swift = await fresh();
      tableNamed(swift, "signed_in_reader").columns.push(textColumn(keyword));
      expect(() => normalizeLocalSQLiteSpec(swift)).toThrow(
        `column signed_in_reader.${keyword} derives the identifier "${keyword}", which is a Swift keyword`,
      );
    }
  });

  test("refuses channel methods whose Kotlin cases are one", async () => {
    // `readURL` and `readUrl` are distinct wire names and Swift cases, but both are
    // READ_URL in the subject's Kotlin enum.
    const spec = await fresh();
    const [settings] = spec.channel.subjects;
    settings!.methods.push(
      { name: "readURL", returns: "stringOrNull" },
      { name: "readUrl", returns: "stringOrNull" },
    );

    expect(() => normalizeLocalSQLiteSpec(spec)).toThrow(
      "channel method settings.readUrl and channel method settings.readURL both derive READ_URL in LocalSQLiteSettingsMethod's cases",
    );
  });

  test("refuses channel methods of two subjects that derive one Dart constant", async () => {
    // Subject `a` with method `bC` and subject `aB` with method `c` are both `aBC`.
    const spec = await fresh();
    spec.channel.subjects.push(
      {
        name: "a",
        prefix: "localSQLite.a.",
        methods: [{ name: "bC", returns: "void" }],
      },
      {
        name: "aB",
        prefix: "localSQLite.aB.",
        methods: [{ name: "c", returns: "void" }],
      },
    );

    expect(() => normalizeLocalSQLiteSpec(spec)).toThrow(
      "channel method aB.c and channel method a.bC both derive aBC in the generated Dart channel constants",
    );
  });

  test("refuses a channel subject that is a Swift keyword", async () => {
    // A subject is a Swift enum case as written, and `default` is not one.
    const spec = await fresh();
    spec.channel.subjects.push({
      name: "default",
      prefix: "localSQLite.default.",
      methods: [{ name: "read", returns: "void" }],
    });

    expect(() => normalizeLocalSQLiteSpec(spec)).toThrow(
      'channel subject default derives the identifier "default", which is a Swift keyword',
    );
  });

  test("refuses a brand that is a Swift keyword", async () => {
    // A brand is declared as a Swift struct of its name. The brand pattern already
    // refuses a lowercase name, and with it every Kotlin keyword.
    for (const [brand, language] of [
      ["Self", "Swift"],
      ["Any", "Swift"],
    ] as const) {
      const spec = await fresh();
      tableNamed(spec, "signed_in_reader").columns.push({
        ...textColumn("nickname"),
        brand,
      });
      expect(() => normalizeLocalSQLiteSpec(spec)).toThrow(
        `column signed_in_reader.nickname's brand derives the identifier "${brand}", which is a ${language} keyword`,
      );
    }
  });

  // The checks above refuse what would not compile, or would bind the wrong value; each
  // shape here is one they must still admit.
  test("admits names that only resemble a refused one", async () => {
    // A channel subject lands as written only in Swift, so a Kotlin keyword is a legal
    // subject.
    const subject = await fresh();
    subject.channel.subjects.push({
      name: "when",
      prefix: "localSQLite.when.",
      methods: [{ name: "read", returns: "void" }],
    });
    expect(() => normalizeLocalSQLiteSpec(subject)).not.toThrow();

    // Words Swift reserves only in particular contexts name a field and a method.
    const contextual = await fresh();
    tableNamed(contextual, "signed_in_reader").columns.push(
      textColumn("final"),
      textColumn("open"),
    );
    expect(() => normalizeLocalSQLiteSpec(contextual)).not.toThrow();

    // A fixed singleton's slot column is never emitted as a field or a parameter, so a
    // value column whose field it would collide with is legal.
    const slot = await fresh();
    slot.tables.push({
      name: "step_counter",
      doc: "Steps taken since the counter was last reset.",
      primaryKey: ["slot_1"],
      uniqueKeys: [],
      indexes: [],
      analyze: false,
      columns: [
        {
          name: "slot_1",
          sqliteType: "INTEGER",
          nullable: false,
          brand: "StepCounterSlotId",
          check: "slot_1 = 1",
        },
        {
          name: "slot1",
          sqliteType: "INTEGER",
          nullable: false,
          brand: "StepCounterSlotValue",
        },
        {
          name: "row_version",
          sqliteType: "INTEGER",
          nullable: false,
          brand: "StoredStepCounterRowVersion",
          check: "row_version >= 1",
        },
      ],
      operations: [
        {
          name: "read_step_counter",
          kind: "read",
          predicate: [{ column: "slot_1", operator: "=" }],
        },
      ],
    });
    expect(() => normalizeLocalSQLiteSpec(slot)).not.toThrow();
  });

  // Not a refusal: the version-reader constant used to be emitted inside each read's
  // branch, so a table that reads its version back declared it once per read - zero times
  // or twice where it has no read or two. Both shapes are legitimate, so the constant is
  // now anchored to one operation. The Swift type-check suite compiles them.
  test("declares the version-reader constant once whatever a table's reads", async () => {
    const noRead = await fresh();
    const reader = tableNamed(noRead, "signed_in_reader");
    reader.operations = reader.operations.filter(
      (operation) => operation.kind !== "read",
    );
    const twoReads = await fresh();
    tableNamed(twoReads, "signed_in_reader").operations.push({
      name: "read_again_signed_in_reader",
      kind: "read",
      predicate: [{ column: "singleton_id", operator: "=" }],
    });

    for (const spec of [noRead, twoReads]) {
      const { kotlin, swift } = renderRaw(spec);
      expect(occurrences(kotlin, 'READ_READER_VERSION_SQL = """')).toBe(1);
      expect(occurrences(swift, 'readReaderVersionSQL = """')).toBe(1);
    }
  });
});
