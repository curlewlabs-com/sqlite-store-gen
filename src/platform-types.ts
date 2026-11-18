// Renders the value, row, metadata, span, and generated error types shared
// across the local SQLite Kotlin and Swift surfaces.

import {
  VERSION_COLUMN,
  type LocalSQLiteSpec,
  type NormalizedTable,
} from "./model";
import {
  hasOwnerSourcedInsert,
  kotlinValueType,
  ownerSourcedInsertResultType,
  swiftValueType,
} from "./sql";

import { kotlinDeleteResult, swiftDeleteResult } from "./delete-summary";

function kotlinValueClass(brand: string, type: "String" | "Long"): string {
  return `@JvmInline
value class ${brand}(
    val value: ${type},
)`;
}

function kotlinPositiveVersionClass(brand: string, message: string): string {
  return `@JvmInline
value class ${brand}(
    val value: Long,
) {
    init {
        require(value >= 1L) { ${JSON.stringify(message)} }
    }
}`;
}

function kotlinTypeDecls(table: NormalizedTable): string {
  const declarations: string[] = [];
  // The owner key is the primary key, so it is excluded from valueColumns; a
  // keyed table still references its brand as the caller-supplied key type, so
  // declare it. A singleton's slot brand names no value type and stays implicit.
  if (table.keyedSlot !== undefined) {
    declarations.push(
      kotlinValueClass(table.keyedSlot.brand, table.keyedSlot.kotlinType),
    );
  }
  for (const column of table.valueColumns) {
    if (column.name === VERSION_COLUMN) continue;
    declarations.push(kotlinValueClass(column.brand, column.kotlinType));
  }
  if (table.hasCas && table.expectedVersionBrand !== undefined) {
    declarations.push(
      kotlinPositiveVersionClass(
        table.expectedVersionBrand,
        "expected row version must be positive",
      ),
    );
  }
  declarations.push(
    kotlinPositiveVersionClass(
      table.versionColumn.brand,
      `stored ${table.noun} row version must be positive`,
    ),
  );
  const fields = table.readColumns
    .map((column) => `    val ${column.fieldName}: ${kotlinValueType(column)},`)
    .join("\n");
  declarations.push(`data class ${table.rowType}(
${fields}
)`);
  return declarations.join("\n\n");
}

function kotlinCasResult(table: NormalizedTable): string {
  const type = table.casResultType;
  return `sealed interface ${type} {
    data object Applied : ${type}

    data class Stale(
        val observedVersion: ${table.versionColumn.brand},
    ) : ${type}

    data object Missing : ${type}

    data object Busy : ${type}
}`;
}

// Shared by the Kotlin and Swift emissions of the span type, so the one explanation of what a
// measured span is does not get a copy per platform to drift apart.
const LOCAL_STORE_SPAN_DOC = `// One span this connection spent under the store's contention budget. \`kind\` and
// \`lostBudget\` together pick the metric key the consumer emits it under, so this type
// carries no key of its own.
//
// **The routing contract lives here, and only here.** The handle-observer and
// open-parameter seams reach the consumer, and
// which one a span takes is decided by whether the handle exists yet when it closes:
//
//   - WRITE and READ spans arrive on \`spanObserver\`, the property on this handle. Each is
//     measured by operations the consumer invoked ON the handle, so it is already there to
//     have been installed on.
//   - An OPEN span cannot. Its window closes before \`open\` has returned anything to install
//     on, so \`open\` takes the same observer as a PARAMETER instead. That lifecycle
//     difference is the reason the seams are distinct.
//
// The seams are meant to land in one recorder, and on every platform the consumer's single
// store funnel passes the same recorder entry to each - so the recorder carries
// WRITE, READ and OPEN alike. A caller that wires only one seam collects one kind and silently drops the
// other; the storage-operations types name that as the property they hold, and do not
// restate the reasoning above.
//
// A WRITE span is one generated write from its first attempt on the write lock through
// commit, once per write unit on the transaction and autocommit write shapes - the whole BEGIN IMMEDIATE unit, or
// the bare step an autocommit write takes the lock inside. An OPEN span is the open's own
// lock-taking window: from the connection open - which takes no lock on either platform, so
// the window starts at a fixed point rather than at its first waiter - through the header
// read that closes the classified window. Neither covers the schema ladder or the baseline
// create, which run once per version rather than in steady state.
//
// A READ span is a generated read's first acquisition and the work that rides on it - one
// sqlite3_step on every platform - and nothing after. SQLite takes SHARED there and holds
// it until reset/finalize, so the steps after it re-acquire nothing and timing them would
// price row work as contention.
//
// Each platform times one direct sqlite step inside that window. APIs that materialize a
// result set are outside this boundary because their value would include row work beyond
// the single lock acquisition this span represents.
//
// The prepare is outside the window on EVERY platform, which is a deliberate symmetric
// exclusion rather than an oversight: loading a schema can take SHARED, so a prepare-time
// busy exists in principle and is not measured here. It stays out because the step is the
// lock event the budget is charged for.
//
// Attempt-to-commit rather than hold, and the difference only shows under contention:
// acquisition is where a contended write pays its busy-handler wait, and on the
// autocommit shape that wait happens *inside* the step with no separable leg to time.
// Uncontended - the ordinary case - there is nothing to wait for and the span is the
// hold. So the body of the distribution reads as hold time and the contended tail reads
// high by the wait it paid, which is the direction the metric wants: what a waiter
// actually costs is the question the store's busy budget is sized against.
//
// An OPEN span carries one bias a WRITE span does not, and it decides how the number may
// be read: the window holds SEVERAL lock-taking statements, each entitled to its own full
// budget, so \`millis\` is a per-open total rather than one lock event - the quantity the
// budget is actually charged in. It over-states any single wait, which is the safe
// direction for the one inference the total supports (a busy open materially under the
// budget cannot have exhausted it) and the unsafe direction for its converse.
//
// \`maxLegMillis\` is what makes the converse readable, and it is the reason an OPEN span
// carries a second number at all. The legs PARTITION the window - connect, budget,
// identity, profile, header - so their sum is \`millis\` and the largest of them BOUNDS any
// lock event in this open from above. Read together, \`maxLegMillis\` and the total
// distinguish budget concentration from repeated blocking: \`maxLegMillis\` at the
// budget says the blocking was concentrated in a leg,
// while a total well above \`maxLegMillis\` says the open blocked more than once. Nil on
// WRITE and READ spans, which have no legs to partition - each is a single statement that
// takes its lock inside the step, with nothing separable to time.
//
// A leg is not always a single lock event, so read the bound as a bound. The \`profile\` leg
// runs more than one statement, on EVERY platform (\`configureConnection\` issues a dozen
// PRAGMAs plus the defensive db-config, of which only \`journal_mode\` can return busy - the
// rest are connection-level and take no lock). When the largest leg is that one,
// \`maxLegMillis\` is a per-leg total rather than one lock event. The remaining legs -
// \`connect\`, \`budget\`, \`identity\`, \`header\` - are single calls, so there the bound is
// tight; \`connect\` is one sqlite3_open_v2 call, with connection setup isolated in the
// profile leg. Every case errs the same way the total does, high rather than low, which is
// the direction the safe inference needs.
//
// A READ span does not carry the OPEN's per-open-total bias, which is what makes it the
// closest of the three to the budget: one step is one lock event, the unit the budget is
// actually charged in. What it does include beyond the wait is that step's own row work - a
// primary-key lookup on a small table - so it over-states a pure acquisition slightly, in
// the same safe direction.
//
// \`millis\` is the span on the platform's monotonic clock; \`lostBudget\` says the unit
// surrendered the contention budget instead of completing.
//
// The generated layer measures and hands the number out; sampling, gating, and
// buffering stay on the consumer's side - the same classify-here / act-there boundary
// this layer keeps for integrity reports.`;

const KOTLIN_METADATA_TYPES = `data class LocalSQLiteTableMetadata(
    val name: String,
    val primaryKey: List<String>,
    val declaredIndexes: List<LocalSQLiteIndexMetadata>,
    val analyze: Boolean,
)

data class LocalSQLiteIndexMetadata(
    val name: String,
    val columns: List<String>,
    val unique: Boolean,
)

data class LocalSQLiteConnectionProfile(
    val journalMode: String,
    val lockingMode: String,
    val synchronous: Long,
    val busyTimeoutMillis: Long,
    val cacheSize: Long,
    val mmapSizeBytes: Long,
    val foreignKeys: Boolean,
    val trustedSchema: Boolean,
    val defensive: Boolean,
)

enum class LocalSQLiteStoreSpanKind {
    WRITE,
    OPEN,
    READ,
}

${LOCAL_STORE_SPAN_DOC}
data class LocalSQLiteStoreSpan(
    val kind: LocalSQLiteStoreSpanKind,
    val millis: Double,
    val lostBudget: Boolean,
    val maxLegMillis: Double? = null,
)`;

// Thrown by the generated store when the on-disk user_version is newer than this
// build's SCHEMA_VERSION - a downgrade / rollback we cannot safely read. A distinct
// type (not the generic IllegalStateException an ordinary open failure would raise)
// so the consumer can catch exactly this state and reset its stored state instead of
// failing closed.
const KOTLIN_NEWER_SCHEMA_EXCEPTION = `class LocalSQLiteNewerSchemaException(
    val onDiskVersion: Long,
    val supportedVersion: Long,
) : IllegalStateException(
        "Generated local SQLite store schema version \$onDiskVersion is newer than supported \$supportedVersion",
    )`;

const KOTLIN_GENERATED_EXCEPTION = `class LocalSQLiteGeneratedException(
    val operation: String,
    val resultCode: Int,
    val extendedResultCode: Int,
    val sqliteMessage: String,
) : IllegalStateException(
        "SQLite $operation failed (code=$resultCode, extended=$extendedResultCode): $sqliteMessage",
    )`;

function kotlinOwnerSourcedInsertResult(table: NormalizedTable): string {
  const type = ownerSourcedInsertResultType(table);
  return `sealed interface ${type} {
    ${table.operations.some((op) => op.spec.allocateKey !== undefined) ? `data class Recorded(val key: ${table.keyedSlot!.brand})` : "data object Recorded"} : ${type}

    data object NoCurrentOwner : ${type}

    data object Busy : ${type}
}`;
}

function swiftOwnerSourcedInsertResult(table: NormalizedTable): string {
  return `enum ${ownerSourcedInsertResultType(table)}: Equatable, Sendable {
    case recorded${table.operations.some((op) => op.spec.allocateKey !== undefined) ? `(key: ${table.keyedSlot!.brand})` : ""}
    case noCurrentOwner
    case busy
}`;
}

function swiftValueStruct(brand: string, type: "String" | "Int64"): string {
  return `struct ${brand}: Equatable, Sendable {
    let value: ${type}
}`;
}

function swiftPositiveVersionStruct(brand: string, message: string): string {
  return `struct ${brand}: Equatable, Sendable {
    let value: Int64

    init(value: Int64) {
        precondition(value >= 1, ${JSON.stringify(message)})
        self.value = value
    }
}`;
}

function swiftTypeDecls(table: NormalizedTable): string {
  const declarations: string[] = [];
  // The owner key is the primary key, so it is excluded from valueColumns; a
  // keyed table still references its brand as the caller-supplied key type, so
  // declare it. A singleton's slot brand names no value type and stays implicit.
  if (table.keyedSlot !== undefined) {
    declarations.push(
      swiftValueStruct(table.keyedSlot.brand, table.keyedSlot.swiftType),
    );
  }
  for (const column of table.valueColumns) {
    if (column.name === VERSION_COLUMN) continue;
    declarations.push(swiftValueStruct(column.brand, column.swiftType));
  }
  if (table.hasCas && table.expectedVersionBrand !== undefined) {
    declarations.push(
      swiftPositiveVersionStruct(
        table.expectedVersionBrand,
        "expected row version must be positive",
      ),
    );
  }
  declarations.push(
    swiftPositiveVersionStruct(
      table.versionColumn.brand,
      `stored ${table.noun} row version must be positive`,
    ),
  );
  const fields = table.readColumns
    .map((column) => `    let ${column.fieldName}: ${swiftValueType(column)}`)
    .join("\n");
  declarations.push(`struct ${table.rowType}: Equatable, Sendable {
${fields}
}`);
  return declarations.join("\n\n");
}

function swiftCasResult(table: NormalizedTable): string {
  return `enum ${table.casResultType}: Equatable, Sendable {
    case applied
    case stale(observedVersion: ${table.versionColumn.brand})
    case missing
    case busy
}`;
}

const SWIFT_METADATA_TYPES = `struct LocalSQLiteTableMetadata: Equatable, Sendable {
    let name: String
    let primaryKey: [String]
    let declaredIndexes: [LocalSQLiteIndexMetadata]
    let analyze: Bool
}

struct LocalSQLiteIndexMetadata: Equatable, Sendable {
    let name: String
    let columns: [String]
    let unique: Bool
}

struct LocalSQLiteConnectionProfile: Equatable, Sendable {
    let journalMode: String
    let lockingMode: String
    let synchronous: Int64
    let busyTimeoutMillis: Int64
    let cacheSize: Int64
    let mmapSizeBytes: Int64
    let foreignKeys: Bool
    let trustedSchema: Bool
    let defensive: Bool
}

enum LocalSQLiteStoreSpanKind: Equatable, Sendable {
    case write
    case open
    case read
}

${LOCAL_STORE_SPAN_DOC}
struct LocalSQLiteStoreSpan: Equatable, Sendable {
    let kind: LocalSQLiteStoreSpanKind
    let millis: Double
    let lostBudget: Bool
    let maxLegMillis: Double?

    init(
        kind: LocalSQLiteStoreSpanKind,
        millis: Double,
        lostBudget: Bool,
        maxLegMillis: Double? = nil
    ) {
        self.kind = kind
        self.millis = millis
        self.lostBudget = lostBudget
        self.maxLegMillis = maxLegMillis
    }
}`;

const SWIFT_ERROR_ENUM = `enum LocalSQLiteGeneratedError: Error, Equatable, LocalizedError, Sendable {
    case nonFileDatabaseURL(String)
    case mainThreadAccess(String)
    case sqlite(
        operation: String,
        resultCode: Int32,
        extendedResultCode: Int32,
        message: String
    )
    case unexpectedResult(operation: String, detail: String)
    // The on-disk user_version is newer than this build's schemaVersion - a
    // downgrade / rollback we cannot safely read. A distinct case (not
    // unexpectedResult, which many ordinary failures use) so the consumer can catch
    // exactly this state and reset the app's state instead of failing closed.
    case newerSchema(onDisk: Int64, supported: Int64)
    // An open that failed inside SQLite, carrying the reactive probe's classification.
    // Distinct for the same reason newerSchema is: the consumer has to act on the class,
    // and only the consumer may choose between preserving and rebuilding the store.
    case integrity(report: LocalSQLiteIntegrityReport, operation: String, message: String)

    var errorDescription: String? {
        switch self {
        case let .nonFileDatabaseURL(value):
            return "SQLite database URL is not a file URL: \\(value)"
        case let .mainThreadAccess(operation):
            return "Generated local SQLite operation must not run on a UI process's main thread: "
                + operation
        case let .sqlite(operation, resultCode, extendedResultCode, message):
            return "SQLite \\(operation) failed "
                + "(code=\\(resultCode), extended=\\(extendedResultCode)): \\(message)"
        case let .unexpectedResult(operation, detail):
            return "SQLite \\(operation) returned an unexpected result: \\(detail)"
        case let .newerSchema(onDisk, supported):
            return "Generated local SQLite store schema version \\(onDisk) is newer than supported \\(supported)"
        case let .integrity(report, operation, message):
            return "SQLite \\(operation) failed at \\(report.stage) "
                + "classified \\(report.recoveryClass): \\(message)"
        }
    }
}`;

export function kotlinTypeBlocks(spec: LocalSQLiteSpec): string[] {
  const blocks: string[] = [];
  for (const table of spec.tables) blocks.push(kotlinTypeDecls(table));
  for (const table of spec.tables) {
    if (table.casResultType !== undefined) {
      blocks.push(kotlinCasResult(table));
    }
    if (hasOwnerSourcedInsert(table)) {
      blocks.push(kotlinOwnerSourcedInsertResult(table));
    }
  }
  if (
    spec.tables.some((table) =>
      table.operations.some(
        (operation) => operation.spec.deleteSummary !== undefined,
      ),
    )
  )
    blocks.push(kotlinDeleteResult);
  blocks.push(KOTLIN_METADATA_TYPES);
  blocks.push(KOTLIN_GENERATED_EXCEPTION);
  blocks.push(KOTLIN_NEWER_SCHEMA_EXCEPTION);
  return blocks;
}

export function swiftTypeBlocks(spec: LocalSQLiteSpec): string[] {
  const blocks: string[] = [];
  for (const table of spec.tables) blocks.push(swiftTypeDecls(table));
  for (const table of spec.tables) {
    if (table.casResultType !== undefined) blocks.push(swiftCasResult(table));
    if (hasOwnerSourcedInsert(table)) {
      blocks.push(swiftOwnerSourcedInsertResult(table));
    }
  }
  if (
    spec.tables.some((table) =>
      table.operations.some(
        (operation) => operation.spec.deleteSummary !== undefined,
      ),
    )
  )
    blocks.push(swiftDeleteResult);
  blocks.push(SWIFT_METADATA_TYPES);
  return blocks;
}

export function swiftGeneratedError(): string {
  return SWIFT_ERROR_ENUM;
}
