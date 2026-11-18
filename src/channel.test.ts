import { describe, expect, test } from "bun:test";
import {
  normalizeLocalSQLiteChannel,
  renderLocalSQLiteChannel,
  type LocalSQLiteChannelSpec,
} from "./channel";

function channelSpec(): LocalSQLiteChannelSpec {
  return {
    name: "example.reader/storage",
    subjects: [
      {
        name: "reader",
        prefix: "localSQLite.reader.",
        methods: [
          {
            name: "readName",
            returns: "stringOrNull",
            args: [{ name: "includeEmpty", type: "bool" }],
          },
          { name: "default", returns: "void" },
        ],
      },
    ],
  };
}

describe("channel compiler", () => {
  test("renders one literal wire contract into all three platform surfaces", () => {
    const outputs = renderLocalSQLiteChannel(
      normalizeLocalSQLiteChannel(channelSpec()),
      "// Generated file. Do not edit by hand.",
    );

    const wire = "localSQLite.reader.readName";
    expect(outputs.swift).toContain(`case readName = "${wire}"`);
    expect(outputs.kotlin).toContain(`READ_NAME("${wire}")`);
    expect(outputs.dart).toContain("static const String readerReadName");
    expect(outputs.dart).toContain(`'${wire}'`);
  });

  // A mismatched prefix would admit a method under one subject while routing it
  // through another subject's bridge namespace.
  test("rejects a subject prefix that does not name its owner", () => {
    const raw = channelSpec();
    raw.subjects[0]!.prefix = "localSQLite.settings.";

    expect(() => normalizeLocalSQLiteChannel(raw)).toThrow(
      'channel subject reader must declare prefix "localSQLite.reader."',
    );
  });

  // Swift wire suffixes may be language keywords; escaping the identifier keeps the
  // shipped wire value literal instead of silently renaming the contract.
  test("escapes a Swift keyword without changing its wire value", () => {
    const outputs = renderLocalSQLiteChannel(
      normalizeLocalSQLiteChannel(channelSpec()),
      "// Generated file. Do not edit by hand.",
    );

    expect(outputs.swift).toContain(
      'case `default` = "localSQLite.reader.default"',
    );
    expect(outputs.kotlin).toContain('DEFAULT("localSQLite.reader.default")');
    expect(outputs.dart).toContain(
      "readerDefault = 'localSQLite.reader.default'",
    );
  });
});
