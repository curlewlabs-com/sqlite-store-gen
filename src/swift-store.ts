// Renders Swift's public app-group database location and open/close facade.

// The database file name is the consumer's own, and validated where the options are read
// (options.ts).
export function swiftStoreEnum(databaseFileName: string): string {
  return `enum LocalSQLiteGeneratedStore {
    // Exposed so a consumer acting on a recovery class can reach the file itself. The
    // generated layer classifies but never deletes: which bytes survive a corrupt store
    // is a product decision about the user's data, so it stays on the consumer's side.
    //
    // The App Group identifier is a parameter rather than a constant here because it is
    // the app's configuration, not schema: it already has one home in the app's own code,
    // and a second copy in generated output would be a copy no sweep could keep honest.
    static func sharedContainerDatabaseURL(appGroupIdentifier: String) throws -> URL {
        guard let containerURL = FileManager.default.containerURL(
            forSecurityApplicationGroupIdentifier: appGroupIdentifier
        ) else {
            throw LocalSQLiteGeneratedError.unexpectedResult(
                operation: "resolve shared-container generated local SQLite database",
                detail: "App Group container is unavailable"
            )
        }
        return containerURL
            .appendingPathComponent(sharedContainerDirectoryName, isDirectory: true)
            .appendingPathComponent(databaseName)
    }

    // hostsUserInterface is the opening process's own declaration, for the same reason the
    // App Group identifier above is a parameter: it is the app's topology rather than schema.
    // GeneratedLocalSQLiteDatabase.assertNotMainThread carries what it governs.
    static func openSharedContainer(
        appGroupIdentifier: String,
        hostsUserInterface: Bool = true,
        integrityObserver: (LocalSQLiteIntegrityReport) -> Void,
        spanObserver: ((LocalSQLiteStoreSpan) -> Void)? = nil
    ) throws -> GeneratedLocalSQLiteDatabase {
        try GeneratedLocalSQLiteDatabase.open(
            databaseURL: sharedContainerDatabaseURL(appGroupIdentifier: appGroupIdentifier),
            directoryFileProtection: databaseDirectoryFileProtection,
            hostsUserInterface: hostsUserInterface,
            integrityObserver: integrityObserver,
            spanObserver: spanObserver
        )
    }

    static func openForTesting(
        databaseURL: URL,
        hostsUserInterface: Bool = true,
        spanObserver: ((LocalSQLiteStoreSpan) -> Void)? = nil
    ) throws -> GeneratedLocalSQLiteDatabase {
        try GeneratedLocalSQLiteDatabase.openForTesting(
            databaseURL: databaseURL,
            hostsUserInterface: hostsUserInterface,
            spanObserver: spanObserver
        )
    }

    static func openForTesting(
        databaseURL: URL,
        integrityObserver: (LocalSQLiteIntegrityReport) -> Void
    ) throws -> GeneratedLocalSQLiteDatabase {
        try GeneratedLocalSQLiteDatabase.openForTesting(
            databaseURL: databaseURL,
            integrityObserver: integrityObserver
        )
    }

    static func openForTesting(
        databaseURL: URL,
        validateRuntimeIdentity: (OpaquePointer) throws -> Void
    ) throws -> GeneratedLocalSQLiteDatabase {
        try GeneratedLocalSQLiteDatabase.openForTesting(
            databaseURL: databaseURL,
            validateRuntimeIdentity: validateRuntimeIdentity
        )
    }

    // The only route to a budget other than the contract row, and the private open in
    // GeneratedLocalSQLiteDatabase carries why one exists. What the app and its extensions
    // call is openSharedContainer, which does not take it, so no production open can reach
    // a budget this store did not set itself.
    static func openForTesting(
        databaseURL: URL,
        busyBudgetMillis: Int64
    ) throws -> GeneratedLocalSQLiteDatabase {
        try GeneratedLocalSQLiteDatabase.openForTesting(
            databaseURL: databaseURL,
            busyBudgetMillis: busyBudgetMillis
        )
    }

    static func close(_ database: GeneratedLocalSQLiteDatabase) throws {
        try database.close()
    }

    // Applied to the containing directory, never to the database file: SQLite creates and
    // unlinks the -journal sidecar itself for the lifetime of the store, so the file is the
    // wrong thing to stamp: a class set on the file never reaches the journal, and a
    // locked-device writer then fails partway through instead of failing loudly. This class
    // rather than .completeFileProtection because a process woken while the device is
    // locked must still reach the store.
    static let databaseDirectoryFileProtection = FileProtectionType.completeUntilFirstUserAuthentication

    private static let sharedContainerDirectoryName = "local_sqlite"
    private static let databaseName = "${databaseFileName}"
}`;
}
