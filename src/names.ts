// The identifier spelling every emitted name is derived with.

// snake_case -> camelCase. The class after `_` includes DIGITS, not just letters,
// because a name segment can begin with one (`over_1s` -> `over1s`): matching letters
// alone leaves the underscore in place, and an identifier carrying one is a Swift
// `identifier_name` lint failure rather than a cosmetic slip. Uppercasing a digit is the
// identity, so widening the class changes nothing for a segment that starts with a letter.
export function toCamelCase(name: string): string {
  return name.replace(/_([a-z0-9])/g, (_, c) => c.toUpperCase());
}
