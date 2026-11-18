// The names a consumer supplies to the renderer beside its spec, and the shape each must
// have to land in generated source.

import { KOTLIN_HARD_KEYWORDS } from "./identifiers";

// The Kotlin package curlew-sqlite publishes its binding and engine guards in. Its JNI
// shim resolves the binding class by this name, so an app taking that library as it is
// published has nothing to supply; an app that vendors the binding into its own package
// names that package instead.
export const DEFAULT_BINDING_PACKAGE = "com.curlewlabs.sqlite";

// What the caller supplies beside the spec: the values that name the consumer's app rather
// than its schema - its Kotlin package, the package the SQLite binding lives in, its
// database file, and a header naming its own spec and regenerate command.
export interface LocalSQLiteRenderOptions {
  kotlinPackage: string;
  bindingPackage?: string;
  databaseFileName: string;
  notice: string;
}

export type ResolvedRenderOptions = Required<LocalSQLiteRenderOptions>;

// Each lands verbatim in generated source - a package in a Kotlin `package`/`import` line,
// the file name in a Kotlin and a Swift string literal - so a value outside these shapes
// would emit code that does not compile, or a literal that ends early.
const KOTLIN_PACKAGE_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/;
const DATABASE_FILE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function resolveRenderOptions(
  options: LocalSQLiteRenderOptions,
): ResolvedRenderOptions {
  const resolved: ResolvedRenderOptions = {
    kotlinPackage: options.kotlinPackage,
    bindingPackage: options.bindingPackage ?? DEFAULT_BINDING_PACKAGE,
    databaseFileName: options.databaseFileName,
    notice: options.notice,
  };
  for (const key of ["kotlinPackage", "bindingPackage"] as const) {
    if (!KOTLIN_PACKAGE_PATTERN.test(resolved[key])) {
      throw new Error(
        `${key} "${resolved[key]}" must be a lowercase dotted Kotlin package name`,
      );
    }
    // A `package` or `import` line takes no backticks from this generator, so a
    // keyword segment (`org.example.object`) does not parse.
    const keyword = resolved[key]
      .split(".")
      .find((segment) => KOTLIN_HARD_KEYWORDS.has(segment));
    if (keyword !== undefined) {
      throw new Error(
        `${key} "${resolved[key]}" has the segment "${keyword}", which is a Kotlin keyword`,
      );
    }
  }
  if (!DATABASE_FILE_NAME_PATTERN.test(resolved.databaseFileName)) {
    throw new Error(
      `databaseFileName "${resolved.databaseFileName}" must be a plain file name (letters, digits, '.', '_', '-')`,
    );
  }
  return resolved;
}
