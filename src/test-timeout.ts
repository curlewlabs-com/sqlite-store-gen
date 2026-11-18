// The per-test backstop for this package's suites, which the test script hands
// to bun's --timeout.
//
// Bun's own default, 5 seconds, fails a healthy test on a host busy enough to
// starve it, and any ceiling sized off the healthy path only turns contention
// into a flake; a test that truly hangs still fails at this one.
const TEST_TIMEOUT_MS = 180_000;

// The test script reads the value by running this file, because a package
// script cannot import a constant. The flag, not a preloaded
// setDefaultTimeout, carries it: bun resets that default for each test file
// after the first.
if (import.meta.main) {
  process.stdout.write(String(TEST_TIMEOUT_MS));
}
