// Renders Swift's reactive local SQLite integrity vocabulary and probe.
// The generated open path invokes the probe after a failed open or recovered
// journal; reports classify recovery without deciding the consumer's action.

import type { LocalSQLiteSpec } from "./model";
import { columnListLines } from "./sql";

// The integrity stages (where an open failed) and recovery classes (what the bytes on disk
// say about it). Each platform renders the same set, and each computes a class
// from the same observables, so a class means one thing across the pair.
const SWIFT_INTEGRITY_TYPES = `enum LocalSQLiteIntegrityStage: String, Equatable, Sendable {
    case open
    case journalReplay
    case headerRead
    case integrityCheck
}

enum LocalSQLiteRecoveryClass: String, Equatable, Sendable {
    case intact
    case recoverableJournal
    case indexDamage
    case pageDamage
    case notADatabase
    case unreadable
    // A peer held the lock past the busy budget. Its own class rather than a shade of
    // \`unreadable\` because \`contended\` and \`unreadable\` answer different questions and
    // only \`unreadable\` is a
    // property of the FILE: \`unreadable\` means this process could not read the bytes,
    // which on a store at this Data Protection class means the reboot-to-first-unlock
    // window; \`contended\` means the bytes are fine and someone else was writing them.
    // Keeping those classes distinct preserves the locked-device signal.
    case contended
}

struct LocalSQLiteIntegrityReport: Equatable, Sendable {
    let stage: LocalSQLiteIntegrityStage
    let recoveryClass: LocalSQLiteRecoveryClass
    // The SQLite result code, populated on every platform. Nil for a failure that never
    // reached SQLite - a thread-policy check, or a filesystem error on the way to the
    // connection - which has no code to report.
    let resultCode: Int32?
    let failureDetail: String?
}

// Which phase of OUR open sequence raised, which is what the integrity stage records.
// Deliberately not a claim about which of SQLite's internal steps ran: the profile
// PRAGMAs are simply the first access we make that can perform rollback, and applying the
// profile alone completes a hot-journal recovery.
enum LocalSQLiteOpenPhase: Equatable, Sendable {
    case connect
    case profile
    case headerRead
}`;

export function swiftIntegrityProbe(spec: LocalSQLiteSpec): string {
  const scans = spec.tables
    .map((table) => {
      const columns = columnListLines(
        table.spec.columns.map((column) => column.name),
        "                    ",
      );
      return `        IntegrityScan(
            sql: """
                SELECT
${columns}
                FROM ${table.spec.name}
                """,
            columnCount: ${table.spec.columns.length}
        )`;
    })
    .join(",\n");
  return `private struct LocalSQLiteProbeFailure: Error {
    let resultCode: Int32
}

// Reactive by construction: nothing here runs on a healthy open, which still reads one
// header integer and touches no page of the database (the version-gated open). PRAGMA
// integrity_check reads every page, so putting it on the steady-state path
// would cost exactly what the version gate exists to avoid.
//
// quick_check is deliberately absent rather than cheaper-first - it cannot clear a
// database, because the index-versus-table mismatch it skips is the indexDamage class.
enum LocalSQLiteIntegrityProbe {
    // The database-header string SQLite's file format documents at offset 0
    // (https://www.sqlite.org/fileformat2.html#the_database_header). Read from the bytes
    // rather than taken from the result code, so each platform computes notADatabase from
    // the same observable rather than relying on the engine to report SQLITE_NOTADB in
    // every case it could.
    private static let headerMagic = Array("SQLite format 3\\u{0}".utf8)

    // A failed open cannot be asked what it holds, so the class comes from the bytes on
    // disk plus the result code. Order matters: contention is decided FIRST, then
    // unreadable and notADatabase, then corruption - because a lock, a file we could not
    // read, and a file that is not a database are all "not a diagnosis of damage".
    //
    // Contention leads because it is the one answer the bytes cannot contribute to: a busy
    // result code is a statement about another connection, not about this file, so reading
    // the header to decide it would be reading the wrong evidence - and would also spend a
    // second file open on the path a contended cold start takes most often.
    static func classifyOpenFailure(
        databaseURL: URL,
        journalPresentAtOpen: Bool,
        phase: LocalSQLiteOpenPhase,
        resultCode: Int32
    ) -> LocalSQLiteIntegrityReport {
        let recoveryClass: LocalSQLiteRecoveryClass
        if isContentionCode(resultCode) {
            recoveryClass = .contended
        } else if let header = readHeaderMagic(databaseURL: databaseURL) {
            if header == headerMagic {
                recoveryClass = isCorruptionCode(resultCode) ? .pageDamage : .unreadable
            } else {
                recoveryClass = .notADatabase
            }
        } else {
            recoveryClass = .unreadable
        }
        return LocalSQLiteIntegrityReport(
            stage: stageFor(phase: phase, journalPresentAtOpen: journalPresentAtOpen),
            recoveryClass: recoveryClass,
            resultCode: resultCode,
            failureDetail: nil
        )
    }

    // The store opened, so it can answer for itself. Reached only when a journal sidecar
    // was present when this open began - i.e. the previous writer was interrupted and this
    // open just rolled it back.
    static func classifyOpenStore(
        raw: OpaquePointer,
        journalPresentAtOpen: Bool
    ) -> LocalSQLiteIntegrityReport {
        let faultCount: Int
        do {
            faultCount = try countIntegrityFaults(raw: raw)
        } catch let failure as LocalSQLiteProbeFailure {
            return LocalSQLiteIntegrityReport(
                stage: .integrityCheck,
                recoveryClass: classifyProbeFailureCode(failure.resultCode),
                resultCode: failure.resultCode,
                failureDetail: nil
            )
        } catch {
            return LocalSQLiteIntegrityReport(
                stage: .integrityCheck,
                recoveryClass: .unreadable,
                resultCode: nil,
                failureDetail: nil
            )
        }
        if faultCount == 0 {
            return LocalSQLiteIntegrityReport(
                stage: .integrityCheck,
                recoveryClass: journalPresentAtOpen ? .recoverableJournal : .intact,
                resultCode: nil,
                failureDetail: nil
            )
        }
        // Faults on a store that opened. Which class that is turns on the class definition
        // itself - indexDamage is the one where "row data reads back whole" - so read every
        // row of every live table and let that answer it. Deliberately not parsed out of
        // integrity_check's message text: that is a vendor format we do not own, and the
        // messages carry rowids, which stay out of a report.
        return LocalSQLiteIntegrityReport(
            stage: .integrityCheck,
            recoveryClass: liveRowsReadBackWhole(raw: raw) ? .indexDamage : .pageDamage,
            resultCode: nil,
            failureDetail: "integrity_check reported \\(faultCount) problem(s)"
        )
    }

    static func journalPresent(databaseURL: URL) -> Bool {
        FileManager.default.fileExists(atPath: journalURL(for: databaseURL).path)
    }

    static func journalURL(for databaseURL: URL) -> URL {
        URL(fileURLWithPath: databaseURL.path + journalSuffix)
    }

    // SQLite's file change counter, at offset 24 of the database header
    // (https://www.sqlite.org/fileformat2.html#the_database_header). Read off the file for
    // the same reason the magic above is: it has to be computable on Android too, whose
    // bindings expose no equivalent through the connection.
    static func changeCounter(databaseURL: URL) -> UInt32? {
        guard let handle = try? FileHandle(forReadingFrom: databaseURL) else { return nil }
        defer { try? handle.close() }
        guard let data = try? handle.read(upToCount: changeCounterOffset + changeCounterBytes),
              data.count == changeCounterOffset + changeCounterBytes else { return nil }
        return data[changeCounterOffset..<(changeCounterOffset + changeCounterBytes)]
            .reduce(UInt32(0)) { accumulated, byte in (accumulated << 8) | UInt32(byte) }
    }

    // The second integrity trigger, and the discriminator a store with a peer writing
    // process owes. The journal pair alone is
    // compatible with either this open rolling back an interrupted writer or a peer
    // committing during this open.
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
    static func rolledBackAnInterruptedWriter(
        journalPresentAtOpen: Bool,
        journalPresentAfterRecovery: Bool,
        changeCounterAtOpen: UInt32?,
        changeCounterAfterRecovery: UInt32?
    ) -> Bool {
        guard journalPresentAtOpen, !journalPresentAfterRecovery else { return false }
        guard let atOpen = changeCounterAtOpen,
              let afterRecovery = changeCounterAfterRecovery else { return true }
        return afterRecovery <= atOpen
    }

    // A journal present when the open began means the furthest the store can have got
    // before this phase is the rollback it forced, so that is the stage recorded.
    private static func stageFor(
        phase: LocalSQLiteOpenPhase,
        journalPresentAtOpen: Bool
    ) -> LocalSQLiteIntegrityStage {
        switch phase {
        case .connect:
            return .open
        case .profile:
            return journalPresentAtOpen ? .journalReplay : .open
        case .headerRead:
            return .headerRead
        }
    }

    // The store answered, so there are no bytes to inspect and the code is all there is.
    // Same precedence as the open path: contention first, damage only on a corruption code.
    private static func classifyProbeFailureCode(_ resultCode: Int32) -> LocalSQLiteRecoveryClass {
        if isContentionCode(resultCode) { return .contended }
        return isCorruptionCode(resultCode) ? .pageDamage : .unreadable
    }

    // SQLITE_BUSY and SQLITE_LOCKED, checked on the primary code so an extended code
    // (SQLITE_BUSY_SNAPSHOT and friends) classifies with its family.
    //
    // Declared here rather than beside its other caller because this is the type that has
    // to name the recovery class, and one definition of "a peer held the lock" is what
    // keeps the classified class and the write-span observer agreeing about what
    // contention is. Kotlin's twin is LocalSQLiteIntegrityProbe.isContentionFailure.
    static func isContentionCode(_ resultCode: Int32) -> Bool {
        let primary = resultCode & 0xFF
        return primary == SQLITE_BUSY || primary == SQLITE_LOCKED
    }

    private static func isCorruptionCode(_ resultCode: Int32) -> Bool {
        let primary = resultCode & 0xFF
        return primary == SQLITE_CORRUPT || primary == SQLITE_NOTADB
    }

    private static func readHeaderMagic(databaseURL: URL) -> [UInt8]? {
        guard let handle = try? FileHandle(forReadingFrom: databaseURL) else { return nil }
        defer { try? handle.close() }
        guard let data = try? handle.read(upToCount: headerMagic.count),
              data.count == headerMagic.count else { return nil }
        return Array(data)
    }

    private static func countIntegrityFaults(raw: OpaquePointer) throws -> Int {
        var statement: OpaquePointer?
        let prepared = integrityCheckSQL.withCString { sqlPointer in
            curlew_sqlite3_prepare_v2(raw, sqlPointer, -1, &statement, nil)
        }
        guard prepared == SQLITE_OK, let statement else {
            throw LocalSQLiteProbeFailure(resultCode: prepared)
        }
        defer { curlew_sqlite3_finalize(statement) }
        var faults = 0
        while true {
            let step = curlew_sqlite3_step(statement)
            if step == SQLITE_DONE { break }
            guard step == SQLITE_ROW else { throw LocalSQLiteProbeFailure(resultCode: step) }
            // A clean run is the single literal row "ok"; anything else - including a NULL
            // this never expects - counts as a fault.
            let text = curlew_sqlite3_column_text(statement, 0).map { String(cString: \$0) }
            if text?.lowercased() != integrityCheckOK { faults += 1 }
        }
        return faults
    }

    private static func liveRowsReadBackWhole(raw: OpaquePointer) -> Bool {
        for scan in integrityScans {
            var statement: OpaquePointer?
            let prepared = scan.sql.withCString { sqlPointer in
                curlew_sqlite3_prepare_v2(raw, sqlPointer, -1, &statement, nil)
            }
            guard prepared == SQLITE_OK, let statement else { return false }
            defer { curlew_sqlite3_finalize(statement) }
            while true {
                let step = curlew_sqlite3_step(statement)
                if step == SQLITE_DONE { break }
                guard step == SQLITE_ROW else { return false }
                // Fetch every column's value, not just the row. A long TEXT value lives on
                // overflow pages that are only touched when the value itself is read, so stepping alone
                // would leave them unvisited. The column count is generated, since the shim
                // exposes no sqlite3_column_count.
                for index in 0..<scan.columnCount {
                    _ = curlew_sqlite3_column_text(statement, index)
                }
            }
        }
        return true
    }

    private struct IntegrityScan {
        let sql: String
        let columnCount: Int32
    }

    private static let journalSuffix = "-journal"
    private static let changeCounterOffset = 24
    private static let changeCounterBytes = 4
    private static let integrityCheckSQL = "PRAGMA integrity_check"
    private static let integrityCheckOK = "ok"
    private static let integrityScans: [IntegrityScan] = [
${scans}
    ]
}`;
}

export function swiftIntegrityDeclarations(): string {
  return SWIFT_INTEGRITY_TYPES;
}
