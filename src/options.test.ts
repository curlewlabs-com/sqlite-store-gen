import { describe, expect, test } from "bun:test";
import {
  DEFAULT_BINDING_PACKAGE,
  type LocalSQLiteRenderOptions,
} from "./options";
import { renderLocalSQLiteSources } from "./render";
import { loadExample } from "./test-support";

const OPTIONS: LocalSQLiteRenderOptions = {
  kotlinPackage: "org.example.notes.storage",
  bindingPackage: "org.example.notes.sqlite",
  databaseFileName: "notes.sqlite3",
  notice: "// other app header",
};

describe("render options", () => {
  // Each option names something of the consumer's own. Guards the regression where a
  // template keeps a value literally: an app would ship a Kotlin import it cannot
  // resolve, or a database file named for someone else.
  test("every app-identifying value in the output comes from the options", async () => {
    const sources = renderLocalSQLiteSources(await loadExample(), OPTIONS);

    expect(sources.kotlin).toContain("package org.example.notes.storage\n");
    for (const symbol of [
      "AndroidBundledSQLiteSourceIdGuard",
      "AndroidBundledSQLiteVersionGuard",
      "CurlewSQLite",
    ]) {
      expect(sources.kotlin).toContain(
        `import org.example.notes.sqlite.${symbol}\n`,
      );
    }
    expect(sources.kotlin).toContain(
      'APP_PRIVATE_DATABASE_NAME = "notes.sqlite3"',
    );
    expect(sources.swift).toContain('databaseName = "notes.sqlite3"');
    for (const output of [sources.kotlin, sources.swift, sources.dart]) {
      expect(output.startsWith("// other app header\n")).toBe(true);
    }
  });

  // An app taking curlew-sqlite as published supplies no binding package. The default
  // has to be the package that library's JNI shim resolves its binding class in, or the
  // emitted imports would not compile against it.
  test("defaults the binding package to curlew-sqlite's published one", async () => {
    const { bindingPackage: _omitted, ...rest } = OPTIONS;
    const { kotlin } = renderLocalSQLiteSources(await loadExample(), rest);

    expect(DEFAULT_BINDING_PACKAGE).toBe("com.curlewlabs.sqlite");
    expect(kotlin).toContain("import com.curlewlabs.sqlite.CurlewSQLite\n");
  });

  // Each value is emitted verbatim into a Kotlin package/import line or a string
  // literal, so an unchecked one would produce source that does not compile, or a
  // literal a quote could end early.
  test.each([
    ["kotlinPackage", "org.example.Notes"],
    ["kotlinPackage", "org.example..notes"],
    ["bindingPackage", "org.example.notes;"],
    ["bindingPackage", ""],
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
    ["bindingPackage", "org.when.sqlite", "when"],
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
