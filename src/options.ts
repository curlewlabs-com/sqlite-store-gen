// The names a consumer supplies to the renderer beside its spec, and the shape each must
// have to land in generated source.

import { KOTLIN_HARD_KEYWORDS } from "./identifiers";

// What the caller supplies beside the spec: the values that name the consumer's app rather
// than its schema - its Kotlin package, its database file, and a header naming its own
// spec and regenerate command.
export interface LocalSQLiteRenderOptions {
  kotlinPackage: string;
  databaseFileName: string;
  notice: string;
}

export type ResolvedRenderOptions = Required<LocalSQLiteRenderOptions>;

const OPTION_KEYS: readonly string[] = [
  "kotlinPackage",
  "databaseFileName",
  "notice",
] satisfies (keyof LocalSQLiteRenderOptions)[];

// Each lands verbatim in generated source - a package in a Kotlin `package`/`import` line,
// the file name in a Kotlin and a Swift string literal - so a value outside these shapes
// would emit code that does not compile, or a literal that ends early.
const KOTLIN_PACKAGE_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;
const DATABASE_FILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function resolveRenderOptions(
  options: LocalSQLiteRenderOptions,
): ResolvedRenderOptions {
  // An option this renderer does not read would otherwise be dropped without a word, and
  // the output would differ from what its caller asked for.
  const unknown = Object.keys(options).filter(
    (key) => !OPTION_KEYS.includes(key),
  );
  if (unknown.length > 0) {
    throw new Error(
      `unknown render option ${unknown.map((key) => `"${key}"`).join(", ")}; the options are ${OPTION_KEYS.join(", ")}`,
    );
  }
  const resolved: ResolvedRenderOptions = {
    kotlinPackage: options.kotlinPackage,
    databaseFileName: options.databaseFileName,
    notice: options.notice,
  };
  if (!KOTLIN_PACKAGE_PATTERN.test(resolved.kotlinPackage)) {
    throw new Error(
      `kotlinPackage "${resolved.kotlinPackage}" must be a lowercase dotted Kotlin package name`,
    );
  }
  // A `package` line takes no backticks from this generator, so a keyword segment
  // (`org.example.object`) does not parse.
  const keyword = resolved.kotlinPackage
    .split(".")
    .find((segment) => KOTLIN_HARD_KEYWORDS.has(segment));
  if (keyword !== undefined) {
    throw new Error(
      `kotlinPackage "${resolved.kotlinPackage}" has the segment "${keyword}", which is a Kotlin keyword`,
    );
  }
  if (!DATABASE_FILE_NAME_PATTERN.test(resolved.databaseFileName)) {
    throw new Error(
      `databaseFileName "${resolved.databaseFileName}" must be a plain file name (letters, digits, '.', '_', '-')`,
    );
  }
  return resolved;
}
