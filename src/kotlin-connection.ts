// Renders Android's path from a native SQLite handle to a verified connection profile,
// including its public store factory.

export const KOTLIN_FILE_HELPERS = `private fun sqliteError(
    raw: Long,
    operation: String,
    resultCode: Int,
): LocalSQLiteGeneratedException =
    LocalSQLiteGeneratedException(
        operation,
        resultCode,
        CurlewSQLite.nativeExtendedErrcode(raw),
        CurlewSQLite.errmsg(raw),
    )

// A NOT NULL TEXT column that reads back NULL means the store disagrees with its own
// schema, which is a fault to report rather than a value to normalize. Swift folds the same
// check into its SQLITE_ROW guard, so each platform refuses the row instead of substituting
// the empty string - which on the owner read would mean "no current owner" and would
// drop the row being recorded.
//
// An IllegalStateException rather than LocalSQLiteGeneratedException because nothing here
// came from SQLite: the step succeeded and the value is wrong. That also gives the integrity
// probe the right answer, since a failure carrying no result code classifies off the file's
// bytes and takes the preserve action rather than a rebuild.
private fun requiredText(
    statement: Long,
    column: Int,
    operation: String,
): String =
    CurlewSQLite.columnText(statement, column)
        ?: error("Generated $operation read NULL from NOT NULL TEXT column $column")

private fun prepareStatement(
    raw: Long,
    sql: String,
    operation: String,
): Long {
    val statement = LongArray(1)
    val result = CurlewSQLite.prepareV2(raw, sql, statement)
    if (result != CurlewSQLite.OK || statement[0] == 0L) {
        throw sqliteError(raw, operation, result)
    }
    return statement[0]
}

private fun <T> withPreparedStatement(
    raw: Long,
    sql: String,
    operation: String,
    body: (Long) -> T,
): T {
    val statement = prepareStatement(raw, sql, operation)
    try {
        return body(statement)
    } finally {
        CurlewSQLite.nativeFinalize(statement)
    }
}

// Steps a statement that returns no rows. The untimed twin of the class's stepDone: the
// open's statements are covered by the open span, which the companion times as one window.
private fun executeStatement(
    raw: Long,
    sql: String,
    operation: String,
) {
    withPreparedStatement(raw, sql, operation) { statement ->
        val result = CurlewSQLite.nativeStep(statement)
        if (result != CurlewSQLite.DONE && result != CurlewSQLite.ROW) {
            throw sqliteError(raw, operation, result)
        }
    }
}

// A value-reporting PRAGMA applies the assignment - "PRAGMA journal_mode = DELETE" answers with the
// mode it entered - so this steps the row rather than discarding it. That is why the
// profile can require its settings rather than request them.
private fun readPragmaTextOn(
    raw: Long,
    sql: String,
): String =
    withPreparedStatement(raw, sql, "read pragma") { statement ->
        val result = CurlewSQLite.nativeStep(statement)
        if (result != CurlewSQLite.ROW) throw sqliteError(raw, "read pragma: $sql", result)
        requiredText(statement, 0, "read pragma: $sql")
    }

private fun readPragmaLongOn(
    raw: Long,
    sql: String,
): Long =
    withPreparedStatement(raw, sql, "read pragma") { statement ->
        val result = CurlewSQLite.nativeStep(statement)
        if (result != CurlewSQLite.ROW) throw sqliteError(raw, "read pragma: $sql", result)
        CurlewSQLite.nativeColumnInt64(statement, 0)
    }`;

export const KOTLIN_COMPANION_METHODS = `        // Named rather than a trailing lambda: the private overload's last parameter is the
        // span observer, so a trailing lambda would silently bind to the wrong one.
        fun open(databaseFile: File): GeneratedLocalSQLiteDatabase = open(databaseFile, ::validateRuntimeIdentity, integrityObserver = {})

        // The observer is how a classification reaches the consumer without the generated
        // layer acting on it: deleting a database is a product decision about the user's
        // data, so it stays on the consumer's side of this boundary.
        //
        // spanObserver is where the OPEN span goes - a parameter rather than the handle
        // property the other kinds use. LocalSQLiteStoreSpan owns why.
        fun open(
            databaseFile: File,
            integrityObserver: (LocalSQLiteIntegrityReport) -> Unit,
            spanObserver: ((LocalSQLiteStoreSpan) -> Unit)? = null,
        ): GeneratedLocalSQLiteDatabase = open(databaseFile, ::validateRuntimeIdentity, integrityObserver, spanObserver)

        // busyBudgetMillis is the contract row for every caller that does not name one,
        // and only openForTesting can: a test that stages contention deliberately puts a
        // real opener on the losing side of a peer's whole write transaction, which the
        // row is not sized for and does not have to be. What the profile still defends
        // against is a budget that did not take: the read-back below compares against what
        // was asked for rather than against one constant, so a test's longer wait is
        // required of SQLite exactly as the row is.
        private fun open(
            databaseFile: File,
            runtimeIdentityValidator: (Long) -> Unit,
            integrityObserver: (LocalSQLiteIntegrityReport) -> Unit,
            spanObserver: ((LocalSQLiteStoreSpan) -> Unit)? = null,
            busyBudgetMillis: Long = SQLITE_BUSY_TIMEOUT_MILLIS,
        ): GeneratedLocalSQLiteDatabase {
            assertNotMainThread("open")
            // Brings up the shim, and the engine with it as a declared dependency.
            CurlewSQLite.load()
            val parent = databaseFile.parentFile ?: error("SQLite database path has no parent")
            if (!parent.isDirectory && !parent.mkdirs()) {
                error("Could not create generated SQLite database directory")
            }
            // The opening change-counter and journal-presence samples precede SQLite, and their
            // ORDER is the correctness property: the counter samples must BRACKET the
            // journal samples in time (counter, journal, ... journal, counter). Any peer
            // commit inside that window then advances the counter between the opening and closing reads and
            // is visible as such. Read the journal first and a peer that commits before the
            // counter read supplies a post-commit "at open" value, and its own vanished
            // journal then reads as this open's rollback. See rolledBackAnInterruptedWriter.
            //
            // This is what a healthy open pays for the probe: one 28-byte header read and
            // one filesystem existence check, no page of the database, and nothing on the
            // classified path. The counter cannot be skipped when no journal is present,
            // because skipping it is the reordering above.
            val changeCounterAtOpen = LocalSQLiteIntegrityProbe.changeCounter(databaseFile)
            // A journal here means a writer was interrupted or a peer is mid-transaction,
            // and a damaged journal does not fail the open, so this is the only signal that
            // a partial rollback is worth classifying at all.
            val journalPresentAtOpen = LocalSQLiteIntegrityProbe.journalPresent(databaseFile)
            var rolledBackAnInterruptedWriter = false
            var phase = LocalSQLiteOpenPhase.CONNECT
            // The contention window opens HERE, on the connection open. Everything before it
            // is the directory create and the probe's change-counter and journal-presence
            // reads, which touch no lock, so
            // folding them in would price filesystem work into a contention number.
            //
            // It starts before the connect rather than after the budget for the same
            // reason the Swift twin does: sqlite3_open_v2 takes no lock, but the leg has to
            // exist for the legs to partition the window. Non-null means the window is
            // still open; it is cleared the moment it is recorded, so no path records twice.
            var openSpanTimer: OpenSpanTimer? =
                if (spanObserver == null) null else OpenSpanTimer(System.nanoTime())
            val handle = LongArray(1)
            val openResult =
                CurlewSQLite.openV2(
                    databaseFile.absolutePath,
                    CurlewSQLite.OPEN_READWRITE or CurlewSQLite.OPEN_CREATE,
                    handle,
                )
            val database = handle[0]
            if (openResult != CurlewSQLite.OK) {
                // sqlite3_open_v2 hands back a handle even on failure, so the message can be
                // read off it - and it still has to be closed.
                val failure = sqliteError(database, "open", openResult)
                if (database != 0L) CurlewSQLite.nativeCloseV2(database)
                if (isSQLiteBusy(failure)) {
                    recordOpenSpan(openSpanTimer, lostBudget = true, spanObserver)
                    openSpanTimer = null
                }
                throw LocalSQLiteIntegrityException(
                    LocalSQLiteIntegrityProbe.classifyOpenFailure(
                        databaseFile,
                        journalPresentAtOpen,
                        phase,
                        failure,
                    ),
                    failure,
                )
            }
            // Extended codes on, so a classification sees SQLITE_CORRUPT_VTAB and friends
            // with their family in the low byte. iOS sets this on the same line of its open.
            CurlewSQLite.nativeExtendedResultCodes(database, 1)
            val generated =
                try {
                    // Leg 1 closes: the connect. sqlite3_open_v2 takes no lock and runs no
                    // framework setup statements, so this leg is near-zero by construction
                    // and represents only the physical connection open.
                    openSpanTimer?.markLeg()
                    val busyTimeoutMillis = applyBusyBudget(database, busyBudgetMillis)
                    // Leg 2 closes: the budget. A pragma pair that takes no lock, so this
                    // leg is near-zero by construction and is timed only to keep the
                    // partition total.
                    openSpanTimer?.markLeg()
                    runtimeIdentityValidator(database)
                    // Leg 3 closes: the runtime-identity SELECT, the first statement WE
                    // issue that can wait - loading the schema takes SHARED.
                    openSpanTimer?.markLeg()
                    phase = LocalSQLiteOpenPhase.PROFILE
                    val profile = configureConnection(database, busyTimeoutMillis)
                    // Leg 4 closes: the profile. Leg 5, the header read, closes in
                    // recordOpenSpan.
                    openSpanTimer?.markLeg()
                    // The header read the headerRead stage names, taken here rather than
                    // inferred from createSchema. It is one header integer and free, and
                    // doing it explicitly is what keeps the stage meaning what the
                    // vocabulary says it means.
                    phase = LocalSQLiteOpenPhase.HEADER_READ
                    readPragmaLongOn(database, READ_SCHEMA_VERSION_SQL)
                    // The window closes with the last statement of the classified open,
                    // ahead of createSchema for the same reason a ladder step is outside a
                    // write span: a migration runs once per version, and folding it in
                    // would put its cost into a distribution about ordinary opens.
                    recordOpenSpan(openSpanTimer, lostBudget = false, spanObserver)
                    openSpanTimer = null
                    // The closing journal-presence and change-counter observations happen HERE,
                    // before any schema work.
                    // Rollback is already finished by this point - the profile alone
                    // completes it - and every statement after this one is our own baseline
                    // create, obsolete drop, or ladder step, whose commit advances the
                    // change counter exactly as a peer's does. Closing the window here is
                    // what keeps our own schema work out of the discriminator.
                    //
                    // Closing samples, in the mirrored order that completes the bracket:
                    // journal first, counter last. Reading the counter first here would let
                    // a peer commit landing between the two supply a pre-commit value beside
                    // its own vanished journal - the same misread, from the other end.
                    if (journalPresentAtOpen) {
                        val journalPresentAfterRecovery =
                            LocalSQLiteIntegrityProbe.journalPresent(databaseFile)
                        rolledBackAnInterruptedWriter =
                            LocalSQLiteIntegrityProbe.rolledBackAnInterruptedWriter(
                                journalPresentAtOpen = true,
                                journalPresentAfterRecovery = journalPresentAfterRecovery,
                                changeCounterAtOpen = changeCounterAtOpen,
                                changeCounterAfterRecovery =
                                    LocalSQLiteIntegrityProbe.changeCounter(databaseFile),
                            )
                    }
                    GeneratedLocalSQLiteDatabase(database, profile)
                } catch (e: LocalSQLiteGeneratedException) {
                    // Only a busy loss is a contention sample. An open that failed for any
                    // other reason - a damaged file, a newer schema - measures a corruption
                    // or migration outcome, which is reported as itself and would only
                    // blur this one.
                    if (isSQLiteBusy(e)) {
                        recordOpenSpan(openSpanTimer, lostBudget = true, spanObserver)
                    }
                    CurlewSQLite.nativeCloseV2(database)
                    throw LocalSQLiteIntegrityException(
                        LocalSQLiteIntegrityProbe.classifyOpenFailure(
                            databaseFile,
                            journalPresentAtOpen,
                            phase,
                            e,
                        ),
                        e,
                    )
                } catch (e: RuntimeException) {
                    // Provider-identity and main-thread failures reach here. Neither says
                    // anything about the bytes on disk, so neither is classified.
                    CurlewSQLite.nativeCloseV2(database)
                    throw e
                }
            return try {
                // Deliberately OUTSIDE the classified window above. A baseline create, an
                // obsolete-table drop, an additive column reconcile, or a ladder step that
                // fails is a migration failure - it has its own report, its own
                // preserve-every-input policy, and its own retry-next-open
                // convergence. Classifying one as corruption would hand a migration bug to
                // the consumer's rebuild action and discard a store that is not damaged.
                generated.createSchema()
                // The decision was taken above; only the scan is deferred to here, so that
                // every live table exists for liveRowsReadBackWhole to read. A store
                // climbing the ladder is missing the tables a later step creates until
                // createSchema has run, and scanning before that would read the absence as
                // unreadable rows.
                if (rolledBackAnInterruptedWriter) {
                    integrityObserver(LocalSQLiteIntegrityProbe.classifyOpenStore(database, true))
                }
                generated
            } catch (e: RuntimeException) {
                // Migration failures and the distinct newer-schema refusal each leave here
                // unclassified, each to the contract that already owns it.
                CurlewSQLite.nativeCloseV2(database)
                throw e
            }
        }

        fun openForTesting(
            databaseFile: File,
            runtimeIdentityValidator: (Long) -> Unit = ::validateRuntimeIdentity,
            integrityObserver: (LocalSQLiteIntegrityReport) -> Unit = {},
            spanObserver: ((LocalSQLiteStoreSpan) -> Unit)? = null,
            busyBudgetMillis: Long = SQLITE_BUSY_TIMEOUT_MILLIS,
        ): GeneratedLocalSQLiteDatabase =
            open(databaseFile, runtimeIdentityValidator, integrityObserver, spanObserver, busyBudgetMillis)

        private fun validateRuntimeIdentity(raw: Long) {
            assertNotMainThread("validate runtime identity")
            AndroidBundledSQLiteVersionGuard.requireSupported(readPragmaTextOn(raw, SQLITE_VERSION_SQL))
            AndroidBundledSQLiteSourceIdGuard.requireExpected(readPragmaTextOn(raw, SQLITE_SOURCE_ID_SQL))
        }

        // The open's window and the legs that partition it. Nanoseconds and the same
        // monotonic source every write span uses, never crossed with a wall clock.
        //
        // \`markLeg\` closes the leg that just finished and opens the next one, and it is
        // called after EVERY leg rather than only the lock-taking ones. That is what makes
        // the legs a partition: a stretch of the window belonging to no leg could hide cost
        // the max never sees, and the whole reading rule is that the legs sum to the total.
        private class OpenSpanTimer(val start: Long) {
            private var legStart: Long = start
            var maxLegMillis: Double = 0.0
                private set

            fun markLeg(now: Long) {
                val legMillis = (now - legStart) / 1_000_000.0
                if (legMillis > maxLegMillis) {
                    maxLegMillis = legMillis
                }
                legStart = now
            }

            fun markLeg() = markLeg(System.nanoTime())
        }

        // In the companion because the open measures a window that closes before an
        // instance exists, so the observer arrives as a parameter rather than from
        // \`spanObserver\`. A null timer is a window that never opened - nothing is
        // collecting - or one already recorded, which is what keeps the call sites
        // branch-free.
        private fun recordOpenSpan(
            timer: OpenSpanTimer?,
            lostBudget: Boolean,
            spanObserver: ((LocalSQLiteStoreSpan) -> Unit)?,
        ) {
            if (timer == null) return
            // A shared clock read serves the total and final leg, so the legs sum to the
            // total exactly rather than differing by the cost of another read.
            val now = System.nanoTime()
            // The leg in flight when the window closed is a leg like any other - and on a
            // busy loss it is THE leg, the one that surrendered the budget. Closing it here
            // is what keeps the failure path's max the number the reading rule claims.
            timer.markLeg(now)
            spanObserver?.invoke(
                LocalSQLiteStoreSpan(
                    LocalSQLiteStoreSpanKind.OPEN,
                    (now - timer.start) / 1_000_000.0,
                    lostBudget,
                    timer.maxLegMillis,
                ),
            )
        }

        // The connection's FIRST statement, ahead of the identity check and the rest of
        // the profile, because SQLite's default busy timeout is 0: until this runs, every
        // statement that needs a lock fails outright the instant a peer holds one instead
        // of waiting for it, and an open is a lock-taking sequence from its first statement
        // onward (loading the schema alone takes SHARED). A peer commit is a real window
        // rather than a theoretical one - \`synchronous = EXTRA\` puts the database and
        // directory fsyncs inside it -
        // and the open has no outer retry, so a failure here loses the whole pass for
        // whatever consumer opened.
        //
        // Safe to run first because it takes no lock itself: it installs a
        // connection-level handler and touches no page of the database, so it succeeds
        // while a peer holds EXCLUSIVE. The budget covers every statement after it.
        private fun applyBusyBudget(
            raw: Long,
            budgetMillis: Long,
        ): Long {
            assertNotMainThread("apply busy budget")
            executeStatement(raw, "PRAGMA busy_timeout = $budgetMillis", "set busy_timeout")
            val busyTimeoutMillis = readPragmaLongOn(raw, "PRAGMA busy_timeout")
            require(busyTimeoutMillis == budgetMillis) {
                "SQLite busy_timeout was not applied: $busyTimeoutMillis"
            }
            return busyTimeoutMillis
        }

        // Takes the budget rather than applying it: \`applyBusyBudget\` already ran, and it
        // has to have run, because every read-back below needs a lock this connection can
        // wait for.
        private fun configureConnection(
            raw: Long,
            busyTimeoutMillis: Long,
        ): LocalSQLiteConnectionProfile {
            assertNotMainThread("configure connection")
            val journalMode = readPragmaTextOn(raw, "PRAGMA journal_mode = DELETE")
            require(journalMode.equals("delete", ignoreCase = true)) {
                "SQLite journal_mode did not enter rollback DELETE mode: $journalMode"
            }
            val lockingMode = readPragmaTextOn(raw, "PRAGMA locking_mode = NORMAL")
            require(lockingMode.equals("normal", ignoreCase = true)) {
                "SQLite locking_mode did not enter NORMAL mode: $lockingMode"
            }
            executeStatement(raw, "PRAGMA synchronous = EXTRA", "set synchronous")
            val synchronous = readPragmaLongOn(raw, "PRAGMA synchronous")
            require(synchronous == SQLITE_SYNCHRONOUS_EXTRA) {
                "SQLite synchronous did not enter EXTRA mode: $synchronous"
            }
            executeStatement(raw, "PRAGMA cache_size = -2000", "set cache_size")
            val cacheSize = readPragmaLongOn(raw, "PRAGMA cache_size")
            require(cacheSize == SQLITE_CACHE_SIZE) {
                "SQLite cache_size was not applied: $cacheSize"
            }
            executeStatement(raw, "PRAGMA mmap_size = 0", "set mmap_size")
            val mmapSizeBytes = readPragmaLongOn(raw, "PRAGMA mmap_size")
            require(mmapSizeBytes == 0L) {
                "SQLite mmap_size was not disabled: $mmapSizeBytes"
            }
            executeStatement(raw, "PRAGMA foreign_keys = ON", "set foreign_keys")
            val foreignKeys = readPragmaLongOn(raw, "PRAGMA foreign_keys") == 1L
            require(foreignKeys) {
                "SQLite foreign_keys was not enabled"
            }
            executeStatement(raw, "PRAGMA trusted_schema = OFF", "set trusted_schema")
            val trustedSchema = readPragmaLongOn(raw, "PRAGMA trusted_schema") == 1L
            require(!trustedSchema) {
                "SQLite trusted_schema was not disabled"
            }
            // Not a PRAGMA: SQLITE_DBCONFIG_DEFENSIVE is set through sqlite3_db_config,
            // which reports back what the connection actually holds - so this is required
            // rather than requested, on the same terms as the read-backs above. The AAR's
            // Java bindings expose no sqlite3_db_config, so the native shim is the only
            // route to this connection setting.
            val defensiveCurrent = IntArray(1)
            val defensiveResult = CurlewSQLite.nativeDbConfigDefensive(raw, 1, defensiveCurrent)
            if (defensiveResult != CurlewSQLite.OK || defensiveCurrent[0] != 1) {
                throw sqliteError(raw, "enable defensive mode", defensiveResult)
            }
            return LocalSQLiteConnectionProfile(
                journalMode = journalMode.lowercase(),
                lockingMode = lockingMode.lowercase(),
                synchronous = synchronous,
                busyTimeoutMillis = busyTimeoutMillis,
                cacheSize = cacheSize,
                mmapSizeBytes = mmapSizeBytes,
                foreignKeys = foreignKeys,
                trustedSchema = trustedSchema,
                defensive = true,
            )
        }

        // Unconditional, where the Swift side takes the opening process's declaration of
        // whether it hosts a user interface. Android has no non-UI process to exempt:
        // receivers, services and WorkManager jobs run in the app's process by default, so
        // every caller here is on the process whose main thread draws the screen. The rule
        // is the same rule - see the Swift assertNotMainThread.
        private fun assertNotMainThread(operation: String) {
            check(Looper.myLooper() != Looper.getMainLooper()) {
                "Generated local SQLite operation must not run on the main thread: $operation"
            }
        }`;

// The store facade, with the consumer's database file name: the name is the consumer's
// own, and validated where the options are read (options.ts).
export function kotlinStoreObject(databaseFileName: string): string {
  return `object LocalSQLiteGeneratedStore {
    // Exposed so a consumer acting on a recovery class can reach the file itself. The
    // generated layer classifies but never deletes: which bytes survive a corrupt store
    // is a product decision about the user's data, so it stays on the consumer's side.
    fun appPrivateDatabaseFile(context: Context): File = context.getDatabasePath(APP_PRIVATE_DATABASE_NAME)

    fun openAppPrivate(context: Context): GeneratedLocalSQLiteDatabase =
        GeneratedLocalSQLiteDatabase.open(context.getDatabasePath(APP_PRIVATE_DATABASE_NAME))

    fun openAppPrivate(
        context: Context,
        integrityObserver: (LocalSQLiteIntegrityReport) -> Unit,
        spanObserver: ((LocalSQLiteStoreSpan) -> Unit)? = null,
    ): GeneratedLocalSQLiteDatabase =
        GeneratedLocalSQLiteDatabase.open(
            context.getDatabasePath(APP_PRIVATE_DATABASE_NAME),
            integrityObserver,
            spanObserver,
        )

    fun openForTesting(databaseFile: File): GeneratedLocalSQLiteDatabase = GeneratedLocalSQLiteDatabase.openForTesting(databaseFile)

    // Distinct name for the same reason the integrity-observer entry above has one: the
    // observer lambdas erase to the same JVM signature as the runtime-identity validator.
    fun openForTestingWithSpanObserver(
        databaseFile: File,
        spanObserver: (LocalSQLiteStoreSpan) -> Unit,
    ): GeneratedLocalSQLiteDatabase = GeneratedLocalSQLiteDatabase.openForTesting(databaseFile, spanObserver = spanObserver)

    // Distinct name rather than an overload: the span and integrity observer lambdas erase to the same JVM
    // signature as the runtime-identity one below.
    fun openForTestingWithIntegrityObserver(
        databaseFile: File,
        integrityObserver: (LocalSQLiteIntegrityReport) -> Unit,
    ): GeneratedLocalSQLiteDatabase = GeneratedLocalSQLiteDatabase.openForTesting(databaseFile, integrityObserver = integrityObserver)

    fun openForTesting(
        databaseFile: File,
        runtimeIdentityValidator: (Long) -> Unit,
    ): GeneratedLocalSQLiteDatabase = GeneratedLocalSQLiteDatabase.openForTesting(databaseFile, runtimeIdentityValidator)

    // The only route to a budget other than the contract row, and the private open above
    // carries why one exists. What the app calls is openAppPrivate, which does not take
    // it, so no production open can reach a budget this store did not set itself.
    fun openForTesting(
        databaseFile: File,
        busyBudgetMillis: Long,
    ): GeneratedLocalSQLiteDatabase =
        GeneratedLocalSQLiteDatabase.openForTesting(databaseFile, busyBudgetMillis = busyBudgetMillis)

    fun close(database: GeneratedLocalSQLiteDatabase) {
        database.close()
    }

    private const val APP_PRIVATE_DATABASE_NAME = "${databaseFileName}"
}`;
}
