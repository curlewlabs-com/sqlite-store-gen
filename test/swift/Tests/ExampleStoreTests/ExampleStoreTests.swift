// Storage tests for the Swift the generator emits from example/spec.json, run against the
// engine curlew-sqlite pins. Each opens a fresh database file of its own.

import CurlewSQLite
import XCTest

@testable import ExampleStore

final class ExampleStoreTests: XCTestCase {
    private var directory: URL!

    override func setUpWithError() throws {
        directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("example-store-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        try FileManager.default.removeItem(at: directory)
    }

    // XCTest runs on the main thread, which the store refuses where a user interface runs;
    // a test process draws none, which is exactly the declaration hostsUserInterface makes.
    private func open() throws -> GeneratedLocalSQLiteDatabase {
        try LocalSQLiteGeneratedStore.openForTesting(
            databaseURL: directory.appendingPathComponent("reader.sqlite3"),
            hostsUserInterface: false
        )
    }

    // The open verifies the engine's version floor and exact source ID before it creates a
    // table, so an open that succeeds is the proof this build linked the pinned engine.
    func testOpenVerifiesThePinnedEngineAndSeedsTheSettingsRow() throws {
        let database = try open()
        defer { try? LocalSQLiteGeneratedStore.close(database) }

        let settings = try XCTUnwrap(try AppSettingsOperations.read(database: database))
        XCTAssertEqual(settings.theme.value, "system")
        XCTAssertEqual(settings.wordsPerMinute.value, 250)
        XCTAssertEqual(settings.tourShown.value, 0)
    }

    // The guarded update is a claim: the first caller changes the row, every later one
    // changes nothing, and the changed-row count is the verdict.
    func testTourClaimSucceedsOnce() throws {
        let database = try open()
        defer { try? LocalSQLiteGeneratedStore.close(database) }

        XCTAssertTrue(try AppSettingsOperations.claimTour(
            database: database, tourShown: AppSettingsTourShown(value: 1)))
        XCTAssertFalse(try AppSettingsOperations.claimTour(
            database: database, tourShown: AppSettingsTourShown(value: 1)))
    }

    // A reset returns every column to its default except the one that declares it survives.
    func testResetKeepsOnlyTheSurvivingColumn() throws {
        let database = try open()
        defer { try? LocalSQLiteGeneratedStore.close(database) }

        XCTAssertTrue(try AppSettingsOperations.setTheme(
            database: database, theme: AppSettingsTheme(value: "dark")))
        XCTAssertTrue(try AppSettingsOperations.claimTour(
            database: database, tourShown: AppSettingsTourShown(value: 1)))
        XCTAssertTrue(try AppSettingsOperations.resetToDefaults(database: database))

        let settings = try XCTUnwrap(try AppSettingsOperations.read(database: database))
        XCTAssertEqual(settings.theme.value, "system")
        XCTAssertEqual(settings.tourShown.value, 1)
    }

    // With nobody signed in there is no owner to record a highlight for, and the insert
    // writes nothing. Once a reader is signed in it records under that reader, and the
    // pointer in the settings row lands in the same transaction.
    func testStagingRecordsUnderTheSignedInReaderOrNotAtAll() throws {
        let database = try open()
        defer { try? LocalSQLiteGeneratedStore.close(database) }

        XCTAssertEqual(try stage(database, at: 1000), .noCurrentOwner)
        XCTAssertNil(try PendingHighlightOperations.readHead(database: database))

        _ = try SignedInReaderOperations.insertOrReplace(
            database: database, readerId: SignedInReaderId(value: "reader-1"))
        XCTAssertEqual(
            try stage(database, at: 1000),
            .recorded(key: PendingHighlightStagedAtMs(value: 1000)))
        // Same proposed key: allocated past the backlog rather than overwriting it.
        XCTAssertEqual(
            try stage(database, at: 1000),
            .recorded(key: PendingHighlightStagedAtMs(value: 1001)))

        let head = try XCTUnwrap(try PendingHighlightOperations.readHead(database: database))
        XCTAssertEqual(head.readerId.value, "reader-1")
        XCTAssertNil(head.marginNote)
        XCTAssertNil(head.pageNumber)
        let next = try XCTUnwrap(try PendingHighlightOperations.readSuccessor(
            database: database, stagedAtMs: head.stagedAtMs))
        XCTAssertEqual(next.stagedAtMs.value, 1001)
        XCTAssertNil(try PendingHighlightOperations.readSuccessor(
            database: database, stagedAtMs: next.stagedAtMs))

        let settings = try XCTUnwrap(try AppSettingsOperations.read(database: database))
        XCTAssertEqual(settings.lastHighlightKeyMs.value, 1001)
    }

    // The counted cleanup reports exactly what it deleted, for the one reader it names.
    func testCleanupCountsOnlyTheNamedReader() throws {
        let database = try open()
        defer { try? LocalSQLiteGeneratedStore.close(database) }

        _ = try SignedInReaderOperations.insertOrReplace(
            database: database, readerId: SignedInReaderId(value: "reader-1"))
        _ = try stage(database, at: 10)
        _ = try stage(database, at: 20)
        _ = try SignedInReaderOperations.insertOrReplace(
            database: database, readerId: SignedInReaderId(value: "reader-2"))
        _ = try stage(database, at: 30)

        XCTAssertEqual(
            try PendingHighlightOperations.deleteForReader(
                database: database, readerId: PendingHighlightReaderId(value: "reader-1")),
            .committed(count: 2, oldestObservedAtMs: 5))
        let head = try XCTUnwrap(try PendingHighlightOperations.readHead(database: database))
        XCTAssertEqual(head.readerId.value, "reader-2")
    }

    // A compare-and-set applies only against the version the caller observed, and an
    // ensure never overwrites a row that already exists.
    func testCompareAndSetAppliesOnlyAtTheObservedVersion() throws {
        let database = try open()
        defer { try? LocalSQLiteGeneratedStore.close(database) }
        let reader = ReaderProfileReaderId(value: "reader-1")

        XCTAssertTrue(try ReaderProfileOperations.ensure(database: database, readerId: reader))
        XCTAssertFalse(try ReaderProfileOperations.ensure(database: database, readerId: reader))
        let row = try XCTUnwrap(try ReaderProfileOperations.read(database: database, readerId: reader))
        XCTAssertEqual(row.rowVersion.value, 1)

        XCTAssertEqual(
            try ReaderProfileOperations.compareAndSetBooksFinished(
                database: database,
                booksFinished: ReaderProfileBooksFinished(value: 3),
                readerId: reader,
                expectedVersion: ExpectedReaderProfileRowVersion(value: 1)),
            .applied)
        XCTAssertEqual(
            try ReaderProfileOperations.compareAndSetBooksFinished(
                database: database,
                booksFinished: ReaderProfileBooksFinished(value: 4),
                readerId: reader,
                expectedVersion: ExpectedReaderProfileRowVersion(value: 1)),
            .stale(observedVersion: StoredReaderProfileRowVersion(value: 2)))
        XCTAssertEqual(
            try ReaderProfileOperations.compareAndSetBooksFinished(
                database: database,
                booksFinished: ReaderProfileBooksFinished(value: 4),
                readerId: ReaderProfileReaderId(value: "nobody"),
                expectedVersion: ExpectedReaderProfileRowVersion(value: 1)),
            .missing)
    }

    // The deadline only ever moves later.
    func testDeadlineExtensionNeverShortens() throws {
        let database = try open()
        defer { try? LocalSQLiteGeneratedStore.close(database) }
        let reader = ReaderProfileReaderId(value: "reader-1")
        _ = try ReaderProfileOperations.ensure(database: database, readerId: reader)

        _ = try ReaderProfileOperations.extendSyncDeadline(
            database: database, syncNotBeforeMs: ReaderProfileSyncNotBeforeMs(value: 5000), readerId: reader)
        _ = try ReaderProfileOperations.extendSyncDeadline(
            database: database, syncNotBeforeMs: ReaderProfileSyncNotBeforeMs(value: 1000), readerId: reader)

        let row = try XCTUnwrap(try ReaderProfileOperations.read(database: database, readerId: reader))
        XCTAssertEqual(row.syncNotBeforeMs.value, 5000)
    }

    // A store stamped by a newer build is refused rather than read with a schema it does
    // not have; what to do about it is the app's decision.
    func testNewerSchemaIsRefused() throws {
        let url = directory.appendingPathComponent("reader.sqlite3")
        try LocalSQLiteGeneratedStore.close(try open())
        try stampUserVersion(99, at: url)

        XCTAssertThrowsError(try open()) { error in
            guard case LocalSQLiteGeneratedError.newerSchema(let onDisk, _) = error else {
                return XCTFail("expected newerSchema, got \(error)")
            }
            XCTAssertEqual(onDisk, 99)
        }
    }

    private func stage(
        _ database: GeneratedLocalSQLiteDatabase, at key: Int64
    ) throws -> PendingHighlightInsertResult {
        try PendingHighlightOperations.stage(
            database: database,
            stagedAtMs: PendingHighlightStagedAtMs(value: key),
            bookIsbn: PendingHighlightBookIsbn(value: "9780000000000"),
            excerpt: PendingHighlightExcerpt(value: "an excerpt"),
            marginNote: nil,
            pageNumber: nil,
            capturedAtMs: PendingHighlightCapturedAtMs(value: key / 2),
            uploadAttempts: PendingHighlightUploadAttempts(value: 0),
            retryNotBeforeMs: PendingHighlightRetryNotBeforeMs(value: 0))
    }

    private func stampUserVersion(_ version: Int32, at url: URL) throws {
        var handle: OpaquePointer?
        XCTAssertEqual(
            curlew_sqlite3_open_v2(url.path, &handle, SQLITE_OPEN_READWRITE, nil), SQLITE_OK)
        defer { _ = curlew_sqlite3_close_v2(handle) }
        var statement: OpaquePointer?
        XCTAssertEqual(
            curlew_sqlite3_prepare_v2(handle, "PRAGMA user_version = \(version)", -1, &statement, nil),
            SQLITE_OK)
        defer { _ = curlew_sqlite3_finalize(statement) }
        XCTAssertEqual(curlew_sqlite3_step(statement), SQLITE_DONE)
    }
}
