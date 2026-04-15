import { describe, expect, test } from "bun:test";

import { compressTestOutput } from "../tools/shared/shell-compression/compressors/test-runner.js";

// ── Pytest fixtures ────────────────────────────────────────────────

const PYTEST_ALL_PASS_VERBOSE = `
============================= test session starts ==============================
platform linux -- Python 3.12.0, pytest-8.0.0
collected 250 tests

tests/test_auth.py::test_login PASSED
tests/test_auth.py::test_logout PASSED
tests/test_auth.py::test_register PASSED
tests/test_auth.py::test_reset_password PASSED
tests/test_auth.py::test_change_email PASSED
${Array.from({ length: 245 }, (_, i) => `tests/test_suite.py::test_case_${i} PASSED`).join("\n")}

============================== 250 passed in 12.34s ==============================
`.trim();

const PYTEST_WITH_FAILURES = `
============================= test session starts ==============================
platform linux -- Python 3.12.0, pytest-8.0.0
collected 50 tests

tests/test_auth.py::test_login PASSED
tests/test_auth.py::test_logout PASSED
tests/test_auth.py::test_register PASSED
tests/test_db.py::test_migration PASSED

================================= FAILURES =================================
_________________________________ test_auth_login _________________________________

    def test_auth_login():
>       assert response.status_code == 200
E       AssertionError: expected 200 but got 401

tests/test_auth.py:42: AssertionError
_________________________________ test_db_migration _________________________________

    def test_db_migration():
>       db.connect()
E       ConnectionError: could not connect to database

tests/test_db.py:88: ConnectionError

=========================== short test summary info ============================
FAILED tests/test_auth.py::test_auth_login
FAILED tests/test_db.py::test_db_migration
============================== 47 passed, 2 failed, 1 skipped in 3.21s ==============================
`.trim();

// ── Jest fixtures ──────────────────────────────────────────────────

const JEST_ALL_PASS = `
PASS src/utils/math.test.ts
PASS src/utils/string.test.ts
PASS src/utils/array.test.ts
PASS src/components/Button.test.tsx
PASS src/components/Modal.test.tsx
PASS src/hooks/useAuth.test.ts
PASS src/hooks/useData.test.ts
${Array.from({ length: 100 }, (_, i) => `PASS src/tests/suite${i}.test.ts`).join("\n")}

Test Suites: 107 passed, 107 total
Tests:       342 passed, 342 total
Snapshots:   0 total
Time:        8.432 s
`.trim();

const JEST_WITH_FAILURES = `
PASS src/utils/math.test.ts
PASS src/utils/string.test.ts
FAIL src/components/Button.test.tsx
  ● Button › renders correctly

    expect(received).toBe(expected)

    Expected: "Submit"
    Received: "Cancel"

      12 |   render(<Button label="Submit" />);
      13 |   const btn = screen.getByRole('button');
    > 14 |   expect(btn.textContent).toBe("Submit");
         |                           ^
      15 | });

      at Object.<anonymous> (src/components/Button.test.tsx:14:27)

FAIL src/hooks/useAuth.test.ts
  ● useAuth › returns user after login

    TypeError: Cannot read properties of null (reading 'user')

      22 |   const { result } = renderHook(() => useAuth());
    > 23 |   expect(result.current.user).toBeDefined();
         |                         ^
      24 | });

      at Object.<anonymous> (src/hooks/useAuth.test.ts:23:25)

PASS src/hooks/useData.test.ts

Test Suites: 2 failed, 3 passed, 5 total
Tests:       2 failed, 18 passed, 20 total
Snapshots:   0 total
Time:        3.210 s
`.trim();

// ── Cargo test fixtures ────────────────────────────────────────────

const CARGO_ALL_PASS = `
running 200 tests
${Array.from({ length: 200 }, (_, i) => `test tests::test_case_${i} ... ok`).join("\n")}

test result: ok. 200 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 2.45s
`.trim();

const CARGO_WITH_FAILURES = `
running 10 tests
test tests::test_parse_valid ... ok
test tests::test_parse_invalid ... ok
test tests::test_serialize ... ok
test tests::test_auth_flow ... FAILED
test tests::test_db_conn ... FAILED
test tests::test_format ... ok
test tests::test_roundtrip ... ok
test tests::test_edge_case ... ok

failures:

---- tests::test_auth_flow stdout ----
thread 'tests::test_auth_flow' panicked at 'assertion failed: token.is_valid()'
note: run with \`RUST_BACKTRACE=1\` for a backtrace

---- tests::test_db_conn stdout ----
thread 'tests::test_db_conn' panicked at 'connection refused: Os { code: 111, kind: ConnectionRefused }'

failures:
    tests::test_auth_flow
    tests::test_db_conn

test result: FAILED. 8 passed; 2 failed; 0 ignored; 0 measured; 0 filtered out; finished in 1.23s
`.trim();

// ── Go test fixtures ───────────────────────────────────────────────

const GO_ALL_PASS = `
${Array.from({ length: 50 }, (_, i) => `--- PASS: TestCase${i} (0.00s)`).join("\n")}
ok  	github.com/example/pkg1	0.123s
ok  	github.com/example/pkg2	0.456s
ok  	github.com/example/pkg3	0.789s
`.trim();

const GO_WITH_FAILURES = `
--- PASS: TestAdd (0.00s)
--- PASS: TestSubtract (0.00s)
--- FAIL: TestDivide (0.01s)
    math_test.go:42: expected 2.5, got NaN
    math_test.go:43: division by zero not handled
--- PASS: TestMultiply (0.00s)
--- FAIL: TestModulo (0.00s)
    math_test.go:58: unexpected panic
FAIL	github.com/example/math	0.034s
ok  	github.com/example/util	0.012s
`.trim();

// ── Compilation error fixtures ─────────────────────────────────────

const RUST_COMPILATION_ERROR = `
error[E0308]: mismatched types
  --> src/main.rs:10:5
   |
10 |     let x: i32 = "hello";
   |                  ^^^^^^^ expected \`i32\`, found \`&str\`

error: aborting due to previous error
`.trim();

const JS_SYNTAX_ERROR = `
SyntaxError: Unexpected token '{' at src/index.ts:15:3
  at Module._compile (internal/modules/cjs/loader.js:723:23)
  at Object.Module._extensions..js (internal/modules/cjs/loader.js:789:10)
`.trim();

const JS_TYPE_ERROR = `
TypeError: Cannot read properties of undefined (reading 'map')
    at processData (src/utils.ts:42:15)
    at Object.<anonymous> (src/index.ts:10:1)
`.trim();

const MODULE_NOT_FOUND = `
Error: cannot find module '@/components/Button'
  Require stack:
  - /app/src/index.ts
`.trim();

// ── Tests ──────────────────────────────────────────────────────────

describe("compressTestOutput", () => {
  // ── Pytest ─────────────────────────────────────────────────────

  describe("pytest", () => {
    test("collapses all-pass output to summary count", () => {
      const result = compressTestOutput(PYTEST_ALL_PASS_VERBOSE, "", 0);
      expect(result).toContain("250 passed");
      // Should NOT contain individual PASSED lines
      expect(result).not.toContain("test_case_100 PASSED");
    });

    test("achieves >80% compression on all-pass suite", () => {
      const result = compressTestOutput(PYTEST_ALL_PASS_VERBOSE, "", 0);
      const ratio = 1 - result.length / PYTEST_ALL_PASS_VERBOSE.length;
      expect(ratio).toBeGreaterThan(0.8);
    });

    test("preserves failure details verbatim", () => {
      const result = compressTestOutput(PYTEST_WITH_FAILURES, "", 1);
      expect(result).toContain("AssertionError: expected 200 but got 401");
      expect(result).toContain(
        "ConnectionError: could not connect to database",
      );
      expect(result).toContain("test_auth_login");
      expect(result).toContain("test_db_migration");
    });

    test("preserves summary with passed/failed/skipped counts", () => {
      const result = compressTestOutput(PYTEST_WITH_FAILURES, "", 1);
      expect(result).toContain("47 passed");
      expect(result).toContain("2 failed");
      expect(result).toContain("1 skipped");
    });

    test("preserves stderr when exit code is non-zero", () => {
      const stderr =
        "WARNING: some deprecation notice\nERROR: critical failure";
      const result = compressTestOutput(PYTEST_WITH_FAILURES, stderr, 1);
      expect(result).toContain(stderr.trim());
    });
  });

  // ── Jest / Vitest ──────────────────────────────────────────────

  describe("jest/vitest", () => {
    test("collapses all-pass output to summary", () => {
      const result = compressTestOutput(JEST_ALL_PASS, "", 0);
      expect(result).toContain("107 passed");
      expect(result).toContain("342 passed");
      // Individual PASS lines should be collapsed
      expect(result).not.toContain("PASS src/tests/suite50.test.ts");
    });

    test("achieves >80% compression on all-pass suite", () => {
      const result = compressTestOutput(JEST_ALL_PASS, "", 0);
      const ratio = 1 - result.length / JEST_ALL_PASS.length;
      expect(ratio).toBeGreaterThan(0.8);
    });

    test("preserves FAIL blocks verbatim", () => {
      const result = compressTestOutput(JEST_WITH_FAILURES, "", 1);
      // Button test failure
      expect(result).toContain('Expected: "Submit"');
      expect(result).toContain('Received: "Cancel"');
      // useAuth test failure
      expect(result).toContain(
        "TypeError: Cannot read properties of null (reading 'user')",
      );
    });

    test("preserves summary lines", () => {
      const result = compressTestOutput(JEST_WITH_FAILURES, "", 1);
      expect(result).toContain("Test Suites: 2 failed, 3 passed, 5 total");
      expect(result).toContain("Tests:       2 failed, 18 passed, 20 total");
    });
  });

  // ── Cargo test ─────────────────────────────────────────────────

  describe("cargo test", () => {
    test("collapses all-pass output to summary", () => {
      const result = compressTestOutput(CARGO_ALL_PASS, "", 0);
      expect(result).toContain("200 passed");
      // Individual ok lines should be collapsed
      expect(result).not.toContain("test tests::test_case_100 ... ok");
    });

    test("achieves >80% compression on all-pass suite", () => {
      const result = compressTestOutput(CARGO_ALL_PASS, "", 0);
      const ratio = 1 - result.length / CARGO_ALL_PASS.length;
      expect(ratio).toBeGreaterThan(0.8);
    });

    test("preserves failure details verbatim", () => {
      const result = compressTestOutput(CARGO_WITH_FAILURES, "", 1);
      expect(result).toContain(
        "panicked at 'assertion failed: token.is_valid()'",
      );
      expect(result).toContain("connection refused");
      expect(result).toContain("tests::test_auth_flow");
      expect(result).toContain("tests::test_db_conn");
    });

    test("preserves test result summary", () => {
      const result = compressTestOutput(CARGO_WITH_FAILURES, "", 1);
      expect(result).toContain("test result: FAILED");
      expect(result).toContain("8 passed");
      expect(result).toContain("2 failed");
    });
  });

  // ── Go test ────────────────────────────────────────────────────

  describe("go test", () => {
    test("collapses passing tests to count", () => {
      const result = compressTestOutput(GO_ALL_PASS, "", 0);
      expect(result).toContain("50 passing tests collapsed");
      expect(result).not.toContain("--- PASS: TestCase25");
    });

    test("preserves FAIL block details", () => {
      const result = compressTestOutput(GO_WITH_FAILURES, "", 1);
      expect(result).toContain("--- FAIL: TestDivide");
      expect(result).toContain("expected 2.5, got NaN");
      expect(result).toContain("division by zero not handled");
      expect(result).toContain("--- FAIL: TestModulo");
      expect(result).toContain("unexpected panic");
    });

    test("preserves package summaries", () => {
      const result = compressTestOutput(GO_WITH_FAILURES, "", 1);
      expect(result).toContain("FAIL\tgithub.com/example/math");
      expect(result).toContain("ok  \tgithub.com/example/util");
    });
  });

  // ── Compilation errors ─────────────────────────────────────────

  describe("compilation errors", () => {
    test("passes through Rust compilation errors uncompressed", () => {
      const result = compressTestOutput(RUST_COMPILATION_ERROR, "", 1);
      expect(result).toBe(RUST_COMPILATION_ERROR);
    });

    test("passes through SyntaxError uncompressed", () => {
      const result = compressTestOutput(JS_SYNTAX_ERROR, "", 1);
      expect(result).toBe(JS_SYNTAX_ERROR);
    });

    test("passes through TypeError uncompressed", () => {
      const result = compressTestOutput(JS_TYPE_ERROR, "", 1);
      expect(result).toBe(JS_TYPE_ERROR);
    });

    test("passes through 'cannot find module' uncompressed", () => {
      const result = compressTestOutput(MODULE_NOT_FOUND, "", 1);
      expect(result).toBe(MODULE_NOT_FOUND);
    });

    test("passes through compilation errors in stderr", () => {
      const result = compressTestOutput("", RUST_COMPILATION_ERROR, 1);
      expect(result).toContain("error[E0308]");
    });
  });

  // ── Short output ───────────────────────────────────────────────

  describe("short output", () => {
    test("still compresses short output if pattern matches", () => {
      const shortPytest = `
tests/test_foo.py::test_one PASSED
tests/test_foo.py::test_two PASSED

============================== 2 passed in 0.01s ==============================
`.trim();
      const result = compressTestOutput(shortPytest, "", 0);
      // Should still produce compressed output (summary line)
      expect(result).toContain("2 passed");
      // Should not contain individual PASSED lines
      expect(result).not.toContain("test_one PASSED");
    });
  });

  // ── Verbose / non-verbose ──────────────────────────────────────

  describe("verbose and non-verbose output", () => {
    test("handles pytest non-verbose (dots) output", () => {
      const dotOutput = `
...........................................................
============================== 60 passed in 2.00s ==============================
`.trim();
      const result = compressTestOutput(dotOutput, "", 0);
      expect(result).toContain("60 passed");
    });

    test("handles pytest verbose (-v) output", () => {
      const result = compressTestOutput(PYTEST_ALL_PASS_VERBOSE, "", 0);
      expect(result).toContain("250 passed");
    });
  });

  // ── Error preservation ─────────────────────────────────────────

  describe("error preservation", () => {
    test("includes stderr when exit code is non-zero", () => {
      const stderr = "CRITICAL: database timeout after 30s";
      const result = compressTestOutput(PYTEST_ALL_PASS_VERBOSE, stderr, 1);
      expect(result).toContain(stderr);
    });

    test("does not include stderr section when exit code is 0", () => {
      const stderr = "some warning";
      const result = compressTestOutput(PYTEST_ALL_PASS_VERBOSE, stderr, 0);
      expect(result).not.toContain("--- stderr ---");
    });

    test("does not include stderr section when stderr is empty", () => {
      const result = compressTestOutput(PYTEST_WITH_FAILURES, "", 1);
      expect(result).not.toContain("--- stderr ---");
    });
  });
});
