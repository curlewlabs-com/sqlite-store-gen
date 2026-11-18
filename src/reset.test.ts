import { describe, expect, test } from "bun:test";
import { normalizeLocalSQLiteSpec } from "./spec";
import { cloneSpec, loadExampleRaw, render, tableNamed } from "./test-support";

function resetSqlBlocks(
  spec: ReturnType<typeof normalizeLocalSQLiteSpec>,
): string[] {
  const sources = render(spec);
  // The native renderers differ only in the constant's casing, so one delimiter pair
  // isolates the reset statement on each platform.
  return [sources.kotlin, sources.swift].map((rendered) => {
    const match =
      /(?:RESET_TO_DEFAULTS_SETTINGS_SQL|resetToDefaultsSettingsSQL) = """([\s\S]*?)"""/.exec(
        rendered,
      );
    if (match?.[1] === undefined) {
      throw new Error(
        "rendered output declares no settings reset SQL constant",
      );
    }
    return match[1];
  });
}

describe("reset contract", () => {
  test("resets every settings column but the ones that declare they survive", async () => {
    // The expectation is DERIVED from the spec's own survivesReset flags rather than a
    // hand-written column list, so a column added to the table later tightens this test
    // instead of breaking it - which is the whole reason the reset's targets are derived
    // rather than authored.
    const raw = await loadExampleRaw();
    const settings = tableNamed(raw, "app_settings");
    const settable = settings.columns.filter(
      (column) =>
        column.name !== "singleton_id" && column.name !== "row_version",
    );
    expect(
      settable
        .filter((column) => column.survivesReset === true)
        .map((column) => column.name),
    ).toEqual(["tour_shown"]);

    const sources = render(normalizeLocalSQLiteSpec(raw));
    for (const statement of resetSqlBlocks(normalizeLocalSQLiteSpec(raw))) {
      for (const column of settable) {
        const assignment = `${column.name} = ${
          column.sqliteType === "TEXT" ? `'${column.default}'` : column.default
        }`;
        if (column.survivesReset === true) {
          expect(statement).not.toContain(assignment);
        } else {
          expect(statement).toContain(assignment);
        }
      }
    }
    // The values are compiled in, so the statement's only bind is the singleton slot -
    // there is no argument a caller could pass to reset something else.
    expect(sources.kotlin).toContain(
      "fun resetToDefaults(database: GeneratedLocalSQLiteDatabase): Boolean",
    );
    expect(sources.swift).toContain(
      "static func resetToDefaults(database: GeneratedLocalSQLiteDatabase) throws -> Bool",
    );
  });

  test("covers a column added later without editing the reset operation", async () => {
    // Adding a settable column to the table is the ONLY edit needed for the reset to
    // reach it. A reset that named its columns would keep missing this one until someone
    // remembered the list.
    const spec = cloneSpec(await loadExampleRaw());
    tableNamed(spec, "app_settings").columns.push({
      name: "font_family",
      sqliteType: "TEXT",
      nullable: false,
      brand: "AppSettingsFontFamily",
      default: "",
    });

    for (const statement of resetSqlBlocks(normalizeLocalSQLiteSpec(spec))) {
      expect(statement).toContain("font_family = ''");
    }
  });

  test("rejects a resetToDefaults that authors its own setColumns", async () => {
    // An authored list and the derived one disagree the moment a column is added, and the
    // one that would win is the one that stops covering new columns.
    const invalid = cloneSpec(await loadExampleRaw());
    tableNamed(invalid, "app_settings").operations.find(
      (operation) => operation.kind === "resetToDefaults",
    )!.setColumns = ["theme"];

    expect(() => normalizeLocalSQLiteSpec(invalid)).toThrow(
      "must not declare setColumns",
    );
  });

  test("rejects a reset target that declares no default", async () => {
    // The SET clause emits the declared default as a literal, so a target without one has
    // no value to reset to - the same requirement an ensure makes, for the same reason.
    const invalid = cloneSpec(await loadExampleRaw());
    tableNamed(invalid, "app_settings").columns.push({
      name: "font_family",
      sqliteType: "TEXT",
      nullable: false,
      brand: "AppSettingsFontFamily",
    });

    expect(() => normalizeLocalSQLiteSpec(invalid)).toThrow(
      "reset columns lacking a default: font_family",
    );
  });

  test("rejects a survivesReset column on a table with no reset", async () => {
    // A flag with no reset to opt out of reads as a guarantee that something protects the
    // column; an inert one gets believed while nothing enforces it.
    const invalid = cloneSpec(await loadExampleRaw());
    tableNamed(invalid, "reader_profile").columns.push({
      name: "sample_flag",
      sqliteType: "INTEGER",
      nullable: false,
      brand: "ReaderProfileSampleFlag",
      default: 0,
      survivesReset: true,
    });

    expect(() => normalizeLocalSQLiteSpec(invalid)).toThrow(
      "no resetToDefaults operation to opt out of",
    );
  });

  test("rejects a second resetToDefaults on one table", async () => {
    // survivesReset names "the" reset; a second one leaves every flagged column ambiguous
    // and silently shares an exclusion set neither operation authored.
    const invalid = cloneSpec(await loadExampleRaw());
    tableNamed(invalid, "app_settings").operations.push({
      name: "reset_again_app_settings",
      kind: "resetToDefaults",
      predicate: [{ column: "singleton_id", operator: "=" }],
    });

    expect(() => normalizeLocalSQLiteSpec(invalid)).toThrow(
      "declares more than one resetToDefaults",
    );
  });
});
