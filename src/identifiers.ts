// Owns the checks that each identifier the generator derives from a spec lands in the
// emitted Kotlin and Swift as a legal name, and as the only declaration of that name in
// its scope. A name that fails either way would otherwise surface as a compile error in
// generated code, pointing at a line of output rather than at the spec entry behind it.

import type { NormalizedChannel } from "./channel";
import type { NormalizedTable } from "./model";
import { indexSqlConstant } from "./indexes";
import { additiveColumns } from "./schema";
import {
  hasOwnerSourcedInsert,
  keyedSlotParams,
  ownerSourcedInsertResultType,
} from "./sql";

// Kotlin's hard keywords, which no declaration may take as its name
// (https://kotlinlang.org/docs/keyword-reference.html#hard-keywords). Soft and modifier
// keywords are legal identifiers and are not listed.
export const KOTLIN_HARD_KEYWORDS: ReadonlySet<string> = new Set([
  "as",
  "break",
  "class",
  "continue",
  "do",
  "else",
  "false",
  "for",
  "fun",
  "if",
  "in",
  "interface",
  "is",
  "null",
  "object",
  "package",
  "return",
  "super",
  "this",
  "throw",
  "true",
  "try",
  "typealias",
  "typeof",
  "val",
  "var",
  "when",
  "while",
]);

// The Swift words that cannot name a property, parameter, function, enum case or type
// in the positions the generator emits them, without backticks. Measured with
// `swiftc -typecheck` over every keyword the language reference lists
// (https://docs.swift.org/swift-book/documentation/the-swift-programming-language/lexicalstructure#Keywords-and-Punctuation):
// the words it reserves only in particular contexts (`final`, `open`, `get`, `some`)
// passed in every one of those positions and are not listed, and `Protocol` and `Type`
// failed only as a property, which a derived lowercase field never is.
const SWIFT_RESERVED_WORDS: ReadonlySet<string> = new Set([
  "Any",
  "Self",
  "as",
  "associatedtype",
  "await",
  "break",
  "case",
  "catch",
  "class",
  "continue",
  "default",
  "defer",
  "deinit",
  "do",
  "else",
  "enum",
  "extension",
  "fallthrough",
  "false",
  "fileprivate",
  "for",
  "func",
  "guard",
  "if",
  "import",
  "in",
  "init",
  "inout",
  "internal",
  "is",
  "let",
  "nil",
  "operator",
  "precedencegroup",
  "private",
  "protocol",
  "public",
  "repeat",
  "rethrows",
  "return",
  "self",
  "static",
  "struct",
  "subscript",
  "super",
  "switch",
  "throw",
  "throws",
  "true",
  "try",
  "typealias",
  "var",
  "where",
  "while",
]);

// `languages` names where the name lands as written: most derived names land in both, a
// channel subject only in Swift (Kotlin capitalizes it).
function requireNotKeyword(
  name: string,
  what: string,
  languages: readonly ("Kotlin" | "Swift")[] = ["Kotlin", "Swift"],
): void {
  const kotlin = languages.includes("Kotlin") && KOTLIN_HARD_KEYWORDS.has(name);
  const swift = languages.includes("Swift") && SWIFT_RESERVED_WORDS.has(name);
  if (kotlin || swift) {
    throw new Error(
      `${what} derives the identifier "${name}", which is a ${kotlin ? "Kotlin" : "Swift"} keyword; rename it`,
    );
  }
}

// Records each name against the spec entry it came from, and refuses a second entry
// deriving a name already taken in the same scope.
class Scope {
  private readonly owners = new Map<string, string>();

  constructor(private readonly description: string) {}

  claim(name: string, owner: string): void {
    const existing = this.owners.get(name);
    if (existing !== undefined) {
      throw new Error(
        `${owner} and ${existing} both derive ${name} in ${this.description}; rename one of them`,
      );
    }
    this.owners.set(name, owner);
  }
}

export function validateDerivedNames(
  tables: readonly NormalizedTable[],
  channel: NormalizedChannel,
): void {
  // One generated database class per platform holds every table's operation methods,
  // version readers, row readers and the private halves of each transaction.
  const databaseMembers = new Scope("the generated database class");
  // One companion (Kotlin) and one static set (Swift) hold every SQL constant.
  const kotlinConstants = new Scope("the generated Kotlin SQL constants");
  const swiftConstants = new Scope("the generated Swift SQL constants");
  const typeNames = new Scope("the generated type names");

  for (const table of tables) {
    const tableOwner = `table ${table.spec.name}`;
    typeNames.claim(table.rowType, tableOwner);
    typeNames.claim(`${table.typePrefix}Operations`, tableOwner);
    if (table.casResultType !== undefined) {
      typeNames.claim(table.casResultType, tableOwner);
    }
    if (hasOwnerSourcedInsert(table)) {
      typeNames.claim(ownerSourcedInsertResultType(table), tableOwner);
    }

    // Each brand is declared as a Kotlin value class and a Swift struct; a singleton's
    // slot brand is the one that is never declared. Nor is a singleton's slot column
    // emitted: what lands as a field or a parameter is the value columns and an
    // owner-keyed table's key.
    for (const column of [...keyedSlotParams(table), ...table.valueColumns]) {
      const owner = `column ${table.spec.name}.${column.name}`;
      requireNotKeyword(column.fieldName, owner);
      requireNotKeyword(column.brand, `${owner}'s brand`);
      typeNames.claim(column.brand, `${owner}'s brand`);
    }
    if (table.hasCas && table.expectedVersionBrand !== undefined) {
      const owner = `${table.spec.name}'s expected-version brand`;
      requireNotKeyword(table.expectedVersionBrand, owner);
      typeNames.claim(table.expectedVersionBrand, owner);
    }

    const fields = new Scope(`${table.rowType}'s fields`);
    for (const column of table.readColumns) {
      fields.claim(
        column.fieldName,
        `column ${table.spec.name}.${column.name}`,
      );
    }

    databaseMembers.claim(table.cursorFn, tableOwner);
    if (table.emitsVersionReader) {
      databaseMembers.claim(table.versionReader, tableOwner);
      kotlinConstants.claim(table.kotlinReadVersionConst, tableOwner);
      swiftConstants.claim(table.swiftReadVersionConst, tableOwner);
    }
    kotlinConstants.claim(table.kotlinCreateConst, tableOwner);
    swiftConstants.claim(table.swiftCreateConst, tableOwner);
    if (
      table.kotlinBootstrapConst !== undefined &&
      table.swiftBootstrapConst !== undefined
    ) {
      kotlinConstants.claim(table.kotlinBootstrapConst, tableOwner);
      swiftConstants.claim(table.swiftBootstrapConst, tableOwner);
    }
    for (const column of additiveColumns(table.spec)) {
      const owner = `column ${table.spec.name}.${column.name}`;
      kotlinConstants.claim(table.kotlinAddColumnConst(column), owner);
      swiftConstants.claim(table.swiftAddColumnConst(column), owner);
    }
    for (const index of table.spec.indexes) {
      const owner = `index ${index.name}`;
      kotlinConstants.claim(indexSqlConstant(index, "kotlin"), owner);
      swiftConstants.claim(indexSqlConstant(index, "swift"), owner);
    }

    const operationsObject = new Scope(`${table.typePrefix}'s operations`);
    for (const operation of table.operations) {
      const owner = `operation ${operation.spec.name}`;
      requireNotKeyword(operation.dbMethod, owner);
      requireNotKeyword(operation.apiMethod, owner);
      operationsObject.claim(operation.apiMethod, owner);
      databaseMembers.claim(operation.dbMethod, owner);
      kotlinConstants.claim(operation.kotlinSqlConst, owner);
      swiftConstants.claim(operation.swiftSqlConst, owner);
      if (operation.spec.deleteSummary !== undefined) {
        databaseMembers.claim(`${operation.dbMethod}Summary`, owner);
        kotlinConstants.claim(`${operation.kotlinSqlConst}_SUMMARY`, owner);
        swiftConstants.claim(`${operation.swiftSqlConst}Summary`, owner);
      }
      if (operation.category === "insertForCurrentOwner") {
        databaseMembers.claim(operation.swiftOwnerReadName, owner);
        kotlinConstants.claim(operation.kotlinOwnerReadConst, owner);
        swiftConstants.claim(operation.swiftOwnerReadConst, owner);
        if (operation.coWrite !== undefined) {
          databaseMembers.claim(operation.swiftCoWriteName, owner);
          kotlinConstants.claim(operation.kotlinCoWriteConst, owner);
          swiftConstants.claim(operation.swiftCoWriteConst, owner);
        }
      }
    }
  }

  const dartConstants = new Scope("the generated Dart channel constants");
  for (const subject of channel.subjects) {
    const owner = `channel subject ${subject.name}`;
    // A subject is a Swift enum case as written (`case <subject>(...)`); Kotlin and Dart
    // take it capitalized or prefixed.
    requireNotKeyword(subject.name, owner, ["Swift"]);
    typeNames.claim(subject.swiftEnum, owner);
    const kotlinCases = new Scope(`${subject.kotlinEnum}'s cases`);
    for (const method of subject.methods) {
      const methodOwner = `channel method ${subject.name}.${method.name}`;
      kotlinCases.claim(method.kotlinCase, methodOwner);
      dartConstants.claim(method.dartConstant, methodOwner);
    }
  }
}
