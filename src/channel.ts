// Compiles the shipped local-SQLite method-channel declaration into one
// normalized wire model and the exhaustive Swift, Kotlin, and Dart surfaces
// that consume it. Wire names stay literal because column names may evolve
// without moving a client-facing method.

const SWIFT_LINE_LIMIT = 120;
const KOTLIN_LINE_LIMIT = 120;
const DART_LINE_LIMIT = 80;

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

interface LocalSQLiteChannelArgSpec {
  name: string;
  type: "string" | "bool";
}

type ChannelReturnKind = "bool" | "string" | "stringOrNull" | "void" | "row";

interface LocalSQLiteChannelMethodSpec {
  name: string;
  returns: ChannelReturnKind;
  args?: LocalSQLiteChannelArgSpec[];
  doc?: string | undefined;
}

interface LocalSQLiteChannelSubjectSpec {
  name: string;
  prefix: string;
  doc?: string | undefined;
  methods: LocalSQLiteChannelMethodSpec[];
}

export interface LocalSQLiteChannelSpec {
  name: string;
  doc?: string | undefined;
  subjects: LocalSQLiteChannelSubjectSpec[];
}

interface NormalizedChannelMethod {
  // The wire suffix, verbatim from the spec. Doubles as the Swift case name and
  // the stem every other platform's identifier is built from.
  name: string;
  wire: string;
  returns: ChannelReturnKind;
  args: LocalSQLiteChannelArgSpec[];
  doc?: string | undefined;
  swiftCase: string;
  kotlinCase: string;
  dartConstant: string;
}

interface NormalizedChannelSubject {
  name: string;
  prefix: string;
  doc?: string | undefined;
  methods: NormalizedChannelMethod[];
  swiftEnum: string;
  kotlinEnum: string;
  swiftPrefixConstant: string;
}

export interface NormalizedChannel {
  name: string;
  doc?: string | undefined;
  subjects: NormalizedChannelSubject[];
  allMethods: NormalizedChannelMethod[];
}

// Swift's own keywords, which a wire suffix is free to collide with (`repoint`
// does not, but `default` or `case` would). Escaped with backticks rather than
// renamed, so the enum case still reads as the wire name it carries.
const SWIFT_RESERVED_WORDS = new Set([
  "as",
  "associatedtype",
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
  "final",
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
  "open",
  "operator",
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

const CHANNEL_METHOD_NAME_PATTERN = /^[a-z][A-Za-z0-9]*$/;
const CHANNEL_SUBJECT_NAME_PATTERN = /^[a-z][A-Za-z0-9]*$/;
const CHANNEL_ARG_NAME_PATTERN = /^[a-z][A-Za-z0-9]*$/;
const CHANNEL_WIRE_ROOT = "localSQLite.";

function screamingSnakeFromCamel(camel: string): string {
  return camel.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toUpperCase();
}

export function normalizeLocalSQLiteChannel(
  raw: LocalSQLiteChannelSpec,
): NormalizedChannel {
  if (typeof raw?.name !== "string" || raw.name.length === 0) {
    throw new Error("channel.name must be the method-channel name");
  }
  if (!Array.isArray(raw.subjects) || raw.subjects.length === 0) {
    throw new Error("channel must declare at least one subject");
  }

  const seenWire = new Set<string>();
  const seenSubject = new Set<string>();
  const subjects = raw.subjects.map((subject) => {
    if (!CHANNEL_SUBJECT_NAME_PATTERN.test(subject.name ?? "")) {
      throw new Error(
        `channel subject name "${subject.name}" must be lowerCamelCase`,
      );
    }
    if (seenSubject.has(subject.name)) {
      throw new Error(`Duplicate channel subject ${subject.name}`);
    }
    seenSubject.add(subject.name);

    // The prefix is what each bridge matches before dispatch, so a subject whose
    // prefix does not carry its own name would route methods it does not own.
    const expectedPrefix = `${CHANNEL_WIRE_ROOT}${subject.name}.`;
    if (subject.prefix !== expectedPrefix) {
      throw new Error(
        `channel subject ${subject.name} must declare prefix "${expectedPrefix}", got "${subject.prefix}"`,
      );
    }
    if (!Array.isArray(subject.methods) || subject.methods.length === 0) {
      throw new Error(
        `channel subject ${subject.name} must declare at least one method`,
      );
    }

    const seenMethod = new Set<string>();
    const methods = subject.methods.map((method) => {
      if (!CHANNEL_METHOD_NAME_PATTERN.test(method.name ?? "")) {
        throw new Error(
          `channel method name "${method.name}" on ${subject.name} must be lowerCamelCase`,
        );
      }
      if (seenMethod.has(method.name)) {
        throw new Error(
          `Duplicate channel method ${subject.name}.${method.name}`,
        );
      }
      seenMethod.add(method.name);

      const wire = `${subject.prefix}${method.name}`;
      // Global, not per-subject: the bridges resolve an incoming string against
      // every subject, so subjects sharing a wire name would make which one
      // answers depend on resolution order.
      if (seenWire.has(wire)) {
        throw new Error(`Duplicate channel wire name ${wire}`);
      }
      seenWire.add(wire);

      const args = method.args ?? [];
      const seenArg = new Set<string>();
      for (const arg of args) {
        if (!CHANNEL_ARG_NAME_PATTERN.test(arg.name ?? "")) {
          throw new Error(
            `channel argument "${arg.name}" on ${wire} must be lowerCamelCase`,
          );
        }
        if (seenArg.has(arg.name)) {
          throw new Error(`Duplicate argument ${arg.name} on ${wire}`);
        }
        seenArg.add(arg.name);
        if (arg.type !== "string" && arg.type !== "bool") {
          throw new Error(
            `channel argument ${arg.name} on ${wire} has unsupported type "${arg.type}"`,
          );
        }
      }

      return {
        name: method.name,
        wire,
        returns: method.returns,
        args,
        doc: method.doc,
        swiftCase: SWIFT_RESERVED_WORDS.has(method.name)
          ? `\`${method.name}\``
          : method.name,
        kotlinCase: screamingSnakeFromCamel(method.name),
        dartConstant: `${subject.name}${capitalize(method.name)}`,
      };
    });

    const typePrefix = capitalize(subject.name);
    return {
      name: subject.name,
      prefix: subject.prefix,
      doc: subject.doc,
      methods,
      swiftEnum: `LocalSQLite${typePrefix}Method`,
      kotlinEnum: `LocalSQLite${typePrefix}Method`,
      swiftPrefixConstant: `${subject.name}MethodPrefix`,
    };
  });

  return {
    name: raw.name,
    doc: raw.doc,
    subjects,
    allMethods: subjects.flatMap((subject) => subject.methods),
  };
}

// Wraps prose to a comment block at the given indent. The spec's doc strings are
// single paragraphs, so this is the only formatting they need.
function channelDocComment(
  doc: string | undefined,
  indent: string,
  limit: number,
): string {
  if (doc === undefined || doc.length === 0) {
    return "";
  }
  const lines: string[] = [];
  let current = "";
  for (const word of doc.split(/\s+/)) {
    const candidate = current.length === 0 ? word : `${current} ${word}`;
    if (`${indent}// ${candidate}`.length > limit && current.length > 0) {
      lines.push(`${indent}// ${current}`);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current.length > 0) {
    lines.push(`${indent}// ${current}`);
  }
  return `${lines.join("\n")}\n`;
}

function renderSwiftChannel(channel: NormalizedChannel): string {
  const enums = channel.subjects
    .map((subject) => {
      const cases = subject.methods
        .map(
          (method) =>
            `${channelDocComment(method.doc, "  ", SWIFT_LINE_LIMIT)}  case ${method.swiftCase} = "${method.wire}"`,
        )
        .join("\n");
      return `${channelDocComment(subject.doc, "", SWIFT_LINE_LIMIT)}enum ${subject.swiftEnum}: String, CaseIterable {
${cases}

  static let methodPrefix = "${subject.prefix}"
}`;
    })
    .join("\n\n");

  const routerCases = channel.subjects
    .map((subject) => `  case ${subject.name}(${subject.swiftEnum})`)
    .join("\n");
  const routerWire = channel.subjects
    .map(
      (subject) =>
        `    case .${subject.name}(let method): return method.rawValue`,
    )
    .join("\n");
  const routerInit = channel.subjects
    .map(
      (
        subject,
      ) => `    if let method = ${subject.swiftEnum}(rawValue: rawValue) {
      self = .${subject.name}(method)
      return
    }`,
    )
    .join("\n");

  return `// The channel's method set, one enum per subject.
//
// A bridge switching over one of these WITHOUT a default arm is what makes a
// missing route a compile error instead of a runtime notImplemented, and what
// makes a method handled under the wrong subject a type error rather than a
// crash. Do not add a default arm to recover a "cannot happen" case: the whole
// point is that the compiler proves it cannot.
${enums}

// Resolves an incoming channel method to its subject, or nil when the name is not
// ours. This single lookup is the whole entry check, with no prefix test or admission
// set kept by hand beside it - a name that resolves is by construction one the
// generated enums carry.
enum LocalSQLiteChannelMethod {
${routerCases}

  static let channelName = "${channel.name}"

  // The wire name, for diagnostics and error payloads. The bridges resolve the
  // enum once at the boundary and carry it from there, so this is the only place
  // the string comes back.
  var wire: String {
    switch self {
${routerWire}
    }
  }

  init?(rawValue: String) {
${routerInit}
    return nil
  }
}`;
}

function renderKotlinChannel(channel: NormalizedChannel): string {
  const enums = channel.subjects
    .map((subject) => {
      const cases = subject.methods
        .map(
          (method) =>
            `${channelDocComment(method.doc, "    ", KOTLIN_LINE_LIMIT)}    ${method.kotlinCase}("${method.wire}"),`,
        )
        .join("\n");
      return `${channelDocComment(subject.doc, "", KOTLIN_LINE_LIMIT)}enum class ${subject.kotlinEnum}(val wire: String) {
${cases}
    ;

    companion object {
        const val METHOD_PREFIX = "${subject.prefix}"

        private val BY_WIRE: Map<String, ${subject.kotlinEnum}> = entries.associateBy { it.wire }

        fun fromWire(wire: String): ${subject.kotlinEnum}? = BY_WIRE[wire]
    }
}`;
    })
    .join("\n\n");

  const routerMembers = channel.subjects
    .map(
      (subject) =>
        `    @JvmInline
    value class ${capitalize(subject.name)}(val method: ${subject.kotlinEnum}) : LocalSQLiteChannelMethod {
        override val wire: String get() = method.wire
    }`,
    )
    .join("\n\n");
  const routerLookup = channel.subjects
    .map(
      (subject) =>
        `            ${subject.kotlinEnum}.fromWire(wire)?.let { return ${capitalize(subject.name)}(it) }`,
    )
    .join("\n");

  return `// The channel's method set, one enum per subject.
//
// A bridge branching over one of these in an EXHAUSTIVE when - one used as an
// expression, with no else arm - is what makes a missing route a compile error
// instead of a runtime notImplemented, and what makes a method handled under the
// wrong subject a type error. Do not add an else arm to recover a "cannot happen"
// case: the whole point is that the compiler proves it cannot.
${enums}

// Resolves an incoming channel method to its subject, or null when the name is not
// ours. This single lookup is the whole entry check, with no prefix test kept by hand
// beside it - a name that resolves is by construction one the generated enums carry.
sealed interface LocalSQLiteChannelMethod {
    // The wire name, for diagnostics and error payloads. The bridge resolves the
    // sealed type once at the boundary and carries it from there, so this is the
    // only place the string comes back.
    val wire: String

${routerMembers}

    companion object {
        const val CHANNEL_NAME = "${channel.name}"

        fun fromWire(wire: String): LocalSQLiteChannelMethod? {
${routerLookup}
            return null
        }
    }
}`;
}

function renderDartChannel(channel: NormalizedChannel, notice: string): string {
  const constants = channel.subjects
    .map((subject) => {
      const entries = subject.methods
        .map((method) => {
          // dart format keeps the declaration on one line where it fits and wraps
          // to a six-space continuation where it does not. Emitting its choice
          // rather than always wrapping is what keeps the output format-clean,
          // which a consumer's format check requires of a file it regenerates.
          const single = `  static const String ${method.dartConstant} = '${method.wire}';`;
          const body =
            single.length <= DART_LINE_LIMIT
              ? single
              : `  static const String ${method.dartConstant} =\n      '${method.wire}';`;
          return `${channelDocComment(method.doc, "  ", DART_LINE_LIMIT)}${body}`;
        })
        .join("\n");
      return `${channelDocComment(subject.doc, "  ", DART_LINE_LIMIT)}${entries}`;
    })
    .join("\n\n");

  return `${notice}

/// Every method name the Dart boundary may send over the local-SQLite method
/// channel, generated from the declaration shared by the Swift and Kotlin bridges.
///
/// The boundary passes these constants rather than string literals, which is what
/// keeps it from sending a name no bridge answers: a name that is not here does
/// not compile on the Dart side, and a name that is here is carried by the
/// bridges' generated enums.
class LocalSQLiteChannelMethods {
  const LocalSQLiteChannelMethods._();

  /// The platform channel these methods are sent over.
  static const String channelName = '${channel.name}';

${constants}
}
`;
}

interface LocalSQLiteChannelOutputs {
  kotlin: string;
  swift: string;
  dart: string;
}

export function renderLocalSQLiteChannel(
  channel: NormalizedChannel,
  generatedFileNotice: string,
): LocalSQLiteChannelOutputs {
  return {
    kotlin: renderKotlinChannel(channel),
    swift: renderSwiftChannel(channel),
    dart: renderDartChannel(channel, generatedFileNotice),
  };
}
