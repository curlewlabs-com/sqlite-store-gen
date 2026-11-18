# sqlite-store-gen

Generate a typed SQLite storage layer for an Android and iOS app, in Kotlin and
in Swift, from one declarative spec, plus the Dart method-channel constants for
a Flutter app that reaches it from Dart.

## What it is

A code generator, run with [Bun](https://bun.sh). You write a JSON spec that
declares your tables, the operations your app performs on them, a forward
migration ladder, and the method set of a Dart/native channel. The generator
checks the spec and writes three files:

- **Kotlin** (`LocalSQLiteGenerated.kt`): a storage layer for Android. It opens
  the database, verifies the engine and the connection profile, migrates the
  schema, and gives each table an operations object with one typed method per
  declared operation.
- **Swift** (`LocalSQLiteGenerated.swift`): the same layer for iOS, statement
  for statement.
- **Dart** (`local_sqlite_channel.dart`): the channel's method names as
  constants, which the Kotlin and Swift files match with exhaustive enums.

The generated code calls SQLite through
[curlew-sqlite](https://github.com/curlewlabs-com/curlew-sqlite), which pins one
official SQLite release on both platforms. It does not use the copy of SQLite
the OS ships.

## Why it exists

An app with an iOS extension, a background worker, or a Flutter UI ends up with
several pieces of code reading and writing the same local state, often from more
than one process. Hand-written SQL in each of them drifts. The platforms
disagree about a statement, a migration runs on one and not the other, and a
column rename breaks a reader nobody remembered. An ORM fixes the drift and
brings a runtime the extension has to load.

This generator takes a different route. The spec is the only place a table,
column, statement or migration is written. Both platforms get the same
statements, the SQL is fixed at generation time, and the generator refuses a
spec whose operations would misbehave. Some examples of what it refuses:

- a predicate no key or index covers, which would scan the table;
- a single-row read, update or delete keyed on a non-unique index, which could
  match several rows;
- a compare-and-set whose version check it did not write itself;
- a ladder step that leaves an upgraded store in a different shape from a fresh
  install;
- a nullable column in a place where NULL would silently match nothing.

What is left at run time is plain prepared statements over a pinned engine.

## How to use it

### Install

The package is published as a release asset rather than to a registry:

```sh
bun add https://github.com/curlewlabs-com/sqlite-store-gen/releases/download/v0.1.1/curlewlabs-com-sqlite-store-gen-0.1.1.tgz
```

### Generate

```sh
bunx sqlite-store-gen storage.spec.json \
  --kotlin-package com.example.app.storage \
  --database-file-name app.sqlite3 \
  --kotlin-out android/app/src/main/kotlin/com/example/app/storage/LocalSQLiteGenerated.kt \
  --swift-out ios/Shared/LocalSQLiteGenerated.swift \
  --dart-out lib/generated/local_sqlite_channel.dart
```

The options:

- `--kotlin-package`: the package of the generated Kotlin file.
- `--database-file-name`: the store's file name on disk. On Android it lives
  under the app's database directory. On iOS it lives under `local_sqlite/` in
  an App Group container.
- `--kotlin-out`, `--swift-out`, `--dart-out`: where each file is written.
- `--binding-package` (optional): the Kotlin package of the `CurlewSQLite`
  binding. It defaults to `com.curlewlabs.sqlite`, where curlew-sqlite publishes
  it. Pass your own package only if you vendor the binding into your module.
- `--notice` (optional): the header written at the top of each file. It defaults
  to a line naming the spec.

Check the generated files in and regenerate whenever the spec changes. Every
file is a pure function of the spec and the options, so CI can regenerate and
diff.

The same rendering is available as a library:

```ts
import {
  loadLocalSQLiteSpec,
  renderLocalSQLiteSources,
} from "@curlewlabs-com/sqlite-store-gen";

const sources = renderLocalSQLiteSources(
  await loadLocalSQLiteSpec("storage.spec.json"),
  {
    kotlinPackage: "com.example.app.storage",
    databaseFileName: "app.sqlite3",
    notice: "// Generated file. Do not edit by hand.",
  },
);
// sources.kotlin, sources.swift, sources.dart
```

### Link the engine

- **iOS:** add the `CurlewSQLite` pod to every target that compiles the
  generated Swift. The generated file does `import CurlewSQLite`.
- **Android:** include curlew-sqlite's `curlewsqlite` Gradle module and depend
  on it from the module that compiles the generated Kotlin.

curlew-sqlite's README has both recipes. Each open checks the engine's version
floor and exact source ID, and refuses an engine that is not the pinned one.

The generated code needs SQLite 3.35.0 or later, for the `RETURNING` clause an
`insert` returns its version with. The generator holds no engine floor of its
own: the binding's floor is the one an open enforces, and curlew-sqlite's is
well above it. An app that binds the generated code to another engine owes the
same floor.

### Open the store and call it

```kotlin
// Android. Every operation runs off the main thread.
val database = LocalSQLiteGeneratedStore.openAppPrivate(context)
val settings = AppSettingsOperations.read(database)
```

```swift
// iOS. hostsUserInterface: false is the declaration an extension makes; an app
// process leaves it true, and the store refuses its main thread.
let database = try LocalSQLiteGeneratedStore.openSharedContainer(
    appGroupIdentifier: "group.com.example.app",
    hostsUserInterface: false,
    integrityObserver: { report in /* log it */ }
)
let settings = try AppSettingsOperations.read(database: database)
```

[`example/spec.json`](example/spec.json) is a complete spec for an invented
reading app. It has:

- a settings singleton with a guarded one-shot claim and a reset;
- a signed-in-reader pointer;
- a per-reader profile with an ensure, a compare-and-set and a monotone
  deadline;
- a highlight queue that any process can stage into for whoever is signed in.

The tests under [`test/swift`](test/swift) exercise its generated Swift against
the pinned engine.

## The spec

The top level:

| Field            | Meaning                                                                                    |
| ---------------- | ------------------------------------------------------------------------------------------ |
| `version`        | The spec format version. This release reads `3`.                                           |
| `schemaVersion`  | The schema version stamped into `PRAGMA user_version`.                                     |
| `migrations`     | The forward ladder: one step per version from `2` to `schemaVersion`.                      |
| `obsoleteTables` | Tables an older schema had and this one drops.                                             |
| `tables`         | The live tables, each with its columns and operations.                                     |
| `channel`        | The Dart/native method set: a channel name, and subjects whose methods have literal names. |

A **table** declares:

- `name`, `doc`, `primaryKey` (a single column), `indexes` and `analyze`.
- `keyedBy` names the primary key when callers supply it, as with a row per
  user. A table without `keyedBy` is a fixed singleton whose key is the constant
  `1`.
- `bootstrapRow: true` seeds a singleton's row on the first open.
- `operationBrands.expectedVersion` is required when the table has a
  compare-and-set.

A **column** has:

- `name` and `sqliteType` (`TEXT` or `INTEGER`);
- `nullable`;
- `brand`, the type name the generated code wraps its values in;
- optionally a `check`, a `default`, and `survivesReset`.

Every table also has a `row_version` column.

An **operation** has a `name` and one of these `kind`s:

| Kind                    | What it emits                                                                                                                                                                                                                                  |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `read`                  | A keyed `SELECT`. With `orderedHead`, the first row in key order. With `orderedSuccessor`, the next one.                                                                                                                                       |
| `insert`                | An upsert (`ON CONFLICT ... DO UPDATE`) that advances `row_version`.                                                                                                                                                                           |
| `ensure`                | `INSERT OR IGNORE` at the declared defaults. Creates the row if absent and never overwrites.                                                                                                                                                   |
| `update`                | An `UPDATE` of `setColumns` only. A `guard` makes it a one-shot claim; `integerMaximum` makes it a monotone MAX.                                                                                                                               |
| `casUpdate`             | A compare-and-set on `row_version` inside `BEGIN IMMEDIATE`, answering applied, stale, missing or busy.                                                                                                                                        |
| `delete`                | A keyed `DELETE`. With `deleteSummary`, it also reports how many rows it deleted for one owner and the oldest observation among them.                                                                                                          |
| `resetToDefaults`       | Returns every column to its default, except those marked `survivesReset`.                                                                                                                                                                      |
| `insertForCurrentOwner` | Reads the owner from a singleton row (`ownerFrom`) and inserts with it in one transaction, answering recorded, no-current-owner or busy. `allocateKey` treats the supplied key as a floor; `alsoSet` writes a pointer in the same transaction. |

A **migration step** is a list of SQL statements in a small set of forms:

- `CREATE TABLE IF NOT EXISTS`
- `ALTER TABLE ... ADD COLUMN`
- `CREATE INDEX`
- `INSERT OR IGNORE`
- `UPDATE`
- `DROP TABLE IF EXISTS` for a table named in `obsoleteTables`

The generator appends the version stamp itself. It replays the whole ladder in
an in-memory SQLite and refuses one whose end state differs from the tables you
declared.

## What the generated layer guarantees, and what stays yours

- **No raw SQL at run time.** All SQL text is constant. Runtime values are
  always bound and never interpolated, and no API takes SQL, a statement or a
  cursor.
- **Each value has its own type.** Two columns that are both `TEXT` still get
  different types.
- **The connection profile is set and read back on every open.** The profile:
  - `journal_mode = DELETE`
  - `synchronous = EXTRA`
  - a 2.5 s busy budget
  - `mmap_size = 0`
  - `foreign_keys = ON`
  - `trusted_schema = OFF`
  - SQLite's defensive mode

  An open whose profile does not read back as set fails.

- **The schema is gated on the version stamp.** An already-current store reads
  one header integer and does no schema work. An older one climbs the ladder. A
  newer one is refused with a distinct error.
- **Corruption is classified, never acted on.** A failed open is classified
  (intact, recoverable journal, index damage, page damage, not a database,
  unreadable, contended) and handed to you. The generated layer never deletes a
  file. What a damaged store costs the user's data is your decision.
- **Threading is yours.** Operations are synchronous. Run them off any thread
  that draws a screen.

## Status

This release generates what the example spec exercises, on Android and iOS:

- **Swift** is compiled and its storage tests run against the pinned engine.
- **Kotlin** is compiled against curlew-sqlite's binding.
- **Runtime tests of the Kotlin on a device or emulator** are not part of this
  repository's CI.

Known limits:

- The iOS store opens only in an App Group container. `openForTesting` takes any
  file URL.
- `deleteSummary` requires its owner column to be `TEXT`.
- Spec format version `3` is the only one this release reads.

## Known issues

Each of these needs a spec that does something the example does not. The ones
marked "fails to compile" fail loudly the first time the generated file is
built; the others are worth knowing before you write such a spec.

- **The ladder check compares a table's STRICT flag and its columns by name,
  type, nullability and key, not by CHECK or DEFAULT.** A migration
  `CREATE TABLE` whose column carries a different CHECK than the spec declares
  is accepted, and an upgraded store enforces the step's. Compare each step's
  CHECKs with the baseline the generator emits; this repository's
  `src/migrations.test.ts` shows one way.
- **A baseline open of an untracked store that already holds an index fails** on
  the plain `CREATE INDEX`. A store reaches version 0 with indexes only if
  something other than this generator built it.
- **Names are not checked for collisions or keywords after they are derived.**
  Two operations whose names derive to the same method (`set_name_x` and
  `set_name` on table `x`), channel methods that differ only in case,
  overlapping insert and `alsoSet` columns, a column or subject named after a
  Kotlin or Swift keyword, and a Kotlin package segment that is a keyword: each
  fails to compile.
- **A table whose writes read the version back but which has no `read`, or which
  has more than one `read`,** emits its version-reader constant zero times or
  twice: fails to compile.

## Development

Use Bun 1.4.4.

```sh
bun install --frozen-lockfile
bun run typecheck
bun run test
```

The native checks need a checkout of curlew-sqlite. The Swift package needs
macOS and Xcode:

```sh
sh test/swift/prepare.sh ../curlew-sqlite && swift test --package-path test/swift
sh test/android/prepare.sh && gradle -p test/android -PcurlewSqliteDir="$PWD/../curlew-sqlite" :example:compileReleaseKotlin
```

## License

Licensed under either of

- Apache License, Version 2.0 ([LICENSE-APACHE](LICENSE-APACHE))
- MIT license ([LICENSE-MIT](LICENSE-MIT))

at your option.

### Contribution

By submitting a contribution for inclusion in this project, you agree that it is
dual licensed as above, without any additional terms or conditions.
