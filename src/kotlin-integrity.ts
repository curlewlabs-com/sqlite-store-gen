// Renders Kotlin's reactive local SQLite integrity vocabulary and probe.
// The generated open path invokes the probe after a failed open or recovered
// journal; reports classify recovery without deciding the consumer's action.

import type { LocalSQLiteSpec } from "./model";
import { columnListLines } from "./sql";

// The integrity stages (where an open failed) and recovery classes (what the bytes on disk
// say about it, from INTACT to UNREADABLE); these enums are what makes the vocabulary
// computable. Kept in the
// generated layer because each platform must render the same set, and because
// classification is generated work while the action taken on it is the consumer's.
const KOTLIN_INTEGRITY_TYPES = `enum class LocalSQLiteIntegrityStage {
    OPEN,
    JOURNAL_REPLAY,
    HEADER_READ,
    INTEGRITY_CHECK,
}

enum class LocalSQLiteRecoveryClass {
    INTACT,
    RECOVERABLE_JOURNAL,
    INDEX_DAMAGE,
    PAGE_DAMAGE,
    NOT_A_DATABASE,
    UNREADABLE,
    // A peer held the lock past the busy budget. Its own class rather than a shade of
    // UNREADABLE because CONTENDED and UNREADABLE answer different questions and
    // only UNREADABLE is a
    // property of the FILE: UNREADABLE means this process could not read the bytes, which
    // on a store at this Data Protection class means the reboot-to-first-unlock window;
    // CONTENDED means the bytes are fine and someone else was writing them. Folding
    // contention into UNREADABLE would bury the locked-device signal under every busy peer.
    CONTENDED,
}

data class LocalSQLiteIntegrityReport(
    val stage: LocalSQLiteIntegrityStage,
    val recoveryClass: LocalSQLiteRecoveryClass,
    // The SQLite result code, populated on every platform. Nullable for a failure that
    // never reached SQLite - a thread-policy check, or a filesystem error on the way to
    // the connection - which has no code to report. failureDetail names the thrown type
    // beside it.
    val resultCode: Int?,
    val failureDetail: String?,
)

// Distinct from the generic open failure for the same reason LocalSQLiteNewerSchemaException
// is: it carries a classification the consumer must act on, and only the consumer may
// choose between preserving and rebuilding the store.
class LocalSQLiteIntegrityException(
    val report: LocalSQLiteIntegrityReport,
    cause: Throwable,
) : IllegalStateException(
        "Generated local SQLite store failed at \${report.stage} classified \${report.recoveryClass}",
        cause,
    )`;

// Which phase of OUR open sequence raised, which is what the integrity stage records.
// Deliberately not a claim about which of SQLite's internal steps ran: the profile
// PRAGMAs are simply the first access we make that can perform rollback, and applying the
// profile alone completes a hot-journal recovery.
//
// One live table's read-back-whole scan. The column count travels with the SQL because
// the shim exposes no sqlite3_column_count - each platform generates it from the same
// spec, so a column added to a table is added to its scan by construction.
const KOTLIN_INTEGRITY_SCAN = `internal data class LocalSQLiteIntegrityScan(
    val sql: String,
    val columnCount: Int,
)`;

const KOTLIN_OPEN_PHASE = `internal enum class LocalSQLiteOpenPhase {
    CONNECT,
    PROFILE,
    HEADER_READ,
}`;

export function kotlinIntegrityProbe(spec: LocalSQLiteSpec): string {
  const scans = spec.tables
    .map((table) => {
      const columns = columnListLines(
        table.spec.columns.map((column) => column.name),
        "                ",
      );
      return `            LocalSQLiteIntegrityScan(
                """
                SELECT
${columns}
                FROM ${table.spec.name}
                """,
                ${table.spec.columns.length},
            )`;
    })
    .join(",\n");
  return `// Reactive by construction: nothing here runs on a healthy open, which still reads one
// header integer and touches no page of the database (the version-gated open). PRAGMA
// integrity_check reads every page, so putting it on the steady-state path
// would cost exactly what the version gate exists to avoid.
//
// quick_check is deliberately absent rather than cheaper-first - it cannot clear a
// database, because the index-versus-table mismatch it skips is the indexDamage class.
internal object LocalSQLiteIntegrityProbe {
    // The database-header string SQLite's file format documents at offset 0
    // (https://www.sqlite.org/fileformat2.html#the_database_header). Read from the bytes
    // rather than inferred from a result code, so each platform computes notADatabase
    // from the same observable.
    private val HEADER_MAGIC: ByteArray = "SQLite format 3\\u0000".toByteArray(Charsets.US_ASCII)

    // A peer holding the lock past the busy budget, read off the result code the failure
    // carries. CurlewSQLite exposes that code directly, so each platform decides
    // contention from the same observable without coupling classification to an exception
    // type or message format.
    //
    // Declared here rather than beside its other caller because this is the object that
    // has to name the recovery class, and one definition of "a peer held the lock" is
    // what keeps the classified class and the write-span observer agreeing about what
    // contention is. Swift's twin is LocalSQLiteIntegrityProbe.isContentionCode.
    fun isContentionFailure(failure: Throwable): Boolean =
        failure is LocalSQLiteGeneratedException && CurlewSQLite.isContentionCode(failure.resultCode)

    // The corruption half of the same result-code rule. Swift's twin is
    // isCorruptionCode.
    fun isCorruptionFailure(failure: Throwable): Boolean =
        failure is LocalSQLiteGeneratedException && CurlewSQLite.isCorruptionCode(failure.resultCode)

    // Null for a failure that did not come from SQLite - a thread-policy check or a
    // filesystem error on the way to the connection. SQLite failures carry their codes
    // through LocalSQLiteGeneratedException.
    private fun resultCodeOf(failure: Throwable): Int? =
        (failure as? LocalSQLiteGeneratedException)?.resultCode

    // A failed open cannot be asked what it holds, so the class comes from the bytes on
    // disk plus the result code. Order matters: contention is decided FIRST, then
    // unreadable and notADatabase, then corruption - because a lock, a file we could not
    // read, and a file that is not a database are all "not a diagnosis of damage".
    //
    // Contention leads because it is the one answer the bytes cannot contribute to: a lock
    // is a statement about another connection, not about this file, so reading the header
    // to decide it would be reading the wrong evidence - and would also spend a second
    // file open on the path a contended cold start takes most often.
    fun classifyOpenFailure(
        databaseFile: File,
        journalPresentAtOpen: Boolean,
        phase: LocalSQLiteOpenPhase,
        failure: Throwable,
    ): LocalSQLiteIntegrityReport {
        val recoveryClass =
            when {
                isContentionFailure(failure) -> LocalSQLiteRecoveryClass.CONTENDED
                else -> {
                    val header = readHeaderMagic(databaseFile)
                    when {
                        header == null -> LocalSQLiteRecoveryClass.UNREADABLE
                        !header.contentEquals(HEADER_MAGIC) ->
                            LocalSQLiteRecoveryClass.NOT_A_DATABASE
                        isCorruptionFailure(failure) -> LocalSQLiteRecoveryClass.PAGE_DAMAGE
                        else -> LocalSQLiteRecoveryClass.UNREADABLE
                    }
                }
            }
        return LocalSQLiteIntegrityReport(
            stage = stageFor(phase, journalPresentAtOpen),
            recoveryClass = recoveryClass,
            resultCode = resultCodeOf(failure),
            failureDetail = failure.javaClass.simpleName,
        )
    }

    // The store opened, so it can answer for itself. Reached only when a journal sidecar
    // was present when this open began - i.e. the previous writer was interrupted and this
    // open just rolled it back.
    fun classifyOpenStore(
        raw: Long,
        journalPresentAtOpen: Boolean,
    ): LocalSQLiteIntegrityReport {
        val faultCount =
            try {
                countIntegrityFaults(raw)
            } catch (e: LocalSQLiteGeneratedException) {
                return LocalSQLiteIntegrityReport(
                    stage = LocalSQLiteIntegrityStage.INTEGRITY_CHECK,
                    // The store answered, so there are no bytes to inspect and the result
                    // code is all there is. Same precedence as the open path: contention
                    // first, damage only on a corruption code.
                    recoveryClass =
                        when {
                            isContentionFailure(e) -> LocalSQLiteRecoveryClass.CONTENDED
                            isCorruptionFailure(e) -> LocalSQLiteRecoveryClass.PAGE_DAMAGE
                            else -> LocalSQLiteRecoveryClass.UNREADABLE
                        },
                    resultCode = e.resultCode,
                    failureDetail = e.javaClass.simpleName,
                )
            }
        if (faultCount == 0) {
            return LocalSQLiteIntegrityReport(
                stage = LocalSQLiteIntegrityStage.INTEGRITY_CHECK,
                recoveryClass =
                    if (journalPresentAtOpen) {
                        LocalSQLiteRecoveryClass.RECOVERABLE_JOURNAL
                    } else {
                        LocalSQLiteRecoveryClass.INTACT
                    },
                resultCode = null,
                failureDetail = null,
            )
        }
        // Faults on a store that opened. Which class that is turns on the class definition
        // itself - indexDamage is the one where "row data reads back whole" - so read every
        // row of every live table and let that answer it. Deliberately not parsed out of
        // integrity_check's message text: that is a vendor format we do not own, and the
        // messages carry rowids, which stay out of a report.
        return LocalSQLiteIntegrityReport(
            stage = LocalSQLiteIntegrityStage.INTEGRITY_CHECK,
            recoveryClass =
                if (liveRowsReadBackWhole(raw)) {
                    LocalSQLiteRecoveryClass.INDEX_DAMAGE
                } else {
                    LocalSQLiteRecoveryClass.PAGE_DAMAGE
                },
            resultCode = null,
            failureDetail = "integrity_check reported $faultCount problem(s)",
        )
    }

    fun journalPresent(databaseFile: File): Boolean = journalFile(databaseFile).exists()

    fun journalFile(databaseFile: File): File = File(databaseFile.absolutePath + JOURNAL_SUFFIX)

    // SQLite's file change counter, at offset 24 of the database header
    // (https://www.sqlite.org/fileformat2.html#the_database_header). Read off the file for
    // the same reason the magic above is: these bindings expose nothing equivalent through
    // the connection, and each platform has to compute this from one observable.
    fun changeCounter(databaseFile: File): Long? =
        try {
            databaseFile.inputStream().use { stream ->
                val header = ByteArray(CHANGE_COUNTER_OFFSET + CHANGE_COUNTER_BYTES)
                if (stream.read(header) != header.size) {
                    null
                } else {
                    var counter = 0L
                    for (index in 0 until CHANGE_COUNTER_BYTES) {
                        counter = (counter shl 8) or (header[CHANGE_COUNTER_OFFSET + index].toLong() and 0xFF)
                    }
                    counter
                }
            }
        } catch (e: IOException) {
            null
        }

    // The second integrity trigger, and the discriminator a store with a peer writing
    // process owes. The journal pair alone says
    // "a journal was there and is now gone", which app-private meant exactly "this open
    // rolled back an interrupted writer" - and with a second writing process also matches
    // "a peer committed during this open".
    //
    // A journal still sitting there afterwards was never replayed, so nothing about the
    // store changed and there is nothing to classify - triggering on presence alone
    // re-arms on every later open of a healthy store carrying an unreplayed journal.
    //
    // The change counter is what separates them, measured against the bundled engine
    // rather than reasoned about: a peer's COMMIT advances it, a rollback does not. A
    // rollback of a writer that had already written page 1 moves it BACK, which is why the
    // test is "did not advance" rather than "is unchanged".
    //
    // The counter only separates them while the CALLER brackets its journal samples with
    // its counter samples - counter, journal, ... journal, counter. Sampled the other way
    // round, a peer that commits between a journal read and the counter read hands this
    // function a post-commit "at open" value beside its own vanished journal, which is
    // indistinguishable from a rollback. The order is the open's to get right; this
    // function cannot check it.
    //
    // What survives the bracket is a peer that ABORTS inside the window: its journal is
    // unlinked with no commit, so the counter is unchanged and this returns true. That is
    // a false positive costing one integrity_check and a class that resolves to preserve.
    //
    // An unreadable counter deliberately falls back to classifying: a false positive costs
    // one integrity check, while a false negative leaves a real rollback unexamined.
    fun rolledBackAnInterruptedWriter(
        journalPresentAtOpen: Boolean,
        journalPresentAfterRecovery: Boolean,
        changeCounterAtOpen: Long?,
        changeCounterAfterRecovery: Long?,
    ): Boolean {
        if (!journalPresentAtOpen || journalPresentAfterRecovery) return false
        if (changeCounterAtOpen == null || changeCounterAfterRecovery == null) return true
        return changeCounterAfterRecovery <= changeCounterAtOpen
    }

    // A journal present when the open began means the furthest the store can have got
    // before this phase is the rollback it forced, so that is the stage recorded.
    private fun stageFor(
        phase: LocalSQLiteOpenPhase,
        journalPresentAtOpen: Boolean,
    ): LocalSQLiteIntegrityStage =
        when (phase) {
            LocalSQLiteOpenPhase.CONNECT -> {
                LocalSQLiteIntegrityStage.OPEN
            }

            LocalSQLiteOpenPhase.PROFILE -> {
                if (journalPresentAtOpen) {
                    LocalSQLiteIntegrityStage.JOURNAL_REPLAY
                } else {
                    LocalSQLiteIntegrityStage.OPEN
                }
            }

            LocalSQLiteOpenPhase.HEADER_READ -> {
                LocalSQLiteIntegrityStage.HEADER_READ
            }
        }

    private fun readHeaderMagic(databaseFile: File): ByteArray? =
        try {
            databaseFile.inputStream().use { stream ->
                val buffer = ByteArray(HEADER_MAGIC.size)
                if (stream.read(buffer) == buffer.size) buffer else null
            }
        } catch (e: IOException) {
            null
        }

    private fun countIntegrityFaults(raw: Long): Int =
        withPreparedStatement(raw, INTEGRITY_CHECK_SQL, "integrity_check") { statement ->
            var faults = 0
            while (true) {
                val step = CurlewSQLite.nativeStep(statement)
                if (step == CurlewSQLite.DONE) break
                if (step != CurlewSQLite.ROW) throw sqliteError(raw, "integrity_check", step)
                // A clean run is the single literal row "ok"; anything else is a fault.
                if (!CurlewSQLite.columnText(statement, 0).equals(INTEGRITY_CHECK_OK, ignoreCase = true)) {
                    faults++
                }
            }
            faults
        }

    private fun liveRowsReadBackWhole(raw: Long): Boolean =
        try {
            for (scan in INTEGRITY_SCANS) {
                withPreparedStatement(raw, scan.sql, "integrity scan") { statement ->
                    while (true) {
                        val step = CurlewSQLite.nativeStep(statement)
                        if (step == CurlewSQLite.DONE) break
                        if (step != CurlewSQLite.ROW) throw sqliteError(raw, "integrity scan", step)
                        // Fetch every column's value, not just the row. A long TEXT value lives
                        // on overflow pages that are only touched when the value itself is read, so
                        // stepping alone would leave them unvisited. The column count is
                        // generated, since the shim exposes no sqlite3_column_count.
                        for (index in 0 until scan.columnCount) CurlewSQLite.columnText(statement, index)
                    }
                }
            }
            true
        } catch (e: LocalSQLiteGeneratedException) {
            false
        }

    private const val JOURNAL_SUFFIX = "-journal"
    private const val CHANGE_COUNTER_OFFSET = 24
    private const val CHANGE_COUNTER_BYTES = 4
    private const val INTEGRITY_CHECK_SQL = "PRAGMA integrity_check"
    private const val INTEGRITY_CHECK_OK = "ok"
    private val INTEGRITY_SCANS: List<LocalSQLiteIntegrityScan> =
        listOf(
${scans},
        )
}`;
}

export function kotlinIntegrityDeclarations(): string[] {
  return [KOTLIN_INTEGRITY_TYPES, KOTLIN_INTEGRITY_SCAN, KOTLIN_OPEN_PHASE];
}
