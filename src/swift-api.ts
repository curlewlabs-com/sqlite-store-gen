// Renders the public Swift operation facade over generated database methods.

import { toCamelCase } from "./names";
import {
  VERSION_COLUMN,
  type NormalizedOperation,
  type NormalizedTable,
} from "./model";
import {
  keyedSlotParams,
  ownerSourcedInsertParams,
  ownerSourcedInsertResultType,
  swiftValueType,
} from "./sql";
import { SWIFT_LINE_LIMIT } from "./swift-layout";

function swiftCall(dbMethod: string, args: string[]): string {
  const single = `        try database.${dbMethod}(${args.join(", ")})`;
  if (single.length <= SWIFT_LINE_LIMIT) return single;
  return `        try database.${dbMethod}(
            ${args.join(",\n            ")}
        )`;
}

export function swiftOperationsEnum(table: NormalizedTable): string {
  const methods = table.operations
    .map((operation) => swiftApiMethod(table, operation))
    .join("\n\n");
  return `enum ${table.typePrefix}Operations {
${methods}
}`;
}

function swiftApiMethod(
  table: NormalizedTable,
  operation: NormalizedOperation,
): string {
  const predicate = operation.effectivePredicate;
  const brandedTerms = predicate.filter((term) => term.brand !== undefined);
  const brandedParamLines = brandedTerms
    .map(
      (term) =>
        `        ${toCamelCase(term.parameter ?? term.column)}: ${term.brand}`,
    )
    .join(",\n");
  const brandedCallArgs = brandedTerms.map(
    (term) =>
      `${toCamelCase(term.parameter ?? term.column)}: ${toCamelCase(term.parameter ?? term.column)}`,
  );
  switch (operation.category) {
    case "read":
      if (brandedTerms.length === 0) {
        return `    static func ${operation.apiMethod}(database: GeneratedLocalSQLiteDatabase) throws -> ${table.rowType}? {
${swiftCall(operation.dbMethod, [])}
    }`;
      }
      return `    static func ${operation.apiMethod}(
        database: GeneratedLocalSQLiteDatabase,
${brandedParamLines}
    ) throws -> ${table.rowType}? {
${swiftCall(operation.dbMethod, brandedCallArgs)}
    }`;
    case "insert": {
      const insertColumns = [
        ...keyedSlotParams(table),
        ...table.settableColumns,
      ];
      const insertParamLines = insertColumns
        .map(
          (column) => `        ${column.fieldName}: ${swiftValueType(column)}`,
        )
        .join(",\n");
      const insertCallArgs = insertColumns.map(
        (column) => `${column.fieldName}: ${column.fieldName}`,
      );
      return `    static func ${operation.apiMethod}(
        database: GeneratedLocalSQLiteDatabase,
${insertParamLines}
    ) throws -> ${table.versionColumn.brand} {
${swiftCall(operation.dbMethod, insertCallArgs)}
    }`;
    }
    case "insertForCurrentOwner": {
      const columns = ownerSourcedInsertParams(table, operation);
      return `    static func ${operation.apiMethod}(
        database: GeneratedLocalSQLiteDatabase,
${columns.map((column) => `        ${column.fieldName}: ${swiftValueType(column)}`).join(",\n")}
    ) throws -> ${ownerSourcedInsertResultType(table)} {
${swiftCall(
  operation.dbMethod,
  columns.map((column) => `${column.fieldName}: ${column.fieldName}`),
)}
    }`;
    }
    case "ensure": {
      const ensureColumns = keyedSlotParams(table);
      const ensureParamLines = ensureColumns
        .map((column) => `        ${column.fieldName}: ${column.brand}`)
        .join(",\n");
      const ensureCallArgs = ensureColumns.map(
        (column) => `${column.fieldName}: ${column.fieldName}`,
      );
      // Comma-join `database` with the slot lines rather than hard-coding a trailing
      // comma: a singleton `ensure` binds its slot internally and contributes no lines,
      // which would otherwise leave a dangling comma and blank line in the signature.
      const ensureParams = [
        "        database: GeneratedLocalSQLiteDatabase",
        ...(ensureParamLines === "" ? [] : [ensureParamLines]),
      ].join(",\n");
      return `    static func ${operation.apiMethod}(
${ensureParams}
    ) throws -> Bool {
${swiftCall(operation.dbMethod, ensureCallArgs)}
    }`;
    }
    case "clear":
      if (operation.spec.deleteSummary !== undefined) {
        return `    static func ${operation.apiMethod}(
        database: GeneratedLocalSQLiteDatabase,
${brandedParamLines}
    ) throws -> LocalSQLiteDeleteResult {
${swiftCall(operation.dbMethod, brandedCallArgs)}
    }`;
      }
      if (operation.spec.boundedScanException !== undefined) {
        return `    static func ${operation.apiMethod}(
        database: GeneratedLocalSQLiteDatabase,
${brandedParamLines}
    ) throws -> Int64 {
${swiftCall(operation.dbMethod, brandedCallArgs)}
    }`;
      }
      if (brandedTerms.length > 0) {
        return `    static func ${operation.apiMethod}(
        database: GeneratedLocalSQLiteDatabase,
${brandedParamLines}
    ) throws -> Bool {
${swiftCall(operation.dbMethod, brandedCallArgs)}
    }`;
      }
      return `    static func ${operation.apiMethod}(database: GeneratedLocalSQLiteDatabase) throws -> Bool {
${swiftCall(operation.dbMethod, [])}
    }`;
    case "casUpdate": {
      // The branded predicate terms include row_version (branded as the expected
      // version), so the key params exclude it and it is appended once, last.
      const casKeyTerms = brandedTerms.filter(
        (term) => term.column !== VERSION_COLUMN,
      );
      const casParams = [
        operation.setColumns
          .map(
            (column) =>
              `        ${column.fieldName}: ${swiftValueType(column)}`,
          )
          .join(",\n"),
        casKeyTerms
          .map(
            (term) =>
              `        ${toCamelCase(term.parameter ?? term.column)}: ${term.brand}`,
          )
          .join(",\n"),
        `        expectedVersion: ${table.expectedVersionBrand}`,
      ]
        .filter((part) => part.length > 0)
        .join(",\n");
      const casCallArgs = [
        ...operation.setColumns.map(
          (column) => `${column.fieldName}: ${column.fieldName}`,
        ),
        ...casKeyTerms.map(
          (term) =>
            `${toCamelCase(term.parameter ?? term.column)}: ${toCamelCase(term.parameter ?? term.column)}`,
        ),
        "expectedVersion: expectedVersion",
      ];
      return `    static func ${operation.apiMethod}(
        database: GeneratedLocalSQLiteDatabase,
${casParams}
    ) throws -> ${table.casResultType} {
${swiftCall(operation.dbMethod, casCallArgs)}
    }`;
    }
    case "columnSet": {
      const setParamLines = operation.setColumns
        .map(
          (column) => `        ${column.fieldName}: ${swiftValueType(column)}`,
        )
        .join(",\n");
      const setCallArgs = operation.setColumns.map(
        (column) => `${column.fieldName}: ${column.fieldName}`,
      );
      const params = [setParamLines, brandedParamLines]
        .filter((part) => part.length > 0)
        .join(",\n");
      return `    static func ${operation.apiMethod}(
        database: GeneratedLocalSQLiteDatabase,
${params}
    ) throws -> Bool {
${swiftCall(operation.dbMethod, [...setCallArgs, ...brandedCallArgs])}
    }`;
    }
    case "defaultsReset":
      // Takes the row key and nothing else - see the Kotlin twin.
      if (brandedTerms.length > 0) {
        return `    static func ${operation.apiMethod}(
        database: GeneratedLocalSQLiteDatabase,
${brandedParamLines}
    ) throws -> Bool {
${swiftCall(operation.dbMethod, brandedCallArgs)}
    }`;
      }
      return `    static func ${operation.apiMethod}(database: GeneratedLocalSQLiteDatabase) throws -> Bool {
${swiftCall(operation.dbMethod, [])}
    }`;
  }
}
