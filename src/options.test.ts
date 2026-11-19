import { describe, expect, test } from "bun:test";
import type { LocalSQLiteRenderOptions } from "./options";
import { renderLocalSQLiteSources } from "./render";
import { loadExample } from "./test-support";

const OPTIONS: LocalSQLiteRenderOptions = {
  kotlinPackage: "org.example.notes.storage",
  databaseFileName: "notes.sqlite3",
  notice: "// other app header",
};

describe("render options", () => {
  // Each option names something of the consumer's own. Guards the regression where a
  // template keeps a value literally: an app would ship a package or a database file
  // named for someone else.
  test("every app-identifying value in the output comes from the options", async () => {
    const sources = renderLocalSQLiteSources(await loadExample(), OPTIONS);

    expect(sources.kotlin).toContain("package org.example.notes.storage\n");
    expect(sources.kotlin).toContain(
      'APP_PRIVATE_DATABASE_NAME = "notes.sqlite3"',
    );
    expect(sources.swift).toContain('databaseName = "notes.sqlite3"');
    for (const output of [sources.kotlin, sources.swift, sources.dart]) {
      expect(output.startsWith("// other app header\n")).toBe(true);
    }
  });

  // The binding is imported from the package curlew-sqlite publishes it in, which its
  // JNI shim resolves the binding class by; any other package would not compile against
  // that library.
  test("imports the binding from curlew-sqlite's published package", async () => {
    const { kotlin } = renderLocalSQLiteSources(await loadExample(), OPTIONS);

    for (const symbol of [
      "AndroidBundledSQLiteSourceIdGuard",
      "AndroidBundledSQLiteVersionGuard",
      "CurlewSQLite",
    ]) {
      expect(kotlin).toContain(`import com.curlewlabs.sqlite.${symbol}\n`);
    }
  });

  // An option the renderer does not read would be dropped silently, and the output would
  // differ from what the caller asked for. bindingPackage is the case that motivates it:
  // a caller still passing it would otherwise get imports from another package than the
  // one it named.
  test.each(["bindingPackage", "kotlinPackages"])(
    "refuses the unknown option %p",
    async (key) => {
      const spec = await loadExample();
      expect(() =>
        renderLocalSQLiteSources(spec, {
          ...OPTIONS,
          [key]: "org.example.notes.sqlite",
        } as LocalSQLiteRenderOptions),
      ).toThrow(`unknown render option "${key}"`);
    },
  );

  // Each value is emitted verbatim into a Kotlin package/import line or a string
  // literal, so an unchecked one would produce source that does not compile, or a
  // literal a quote could end early.
  test.each([
    ["kotlinPackage", "org.example.Notes"],
    ["kotlinPackage", "org.example..notes"],
    ["kotlinPackage", "org.example.notes;"],
    ["kotlinPackage", ""],
  ] as const)("rejects %s %p", async (key, value) => {
    const spec = await loadExample();
    expect(() =>
      renderLocalSQLiteSources(spec, { ...OPTIONS, [key]: value }),
    ).toThrow(
      `${key} "${value}" must be a lowercase dotted Kotlin package name`,
    );
  });

  // A Kotlin `package` line does not parse with a keyword segment, which the pattern
  // above admits because a keyword is a lowercase word.
  test.each([
    ["kotlinPackage", "org.example.object", "object"],
    ["kotlinPackage", "org.when.storage", "when"],
  ] as const)("rejects %s %p", async (key, value, keyword) => {
    const spec = await loadExample();
    expect(() =>
      renderLocalSQLiteSources(spec, { ...OPTIONS, [key]: value }),
    ).toThrow(
      `${key} "${value}" has the segment "${keyword}", which is a Kotlin keyword`,
    );
  });

  test.each(['notes".sqlite3', "data/notes.sqlite3", ".notes", ""])(
    "rejects databaseFileName %p",
    async (value) => {
      const spec = await loadExample();
      expect(() =>
        renderLocalSQLiteSources(spec, { ...OPTIONS, databaseFileName: value }),
      ).toThrow(`databaseFileName "${value}" must be a plain file name`);
    },
  );
});
