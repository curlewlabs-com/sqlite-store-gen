// Compiles one authored local-SQLite table into the resolved columns,
// operations, keys, bootstrap state, and platform names its renderers consume.

import { toCamelCase } from "./names";
import type {
  LocalSQLiteOperationSpec,
  LocalSQLitePredicateTerm,
} from "./operation";
import type { LocalSQLiteColumnSpec } from "./schema";
import {
  VERSION_COLUMN,
  type LocalSQLiteTableSpec,
  type NormalizedBootstrapColumn,
  type NormalizedColumn,
  type NormalizedOperation,
  type NormalizedTable,
  type OperationCategory,
} from "./model";

function pascalCase(snake: string): string {
  const camel = toCamelCase(snake);
  return camel.charAt(0).toUpperCase() + camel.slice(1);
}

function screamingSnakeCase(snake: string): string {
  return snake.toUpperCase();
}

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

function entitySlug(tableName: string): string {
  return tableName.startsWith("local_")
    ? tableName.slice("local_".length)
    : tableName;
}

export function terminalNoun(tableName: string): string {
  const parts = entitySlug(tableName).split("_");
  const last = parts[parts.length - 1];
  if (last === undefined || last === "") {
    throw new Error(`Cannot derive a noun from table ${tableName}`);
  }
  return last;
}

function stripEntitySuffix(operationName: string, tableName: string): string {
  const suffix = `_${entitySlug(tableName)}`;
  return operationName.endsWith(suffix)
    ? operationName.slice(0, operationName.length - suffix.length)
    : operationName;
}

function normalizeColumn(column: LocalSQLiteColumnSpec): NormalizedColumn {
  // A declared default is a reviewed literal an ensure seeds, so its JSON type must
  // match the column's storage type or the emitted VALUES literal would be wrong.
  if (column.default !== undefined) {
    if (column.sqliteType === "TEXT" && typeof column.default !== "string") {
      throw new Error(
        `Column ${column.name} default must be a string for a TEXT column`,
      );
    }
    if (column.sqliteType === "INTEGER" && typeof column.default !== "number") {
      throw new Error(
        `Column ${column.name} default must be a number for an INTEGER column`,
      );
    }
  }
  // Same reason bootstrapRow rejects a non-`true` value: the spec is JSON, so nothing
  // upstream enforces the declared type, and `?? false` would pass a truthy non-boolean
  // straight through - `"no"` would read as protective and quietly exempt the column
  // from every reset. This field's own contract already says a flag that governs
  // nothing must be rejected rather than ignored; a mistyped one is that case.
  if (
    column.survivesReset !== undefined &&
    typeof column.survivesReset !== "boolean"
  ) {
    throw new Error(
      `Column ${column.name} survivesReset must be a boolean (got ${JSON.stringify(
        column.survivesReset,
      )})`,
    );
  }
  return {
    name: column.name,
    sqliteType: column.sqliteType,
    nullable: column.nullable,
    brand: column.brand,
    check: column.check,
    defaultValue: column.default,
    survivesReset: column.survivesReset ?? false,
    fieldName: toCamelCase(column.name),
    kotlinType: column.sqliteType === "TEXT" ? "String" : "Long",
    swiftType: column.sqliteType === "TEXT" ? "String" : "Int64",
  };
}

// Resolves and validates a columnSet op's target columns: each named column must
// exist and be settable (not the primary key, not row_version). A columnSet writes
// only these, leaving every sibling consumer's column on the shared owner row
// untouched; naming the key or the version would write outside its lane.
function resolveColumnSetColumns(
  operation: LocalSQLiteOperationSpec,
  columns: NormalizedColumn[],
  primaryKey: string[],
): NormalizedColumn[] {
  const names = operation.setColumns;
  if (names === undefined || names.length === 0) {
    throw new Error(
      `${operation.name} is an update and must declare a non-empty setColumns`,
    );
  }
  return names.map((name) => {
    if (name === VERSION_COLUMN || primaryKey.includes(name)) {
      throw new Error(
        `${operation.name} setColumns must not include the key or ${VERSION_COLUMN} (${name})`,
      );
    }
    const column = columns.find((candidate) => candidate.name === name);
    if (column === undefined) {
      throw new Error(
        `${operation.name} setColumns references unknown column ${name}`,
      );
    }
    return column;
  });
}

// Derives a resetToDefaults op's target columns: every settable column that has not
// opted out via `survivesReset`. Nothing here reads the operation - that is the point,
// and it is why a column added to the table later is reset with no edit to the op.
//
// An authored `setColumns` is rejected rather than merged: the two would disagree the
// moment a column is added, and the shape that silently wins is the one that stops
// covering new columns - exactly the failure this operation exists to prevent.
//
// Each target must declare a `default`, because the SET clause emits that value as a
// reviewed literal. That is the same requirement an `ensure` makes, and for the same
// reason: a reset and an ensure write the row's not-yet-touched state. An empty target set is rejected -
// a reset that resets nothing is a no-op UPDATE that reads as protection.
function resolveResetColumns(
  operation: LocalSQLiteOperationSpec,
  tableName: string,
  settableColumns: NormalizedColumn[],
): NormalizedColumn[] {
  if (operation.setColumns !== undefined) {
    throw new Error(
      `${operation.name} is a resetToDefaults and must not declare setColumns; its columns are derived from ${tableName} so a column added later is covered without editing the operation`,
    );
  }
  const targets = settableColumns.filter((column) => !column.survivesReset);
  if (targets.length === 0) {
    throw new Error(
      `${operation.name} resets no columns; every settable column of ${tableName} declares survivesReset`,
    );
  }
  const undefaulted = targets.filter(
    (column) => column.defaultValue === undefined,
  );
  if (undefaulted.length > 0) {
    throw new Error(
      `${tableName} declares a resetToDefaults with reset columns lacking a default: ${undefaulted
        .map((column) => column.name)
        .join(
          ", ",
        )}; each column the reset targets must declare the default it resets to`,
    );
  }
  return targets;
}

// Resolves an owner-keyed table's caller-supplied key column, or undefined for a
// fixed singleton. `keyedBy` must name the single primary-key column: that column
// is the slot bound from the caller's owner value (its brand is the key type) in
// place of the SINGLETON_ID constant, so it cannot also carry a `= 1` singleton
// check, which would reject every real owner.
function normalizeKeyedSlot(
  table: LocalSQLiteTableSpec,
  columns: NormalizedColumn[],
  slotColumnName: string,
): NormalizedColumn | undefined {
  const keyedBy = table.keyedBy;
  if (keyedBy === undefined) {
    return undefined;
  }
  if (keyedBy !== slotColumnName) {
    throw new Error(
      `${table.name} keyedBy ${keyedBy} must name the primary-key column ${slotColumnName}`,
    );
  }
  const keyedSlot = columns.find((column) => column.name === keyedBy);
  if (keyedSlot === undefined) {
    throw new Error(
      `${table.name} keyedBy references unknown column ${keyedBy}`,
    );
  }
  if (keyedSlot.check !== undefined) {
    throw new Error(
      `${table.name} owner-key column ${keyedBy} must not declare a check; it is bound to the caller's owner value, not a fixed constant`,
    );
  }
  return keyedSlot;
}

// The version column is generator-owned in a predicate: `synthesizeVersionTerm`
// appends the compare-and-set term to a `casUpdate`, and no other operation compares
// on it at all. A spec that writes the term itself is rejected rather than
// interpreted, because every way of writing it wrong produced SQL that read as a
// compare-and-set and was not one - a missing brand or a wrong brand fell through to
// a plain column set whose unbranded terms bind the fixed SINGLETON_ID slot (emitting
// `row_version = 1`, taking no expected version from the caller, bumping nothing),
// and a `row_version > ?` term kept the CAS pre-read while widening the UPDATE's own
// match. One ban closes all of them, and leaves the version term with a single
// author: this generator.
function rejectAuthoredVersionTerms(operation: LocalSQLiteOperationSpec): void {
  const authored = (operation.predicate ?? []).some(
    (term) => term.column === VERSION_COLUMN,
  );
  if (authored) {
    throw new Error(
      `${operation.name}: ${VERSION_COLUMN} must not appear in a predicate; declare kind "casUpdate" and the generator synthesizes the compare-and-set term from operationBrands.expectedVersion`,
    );
  }
}

// The compare-and-set term, appended to a casUpdate's authored predicate. Equality
// on the version column is the whole of compare-and-set, so the operator is fixed
// here rather than taken from the spec, and the brand is the table's single
// `operationBrands.expectedVersion` declaration rather than a repetition of it that
// could disagree.
function synthesizeVersionTerm(
  expectedVersionBrand: string,
): LocalSQLitePredicateTerm {
  return { column: VERSION_COLUMN, operator: "=", brand: expectedVersionBrand };
}

// A compare-and-set predicate is fully determined by the table it belongs to: the row
// slot, then the version. Neither half is a spec author's choice, so a casUpdate
// declares no predicate at all - the same reason it no longer declares the version
// term. The slot term is branded on an owner-keyed table (it binds the caller's owner)
// and unbranded on a singleton (it binds SINGLETON_ID), which the table already knows
// from `keyedBy`.
//
// Letting the spec supply it was reachable through lost branding and shared exclusions, and the CAS emitters
// cannot defend against either because they read the predicate as given: an owner-keyed
// slot term that lost its brand dropped out of the key columns, so the version re-read
// went out with no owner and SINGLETON_ID got bound into the owner column; and any extra
// branded term joined the key columns, generating a version-reader call with an
// argument that reader does not accept.
function synthesizeCasPredicate(
  operation: LocalSQLiteOperationSpec,
  slotColumnName: string,
  keyedSlot: NormalizedColumn | undefined,
  expectedVersionBrand: string,
): LocalSQLitePredicateTerm[] {
  if ((operation.predicate ?? []).length > 0) {
    throw new Error(
      `${operation.name}: a casUpdate must not declare a predicate; the generator keys it on ${slotColumnName} and appends the ${VERSION_COLUMN} compare-and-set term`,
    );
  }
  // Branded on an owner-keyed table (the term binds the caller's owner), unbranded on
  // a singleton (the bind helpers give an unbranded term the fixed SINGLETON_ID slot).
  const slotTerm: LocalSQLitePredicateTerm =
    keyedSlot === undefined
      ? { column: slotColumnName, operator: "=" }
      : { column: slotColumnName, operator: "=", brand: keyedSlot.brand };
  return [slotTerm, synthesizeVersionTerm(expectedVersionBrand)];
}

function categorize(operation: LocalSQLiteOperationSpec): OperationCategory {
  rejectAuthoredVersionTerms(operation);
  switch (operation.kind) {
    case "read":
      return "read";
    case "insert":
      return "insert";
    case "insertForCurrentOwner":
      return "insertForCurrentOwner";
    case "ensure":
      return "ensure";
    case "casUpdate":
      return "casUpdate";
    // A plain owner-keyed column set writes only its named columns, so a consumer
    // write never clobbers a sibling's column on the shared owner row.
    case "update":
      return "columnSet";
    case "delete":
      return "clear";
    case "resetToDefaults":
      return "defaultsReset";
  }
}

export function normalizeLocalSQLiteTable(
  table: LocalSQLiteTableSpec,
): NormalizedTable {
  const columnNames = validateTable(table);

  const slotColumnName = table.primaryKey[0];
  if (slotColumnName === undefined || table.primaryKey.length !== 1) {
    throw new Error(
      `${table.name} must declare a single-column singleton primary key`,
    );
  }

  const columns = table.columns.map(normalizeColumn);
  const keyedSlot = normalizeKeyedSlot(table, columns, slotColumnName);
  const valueColumns = columns.filter(
    (column) => !table.primaryKey.includes(column.name),
  );
  const versionColumn = valueColumns.find(
    (column) => column.name === VERSION_COLUMN,
  );
  if (versionColumn === undefined) {
    throw new Error(`${table.name} must declare a ${VERSION_COLUMN} column`);
  }
  const settableColumns = valueColumns.filter(
    (column) => column.name !== VERSION_COLUMN,
  );

  const typePrefix = pascalCase(table.name);
  const noun = terminalNoun(table.name);
  const pascalNoun = capitalize(noun);
  const screamNoun = noun.toUpperCase();
  const expectedVersionBrand = table.operationBrands?.expectedVersion;

  // Checked before the operations are normalized, not after, because normalizing a
  // casUpdate synthesizes its version term from this brand.
  const hasCas = table.operations.some(
    (operation) => operation.kind === "casUpdate",
  );
  if (hasCas && expectedVersionBrand === undefined) {
    throw new Error(
      `${table.name} declares a compare-and-set operation but no operationBrands.expectedVersion`,
    );
  }

  const operations = table.operations.map((operation): NormalizedOperation => {
    const category = categorize(operation);
    const shortVerb = stripEntitySuffix(operation.name, table.name);
    const authoredPredicate = operation.predicate ?? [];
    return {
      spec: operation,
      category,
      effectivePredicate:
        category === "casUpdate" && expectedVersionBrand !== undefined
          ? synthesizeCasPredicate(
              operation,
              slotColumnName,
              keyedSlot,
              expectedVersionBrand,
            )
          : authoredPredicate,
      dbMethod: toCamelCase(operation.name),
      apiMethod: toCamelCase(shortVerb),
      kotlinSqlConst: `${shortVerb.toUpperCase()}_${screamNoun}_SQL`,
      swiftSqlConst: `${toCamelCase(shortVerb)}${pascalNoun}SQL`,
      kotlinOwnerReadConst: `READ_OWNER_FOR_${shortVerb.toUpperCase()}_${screamNoun}_SQL`,
      swiftOwnerReadConst: `readOwnerFor${capitalize(toCamelCase(shortVerb))}${pascalNoun}SQL`,
      swiftOwnerReadName: `readOwnerFor${capitalize(toCamelCase(shortVerb))}${pascalNoun}`,
      coWrite: undefined,
      kotlinCoWriteConst: `ALSO_SET_FOR_${shortVerb.toUpperCase()}_${screamNoun}_SQL`,
      swiftCoWriteConst: `alsoSetFor${capitalize(toCamelCase(shortVerb))}${pascalNoun}SQL`,
      swiftCoWriteName: `alsoSetFor${capitalize(toCamelCase(shortVerb))}${pascalNoun}`,
      setColumns:
        category === "columnSet" || category === "casUpdate"
          ? resolveColumnSetColumns(operation, columns, table.primaryKey)
          : [],
      resetColumns:
        category === "defaultsReset"
          ? resolveResetColumns(operation, table.name, settableColumns)
          : [],
      // Filled by resolveOwnerSources once every table is normalized - the source table
      // is another entry in the same spec, which this per-table pass cannot see.
      ownerSource: undefined,
    };
  });

  // One reset per table, because `survivesReset` is declared on the column and names
  // "the" reset. A second one would make each flagged column ambiguous - opted out of
  // which? - and competing operations would silently share an exclusion set neither
  // authored. A table with multiple resets needs per-operation exclusions first.
  const resetOperations = operations.filter(
    (operation) => operation.category === "defaultsReset",
  );
  if (resetOperations.length > 1) {
    throw new Error(
      `${table.name} declares more than one resetToDefaults (${resetOperations
        .map((operation) => operation.spec.name)
        .join(
          ", ",
        )}); survivesReset is declared per column and names a single reset`,
    );
  }

  // A `survivesReset` with no reset to opt out of is rejected, not ignored: it reads
  // at its declaration site as a guarantee that something protects the column, and a
  // silently inert one is how that guarantee gets believed while nothing enforces it.
  if (resetOperations.length === 0) {
    const flagged = columns.filter((column) => column.survivesReset);
    if (flagged.length > 0) {
      throw new Error(
        `${table.name} declares survivesReset on ${flagged
          .map((column) => column.name)
          .join(", ")} but has no resetToDefaults operation to opt out of`,
      );
    }
  }

  // The key and row_version are outside every reset's reach already (it targets
  // settable columns), so a flag there governs nothing and misreads as protection.
  const unsettableFlagged = columns.filter(
    (column) =>
      column.survivesReset &&
      !settableColumns.some((settable) => settable.name === column.name),
  );
  if (unsettableFlagged.length > 0) {
    throw new Error(
      `${table.name} declares survivesReset on non-settable column(s) ${unsettableFlagged
        .map((column) => column.name)
        .join(
          ", ",
        )}; a resetToDefaults never touches the key or ${VERSION_COLUMN}`,
    );
  }

  // ensure is INSERT OR IGNORE with the row's initial values; it must fully
  // specify every column of the new row. The slot binds the caller's owner and
  // row_version seeds at 1, so every settable column must declare a `default` the
  // ensure seeds as a reviewed literal - otherwise ensure would emit an INSERT
  // missing that column's value. This is how a consumer column joins the shared
  // owner row: its default is the not-yet-written state ensure seeds when the owner's
  // row is first created, and the consumer sets it later through its own owner-scoped
  // write.
  const hasEnsure = operations.some(
    (operation) => operation.category === "ensure",
  );
  if (hasEnsure) {
    const undefaulted = settableColumns.filter(
      (column) => column.defaultValue === undefined,
    );
    if (undefaulted.length > 0) {
      throw new Error(
        `${table.name} declares an ensure operation with settable columns lacking a default: ${undefaulted
          .map((column) => column.name)
          .join(
            ", ",
          )}; each settable column must declare a per-column default the ensure seeds`,
      );
    }
  }

  // Only an insert (returns the new version) or a compare-and-set (reads the
  // observed version) reads the version back; a table whose only writes are an
  // ensure + set-based delete never does, so its version reader would be unused.
  const emitsVersionReader = operations.some(
    (operation) =>
      operation.category === "insert" || operation.category === "casUpdate",
  );

  const casResultType = hasCas ? `${typePrefix}CasResult` : undefined;

  // A bootstrap row seeds a single fixed singleton row; an owner-keyed table has
  // no fixed row (rows are created per owner on demand), so the two are exclusive.
  if (table.bootstrapRow !== undefined && keyedSlot !== undefined) {
    throw new Error(
      `${table.name} declares a bootstrap row and an owner key; a bootstrap row seeds a fixed singleton, not an owner-keyed table`,
    );
  }
  const bootstrapColumns = normalizeBootstrapRow(
    table,
    columns,
    slotColumnName,
  );

  return {
    spec: table,
    columnNames,
    typePrefix,
    noun,
    pascalNoun,
    screamNoun,
    slotColumnName,
    allColumns: columns,
    keyedSlot,
    valueColumns,
    readColumns:
      keyedSlot !== undefined &&
      operations.some(
        (operation) =>
          operation.spec.orderedHead !== undefined ||
          operation.spec.orderedSuccessor !== undefined,
      )
        ? [keyedSlot, ...valueColumns]
        : valueColumns,
    settableColumns,
    versionColumn,
    rowType: `${typePrefix}Row`,
    cursorFn: `to${typePrefix}Row`,
    versionReader: `readStored${pascalNoun}Version`,
    emitsVersionReader,
    kotlinReadVersionConst: `READ_${screamNoun}_VERSION_SQL`,
    swiftReadVersionConst: `read${pascalNoun}VersionSQL`,
    kotlinCreateConst: `CREATE_${screamNoun}_TABLE_SQL`,
    swiftCreateConst: `create${pascalNoun}TableSQL`,
    kotlinAddColumnConst: (column) =>
      `ADD_${screamNoun}_${screamingSnakeCase(column.name)}_COLUMN_SQL`,
    swiftAddColumnConst: (column) =>
      `add${pascalNoun}${pascalCase(column.name)}ColumnSQL`,
    bootstrapColumns,
    kotlinBootstrapConst:
      bootstrapColumns === undefined
        ? undefined
        : `BOOTSTRAP_${screamNoun}_SQL`,
    swiftBootstrapConst:
      bootstrapColumns === undefined ? undefined : `bootstrap${pascalNoun}SQL`,
    hasCas,
    casResultType,
    expectedVersionBrand,
    operations,
  };
}

// The ordered column+value list for a table's bootstrap INSERT OR IGNORE, or
// undefined when the table declares none. Every value is DERIVED - the slot column
// at 1, `row_version` at 1, every other column at its declared default - rather than
// authored beside the column list.
//
// Derived because authoring them would mean this generator, `ensure`, and
// `resetToDefaults` all seed one row, with only this copy hand-kept. The hand-kept one
// is the one that drifts, and a drifted seed is close to invisible: old and new values satisfy
// the column's CHECK, so nothing downstream rejects it and a fresh install simply
// answers differently from an upgraded store, which only a repairing ladder step can
// undo. Deriving also keeps a table's column list the only edit a
// new column needs, which is the property resolveResetColumns already gives the reset.
function normalizeBootstrapRow(
  table: LocalSQLiteTableSpec,
  columns: NormalizedColumn[],
  slotColumnName: string,
): NormalizedBootstrapColumn[] | undefined {
  if (table.bootstrapRow === undefined) {
    return undefined;
  }
  // Present-but-not-`true` is rejected rather than read as "no bootstrap". The spec
  // is JSON, so the interface above constrains nothing at run time, and every wrong
  // shape fails the same silent way: the table renders with no seed, the open leaves
  // the row absent, and each reader answers from its own fail-closed default. An
  // object-shaped seed mapping is rejected for the same reason: this flag declares whether derivation
  // runs, never values that could diverge from the column defaults.
  if (table.bootstrapRow !== true) {
    throw new Error(
      `${table.name} bootstrapRow must be exactly true when present (got ${JSON.stringify(
        table.bootstrapRow,
      )}); omit the field for a table with no seeded row`,
    );
  }
  return columns.map((column): NormalizedBootstrapColumn => {
    if (column.name === slotColumnName || column.name === VERSION_COLUMN) {
      return { name: column.name, sqliteType: column.sqliteType, value: 1 };
    }
    if (column.defaultValue === undefined) {
      throw new Error(
        `${table.name} declares bootstrapRow but column ${column.name} has no default to seed it at`,
      );
    }
    return {
      name: column.name,
      sqliteType: column.sqliteType,
      value: column.defaultValue,
    };
  });
}

function validateTable(table: LocalSQLiteTableSpec): Set<string> {
  if (table.columns.length === 0) {
    throw new Error(`${table.name} must define at least one column`);
  }

  const columnNames = new Set<string>();
  for (const column of table.columns) {
    if (columnNames.has(column.name)) {
      throw new Error(`Duplicate column ${column.name}`);
    }
    columnNames.add(column.name);
  }

  for (const keyColumn of table.primaryKey) {
    if (!columnNames.has(keyColumn)) {
      throw new Error(`Primary key references unknown column ${keyColumn}`);
    }
  }

  // Unique constraints remain unsupported; ordinary indexes have their own emitter.
  if (table.uniqueKeys.length > 0) {
    throw new Error(
      `${table.name} declares uniqueKeys but no UNIQUE constraint is ever emitted; implement emission before declaring one`,
    );
  }
  if (table.indexes.length > 0 && !table.analyze) {
    throw new Error(
      `${table.name} declares indexes and must require planner statistics`,
    );
  }

  validateNullableColumns(table);

  return columnNames;
}

// Where a nullable column may and may not appear.
//
// The emitters carry nullability through the shapes a nullable column is FOR - it is
// written by an insert or an update and read back off a row - and the reader gets an
// optional brand, so a caller cannot mistake absent for a stored zero or an empty
// string. What they do not carry is the shapes where a NULL would mean nothing, or
// would mean something wrong; each is rejected here rather than emitted, on the rule
// `survivesReset` and the unique-key rejection above already state: a
// declaration that reads as behavior while nothing implements it is worse than none.
//
// The predicate and guard rejections exist because each of them would
// COMPILE and then quietly match no row: SQL equality against NULL is NULL, never true,
// so `WHERE push_id = ?` bound to NULL and a literal `guard` on a nullable column each
// return zero rows for a row that is sitting right there. A generated keyed read that
// cannot find its own row is exactly the class the branded-predicate machinery exists to
// make unexpressible, and it needs an IS NULL form rather than a bind to say what the
// author meant.
function validateNullableColumns(table: LocalSQLiteTableSpec): void {
  const nullableColumns = new Set(
    table.columns
      .filter((column) => column.nullable)
      .map((column) => column.name),
  );
  if (nullableColumns.size === 0) return;

  for (const keyColumn of table.primaryKey) {
    if (nullableColumns.has(keyColumn)) {
      throw new Error(
        `${table.name}.${keyColumn} is nullable and in the primary key; the key identifies the row, and SQLite admits a NULL into a non-INTEGER PRIMARY KEY rather than refusing it`,
      );
    }
  }
  if (nullableColumns.has(VERSION_COLUMN)) {
    throw new Error(
      `${table.name}.${VERSION_COLUMN} is nullable; every write path seeds or advances it, and a compare-and-set reads it back`,
    );
  }

  for (const column of table.columns) {
    if (column.nullable && column.default !== undefined) {
      throw new Error(
        `${table.name}.${column.name} is nullable and declares a default; a default is emitted as a reviewed SQL literal and there is no NULL form, so a nullable column's not-yet-written state is NULL itself`,
      );
    }
  }

  // `ensure`, `resetToDefaults`, and `bootstrapRow` each write every settable column as
  // a declared-default literal, which the rejection above leaves a nullable column
  // without. Rejected as a table-level combination rather than per column, because the
  // three seed the WHOLE row - a table declaring one has no way to leave a single column
  // out.
  const seedingOperation = table.operations.find(
    (operation) =>
      operation.kind === "ensure" || operation.kind === "resetToDefaults",
  );
  if (seedingOperation !== undefined) {
    throw new Error(
      `${table.name} has nullable columns and declares ${seedingOperation.name} (${seedingOperation.kind}), which writes every settable column as a declared-default literal; implement a NULL seed literal before combining the two`,
    );
  }
  if (table.bootstrapRow === true) {
    throw new Error(
      `${table.name} has nullable columns and declares bootstrapRow, which seeds every settable column as a declared-default literal; implement a NULL seed literal before combining the two`,
    );
  }

  for (const operation of table.operations) {
    for (const term of operation.predicate ?? []) {
      if (nullableColumns.has(term.column)) {
        throw new Error(
          `${operation.name} predicates on nullable column ${term.column}; SQL equality against NULL is never true, so the emitted statement would match no row rather than the row holding NULL`,
        );
      }
    }
    for (const term of operation.guard ?? []) {
      if (nullableColumns.has(term.column)) {
        throw new Error(
          `${operation.name} guards on nullable column ${term.column}; a literal comparison against NULL is never true, so the claim could never be taken`,
        );
      }
    }
    if (
      operation.ownerFrom !== undefined &&
      nullableColumns.has(operation.ownerFrom.into)
    ) {
      throw new Error(
        `${operation.name} sources nullable column ${operation.ownerFrom.into} from ${operation.ownerFrom.table}; the owner read returns a non-null value and an empty one already means nobody to record for`,
      );
    }
  }
}
