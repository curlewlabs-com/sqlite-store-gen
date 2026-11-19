import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { renderLocalSQLiteSources } from "./render";
import { EXAMPLE_SPEC_PATH, loadExample } from "./test-support";

const CLI = fileURLToPath(new URL("./cli.ts", import.meta.url));

function run(args: string[]): { status: number; stderr: string } {
  const result = Bun.spawnSync(["bun", "--no-install", CLI, ...args]);
  return { status: result.exitCode, stderr: result.stderr.toString() };
}

describe("command line", () => {
  // The CLI is the second path to the renderer, so it must hand the renderer exactly the
  // options it was given and write each source where it was told - a swapped output path
  // or a dropped flag would write valid-looking files with the wrong contents.
  test("writes the three sources the library renders for the same options", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sqlite-store-gen-cli-"));
    try {
      const out = {
        kotlin: join(dir, "kotlin", "Store.kt"),
        swift: join(dir, "swift", "Store.swift"),
        dart: join(dir, "dart", "store_channel.dart"),
      };
      const result = run([
        EXAMPLE_SPEC_PATH,
        "--kotlin-package",
        "org.example.reader.storage",
        "--database-file-name",
        "reader.sqlite3",
        "--notice",
        "// header",
        "--kotlin-out",
        out.kotlin,
        "--swift-out",
        out.swift,
        "--dart-out",
        out.dart,
      ]);
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);

      const expected = renderLocalSQLiteSources(await loadExample(), {
        kotlinPackage: "org.example.reader.storage",
        databaseFileName: "reader.sqlite3",
        notice: "// header",
      });
      for (const kind of ["kotlin", "swift", "dart"] as const) {
        expect(readFileSync(out[kind], "utf-8")).toBe(expected[kind]);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("refuses to run without a required option and writes nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "sqlite-store-gen-cli-"));
    try {
      const result = run([
        EXAMPLE_SPEC_PATH,
        "--kotlin-package",
        "org.example.reader.storage",
        "--kotlin-out",
        join(dir, "Store.kt"),
        "--swift-out",
        join(dir, "Store.swift"),
        "--dart-out",
        join(dir, "store_channel.dart"),
      ]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("--database-file-name is required");
      expect(() => readFileSync(join(dir, "Store.kt"))).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // --binding-package was an option until 0.3.0. A command line still passing it must
  // fail rather than write Kotlin importing from another package than the one it named.
  test("refuses an unknown flag and writes nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "sqlite-store-gen-cli-"));
    try {
      const result = run([
        EXAMPLE_SPEC_PATH,
        "--kotlin-package",
        "org.example.reader.storage",
        "--binding-package",
        "org.example.reader.sqlite",
        "--database-file-name",
        "reader.sqlite3",
        "--kotlin-out",
        join(dir, "Store.kt"),
        "--swift-out",
        join(dir, "Store.swift"),
        "--dart-out",
        join(dir, "store_channel.dart"),
      ]);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Unknown option '--binding-package'");
      expect(() => readFileSync(join(dir, "Store.kt"))).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
