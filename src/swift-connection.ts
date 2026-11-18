// Renders Swift's native-handle lifecycle from open through a verified connection profile.

export function swiftConnectionClassHead(swiftSpanState: string): string {
  return `    private let raw: OpaquePointer
    private let connectionProfile: LocalSQLiteConnectionProfile
    private let hostsUserInterface: Bool

${swiftSpanState}

    private init(
        raw: OpaquePointer,
        connectionProfile: LocalSQLiteConnectionProfile,
        hostsUserInterface: Bool
    ) {
        self.raw = raw
        self.connectionProfile = connectionProfile
        self.hostsUserInterface = hostsUserInterface
    }

    private var guardedConnection: GuardedConnection {
        GuardedConnection(raw: raw, hostsUserInterface: hostsUserInterface)
    }

    static func open(
        databaseURL: URL,
        hostsUserInterface: Bool = true
    ) throws -> GeneratedLocalSQLiteDatabase {
        try open(
            databaseURL: databaseURL,
            hostsUserInterface: hostsUserInterface,
            validateRuntimeIdentity: {
                try Self.validateRuntimeIdentity(raw: $0, hostsUserInterface: hostsUserInterface)
            },
            integrityObserver: { _ in }
        )
    }

    // The observer is how a classification reaches the consumer without the generated
    // layer acting on it: deleting a database is a product decision about the user's data,
    // so it stays on the consumer's side of this boundary.
    //
    // directoryFileProtection is applied when this open is the one that creates the
    // containing directory, and nil leaves the platform default in place - which is what
    // a temporary-directory test database wants.
    //
    // hostsUserInterface is the caller's declaration of which kind of process this is; the
    // guard below is the only thing it governs, and assertNotMainThread carries why.
    //
    // spanObserver is where the OPEN span goes - a parameter rather than the handle
    // property the other kinds use. LocalSQLiteStoreSpan owns why.
    static func open(
        databaseURL: URL,
        directoryFileProtection: FileProtectionType? = nil,
        hostsUserInterface: Bool = true,
        integrityObserver: (LocalSQLiteIntegrityReport) -> Void,
        spanObserver: ((LocalSQLiteStoreSpan) -> Void)? = nil
    ) throws -> GeneratedLocalSQLiteDatabase {
        try open(
            databaseURL: databaseURL,
            directoryFileProtection: directoryFileProtection,
            hostsUserInterface: hostsUserInterface,
            validateRuntimeIdentity: {
                try Self.validateRuntimeIdentity(raw: $0, hostsUserInterface: hostsUserInterface)
            },
            integrityObserver: integrityObserver,
            spanObserver: spanObserver
        )
    }

    // busyBudgetMillis is the contract row for every caller that does not name one, and
    // only openForTesting can: a test that stages contention deliberately puts a real
    // opener on the losing side of a peer's whole write transaction, which the row is not
    // sized for and does not have to be. What the profile still defends against is a
    // budget that did not take: the read-back below compares against what was asked for
    // rather than against one constant, so a test's longer wait is required of SQLite
    // exactly as the row is.
    private static func open(
        databaseURL: URL,
        directoryFileProtection: FileProtectionType? = nil,
        hostsUserInterface: Bool,
        validateRuntimeIdentity: (OpaquePointer) throws -> Void,
        integrityObserver: (LocalSQLiteIntegrityReport) -> Void,
        spanObserver: ((LocalSQLiteStoreSpan) -> Void)? = nil,
        busyBudgetMillis: Int64 = sqliteBusyTimeoutMillis
    ) throws -> GeneratedLocalSQLiteDatabase {
        try assertNotMainThread(operation: "open", hostsUserInterface: hostsUserInterface)
        guard databaseURL.isFileURL else {
            throw LocalSQLiteGeneratedError.nonFileDatabaseURL(databaseURL.absoluteString)
        }
        try FileManager.default.createDirectory(
            at: databaseURL.deletingLastPathComponent(),
            withIntermediateDirectories: true,
            attributes: directoryFileProtection.map { [.protectionKey: $0] }
        )
        // The counter and journal trigger-2 samples taken before SQLite, and their
        // ORDER is the correctness property: the counter samples must BRACKET the journal
        // samples in time (counter, journal, ... journal, counter). Any peer commit inside
        // that window then advances the counter between the bracketing reads and is visible as
        // such. Read the journal first and a peer that commits before the counter read
        // supplies a post-commit "at open" value, and its own vanished journal then reads
        // as this open's rollback. See rolledBackAnInterruptedWriter.
        //
        // This is what a healthy open pays for the probe: one 28-byte header read and one
        // filesystem existence check, no page of the database, and nothing on the classified
        // path. The counter cannot be skipped when no journal is present, because skipping
        // it is the reordering above.
        let changeCounterAtOpen = LocalSQLiteIntegrityProbe.changeCounter(databaseURL: databaseURL)
        // A journal here means a writer was interrupted or a peer is mid-transaction, and a
        // damaged journal does not fail the open, so this is the only signal that a partial
        // rollback is worth classifying at all.
        let journalPresentAtOpen = LocalSQLiteIntegrityProbe.journalPresent(databaseURL: databaseURL)
        // The contention window opens HERE, on the connection open. Everything before it is
        // the directory create and the probe's counter and journal reads, which touch no lock, so
        // folding them in would price filesystem work into a contention number.
        //
        // It starts before the connect rather than after the budget: sqlite3_open_v2 takes
        // no lock, but the leg has to exist for the legs to partition the window. Non-nil
        // means the window is still open; it is cleared the moment it is recorded, so no
        // path can record it twice.
        var openSpanTimer: OpenSpanTimer? = spanObserver == nil
            ? nil
            : OpenSpanTimer(start: ProcessInfo.processInfo.systemUptime)
        var database: OpaquePointer?
        let result = databaseURL.path.withCString { pathPointer in
            curlew_sqlite3_open_v2(
                pathPointer,
                &database,
                SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX,
                nil
            )
        }
        guard result == SQLITE_OK, let opened = database else {
            let message = database.flatMap(curlew_sqlite3_errmsg).map(String.init(cString:))
                ?? "SQLite did not provide an error message"
            if LocalSQLiteIntegrityProbe.isContentionCode(result) {
                recordOpenSpan(openSpanTimer, lostBudget: true, to: spanObserver)
                openSpanTimer = nil
            }
            if let database {
                curlew_sqlite3_close_v2(database)
            }
            throw LocalSQLiteGeneratedError.integrity(
                report: LocalSQLiteIntegrityProbe.classifyOpenFailure(
                    databaseURL: databaseURL,
                    journalPresentAtOpen: journalPresentAtOpen,
                    phase: .connect,
                    resultCode: result
                ),
                operation: "open generated local SQLite database",
                message: message
            )
        }
        var phase = LocalSQLiteOpenPhase.connect
        var rolledBackAnInterruptedWriter = false
        let generatedDatabase: GeneratedLocalSQLiteDatabase
        do {
            let connection = GuardedConnection(raw: opened, hostsUserInterface: hostsUserInterface)
            // Leg 1 closes: the connect. sqlite3_open_v2 takes no lock, so this leg is
            // near-zero by construction - and it is still timed as its own leg so a connect
            // that is slow for filesystem reasons cannot masquerade as a lock event in the
            // max.
            openSpanTimer?.markLeg()
            let busyTimeoutMillis = try applyBusyBudget(connection, budgetMillis: busyBudgetMillis)
            // Leg 2 closes: the budget. A pragma pair that takes no lock, so this leg is
            // near-zero by construction and is timed only to keep the partition total.
            openSpanTimer?.markLeg()
            try validateRuntimeIdentity(opened)
            // Leg 3 closes: the runtime-identity SELECT, the first statement here that can
            // actually wait - loading the schema takes SHARED.
            openSpanTimer?.markLeg()
            phase = .profile
            let profile = try configureConnection(connection, busyTimeoutMillis: busyTimeoutMillis)
            // Leg 4 closes: the profile. Leg 5, the header read, closes in recordOpenSpan.
            openSpanTimer?.markLeg()
            // The header read the headerRead stage names, taken here rather than inferred
            // from createSchema. It is one header integer and free, and doing it explicitly
            // is what keeps the stage meaning what the vocabulary says it means.
            phase = .headerRead
            _ = try connection.readPragmaInt64(sql: readSchemaVersionSQL)
            // The window closes with the last statement of the classified open, ahead of
            // createSchema for the same reason a ladder step is outside a write span: a
            // migration runs once per version, and folding it in would put its cost into a
            // distribution about ordinary opens.
            recordOpenSpan(openSpanTimer, lostBudget: false, to: spanObserver)
            openSpanTimer = nil
            // The counter and journal trigger-2 observations close HERE, before any schema work. Rollback is
            // already finished by this point - the profile alone completes it - and every
            // statement after this one is our own baseline create, obsolete drop, or ladder
            // step, whose commit advances the change counter exactly as a peer's does.
            // Closing the window here is what keeps our own schema work out of the
            // discriminator.
            // Closing samples, in the mirrored order that completes the bracket: journal
            // first, counter last. Reading the counter first here would let a peer commit
            // landing between the two supply a pre-commit value beside its own vanished
            // journal - the same misread, from the other end of the window.
            if journalPresentAtOpen {
                let journalPresentAfterRecovery = LocalSQLiteIntegrityProbe.journalPresent(
                    databaseURL: databaseURL)
                rolledBackAnInterruptedWriter =
                    LocalSQLiteIntegrityProbe.rolledBackAnInterruptedWriter(
                        journalPresentAtOpen: true,
                        journalPresentAfterRecovery: journalPresentAfterRecovery,
                        changeCounterAtOpen: changeCounterAtOpen,
                        changeCounterAfterRecovery: LocalSQLiteIntegrityProbe.changeCounter(
                            databaseURL: databaseURL)
                    )
            }
            generatedDatabase = GeneratedLocalSQLiteDatabase(
                raw: opened,
                connectionProfile: profile,
                hostsUserInterface: hostsUserInterface
            )
        } catch let error as LocalSQLiteGeneratedError {
            // Only a busy loss is a contention sample. An open that failed for any other
            // reason - a damaged file, a newer schema - measures a corruption or migration
            // outcome, which is reported as itself and would only blur this one.
            if Self.isSQLiteBusy(error) {
                recordOpenSpan(openSpanTimer, lostBudget: true, to: spanObserver)
            }
            curlew_sqlite3_close_v2(opened)
            throw Self.classified(
                error: error,
                databaseURL: databaseURL,
                journalPresentAtOpen: journalPresentAtOpen,
                phase: phase
            )
        } catch {
            curlew_sqlite3_close_v2(opened)
            throw error
        }
        do {
            // Deliberately OUTSIDE the classified window above. A baseline create, an
            // obsolete-table drop, an additive column reconcile, or a ladder step that fails
            // is a migration failure - it has its own report, its own preserve-every-input
            // policy, and its own retry-next-open convergence.
            // Classifying one as corruption would hand a migration bug to the consumer's
            // rebuild action and discard a store that is not damaged.
            try generatedDatabase.createSchema()
            // The decision was taken above; only the scan is deferred to here, so that every
            // live table exists for liveRowsReadBackWhole to read. A store climbing the
            // ladder is missing the tables a later step creates until createSchema has run,
            // and scanning before that would read the absence as unreadable rows.
            if rolledBackAnInterruptedWriter {
                integrityObserver(
                    LocalSQLiteIntegrityProbe.classifyOpenStore(raw: opened, journalPresentAtOpen: true)
                )
            }
            return generatedDatabase
        } catch {
            // Migration failures and the distinct newerSchema refusal each leave here
            // unclassified, each to the contract that already owns it.
            curlew_sqlite3_close_v2(opened)
            throw error
        }
    }

    // Only a failure SQLite itself reported says anything about the bytes on disk. A
    // newer-schema refusal has its own reset contract, and main-thread / non-file-URL /
    // provider-identity failures are ours, not the store's - all pass through unclassified.
    private static func classified(
        error: LocalSQLiteGeneratedError,
        databaseURL: URL,
        journalPresentAtOpen: Bool,
        phase: LocalSQLiteOpenPhase
    ) -> Error {
        guard case let .sqlite(operation, resultCode, _, message) = error else { return error }
        return LocalSQLiteGeneratedError.integrity(
            report: LocalSQLiteIntegrityProbe.classifyOpenFailure(
                databaseURL: databaseURL,
                journalPresentAtOpen: journalPresentAtOpen,
                phase: phase,
                resultCode: resultCode
            ),
            operation: operation,
            message: message
        )
    }

    static func openForTesting(
        databaseURL: URL,
        hostsUserInterface: Bool = true,
        spanObserver: ((LocalSQLiteStoreSpan) -> Void)? = nil
    ) throws -> GeneratedLocalSQLiteDatabase {
        try open(
            databaseURL: databaseURL,
            hostsUserInterface: hostsUserInterface,
            validateRuntimeIdentity: {
                try Self.validateRuntimeIdentity(raw: $0, hostsUserInterface: hostsUserInterface)
            },
            integrityObserver: { _ in },
            spanObserver: spanObserver
        )
    }

    static func openForTesting(
        databaseURL: URL,
        integrityObserver: (LocalSQLiteIntegrityReport) -> Void
    ) throws -> GeneratedLocalSQLiteDatabase {
        try open(
            databaseURL: databaseURL,
            hostsUserInterface: true,
            validateRuntimeIdentity: {
                try Self.validateRuntimeIdentity(raw: $0, hostsUserInterface: true)
            },
            integrityObserver: integrityObserver
        )
    }

    static func openForTesting(
        databaseURL: URL,
        validateRuntimeIdentity: (OpaquePointer) throws -> Void
    ) throws -> GeneratedLocalSQLiteDatabase {
        try open(
            databaseURL: databaseURL,
            hostsUserInterface: true,
            validateRuntimeIdentity: validateRuntimeIdentity,
            integrityObserver: { _ in }
        )
    }

    static func openForTesting(
        databaseURL: URL,
        busyBudgetMillis: Int64
    ) throws -> GeneratedLocalSQLiteDatabase {
        try open(
            databaseURL: databaseURL,
            hostsUserInterface: true,
            validateRuntimeIdentity: {
                try Self.validateRuntimeIdentity(raw: $0, hostsUserInterface: true)
            },
            integrityObserver: { _ in },
            busyBudgetMillis: busyBudgetMillis
        )
    }

    func connectionProfileForTesting() -> LocalSQLiteConnectionProfile {
        connectionProfile
    }

    func close() throws {
        let result = curlew_sqlite3_close_v2(raw)
        guard result == SQLITE_OK else {
            throw LocalSQLiteGeneratedError.sqlite(
                operation: "close generated local SQLite database",
                resultCode: result,
                extendedResultCode: result,
                message: "database handle did not close cleanly"
            )
        }
    }

    private static func validateRuntimeIdentity(
        raw: OpaquePointer,
        hostsUserInterface: Bool
    ) throws {
        let connection = GuardedConnection(raw: raw, hostsUserInterface: hostsUserInterface)
        try connection.assertNotMainThread(operation: "validate runtime identity")
        let statement = try connection.prepare(
            sql: runtimeIdentitySQL,
            operation: "prepare runtime identity"
        )
        defer { curlew_sqlite3_finalize(statement) }
        let result = curlew_sqlite3_step(statement)
        guard result == SQLITE_ROW,
              let versionBytes = curlew_sqlite3_column_text(statement, 0),
              let sourceIDBytes = curlew_sqlite3_column_text(statement, 1) else {
            if result != SQLITE_ROW {
                throw sqliteError(operation: "read runtime identity", resultCode: result, database: raw)
            }
            throw LocalSQLiteGeneratedError.unexpectedResult(
                operation: "read runtime identity",
                detail: "version or source ID column was NULL"
            )
        }
        try CurlewSQLiteProviderIdentity.validateRuntimeIdentity(
            version: String(cString: versionBytes),
            sourceID: String(cString: sourceIDBytes)
        )
    }`;
}

export const SWIFT_CONFIGURE_BLOCK = `    // The open's window and the legs that partition it. Same monotonic domain as every
    // write span (ProcessInfo.systemUptime), never crossed with a wall clock.
    //
    // \`markLeg\` closes the leg that just finished and opens the next one, and it is called
    // after EVERY leg rather than only the lock-taking ones. That is what makes the legs a
    // partition: a stretch of the window belonging to no leg could hide cost the max never
    // sees, and the whole reading rule is that the legs sum to the total.
    private struct OpenSpanTimer {
        let start: TimeInterval
        private var legStart: TimeInterval
        private(set) var maxLegMillis: Double = 0

        init(start: TimeInterval) {
            self.start = start
            self.legStart = start
        }

        mutating func markLeg(_ now: TimeInterval) {
            maxLegMillis = max(maxLegMillis, (now - legStart) * 1000)
            legStart = now
        }

        mutating func markLeg() {
            markLeg(ProcessInfo.processInfo.systemUptime)
        }
    }

    // Static because the open measures a window that closes before an instance exists, so
    // the observer arrives as a parameter rather than from \`spanObserver\`. A nil timer is a
    // window that never opened - nothing is collecting - or one already recorded, which is
    // what keeps the call sites branch-free.
    private static func recordOpenSpan(
        _ timer: OpenSpanTimer?,
        lostBudget: Bool,
        to spanObserver: ((LocalSQLiteStoreSpan) -> Void)?
    ) {
        guard var timer, let spanObserver else { return }
        // The same clock read supplies the total and final leg, so the legs sum to the
        // total exactly rather than to within the sampling overhead.
        let now = ProcessInfo.processInfo.systemUptime
        // The leg in flight when the window closed is a leg like any other - and on a busy
        // loss it is THE leg, the one that surrendered the budget. Closing it here is what
        // keeps the failure path's max the number the reading rule claims it is.
        timer.markLeg(now)
        spanObserver(LocalSQLiteStoreSpan(
            kind: .open,
            millis: (now - timer.start) * 1000,
            lostBudget: lostBudget,
            maxLegMillis: timer.maxLegMillis
        ))
    }

    // The connection's FIRST statement, ahead of the identity check and the rest of the
    // profile, because SQLite's default busy timeout is 0: until this runs, every statement
    // that needs a lock fails outright the instant a peer holds one instead of waiting for
    // it, and an open is a lock-taking sequence from its first statement onward (loading the
    // schema alone takes SHARED). A peer commit is a real window rather than a theoretical
    // one - \`synchronous = EXTRA\` puts the database and directory fsyncs inside it -
    // and the open has no outer
    // retry, so a failure here loses the whole pass for whatever consumer opened.
    //
    // Safe to run first because it takes no lock itself: it installs a connection-level
    // handler and touches no page of the database, so it succeeds while a peer holds
    // EXCLUSIVE. The budget covers every statement after it.
    private static func applyBusyBudget(
        _ connection: GuardedConnection,
        budgetMillis: Int64
    ) throws -> Int64 {
        try connection.executePragmaSet(
            sql: "PRAGMA busy_timeout = \\(budgetMillis)",
            operation: "set busy_timeout"
        )
        let busyTimeoutMillis = try connection.readPragmaInt64(sql: "PRAGMA busy_timeout")
        guard busyTimeoutMillis == budgetMillis else {
            throw LocalSQLiteGeneratedError.unexpectedResult(
                operation: "apply busy budget",
                detail: "busy_timeout returned \\(busyTimeoutMillis)"
            )
        }
        return busyTimeoutMillis
    }

    // Takes the budget rather than applying it: \`applyBusyBudget\` already ran, and it has to
    // have run, because every read-back below needs a lock this connection can wait for.
    private static func configureConnection(
        _ connection: GuardedConnection,
        busyTimeoutMillis: Int64
    ) throws -> LocalSQLiteConnectionProfile {
        try connection.assertNotMainThread(operation: "configure connection")
        let journalMode = try connection.readPragmaString(sql: "PRAGMA journal_mode = DELETE")
        guard journalMode.lowercased() == "delete" else {
            throw LocalSQLiteGeneratedError.unexpectedResult(
                operation: "configure connection",
                detail: "journal_mode returned \\(journalMode)"
            )
        }
        let lockingMode = try connection.readPragmaString(sql: "PRAGMA locking_mode = NORMAL")
        guard lockingMode.lowercased() == "normal" else {
            throw LocalSQLiteGeneratedError.unexpectedResult(
                operation: "configure connection",
                detail: "locking_mode returned \\(lockingMode)"
            )
        }
        try connection.execute(sql: "PRAGMA synchronous = EXTRA", operation: "set synchronous")
        let synchronous = try connection.readPragmaInt64(sql: "PRAGMA synchronous")
        guard synchronous == sqliteSynchronousExtra else {
            throw LocalSQLiteGeneratedError.unexpectedResult(
                operation: "configure connection",
                detail: "synchronous returned \\(synchronous)"
            )
        }
        try connection.executePragmaSet(sql: "PRAGMA cache_size = -2000", operation: "set cache_size")
        let cacheSize = try connection.readPragmaInt64(sql: "PRAGMA cache_size")
        guard cacheSize == sqliteCacheSize else {
            throw LocalSQLiteGeneratedError.unexpectedResult(
                operation: "configure connection",
                detail: "cache_size returned \\(cacheSize)"
            )
        }
        try connection.executePragmaSet(sql: "PRAGMA mmap_size = 0", operation: "set mmap_size")
        let mmapSizeBytes = try connection.readPragmaInt64(sql: "PRAGMA mmap_size")
        guard mmapSizeBytes == 0 else {
            throw LocalSQLiteGeneratedError.unexpectedResult(
                operation: "configure connection",
                detail: "mmap_size returned \\(mmapSizeBytes)"
            )
        }
        try connection.execute(sql: "PRAGMA foreign_keys = ON", operation: "set foreign_keys")
        let foreignKeys = try connection.readPragmaInt64(sql: "PRAGMA foreign_keys") == 1
        guard foreignKeys else {
            throw LocalSQLiteGeneratedError.unexpectedResult(
                operation: "configure connection",
                detail: "foreign_keys returned off"
            )
        }
        try connection.execute(sql: "PRAGMA trusted_schema = OFF", operation: "set trusted_schema")
        let trustedSchema = try connection.readPragmaInt64(sql: "PRAGMA trusted_schema") == 1
        guard !trustedSchema else {
            throw LocalSQLiteGeneratedError.unexpectedResult(
                operation: "configure connection",
                detail: "trusted_schema returned on"
            )
        }
        var defensiveValue: Int32 = 0
        let defensiveResult = curlew_sqlite3_db_config_defensive(connection.raw, 1, &defensiveValue)
        guard defensiveResult == SQLITE_OK, defensiveValue == 1 else {
            throw sqliteError(
                operation: "enable defensive mode",
                resultCode: defensiveResult,
                database: connection.raw
            )
        }
        return LocalSQLiteConnectionProfile(
            journalMode: journalMode.lowercased(),
            lockingMode: lockingMode.lowercased(),
            synchronous: synchronous,
            busyTimeoutMillis: busyTimeoutMillis,
            cacheSize: cacheSize,
            mmapSizeBytes: mmapSizeBytes,
            foreignKeys: foreignKeys,
            trustedSchema: trustedSchema,
            defensive: true
        )
    }

    // The raw handle paired with the caller's process-kind declaration. They travel
    // together so that every statement keeps its own guard without each helper re-taking
    // the declaration as a parameter - which matters most on the open path, where these
    // run before the database instance that would otherwise hold the pair exists.
    private struct GuardedConnection {
        let raw: OpaquePointer
        let hostsUserInterface: Bool

        func assertNotMainThread(operation: String) throws {
            try GeneratedLocalSQLiteDatabase.assertNotMainThread(
                operation: operation,
                hostsUserInterface: hostsUserInterface
            )
        }

        func execute(sql: String, operation: String) throws {
            try assertNotMainThread(operation: operation)
            let statement = try prepare(sql: sql, operation: operation)
            defer { curlew_sqlite3_finalize(statement) }
            let result = curlew_sqlite3_step(statement)
            guard result == SQLITE_DONE else {
                throw sqliteError(operation: operation, resultCode: result, database: raw)
            }
        }

        func executePragmaSet(sql: String, operation: String) throws {
            try assertNotMainThread(operation: operation)
            let statement = try prepare(sql: sql, operation: operation)
            defer { curlew_sqlite3_finalize(statement) }
            let result = curlew_sqlite3_step(statement)
            guard result == SQLITE_DONE || result == SQLITE_ROW else {
                throw sqliteError(operation: operation, resultCode: result, database: raw)
            }
        }

        func readPragmaString(sql: String) throws -> String {
            try assertNotMainThread(operation: "read pragma")
            let statement = try prepare(sql: sql, operation: "read pragma")
            defer { curlew_sqlite3_finalize(statement) }
            let result = curlew_sqlite3_step(statement)
            guard result == SQLITE_ROW, let bytes = curlew_sqlite3_column_text(statement, 0) else {
                throw sqliteError(operation: "read pragma", resultCode: result, database: raw)
            }
            return String(cString: bytes)
        }

        func readPragmaInt64(sql: String) throws -> Int64 {
            try assertNotMainThread(operation: "read pragma")
            let statement = try prepare(sql: sql, operation: "read pragma")
            defer { curlew_sqlite3_finalize(statement) }
            let result = curlew_sqlite3_step(statement)
            guard result == SQLITE_ROW else {
                throw sqliteError(operation: "read pragma", resultCode: result, database: raw)
            }
            return curlew_sqlite3_column_int64(statement, 0)
        }

        func prepare(sql: String, operation: String) throws -> OpaquePointer {
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
    }

    // The store refuses the main thread only where a user interface runs on it, and that
    // is the app process: its main thread draws the screen the user is looking at, so a
    // store open there is a dropped frame. An extension process has no such screen - it is
    // woken to produce one result, it is already waiting on this read, and it is torn down
    // after - so there is no responsiveness left to protect and every operation may run on
    // the calling thread, main included.
    //
    // Which kind of process this is, is the CALLER's to declare rather than this layer's to
    // detect. A process knows what it is; the store would have to infer it from its bundle,
    // which puts product topology inside a schema artifact and gives a test no way to reach
    // the other branch. hostsUserInterface therefore arrives at the open and is carried on
    // the connection, and the safe value is the default: a caller that says nothing gets the
    // refusal.
    private static func assertNotMainThread(operation: String, hostsUserInterface: Bool) throws {
        if hostsUserInterface, Thread.isMainThread {
            throw LocalSQLiteGeneratedError.mainThreadAccess(operation)
        }
    }

    private func assertNotMainThread(operation: String) throws {
        try Self.assertNotMainThread(operation: operation, hostsUserInterface: hostsUserInterface)
    }`;
