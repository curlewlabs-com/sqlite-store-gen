// Defines the authored local-SQLite operation contract and rejects declarations
// whose generated access path or optional fields would not mean what they say.

import { toCamelCase } from "./names";
import { requireEmittableText } from "./sql";

import {
  validateOrderedSuccessor,
  validateIntegerMaximum,
} from "./keyed-access";

import type { LocalSQLiteSchemaTableSpec } from "./schema";

import type { LocalSQLiteIndexSpec } from "./indexes";

import { validateDeleteSummary } from "./delete-summary";

type PredicateOperator = "=" | "<>" | ">" | "<" | ">=" | "<=";
// `ensure` is a create-if-absent INSERT OR IGNORE: it seeds an owner's row at the
// initial version if none exists and is a no-op if one does, never touching an
// existing row's value or version. It is distinct from `insert` (an unconditional
// version-advancing upsert that overwrites the row) because a shared owner-keyed row is
// written by several consumers into their own columns - a full-row upsert when the
// owner arrives would clobber a sibling consumer's column, so that moment only ensures
// the row exists and each consumer targets its own columns.
//
// `casUpdate` is the cross-process write: it gates the write on the caller's
// observed version and advances it, which is what orders concurrent writers from
// different processes. It is a declared kind rather than a property the generator
// infers from the predicate, because the version term has exactly one legal shape -
// letting a spec author write it meant a wrong brand, a missing brand, or a
// non-equality operator each produced SQL that read as a compare-and-set and was
// not one. The author declares intent; `synthesizeVersionTerm` writes the term.
//
// There is deliberately no `casDelete`. A versioned singleton clears to an
// empty-owner tombstone via a compare-and-set update; a physical CAS delete would
// let stale writers reason about absence and reopen the insert-on-absent
// resurrection hole the tombstone closes.
//
// `resetToDefaults` returns the keyed row to the state a freshly seeded one holds:
// an UPDATE setting every settable column to the same reviewed `default` literal the
// `ensure` seeds. Its target columns are DERIVED from the table rather than authored,
// which is the whole point - a column added later is reset without anyone editing the
// operation, and a column that must survive the reset has to say so
// (`survivesReset`). An authored `setColumns` would put the safe direction behind
// remembering to extend a list.
//
// `insertForCurrentOwner` is `insert`'s cross-process sibling: it reads one column from
// another table's singleton row and inserts with it inside ONE `BEGIN IMMEDIATE` unit,
// instead of binding a value the caller read first. That is what makes "who the current
// owner is" and "what is recorded for them" one fact rather than two. A read-then-insert
// pair outside a transaction is atomic only within one connection - a caller's own lock
// orders callers inside one process - so it does NOT hold for a second process writing
// while the first repoints the owner.
//
// The transaction rather than one `INSERT ... SELECT`, which is equally atomic: the
// guarantee is written down instead of deduced from SQLite's statement semantics, the
// no-owner answer is a value the code branches on rather than zero selected rows, and it
// reuses the wrapper the compare-and-set path already has. It returns recorded /
// no-current-owner / busy, because a caller that collapsed busy into no-current-owner
// would report a settled "nobody" while an owner is in fact recorded.
export type OperationKind =
  | "read"
  | "insert"
  | "insertForCurrentOwner"
  | "ensure"
  | "update"
  | "casUpdate"
  | "delete"
  | "resetToDefaults";

// ---------------------------------------------------------------------------
// Raw spec shapes (the on-disk generated-operation-spec.json, version 3).
// Each entry in `tables` owns its own columns and operations, so a predicate is
// validated against its own table's keys/indexes and can never borrow a schema
// the generator no longer owns. A table declaring a `casUpdate` operation also
// declares `operationBrands.expectedVersion` - the brand the compare-and-set surface
// takes as the caller's observed row_version, declared once for the table and never
// repeated on the operation.
// ---------------------------------------------------------------------------

// A spec-authored comparison. `row_version` is not a legal column here: the
// compare-and-set term is synthesized for a `casUpdate` and belongs to the generator
// (see rejectAuthoredVersionTerms).
export interface LocalSQLitePredicateTerm {
  column: string;
  operator: PredicateOperator;
  brand?: string;
  // A distinct binding when an UPDATE compares and sets the same column.
  parameter?: string;
}

// One equality term of an update's guard, compiled into the WHERE as a LITERAL rather
// than bound. It turns a read-then-write claim into a single statement: the guard is the
// state the caller believed it was acting on, so the row matches only while that is still
// true, and the update's changed-row count IS the verdict.
//
// A literal needs no caller-supplied state and is useful for fixed state transitions.
// Dynamic due-time admission instead binds an aliased predicate parameter, so the
// comparison and replacement deadlines remain independent values.
//
// Deliberately NOT counted toward index coverage (`predicateCoverage` reads only
// the bound predicate): a guard narrows a row the key already found, so it can never be
// the thing that keeps a statement off a scan.
export interface LocalSQLiteGuardTerm {
  column: string;
  value: number | string;
}

export interface LocalSQLiteOperationSpec {
  name: string;
  kind: OperationKind;
  deleteSummary?: { observedAtColumn: string };
  predicate?: LocalSQLitePredicateTerm[];
  boundedScanException?: {
    hardRowBound: string;
    caller: string;
    ordering: string;
    diagnostic: string;
  };
  // Legal on `insertForCurrentOwner` alone: a second write, against a DIFFERENT singleton
  // table, that lands inside the insert's own `BEGIN IMMEDIATE` unit or not at all.
  //
  // It exists because a producer whose durable row and whose pointer AT that row live in
  // different tables has no correct two-statement ordering. Row first leaves a row nothing points
  // at when the second write is lost; pointer first leaves a pointer at a row that was
  // never written, and it has to be stamped before the insert's own answer is known, which
  // is what a caller's honesty gate reads. One unit removes the choice: the row and the pointer land together or
  // neither does, and the gate becomes "the transaction committed".
  //
  // The emitted statement runs AFTER the insert, so an insert that throws takes the second
  // write with it, and its changed-row count is checked like the insert's - a singleton row
  // the schema seeds cannot legitimately be missing, so zero rows is an unexpected result
  // rather than a quiet no-op the caller would read as success.
  //
  // The target is keyed on its own singleton slot and takes no key parameter, for the
  // reason `ownerFrom`'s source does; `setColumns` are its settable columns, bound from the
  // caller after this table's own.
  alsoSet?: { table: string; setColumns: string[] };
  // Allocated under the insert transaction; a co-write can point at the returned key.
  allocateKey?: { alsoSetColumn?: string };
  // Required on `insertForCurrentOwner`, rejected everywhere else: which column of which
  // singleton table supplies `into`, this table's own column, inside the insert's own
  // transaction. `table` and `column` are spec constants like every other identifier -
  // only values are ever bound - and the emitted read keys the source on its singleton
  // slot, with an empty value meaning nobody to record for, so an unset source inserts
  // nothing.
  ownerFrom?: { table: string; column: string; into: string };
  // Literal equality terms ANDed onto an `update`'s WHERE, making the statement itself
  // the claim: it matches only while the row still holds these values, so the changed-row
  // count the caller already reads becomes the verdict rather than a formality. See
  // LocalSQLiteGuardTerm for why a bound predicate term cannot do this.
  guard?: LocalSQLiteGuardTerm[];
  // A `read` that takes the FIRST row of the table in the primary key's own order
  // instead of binding a key - the head of a queue, for a consumer that cannot name the
  // row it wants because the producer minted the key.
  //
  // This is keyed access, not a bounded scan, which is why it carries no
  // `boundedScanException`: the ordering column must BE the table's single-column
  // primary key, so the emitted `ORDER BY <pk> ASC LIMIT 1` needs no sorter - the key's
  // own b-tree order IS the requested order, and the statement halts after the first
  // row. That is what makes its cost independent of how many rows are stored, and that
  // independence is what the exception's `hardRowBound` exists to substitute for when
  // nothing indexes the operation - so an operation this shape admits owes no bound.
  // Measured rather than reasoned: reading the query plan back shows no `TEMP B-TREE`
  // sorter for this shape.
  //
  // Ascending only. A descending head is the same seek at the other end of the same
  // index and costs the same; it is absent because nothing needs it, not because it is
  // harder.
  orderedHead?: { column: string };
  orderedSuccessor?: { column: string };
  integerMaximum?: true;
  // The columns an `update` writes - a subset of the table's settable columns, never
  // the key or row_version. The emitted UPDATE sets only these, so one consumer's
  // owner-scoped write leaves every sibling consumer's column on the shared owner row
  // untouched. Required on **every** update, compare-and-set included: a CAS that set
  // every settable column would clobber a sibling consumer's column on the shared
  // owner-keyed row, which is the exact hazard the partial-column shape exists to
  // prevent. An explicit list can still name every settable column when a caller
  // genuinely wants a full-row swap, so requiring it costs no expressiveness.
  //
  // A `resetToDefaults` must NOT declare one: its columns are derived from the table
  // so that a column added later is covered without editing the operation.
  setColumns?: string[];
}

export interface LocalSQLiteOperationTableSpec extends LocalSQLiteSchemaTableSpec {
  uniqueKeys: string[][];
  indexes: LocalSQLiteIndexSpec[];
  // When set, the table is keyed by a caller-supplied owner value rather than the
  // fixed singleton slot: `keyedBy` names the single primary-key column (its brand
  // is the caller-supplied key type), and every operation binds that value where a
  // singleton table binds the SINGLETON_ID constant. The identifier stays a spec
  // constant - only the bound value changes - so the no-runtime-identifiers
  // contract holds.
  keyedBy?: string;
  operations: LocalSQLiteOperationSpec[];
}

type OptionalOperationField =
  | "deleteSummary"
  | "predicate"
  | "boundedScanException"
  | "ownerFrom"
  | "alsoSet"
  | "allocateKey"
  | "orderedSuccessor"
  | "integerMaximum"
  | "orderedHead"
  | "setColumns"
  | "guard";

const OPTIONAL_OPERATION_FIELDS: readonly OptionalOperationField[] = [
  "deleteSummary",
  "predicate",
  "boundedScanException",
  "ownerFrom",
  "alsoSet",
  "allocateKey",
  "orderedHead",
  "orderedSuccessor",
  "integerMaximum",
  "setColumns",
  "guard",
];

// Every optional field on an operation spec is read by SOME kind's emitter and ignored by
// all the others, so a field on the wrong kind is not an error anywhere downstream - it is
// simply never read. That is the class this table makes unexpressible: an `orderedHead` on
// an insert, a `boundedScanException` on a kind with no predicate to except, `setColumns`
// on a read. Each reads as a declaration that the operation behaves a certain way while
// nothing about the emitted statement does, and each was silently accepted before this
// existed - the access-path checks below return early for the kinds with no predicate, and
// that early return was skipping the whole declaration, not just the predicate.
//
// A total `Record` over `OperationKind` on purpose: a kind added later does not compile
// until it says what it reads, which is the same guarantee the generated channel's
// no-default switches give. `setColumns` and `predicate` are absent from a set that
// could plausibly hold them because an earlier pass owns the rejection with a better message - `setColumns` on
// a `resetToDefaults` (`resolveResetColumns`) and a `predicate` on a `casUpdate`
// (`synthesizeCasPredicate`) - and each runs inside `normalizeLocalSQLiteTable`, which
// completes for every table before any of this runs.
//
// `boundedScanException` is legal on read, update, delete, and reset-to-defaults,
// which reach the index-coverage check below with an authored predicate because
// that check is the only thing that reads it. Insert, insert-for-current-owner,
// ensure, and compare-and-set author no predicate, so there is no scan to excuse.
const CONSULTED_DECLARATIONS_BY_KIND: Record<
  OperationKind,
  readonly OptionalOperationField[]
> = {
  read: [
    "predicate",
    "boundedScanException",
    "orderedHead",
    "orderedSuccessor",
  ],
  insert: [],
  insertForCurrentOwner: ["ownerFrom", "alsoSet", "allocateKey"],
  ensure: [],
  // `guard` is legal on `update` alone. A read has no row to refuse, a delete's guard
  // would be a predicate term, and a casUpdate already carries the generator's own
  // version term - adding a guard would give the statement competing answers to "may I".
  update: [
    "predicate",
    "boundedScanException",
    "setColumns",
    "guard",
    "integerMaximum",
  ],
  casUpdate: ["setColumns"],
  delete: ["predicate", "boundedScanException", "deleteSummary"],
  resetToDefaults: ["predicate", "boundedScanException"],
};

function validateDeclaredFields(operation: LocalSQLiteOperationSpec): void {
  const consulted = CONSULTED_DECLARATIONS_BY_KIND[operation.kind];
  for (const field of OPTIONAL_OPERATION_FIELDS) {
    if (operation[field] !== undefined && !consulted.includes(field)) {
      throw new Error(
        `${operation.name} declares ${field} but is a ${operation.kind}, whose emitters never read it; the declaration would be inert rather than wrong, so it is rejected here instead of shipping as a statement about behavior nothing implements`,
      );
    }
  }
}

// Every way a guard could be authored wrong, rejected where the spec is read rather than
// discovered as a statement that matches no row. Called before the access-path checks
// below, all of which return early for some kind - a guard skipped by an early return
// would emit unvalidated text straight into a WHERE.
function validateGuard(
  table: LocalSQLiteOperationTableSpec,
  operation: LocalSQLiteOperationSpec,
): void {
  const guard = operation.guard;
  if (guard === undefined) {
    return;
  }
  if (guard.length === 0) {
    throw new Error(
      `${operation.name} declares an empty guard; omit the field rather than shipping an update that reads as claimed and is not`,
    );
  }
  const boundColumns = new Set(
    (operation.predicate ?? []).map((term) => term.column),
  );
  const seen = new Set<string>();
  for (const term of guard) {
    const column = table.columns.find((each) => each.name === term.column);
    if (column === undefined) {
      throw new Error(`${operation.name} guards unknown column ${term.column}`);
    }
    if (seen.has(term.column)) {
      throw new Error(
        `${operation.name} guards ${term.column} twice; two literals for one column either repeat or contradict, and either renders as a WHERE that reads deliberate`,
      );
    }
    seen.add(term.column);
    // A column cannot be bound and guarded: the bound term already fixes the value
    // the caller asked for, so a literal beside it either restates it or silently
    // overrides the caller with a value the signature still accepts.
    if (boundColumns.has(term.column)) {
      throw new Error(
        `${operation.name} guards ${term.column}, which its predicate already binds; guard a column the caller does not key on`,
      );
    }
    const expectsNumber = column.sqliteType !== "TEXT";
    if (expectsNumber !== (typeof term.value === "number")) {
      throw new Error(
        `${operation.name} guards ${term.column} with a ${typeof term.value} but the column is ${column.sqliteType}; a mistyped literal compares unequal forever and the update silently never fires`,
      );
    }
    if (typeof term.value === "string") {
      requireEmittableText(
        term.value,
        `${operation.name} guard on ${term.column}`,
      );
    }
  }
}

function validatePredicateParameters(
  operation: LocalSQLiteOperationSpec,
): void {
  const terms = operation.predicate ?? [];
  if (!terms.some((term) => term.parameter !== undefined)) return;
  const names = new Set([
    "database",
    "statement",
    "changedRows",
    "raw",
    "expectedVersion",
    ...(operation.setColumns ?? []).map(toCamelCase),
  ]);
  for (const term of terms) {
    if (
      term.parameter !== undefined &&
      (operation.kind !== "update" ||
        term.brand === undefined ||
        !/^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/.test(term.parameter))
    ) {
      throw new Error(
        `${operation.name}: predicate parameter requires a branded update term and a multiword snake_case name`,
      );
    }
    if (term.brand === undefined) continue;
    const name = toCamelCase(term.parameter ?? term.column);
    if (names.has(name))
      throw new Error(
        `${operation.name}: conflicting predicate parameter ${name}`,
      );
    names.add(name);
  }
}

export function validateLocalSQLiteOperation(
  table: LocalSQLiteOperationTableSpec,
  columnNames: Set<string>,
  operation: LocalSQLiteOperationSpec,
): void {
  validateDeclaredFields(operation);
  validatePredicateParameters(operation);
  validateGuard(table, operation);
  validateDeleteSummary(table, operation);
  validateIntegerMaximum(table, operation);
  if (
    operation.kind === "insert" ||
    operation.kind === "insertForCurrentOwner" ||
    operation.kind === "ensure"
  ) {
    return;
  }
  // The bounded-scan and index-coverage checks below read an authored predicate,
  // and a casUpdate has none: its
  // predicate is synthesized on the single-column primary key, so it is keyed and
  // index-covered by construction rather than by the author remembering to make it
  // so. Authoring one at all is rejected in `synthesizeCasPredicate`, so there is no
  // unvalidated spec text reaching this point - which is what makes skipping the
  // PREDICATE checks safe. Everything else a casUpdate could declare is covered above,
  // by the pass that runs before this early return rather than after it.
  if (operation.kind === "casUpdate") {
    return;
  }
  const predicate = operation.predicate ?? [];
  if (operation.orderedSuccessor !== undefined) {
    validateOrderedSuccessor(table, operation);
    return;
  }
  if (operation.orderedHead !== undefined) {
    validateOrderedHead(table, operation, predicate);
    return;
  }
  if (predicate.length === 0 && operation.boundedScanException === undefined) {
    throw new Error(
      `${operation.name} must declare a keyed predicate, an orderedHead, or a bounded scan exception`,
    );
  }
  for (const term of predicate) {
    if (!columnNames.has(term.column)) {
      throw new Error(
        `${operation.name} references unknown predicate column ${term.column}`,
      );
    }
  }
  // Its fields are checked with the rest of the spec's shape (validateTableShape).
  if (operation.boundedScanException !== undefined) {
    validateUnbrandedTerms(table, operation, predicate);
    return;
  }
  const countedOwnerCleanup = operation.deleteSummary !== undefined;
  const coverage = predicateCoverage(table, predicate, countedOwnerCleanup);
  if (coverage === "nonUniqueIndex") {
    throw new Error(
      `${operation.name} is keyed on a non-unique index; the generated ${operation.kind} expects at most one matching row, and a read of several throws while an update or delete of several writes them all before it throws. Key it on the primary key`,
    );
  }
  if (coverage === "none") {
    throw new Error(
      `${operation.name} predicate is not covered by an emitted key or index; declare indexed access or a bounded scan exception`,
    );
  }
  validateUnbrandedTerms(table, operation, predicate);
}

// An unbranded term takes no caller argument: the emitters bind the fixed SINGLETON_ID
// slot in its place. That is right for exactly one term, a fixed singleton's slot
// column. Anywhere else the term silently becomes `<column> = 1` - a read that finds the
// wrong row or none, and an update or delete that writes whichever row has that key - so
// it is refused here rather than emitted.
function validateUnbrandedTerms(
  table: LocalSQLiteOperationTableSpec,
  operation: LocalSQLiteOperationSpec,
  predicate: LocalSQLitePredicateTerm[],
): void {
  for (const term of predicate) {
    if (term.brand !== undefined) continue;
    if (table.keyedBy === undefined && term.column === table.primaryKey[0]) {
      continue;
    }
    throw new Error(
      `${operation.name} predicate term on ${term.column} declares no brand; only a fixed singleton's slot column may be bound unbranded`,
    );
  }
}

// An `orderedHead` read is admitted as KEYED access rather than as a bounded scan, so
// every condition that makes it one is checked here rather than left to the author.
//
// The ordering column must be the table's single-column primary key: that is what turns
// `ORDER BY <col> ASC LIMIT 1` a request the key's own b-tree order already satisfies,
// so the statement needs no sorter and halts after one row. That is the whole reason this
// shape owes no `hardRowBound`. Order by anything else and the emitted statement differs by
// the column name alone while costing a sorter that must visit every row before it can
// return the first - the failure mode this check exists to make unexpressible.
//
// The operation is already known to be a `read`: `validateDeclaredFields` rejects an
// `orderedHead` on every other kind before any of the access-path checks run - including
// insert, insert-for-current-owner, ensure, and compare-and-set, whose access-path
// checks return early and which this function could never see.
function validateOrderedHead(
  table: LocalSQLiteOperationTableSpec,
  operation: LocalSQLiteOperationSpec,
  predicate: LocalSQLitePredicateTerm[],
): void {
  if (predicate.length > 0) {
    throw new Error(
      `${operation.name} declares an orderedHead and a predicate; a head read binds no key`,
    );
  }
  if (operation.boundedScanException !== undefined) {
    throw new Error(
      `${operation.name} declares an orderedHead and a bounded scan exception; a head read is keyed access on the primary key and needs no exception`,
    );
  }
  const [primaryKeyColumn] = table.primaryKey;
  if (
    table.primaryKey.length !== 1 ||
    operation.orderedHead?.column !== primaryKeyColumn
  ) {
    throw new Error(
      `${operation.name} orders by ${operation.orderedHead?.column}, which is not ${table.name}'s single-column primary key; a head read's ordering must be one the key's own b-tree already satisfies, or it costs a sorter over every row`,
    );
  }
  // A fixed singleton holds one row whose key the caller already knows, so a head read
  // there would be a keyed read written the long way. The shape exists for the opposite
  // case: the PRODUCER mints the key, so the consumer cannot name the row it wants.
  if (table.keyedBy === undefined) {
    throw new Error(
      `${operation.name} declares an orderedHead on singleton table ${table.name}; a head read is for a table whose keys the caller does not know, so it requires keyedBy`,
    );
  }
}

// What keeps an operation's predicate off a scan, if anything does.
//
// Every operation but the counted cleanup is a single-row operation: the emitted read
// returns one row and the emitted update or delete expects one changed row. So only a
// key, whose every column the predicate binds by equality, admits one. A plain index
// over the same columns keeps the statement off a scan but says nothing about how many
// rows match, and is reported apart so the refusal can say so.
//
// The counted cleanup is a set operation by design, and the only one that may visit an
// owner's whole index prefix.
function predicateCoverage(
  table: LocalSQLiteOperationTableSpec,
  predicate: LocalSQLitePredicateTerm[],
  countedOwnerCleanup: boolean,
): "key" | "nonUniqueIndex" | "none" {
  const equalityColumns = new Set(
    predicate
      .filter((term) => term.operator === "=")
      .map((term) => term.column),
  );
  const indexes = table.indexes.map((index) => index.columns);
  if (countedOwnerCleanup) {
    return [table.primaryKey, ...table.uniqueKeys, ...indexes].some(
      (columns) => columns.length > 0 && equalityColumns.has(columns[0]!),
    )
      ? "key"
      : "none";
  }
  const binds = (columns: string[]) =>
    columns.length > 0 &&
    columns.every((column) => equalityColumns.has(column));
  if ([table.primaryKey, ...table.uniqueKeys].some(binds)) return "key";
  return indexes.some(binds) ? "nonUniqueIndex" : "none";
}
