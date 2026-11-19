// Renders a normalized spec into its three sources - the Kotlin storage layer, the Swift
// storage layer, and the Dart channel constants - given the consumer's own names
// (LocalSQLiteRenderOptions). Where the sources are written is the caller's.

import { renderLocalSQLiteChannel } from "./channel";
import {
  KOTLIN_COMPANION_METHODS,
  KOTLIN_FILE_HELPERS,
  kotlinStoreObject,
} from "./kotlin-connection";
import {
  kotlinIntegrityDeclarations,
  kotlinIntegrityProbe,
} from "./kotlin-integrity";
import { kotlinSchemaMembers, kotlinSchemaObject } from "./kotlin-schema";
import {
  kotlinOperationMethod,
  kotlinOperationsObject,
  kotlinVersionReader,
} from "./kotlin-operation";
import { type LocalSQLiteSpec, type NormalizedTable } from "./model";
import {
  kotlinTypeBlocks,
  swiftGeneratedError,
  swiftTypeBlocks,
} from "./platform-types";
import {
  kotlinGeneratedConstants,
  swiftGeneratedConstants,
} from "./platform-constants";
import {
  resolveRenderOptions,
  type LocalSQLiteRenderOptions,
  type ResolvedRenderOptions,
} from "./options";
import { swiftOperationsEnum } from "./swift-api";
import {
  SWIFT_CONFIGURE_BLOCK,
  swiftConnectionClassHead,
} from "./swift-connection";
import { swiftStoreEnum } from "./swift-store";
import {
  swiftIntegrityDeclarations,
  swiftIntegrityProbe,
} from "./swift-integrity";
import { swiftSchemaEnum, swiftSchemaMembers } from "./swift-schema";
import { swiftOperationMethod, swiftVersionReader } from "./swift-operation";
import { KOTLIN_BINDERS, SWIFT_BINDERS } from "./binders";

// How long a lock event sleeps before the operation gives up and reports busy.
// A shared constant serves the Kotlin and Swift defaults that still name it - the budget each platform's
// open defaults to - because a half-edit would leave Kotlin and Swift on different
// budgets and surface only as a failed open at run time. The PRAGMA and its
// read-back carry whatever budget their open was given instead, which is what lets a
// test staging deliberate contention outwait a peer without production reaching a
// second number. The number is sized against a peer process holding the write lock for
// one short transaction: long enough to outwait it, short enough that a caller that does
// lose the budget learns so while it can still report it.
const SQLITE_BUSY_TIMEOUT_MILLIS = 2500;

// The Kotlin package curlew-sqlite publishes its binding and engine guards in. Its JNI
// shim resolves the binding class by this name, so the emitted imports name it too.
const BINDING_PACKAGE = "com.curlewlabs.sqlite";

// ---------------------------------------------------------------------------
// Rendering.
// ---------------------------------------------------------------------------

export interface LocalSQLiteRenderedSources {
  kotlin: string;
  swift: string;
  dart: string;
}

export function renderLocalSQLiteSources(
  spec: LocalSQLiteSpec,
  options: LocalSQLiteRenderOptions,
): LocalSQLiteRenderedSources {
  const resolved = resolveRenderOptions(options);
  const channel = renderLocalSQLiteChannel(spec.channel, resolved.notice);
  return {
    kotlin: `${renderKotlin(spec, resolved)}
${channel.kotlin}
`,
    swift: `${renderSwift(spec, resolved)}
${channel.swift}
`,
    dart: channel.dart,
  };
}

// ---------------------------------------------------------------------------
// Kotlin renderer.
// ---------------------------------------------------------------------------

function renderKotlin(
  spec: LocalSQLiteSpec,
  options: ResolvedRenderOptions,
): string {
  const imports = [
    "import android.content.Context",
    "import android.os.Looper",
    `import ${BINDING_PACKAGE}.AndroidBundledSQLiteSourceIdGuard`,
    `import ${BINDING_PACKAGE}.AndroidBundledSQLiteVersionGuard`,
    // The whole binding surface. Nothing from org.sqlite.database.* is imported any more:
    // the AAR supplies the engine, and CurlewSQLite supplies the only route to it.
    `import ${BINDING_PACKAGE}.CurlewSQLite`,
    "import java.io.File",
    "import java.io.IOException",
  ].join("\n");

  const blocks = kotlinTypeBlocks(spec);
  blocks.push(...kotlinIntegrityDeclarations());
  blocks.push(kotlinSchemaObject(spec));
  blocks.push(kotlinIntegrityProbe(spec));
  blocks.push(KOTLIN_FILE_HELPERS);
  blocks.push(kotlinDatabaseClass(spec));
  blocks.push(kotlinStoreObject(options.databaseFileName));
  for (const table of spec.tables) blocks.push(kotlinOperationsObject(table));

  return `${options.notice}
package ${options.kotlinPackage}

${imports}

${blocks.join("\n\n")}
`;
}

// The rationale is emitted into the generated Kotlin rather than kept here: the empty
// override is what a reader of that file has to understand, and without it the body
// reads as an unfinished stub.
// The failure type every generated statement raises, and Swift's LocalSQLiteGeneratedError
// .sqlite case in Kotlin form.
//
// It carries the numeric result codes, which is new on this platform: the AAR's Java
// bindings mapped codes onto exception subclasses and exposed no number, so contention had
// to be inferred from the thrown type plus a substring match on the message, and the
// integrity report's resultCode was structurally null here while iOS populated it. Every
// platform now classifies from the same observable.
//
// An IllegalStateException subclass because that is what the surrounding consumer layer
// already catches around store work, and because a failed statement genuinely is one -
// keeping the hierarchy means retiring the wrapper does not silently change which failures
// a caller's existing catch admits.
// The statement primitives, at file scope because the database class and companion open
// sequence need them while only the database class has an instance. The open sequence
// applies the connection profile and checks the engine identity before any instance
// exists. Swift's sqliteError is file-scope for the same reason.
//
// Everything here takes the connection as a Long. A caller outside this file cannot reach
// them (private to the file), which is what keeps "no production API accepts a database
// handle" true while still letting the open share one implementation with the operations.
// The Kotlin half of the handle-seam span state; the Swift twin is SWIFT_SPAN_STATE.
// The timing itself is one definition per verb (the write pair and the read below), which
// is what keeps the emitter sites to a direct expression swap. Which kinds reach this seam
// rather than the open's parameter is LocalSQLiteStoreSpan's to state, not this file's.
const KOTLIN_SPAN_STATE = `    // Installed by the consumer's single store funnel; see LocalSQLiteStoreSpan for which
    // kinds arrive here. A process that collects nothing leaves it null, and null is what
    // keeps every span below off the clock entirely.
    var spanObserver: ((LocalSQLiteStoreSpan) -> Unit)? = null

    // Suppresses the per-statement span inside an explicit transaction, where
    // withImmediateTransaction times the whole unit instead - so a transactional write
    // is counted once, as one span rather than a span nested inside a span.
    private var inExplicitTransaction = false

    // One monotonic source for the whole span, never crossed with a wall clock: a
    // System.currentTimeMillis() difference is fiction the moment the clock steps.
    // Nanoseconds because a small-table write can land under a millisecond and the floor
    // this feeds is a question about exactly that body, so the millisecond resolution of
    // SystemClock.uptimeMillis() would quantize the answer away.
    // null whenever nothing is collecting or an enclosing transaction already owns the
    // span, which makes every recordWriteSpan a no-op without the call sites branching.
    private fun writeSpanStart(): Long? =
        if (spanObserver == null || inExplicitTransaction) null else System.nanoTime()

    private fun recordWriteSpan(
        start: Long?,
        lostBudget: Boolean,
    ) {
        if (start == null) return
        spanObserver?.invoke(
            LocalSQLiteStoreSpan(
                LocalSQLiteStoreSpanKind.WRITE,
                (System.nanoTime() - start) / 1_000_000.0,
                lostBudget,
            ),
        )
    }

    // The read half, on the same terms as the write pair above: same monotonic source, same
    // null-means-nothing-is-collecting shape, same suppression inside an explicit
    // transaction - where a generated read is part of a unit withImmediateTransaction
    // already times, so counting it again would nest a span inside a span.
    private fun readSpanStart(): Long? =
        if (spanObserver == null || inExplicitTransaction) null else System.nanoTime()

    private fun recordReadSpan(
        start: Long?,
        lostBudget: Boolean,
    ) {
        if (start == null) return
        spanObserver?.invoke(
            LocalSQLiteStoreSpan(
                LocalSQLiteStoreSpanKind.READ,
                (System.nanoTime() - start) / 1_000_000.0,
                lostBudget,
            ),
        )
    }`;

function kotlinDatabaseClass(spec: LocalSQLiteSpec): string {
  const members: string[] = [];
  members.push(
    `    fun connectionProfileForTesting(): LocalSQLiteConnectionProfile = connectionProfile`,
  );
  members.push(...kotlinSchemaMembers(spec));
  for (const table of spec.tables) {
    for (const operation of table.operations) {
      members.push(kotlinOperationMethod(table, operation));
    }
  }
  if (spec.anyTransaction) {
    members.push(kotlinTransactionHelpers());
  }
  members.push(`    override fun close() {
        CurlewSQLite.nativeCloseV2(raw)
    }`);
  for (const table of spec.tables) {
    if (table.emitsVersionReader) members.push(kotlinVersionReader(table));
  }
  // sqlite3_changes off the connection, where iOS already read it. The wrapper had no
  // equivalent, so this used to run a whole "SELECT changes()" statement to learn what the
  // statement it just stepped had done.
  members.push(`    private fun readChanges(): Long {
        assertNotMainThread("read changes")
        return CurlewSQLite.nativeChanges(raw).toLong()
    }`);
  for (const table of spec.tables) members.push(kotlinRowReader(table));
  members.push(KOTLIN_INSTANCE_HELPERS);
  if (anyPlainInsert(spec)) members.push(KOTLIN_STEP_WRITE_RETURNING);
  members.push(kotlinCompanion(spec));

  return `class GeneratedLocalSQLiteDatabase private constructor(
    // The sqlite3* connection, carried as a Long. Everything that touches it goes through
    // CurlewSQLite; a stale handle is a use-after-free rather than an exception, which is
    // why statement lifetime never leaves this class - the same contract the Swift twin
    // has with its OpaquePointer.
    private val raw: Long,
    private val connectionProfile: LocalSQLiteConnectionProfile,
) : AutoCloseable {
${KOTLIN_SPAN_STATE}

${members.join("\n\n")}
}`;
}

// The statement primitives every emitted operation is built from, and the Kotlin twin of
// SWIFT_INSTANCE_HELPERS. Nothing above these names a sqlite3 call directly.
const KOTLIN_INSTANCE_HELPERS = `    private fun execute(
        sql: String,
        operation: String,
    ) {
        assertNotMainThread(operation)
        withStatement(sql, operation) { statement -> stepDone(statement, operation) }
    }

    private fun prepare(
        sql: String,
        operation: String,
    ): Long {
        assertNotMainThread(operation)
        return prepareStatement(raw, sql, operation)
    }

    // Swift's \`defer { curlew_sqlite3_finalize(statement) }\` in the shape Kotlin has for
    // it. Every prepared statement in this class is finalized through here, including on
    // the throwing path - a leaked statement holds its read lock until the connection
    // closes, which on this store means until the process ends.
    private fun <T> withStatement(
        sql: String,
        operation: String,
        body: (Long) -> T,
    ): T {
        assertNotMainThread(operation)
        return withPreparedStatement(raw, sql, operation, body)
    }

${KOTLIN_BINDERS}

    // isWrite is what separates a generated write from the schema ladder and the
    // transaction control statements, which also step through here: only a write is timed.
    // On the autocommit shape the span is this step and nothing more - prepare and the
    // binds above it touch no lock - and the step is where acquisition, the work, and the
    // commit all happen.
    private fun stepDone(
        statement: Long,
        operation: String,
        isWrite: Boolean = false,
    ) {
        assertNotMainThread(operation)
        val start = if (isWrite) writeSpanStart() else null
        val result = CurlewSQLite.nativeStep(statement)
        if (result != CurlewSQLite.DONE) {
            val error = sqliteError(operation, result)
            if (isSQLiteBusy(error)) recordWriteSpan(start, lostBudget = true)
            throw error
        }
        recordWriteSpan(start, lostBudget = false)
    }

    // The first step of a read, which is where SHARED is taken and the row is produced -
    // so it is the step the read span covers. A subsequent step in a scanning loop
    // re-acquires nothing and would price row work as contention, so those call
    // CurlewSQLite.nativeStep directly.
    //
    // One step, unlike the wrapper this replaced, whose moveToFirst materialized the whole
    // result set - so an Android read span was never comparable to the iOS one. It is now.
    private fun stepFirstRow(
        statement: Long,
        operation: String,
    ): Boolean {
        assertNotMainThread(operation)
        val start = readSpanStart()
        val result = CurlewSQLite.nativeStep(statement)
        if (result == CurlewSQLite.ROW || result == CurlewSQLite.DONE) {
            recordReadSpan(start, lostBudget = false)
            return result == CurlewSQLite.ROW
        }
        val error = sqliteError(operation, result)
        if (isSQLiteBusy(error)) recordReadSpan(start, lostBudget = true)
        throw error
    }

    // ROW or DONE, and anything else throws. The untimed twin of stepFirstRow, for the
    // steps a read span must not cover: the extra-row check after a single-row read, the
    // version re-read inside a transaction the transaction span already times, and the
    // owner read inside the same.
    //
    // Separating DONE from every other non-ROW code is the whole point of it. A bare
    // step-not-ROW test treats SQLITE_BUSY and SQLITE_CORRUPT as "no row", which means a
    // contended read reports absent and a caller that defaults on absence fails open -
    // silent by treating contention as absence and corruption as an empty result.
    // Swift's readers have always made this split.
    private fun stepRowOrDone(
        statement: Long,
        operation: String,
    ): Boolean {
        val result = CurlewSQLite.nativeStep(statement)
        if (result == CurlewSQLite.ROW) return true
        if (result == CurlewSQLite.DONE) return false
        throw sqliteError(operation, result)
    }

    private fun sqliteError(
        operation: String,
        resultCode: Int,
    ): LocalSQLiteGeneratedException = sqliteError(raw, operation, resultCode)`;

// The transaction wrapper every transactional operation shares, generic over its own
// result so a second tenant needs no second copy. `busy` is the value to return when the
// budget is exhausted rather than a fixed `.Busy` case, so the wrapper is typed to no
// table's CasResult.
function kotlinTransactionHelpers(): string {
  return `    private fun <T> withImmediateTransaction(busy: T, body: () -> T): T {
        assertNotMainThread("transaction")
        var shouldRollback = false
        // The whole unit is the span: BEGIN IMMEDIATE attempts the write lock and COMMIT
        // releases it, so the statements between them run inside one span - and a wait for
        // that lock is inside it too. Opened before the flag, which is what makes the
        // enclosed steps defer their span to this one.
        val start = writeSpanStart()
        inExplicitTransaction = true
        try {
            // Reaches SQLite verbatim now. Under the AAR's Java bindings this string was
            // classified by its first three characters and executed as BEGIN EXCLUSIVE,
            // so the unit took the exclusive lock instead of write intent and blocked
            // every concurrent reader for the full busy budget.
            execute(BEGIN_IMMEDIATE_SQL, "begin transaction")
            shouldRollback = true
            val result = body()
            execute(COMMIT_SQL, "commit transaction")
            shouldRollback = false
            recordWriteSpan(start, lostBudget = false)
            return result
        } catch (e: RuntimeException) {
            // Stamped ahead of the rollback so a lost budget's value is the wait alone -
            // the unwind is not time the write held anything.
            val lostBudget = isSQLiteBusy(e)
            if (lostBudget) recordWriteSpan(start, lostBudget = true)
            if (shouldRollback) {
                try {
                    execute(ROLLBACK_SQL, "rollback transaction")
                } catch (rollback: RuntimeException) {
                    e.addSuppressed(rollback)
                    throw e
                }
            }
            if (lostBudget) {
                return busy
            }
            throw e
        } finally {
            inExplicitTransaction = false
        }
    }`;
}

// Not folded into kotlinTransactionHelpers, which a spec with no transactional operation
// does not emit: the autocommit write shape classifies busy too, and that shape is always
// present. The Swift twin sits in SWIFT_BUSY_CLASSIFIER for the same reason.
//
// In the companion rather than the class body because the open classifies its own busy
// loss and has no instance to reach - one classifier for the open and the write, so a busy open and a busy
// write can never come to mean different things.
const KOTLIN_BUSY_CLASSIFIER = `        private fun isSQLiteBusy(e: RuntimeException): Boolean =
            e is LocalSQLiteGeneratedException && CurlewSQLite.isContentionCode(e.resultCode)`;

// Reads one row's declared columns off a stepped statement, positionally, in the order the
// generated SELECT names them. Was a Cursor extension; the statement handle replaced the
// cursor, and the column accessors are the sqlite3 ones the Swift twin already used.
//
// A NOT NULL TEXT column reads through requiredText, which throws on NULL: the schema says
// the column has a value, so a SQL NULL means the store disagrees with its own DDL. Swift
// refuses the same row through its SQLITE_ROW guard.
//
// A nullable column reads its own presence instead, and NULL is a value rather than a
// defect. Text tests the null CurlewSQLite.columnText already answers; an integer has to
// ask the stored type, because nativeColumnInt64 answers 0 for a SQL NULL and for a stored
// zero alike. The type read comes BEFORE any text read on that column, per SQLite's rule
// that a text conversion may rewrite the reported type - which is why isNull is only ever
// consulted on the integer arm here.
function kotlinRowReader(table: NormalizedTable): string {
  const fields = table.readColumns
    .map((column, index) => {
      if (column.nullable) {
        return column.kotlinType === "String"
          ? `            ${column.fieldName} = CurlewSQLite.columnText(statement, ${index})?.let { ${column.brand}(it) },`
          : `            ${column.fieldName} =\n                if (CurlewSQLite.isNull(statement, ${index})) {\n                    null\n                } else {\n                    ${column.brand}(CurlewSQLite.nativeColumnInt64(statement, ${index}))\n                },`;
      }
      return column.kotlinType === "String"
        ? `            ${column.fieldName} = ${column.brand}(requiredText(statement, ${index}, "read ${table.spec.name}")),`
        : `            ${column.fieldName} = ${column.brand}(CurlewSQLite.nativeColumnInt64(statement, ${index})),`;
    })
    .join("\n");
  return `    private fun ${table.cursorFn}(statement: Long): ${table.rowType} =
        ${table.rowType}(
${fields}
        )`;
}

function kotlinCompanion(spec: LocalSQLiteSpec): string {
  const consts = kotlinGeneratedConstants(spec, SQLITE_BUSY_TIMEOUT_MILLIS);

  return `    companion object {
${KOTLIN_COMPANION_METHODS}

${KOTLIN_BUSY_CLASSIFIER}

${consts.join("\n")}
    }`;
}

// ---------------------------------------------------------------------------
// Swift renderer.
// ---------------------------------------------------------------------------

function renderSwift(
  spec: LocalSQLiteSpec,
  options: ResolvedRenderOptions,
): string {
  const blocks = swiftTypeBlocks(spec);
  blocks.push(swiftSchemaEnum(spec));
  blocks.push(swiftIntegrityDeclarations());
  blocks.push(swiftGeneratedError());
  blocks.push(swiftIntegrityProbe(spec));
  blocks.push(swiftDatabaseClass(spec));
  blocks.push(swiftStoreEnum(options.databaseFileName));
  for (const table of spec.tables) blocks.push(swiftOperationsEnum(table));
  blocks.push(SWIFT_SQLITE_ERROR_FUNC);

  return `${options.notice}
import Foundation
import CurlewSQLite

${blocks.join("\n\n")}
`;
}

function swiftDatabaseClass(spec: LocalSQLiteSpec): string {
  const members: string[] = [
    swiftConnectionClassHead(SWIFT_SPAN_STATE),
    ...swiftSchemaMembers(spec),
  ];
  for (const table of spec.tables) {
    for (const operation of table.operations) {
      members.push(swiftOperationMethod(table, operation));
    }
  }
  if (spec.anyTransaction) {
    members.push(swiftTransactionHelpers());
  }
  for (const table of spec.tables) {
    if (table.emitsVersionReader) members.push(swiftVersionReader(table));
  }
  members.push(SWIFT_INSTANCE_HELPERS);
  if (anyPlainInsert(spec)) members.push(SWIFT_STEP_WRITE_RETURNING);
  members.push(SWIFT_BUSY_CLASSIFIER);
  members.push(SWIFT_CONFIGURE_BLOCK);
  members.push(swiftGeneratedConstants(spec, SQLITE_BUSY_TIMEOUT_MILLIS));
  // `type_body_length` is scoped off this one generated type rather than raised in
  // .swiftlint.yml. The cap exists to prompt a human "should this be split?"; this class
  // has no human author to prompt - its length is a pure function of the table and
  // operation count in the reviewed spec, so every added column would re-trip a raised
  // cap and force another config edit. Splitting the emitted type would also break the
  // one-handle-per-database invariant the storage layer depends on. The closed-surface
  // guarantees are enforced by the generator and its tests, not by body length.
  //
  // `function_body_length` rides the same scope and the same argument, for `createLiveTables`:
  // it is a concatenation of one create plus one `ensureColumn` per column plus one optional
  // bootstrap, per table, so its length is that same pure function of the spec and every
  // added column walks it toward whatever the cap is set to. Splitting it per table would
  // emit named-by-table helpers whose only reader is the function that calls them all in
  // order - the ordering IS the contract (obsolete drops, then creates, then the version
  // stamp), and it reads as one sequence because it is one.
  return `// swiftlint:disable type_body_length function_body_length - generated; size follows the reviewed spec
final class GeneratedLocalSQLiteDatabase {
${members.join("\n\n")}
}
// swiftlint:enable type_body_length function_body_length`;
}

// The Swift mirror of kotlinTransactionHelpers: generic over the result, with the busy
// value supplied by the caller rather than a fixed `.busy` case.
function swiftTransactionHelpers(): string {
  return `    private func withImmediateTransaction<T>(
        operation: String,
        busy: T,
        _ body: () throws -> T
    ) throws -> T {
        try assertNotMainThread(operation: operation)
        var shouldRollback = false
        // The whole unit is the span: BEGIN IMMEDIATE attempts the write lock and COMMIT
        // releases it, so the statements between them run inside one span - and a wait for
        // that lock is inside it too. Opened before the flag, which is what makes the
        // enclosed steps defer their span to this one.
        let start = writeSpanStart()
        inExplicitTransaction = true
        defer { inExplicitTransaction = false }
        do {
            try execute(sql: Self.beginImmediateSQL, operation: "begin \\(operation)")
            shouldRollback = true
            let result = try body()
            try execute(sql: Self.commitSQL, operation: "commit \\(operation)")
            shouldRollback = false
            recordWriteSpan(start, lostBudget: false)
            return result
        } catch {
            // Stamped ahead of the rollback so a lost budget's value is the wait alone -
            // the unwind is not time the write held anything.
            let lostBudget = Self.isSQLiteBusy(error)
            if lostBudget {
                recordWriteSpan(start, lostBudget: true)
            }
            var rollbackFailed = false
            if shouldRollback {
                do {
                    try execute(sql: Self.rollbackSQL, operation: "rollback \\(operation)")
                } catch {
                    rollbackFailed = true
                }
            }
            if !rollbackFailed && lostBudget {
                return busy
            }
            throw error
        }
    }`;
}

// Not folded into swiftTransactionHelpers, which a spec with no transactional operation
// does not emit: the autocommit write shape classifies busy too, and that shape is always
// present. The Kotlin twin sits in KOTLIN_BUSY_CLASSIFIER for the same reason.
const SWIFT_BUSY_CLASSIFIER = `    private static func isSQLiteBusy(_ error: Error) -> Bool {
        guard case let LocalSQLiteGeneratedError.sqlite(_, resultCode, extendedResultCode, _) = error else {
            return false
        }
        // Check the primary and extended codes because an extended code carries its family in the low byte only
        // when SQLite set one - a plain SQLITE_BUSY leaves the extended slot equal to the
        // primary, and a driver that reports only the extended one still has to classify.
        return LocalSQLiteIntegrityProbe.isContentionCode(resultCode)
            || LocalSQLiteIntegrityProbe.isContentionCode(extendedResultCode)
    }`;

// The Swift half of the handle-seam span state; the Kotlin twin is KOTLIN_SPAN_STATE.
const SWIFT_SPAN_STATE = `    // Installed by the consumer's single store funnel; see LocalSQLiteStoreSpan for which
    // kinds arrive here. A process that collects nothing leaves it nil, and nil is what
    // keeps every span below off the clock entirely.
    var spanObserver: ((LocalSQLiteStoreSpan) -> Void)?

    // Suppresses the per-statement span inside an explicit transaction, where
    // withImmediateTransaction times the whole unit instead - so a transactional write
    // is counted once, as one span rather than a span nested inside a span.
    private var inExplicitTransaction = false`;

const SWIFT_INSTANCE_HELPERS = `    private func execute(sql: String, operation: String) throws {
        try assertNotMainThread(operation: operation)
        let statement = try prepare(sql: sql, operation: operation)
        defer { curlew_sqlite3_finalize(statement) }
        try stepDone(statement: statement, operation: operation)
    }

    private func prepare(sql: String, operation: String) throws -> OpaquePointer {
        try assertNotMainThread(operation: operation)
        var statement: OpaquePointer?
        let result = sql.withCString { sqlPointer in
            curlew_sqlite3_prepare_v2(raw, sqlPointer, -1, &statement, nil)
        }
        guard result == SQLITE_OK, let statement else {
            throw sqliteError(operation: operation, resultCode: result, database: raw)
        }
        return statement
    }

${SWIFT_BINDERS}

    // isWrite is what separates a generated write from the schema ladder and the
    // transaction control statements, which also step through here: only a write is
    // timed. On the autocommit shape the span is this step and nothing more - prepare and
    // the binds above it touch no lock - and the step is where acquisition, the work, and
    // the commit all happen.
    private func stepDone(
        statement: OpaquePointer,
        operation: String,
        isWrite: Bool = false
    ) throws {
        try assertNotMainThread(operation: operation)
        let start = isWrite ? writeSpanStart() : nil
        let result = curlew_sqlite3_step(statement)
        guard result == SQLITE_DONE else {
            let error = sqliteError(operation: operation, resultCode: result, database: raw)
            if Self.isSQLiteBusy(error) {
                recordWriteSpan(start, lostBudget: true)
            }
            throw error
        }
        recordWriteSpan(start, lostBudget: false)
    }

    // One monotonic domain, ProcessInfo.systemUptime, never crossed with a wall clock. nil
    // whenever nothing is
    // collecting or an enclosing transaction already owns the span, which makes every
    // recordWriteSpan below a no-op without the call sites branching.
    private func writeSpanStart() -> TimeInterval? {
        guard spanObserver != nil, !inExplicitTransaction else { return nil }
        return ProcessInfo.processInfo.systemUptime
    }

    private func recordWriteSpan(_ start: TimeInterval?, lostBudget: Bool) {
        guard let start, let spanObserver else { return }
        spanObserver(LocalSQLiteStoreSpan(
            kind: .write,
            millis: (ProcessInfo.processInfo.systemUptime - start) * 1000,
            lostBudget: lostBudget
        ))
    }

    // The read half, on the same terms as the write pair above: same monotonic domain, same
    // nil-means-nothing-is-collecting shape, and the same suppression inside an explicit
    // transaction, where a generated read is part of a unit withImmediateTransaction already
    // times and counting it again would nest a span inside a span.
    private func readSpanStart() -> TimeInterval? {
        guard spanObserver != nil, !inExplicitTransaction else { return nil }
        return ProcessInfo.processInfo.systemUptime
    }

    private func recordReadSpan(_ start: TimeInterval?, lostBudget: Bool) {
        guard let start, let spanObserver else { return }
        spanObserver(LocalSQLiteStoreSpan(
            kind: .read,
            millis: (ProcessInfo.processInfo.systemUptime - start) * 1000,
            lostBudget: lostBudget
        ))
    }`;

// A write whose statement returns one integer, as an upsert's RETURNING does. SQLite makes
// the change at the first step and commits when the statement finishes, so the span runs
// from the first step through the last, and contention at either one is a lost budget.
// The value is null when the statement returned no row.
const KOTLIN_STEP_WRITE_RETURNING = `    private fun stepWriteReturningLong(
        statement: Long,
        operation: String,
    ): Long? {
        assertNotMainThread(operation)
        val start = writeSpanStart()
        var result = CurlewSQLite.nativeStep(statement)
        var value: Long? = null
        if (result == CurlewSQLite.ROW) {
            value = CurlewSQLite.nativeColumnInt64(statement, 0)
            result = CurlewSQLite.nativeStep(statement)
        }
        if (result != CurlewSQLite.DONE) {
            val error = sqliteError(operation, result)
            if (isSQLiteBusy(error)) recordWriteSpan(start, lostBudget = true)
            throw error
        }
        recordWriteSpan(start, lostBudget = false)
        return value
    }`;

const SWIFT_STEP_WRITE_RETURNING = `    private func stepWriteReturningInt64(
        statement: OpaquePointer,
        operation: String
    ) throws -> Int64? {
        try assertNotMainThread(operation: operation)
        let start = writeSpanStart()
        var result = curlew_sqlite3_step(statement)
        var value: Int64?
        if result == SQLITE_ROW {
            value = curlew_sqlite3_column_int64(statement, 0)
            result = curlew_sqlite3_step(statement)
        }
        guard result == SQLITE_DONE else {
            let error = sqliteError(operation: operation, resultCode: result, database: raw)
            if Self.isSQLiteBusy(error) {
                recordWriteSpan(start, lostBudget: true)
            }
            throw error
        }
        recordWriteSpan(start, lostBudget: false)
        return value
    }`;

function anyPlainInsert(spec: LocalSQLiteSpec): boolean {
  return spec.tables.some((table) =>
    table.operations.some((operation) => operation.category === "insert"),
  );
}

const SWIFT_SQLITE_ERROR_FUNC = `private func sqliteError(
    operation: String,
    resultCode: Int32,
    database: OpaquePointer?
) -> LocalSQLiteGeneratedError {
    LocalSQLiteGeneratedError.sqlite(
        operation: operation,
        resultCode: resultCode,
        extendedResultCode: database.map(curlew_sqlite3_extended_errcode) ?? resultCode,
        message: database.flatMap(curlew_sqlite3_errmsg).map(String.init(cString:))
            ?? "SQLite did not provide an error message"
    )
}`;
