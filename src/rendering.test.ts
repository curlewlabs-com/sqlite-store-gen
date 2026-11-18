import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LocalSQLiteRawSpec } from "./model";
import { normalizeLocalSQLiteSpec } from "./spec";
import {
  addSingletonCasTable,
  cloneSpec,
  CURLEW_SQLITE_STUB,
  loadExample,
  loadExampleRaw,
  render,
  renderRaw,
  tableNamed,
  withSchemaMigrations,
} from "./test-support";

// Apple platforms only: the generated Swift uses Foundation API that only Apple's
// Foundation has (the App Group container), so a swiftc on Linux rejects correct output.
// CI runs this suite on macOS too, where the case is not skipped.
const SWIFTC = process.platform === "darwin" ? Bun.which("swiftc") : null;

// A use site for the example queue's nullable columns, appended to the generated Swift
// before it is type-checked. The failure this is FOR survives a typecheck of the generated
// file alone: a wrapper that narrowed a nullable parameter back to the bare brand still
// compiles, since Swift promotes a non-optional argument to an optional parameter one
// layer down. Only a caller passing nil tells the two apart.
const NULLABLE_USE_SITE = `
private func exerciseNullableColumns(database: GeneratedLocalSQLiteDatabase) throws {
    _ = try PendingHighlightOperations.stage(
        database: database,
        stagedAtMs: PendingHighlightStagedAtMs(value: 1),
        bookIsbn: PendingHighlightBookIsbn(value: "isbn"),
        excerpt: PendingHighlightExcerpt(value: "excerpt"),
        marginNote: nil,
        pageNumber: nil,
        capturedAtMs: PendingHighlightCapturedAtMs(value: 1),
        uploadAttempts: PendingHighlightUploadAttempts(value: 0),
        retryNotBeforeMs: PendingHighlightRetryNotBeforeMs(value: 0)
    )
    if let row = try PendingHighlightOperations.readHead(database: database) {
        let note: String? = row.marginNote?.value
        let page: Int64? = row.pageNumber?.value
        _ = note
        _ = page
    }
}`;

describe("generated platform rendering", () => {
  // A NOT NULL TEXT column reading back NULL means the store disagrees with its own DDL.
  // Swift refuses the row through its SQLITE_ROW guard; Kotlin has to refuse it
  // explicitly, and the tolerant form (orEmpty()) is a one-operator edit away. The owner
  // read is called out because its tolerant form is silent: a NULL owner normalized to ""
  // reads as no current owner and drops the row being recorded.
  test("renders Android text reads that refuse a NULL in a NOT NULL column", async () => {
    const { kotlin } = render(await loadExample());

    expect(kotlin).toContain("private fun requiredText(");
    expect(kotlin).toContain(
      'requiredText(statement, 0, "read current owner")',
    );
    expect(kotlin).not.toContain("orEmpty()");
  });

  // The flag set is the only place an open could be told to destroy data: an open with
  // a corruption handler that deletes the file and retries hands the caller an empty store
  // with no error at all. sqlite3_open_v2 has no such concept, and the flags are pinned to
  // the pair iOS passes.
  test("renders an Android open with only the READWRITE and CREATE flags iOS passes", async () => {
    const { kotlin } = render(await loadExample());

    const openCall = kotlin.slice(kotlin.indexOf("CurlewSQLite.openV2("));
    expect(openCall.slice(0, openCall.indexOf("),"))).toContain(
      "CurlewSQLite.OPEN_READWRITE or CurlewSQLite.OPEN_CREATE",
    );
    expect(kotlin).not.toContain("org.sqlite.database");
    expect(kotlin).not.toContain("DatabaseErrorHandler");
  });

  test("renders sources that reclaim obsolete tables on open", async () => {
    const sources = render(await loadExample());
    // Every open that reaches the baseline drops obsolete tables before creating the
    // live ones, so an older build's rows are freed.
    for (const output of [sources.kotlin, sources.swift]) {
      expect(output).toContain("DROP TABLE IF EXISTS legacy_reading_cache");
    }
  });

  test("renders the compare-and-set surface on every platform when a CAS table is present", async () => {
    const raw = cloneSpec(await loadExampleRaw());
    addSingletonCasTable(raw);
    const { kotlin, swift } = renderRaw(raw);

    expect(kotlin).toContain("sealed interface SyncCursorCasResult");
    expect(kotlin).toContain("data object Applied : SyncCursorCasResult");
    expect(kotlin).toContain(
      "data class Stale(\n        val observedVersion: StoredSyncCursorRowVersion,",
    );
    expect(kotlin).toContain("fun compareAndSetUpdateSyncCursor(");
    expect(kotlin).toContain("value class ExpectedSyncCursorRowVersion(");

    expect(swift).toContain("enum SyncCursorCasResult: Equatable, Sendable");
    expect(swift).toContain(
      "case stale(observedVersion: StoredSyncCursorRowVersion)",
    );
    expect(swift).toContain("func compareAndSetUpdateSyncCursor(");
    // The singleton slot-id brand names no value type: the slot is the constant 1.
    expect(`${kotlin}\n${swift}`).not.toContain("SyncCursorSlotId");
    // The spec declares a compare-and-set update and no compare-and-set delete, so a
    // delete surface here would be one the spec never asked for.
    expect(kotlin).not.toContain("compareAndSetDeleteSyncCursor");
    expect(swift).not.toContain("compareAndSetDeleteSyncCursor");
  });

  test("keeps the compare-and-set busy-lock mapping in the transaction wrapper", async () => {
    const raw = cloneSpec(await loadExampleRaw());
    addSingletonCasTable(raw);
    const { kotlin, swift } = renderRaw(raw);

    // A lock contended by another connection must surface as Busy, not a thrown error,
    // so the caller can retry. The wrapper is generic over its result - owner-sourced
    // inserts and the counted delete run inside it too - so the busy VALUE comes from the
    // call site and the wrapper returns it.
    expect(kotlin).toContain(
      "withImmediateTransaction(SyncCursorCasResult.Busy) {",
    );
    expect(kotlin).toContain("return busy");
    expect(kotlin).toContain(
      'execute(BEGIN_IMMEDIATE_SQL, "begin transaction")',
    );
    expect(swift).toContain("busy: .busy");
    expect(swift).toContain("return busy");
    expect(swift).toContain(
      'try execute(sql: Self.beginImmediateSQL, operation: "begin \\(operation)")',
    );
  });

  test("renders the signed-in pointer as a non-CAS singleton on every platform", async () => {
    const { kotlin, swift } = render(await loadExample());
    const combined = `${kotlin}\n${swift}`;

    // read plus the unconditional insert_or_replace repoint are the pointer's surface.
    expect(kotlin).toContain("fun readSignedInReader(): SignedInReaderRow?");
    // A single-parameter signature that fits the line limit is emitted inline, since
    // ktlint rejects a wrapped signature that fits.
    expect(kotlin).toContain(
      "fun insertOrReplaceSignedInReader(readerId: SignedInReaderId): StoredSignedInReaderRowVersion {",
    );
    expect(swift).toContain(
      "func readSignedInReader() throws -> SignedInReaderRow?",
    );
    expect(swift).toContain("func insertOrReplaceSignedInReader(");
    expect(combined).not.toContain("SignedInReaderCasResult");
    expect(combined).not.toContain("SignedInReaderSlotId");
  });

  test("renders the reader profile as an owner-keyed table on every platform", async () => {
    const { kotlin, swift } = render(await loadExample());
    const combined = `${kotlin}\n${swift}`;

    // The owner key is the primary key, so unlike a singleton's slot it is a
    // caller-supplied key type and must be declared.
    expect(kotlin).toContain("value class ReaderProfileReaderId(");
    expect(swift).toContain("struct ReaderProfileReaderId");
    // Every operation binds the owner as a value - never SINGLETON_ID, never interpolated.
    expect(kotlin).toContain(
      "fun readReaderProfile(readerId: ReaderProfileReaderId): ReaderProfileRow? {",
    );
    expect(kotlin).toContain(
      'withStatement(READ_PROFILE_SQL, "read_reader_profile")',
    );
    expect(kotlin).toContain("bindText(readerId.value, 1, statement)");
    expect(combined).toContain("WHERE reader_id = ?");
    // ensure is a create-if-absent INSERT OR IGNORE binding the caller's owner at the
    // slot and reporting whether it created a row - never a version bump or overwrite,
    // so it cannot clobber a sibling consumer's column.
    expect(kotlin).toContain(
      "fun ensureReaderProfile(readerId: ReaderProfileReaderId): Boolean {",
    );
    expect(swift).toContain(
      "func ensureReaderProfile(readerId: ReaderProfileReaderId) throws -> Bool {",
    );
    expect(combined).toContain("INSERT OR IGNORE INTO reader_profile");
    expect(swift).toContain(
      "try bindText(readerId.value, at: 1, statement: statement)",
    );
    // An exact owner-keyed physical delete, returning whether that one row existed.
    expect(kotlin).toContain(
      "fun deleteReaderProfile(readerId: ReaderProfileReaderId): Boolean {",
    );
    expect(swift).toContain(
      "func deleteReaderProfile(readerId: ReaderProfileReaderId) throws -> Bool {",
    );
    expect(combined).not.toContain("WHERE reader_id <> ?");
    // The read's one TEXT value column extends the SQLITE_ROW guard with its byte binding
    // and ends it. The broken shape - a trailing comma with NO bindings - is invalid
    // Swift and stays forbidden.
    expect(swift).toContain(
      "let displayNameBytes = curlew_sqlite3_column_text(statement, 0) else {",
    );
    expect(swift).not.toContain("guard stepResult == SQLITE_ROW,\n else {");
  });

  // Only the LAST text column of a row guard carries `else {`, so a column appended after
  // it has to move the terminator rather than leave two.
  test("chains a row guard's text bindings and terminates it once", async () => {
    const { swift } = render(await loadExample());

    expect(swift).toContain(
      "let readerIdBytes = curlew_sqlite3_column_text(statement, 1),",
    );
    expect(swift).toContain(
      "let bookIsbnBytes = curlew_sqlite3_column_text(statement, 2),",
    );
    expect(swift).toContain(
      "let excerptBytes = curlew_sqlite3_column_text(statement, 3) else {",
    );
  });

  // The settings row's writes are column sets and a reset - none reads the version back
  // - so its private version reader is not emitted, leaving no unused private function.
  test("emits a version reader only for a table whose writes read the version back", async () => {
    const { kotlin, swift } = render(await loadExample());

    for (const output of [kotlin, swift]) {
      expect(output).toContain("readStoredReaderVersion");
      expect(output).toContain("readStoredProfileVersion");
      expect(output).not.toContain("readStoredSettingsVersion");
    }
  });

  // An owner-keyed compare-and-set orders competing processes writing one owner's row, so
  // it binds the caller's owner rather than the singleton slot, and touches only its own
  // column - a CAS writing every settable column would clobber a sibling's.
  test("renders owner-keyed compare-and-set binding the owner, not the singleton slot", async () => {
    const { kotlin, swift } = render(await loadExample());

    for (const rendered of [kotlin, swift]) {
      expect(rendered).toContain("WHERE reader_id = ? AND row_version = ?");
      expect(rendered).toContain(
        "SET books_finished = ?, row_version = row_version + 1",
      );
      expect(rendered).not.toContain(
        "SET books_finished = ?, display_name = ?",
      );
    }
    expect(kotlin).toContain("ReaderProfileCasResult");
    expect(swift).toContain("ReaderProfileCasResult");
    // The write binds the caller's owner key, not the fixed singleton slot: a method that
    // bound the slot would match no owner-keyed row and report every write missing.
    for (const [source, keyword] of [
      [kotlin, "fun"],
      [swift, "func"],
    ] as const) {
      const start = source.indexOf(
        `${keyword} compareAndSetBooksFinishedReaderProfile(`,
      );
      expect(start).toBeGreaterThanOrEqual(0);
      const method = source.slice(
        start,
        source.indexOf(`\n    ${keyword} `, start + 1),
      );
      expect(method).toContain("readerId.value");
    }
  });

  test.skipIf(SWIFTC === null)(
    "the generated Swift type-checks against the CurlewSQLite stub",
    async () => {
      // A real typecheck, not a parse: a missing argument label or an empty-collection
      // guard passes `swiftc -parse` and fails here. Each spec below exercises template
      // branches the others do not reach.
      const typecheck = (swift: string): void => {
        const stubbed = swift.replace(
          "import CurlewSQLite",
          CURLEW_SQLITE_STUB,
        );
        const dir = mkdtempSync(join(tmpdir(), "sqlite-store-gen-swiftcheck-"));
        try {
          const file = join(dir, "LocalSQLiteGenerated.swift");
          writeFileSync(file, stubbed);
          const result = spawnSync(SWIFTC!, ["-typecheck", file], {
            encoding: "utf8",
          });
          if (result.status !== 0) {
            throw new Error(
              `generated Swift failed swiftc -typecheck ` +
                `(exit ${result.status}, signal ${result.signal}):\n` +
                result.stdout +
                result.stderr,
            );
          }
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      };
      const swiftOf = (spec: LocalSQLiteRawSpec): string =>
        renderRaw(spec).swift;

      typecheck(swiftOf(await loadExampleRaw()) + NULLABLE_USE_SITE);
      typecheck(
        swiftOf(withSchemaMigrations(cloneSpec(await loadExampleRaw()))),
      );
      // Both compare-and-set slot shapes in one spec, which is what a second tenant looks
      // like: each CAS type is rendered per table and the transaction wrapper is generic,
      // so a helper typed to one tenant's result would fail to compile the other's body.
      const casTenants = cloneSpec(await loadExampleRaw());
      addSingletonCasTable(casTenants);
      typecheck(swiftOf(casTenants));
      // A table that reads its version back with no read of its own, and one with two
      // reads: the version-reader constant is declared once in each.
      const noRead = cloneSpec(await loadExampleRaw());
      const reader = tableNamed(noRead, "signed_in_reader");
      reader.operations = reader.operations.filter(
        (operation) => operation.kind !== "read",
      );
      typecheck(swiftOf(noRead));
      const twoReads = cloneSpec(await loadExampleRaw());
      tableNamed(twoReads, "signed_in_reader").operations.push({
        name: "read_again_signed_in_reader",
        kind: "read",
        predicate: [{ column: "singleton_id", operator: "=" }],
      });
      typecheck(swiftOf(twoReads));
    },
  );

  // What a nullable column emits at every position it reaches. ABSENT stays
  // distinguishable end to end: nil binds a real SQL NULL rather than "" or 0, and a stored
  // NULL decodes back to nil. Text answers its own presence (`column_text` returns NULL);
  // an integer cannot - `column_int64` answers 0 for NULL and for a stored zero alike - so
  // the integer arm alone asks the stored type first.
  test("renders nullable columns as optionals that keep NULL distinct from a zero value", async () => {
    const { kotlin, swift } = render(await loadExample());

    expect(swift).toContain("let marginNote: PendingHighlightMarginNote?");
    expect(swift).toContain("let pageNumber: PendingHighlightPageNumber?");
    expect(swift).toContain("let readerId: PendingHighlightReaderId\n");
    expect(kotlin).toContain("val marginNote: PendingHighlightMarginNote?,");
    expect(kotlin).toContain("val pageNumber: PendingHighlightPageNumber?,");

    expect(swift).toContain("try bindOptionalText(marginNote?.value,");
    expect(swift).toContain("try bindOptionalInt64(pageNumber?.value,");
    expect(kotlin).toContain("bindOptionalText(marginNote?.value,");
    expect(kotlin).toContain("bindOptionalInt64(pageNumber?.value,");
    expect(swift).toContain("curlew_sqlite3_bind_null(statement, index)");
    expect(kotlin).toContain("CurlewSQLite.nativeBindNull(statement, index)");

    // The nullable text column must NOT join the SQLITE_ROW guard, whose else-arm throws:
    // a legitimate NULL would surface as a database error.
    expect(swift).not.toContain(
      "let marginNoteBytes = curlew_sqlite3_column_text",
    );
    expect(swift).toContain(
      `marginNote: curlew_sqlite3_column_text(statement, 4).map {
                PendingHighlightMarginNote(value: String(cString: $0))
            }`,
    );
    expect(swift).toContain(
      `pageNumber: curlew_sqlite3_column_type(statement, 5) == SQLITE_NULL
                ? nil
                : PendingHighlightPageNumber(value: curlew_sqlite3_column_int64(statement, 5))`,
    );
    expect(kotlin).toContain(
      "marginNote = CurlewSQLite.columnText(statement, 4)?.let { PendingHighlightMarginNote(it) },",
    );
    expect(kotlin).toContain("if (CurlewSQLite.isNull(statement, 5)) {");
    expect(kotlin).not.toContain(
      'requiredText(statement, 4, "read pending_highlight")',
    );

    // The DDL is the other half: without NOT NULL there is nothing for a NULL to violate.
    expect(kotlin).toContain("margin_note TEXT,");
    expect(kotlin).toContain("page_number INTEGER,");
    expect(kotlin).toContain("reader_id TEXT NOT NULL,");
  });

  // The main-thread guard differs by platform on purpose: an iOS extension process has
  // no screen to stall and takes the opening process's own declaration; an Android store
  // has no such process, so its guard stays unconditional.
  test("the main-thread guard takes the process kind on Swift and not on Kotlin", async () => {
    const { kotlin, swift } = render(
      normalizeLocalSQLiteSpec(await loadExampleRaw()),
    );

    expect(swift).toContain(
      "private static func assertNotMainThread(operation: String, hostsUserInterface: Bool) throws {",
    );
    expect(swift).toContain("if hostsUserInterface, Thread.isMainThread {");
    expect(kotlin).toContain(
      "private fun assertNotMainThread(operation: String) {",
    );
    expect(kotlin).not.toContain("hostsUserInterface");
  });
});
