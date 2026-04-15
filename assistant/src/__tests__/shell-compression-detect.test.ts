import { describe, expect, test } from "bun:test";

import { detectCommand } from "../tools/shared/shell-compression/detect-command.js";

describe("detectCommand", () => {
  // ── Test runners ──────────────────────────────────────────────

  test("pytest -v -> test-runner", () => {
    expect(detectCommand("pytest -v").category).toBe("test-runner");
  });

  test("python -m pytest -> test-runner", () => {
    expect(detectCommand("python -m pytest tests/").category).toBe(
      "test-runner",
    );
  });

  test("cargo test -> test-runner", () => {
    expect(detectCommand("cargo test --release").category).toBe("test-runner");
  });

  test("jest -> test-runner", () => {
    expect(detectCommand("jest --coverage").category).toBe("test-runner");
  });

  test("vitest -> test-runner", () => {
    expect(detectCommand("vitest run").category).toBe("test-runner");
  });

  test("npx jest -> test-runner", () => {
    expect(detectCommand("npx jest src/").category).toBe("test-runner");
  });

  test("npx vitest -> test-runner", () => {
    expect(detectCommand("npx vitest").category).toBe("test-runner");
  });

  test("go test -> test-runner", () => {
    expect(detectCommand("go test ./...").category).toBe("test-runner");
  });

  test("bun test -> test-runner", () => {
    expect(detectCommand("bun test src/foo.test.ts").category).toBe(
      "test-runner",
    );
  });

  test("rspec -> test-runner", () => {
    expect(detectCommand("rspec spec/models/").category).toBe("test-runner");
  });

  test("playwright -> test-runner", () => {
    expect(detectCommand("playwright test").category).toBe("test-runner");
  });

  // ── git diff / git show ───────────────────────────────────────

  test("git diff HEAD~1 -> git-diff", () => {
    expect(detectCommand("git diff HEAD~1").category).toBe("git-diff");
  });

  test("git diff --staged -> git-diff", () => {
    expect(detectCommand("git diff --staged").category).toBe("git-diff");
  });

  test("git show abc123 -> git-diff", () => {
    expect(detectCommand("git show abc123").category).toBe("git-diff");
  });

  // ── git status ────────────────────────────────────────────────

  test("git status -> git-status", () => {
    expect(detectCommand("git status").category).toBe("git-status");
  });

  test("git status --short -> git-status", () => {
    expect(detectCommand("git status --short").category).toBe("git-status");
  });

  // ── Directory listing ─────────────────────────────────────────

  test("ls -la src/ -> directory-listing", () => {
    expect(detectCommand("ls -la src/").category).toBe("directory-listing");
  });

  test("find . -name '*.ts' -> directory-listing", () => {
    expect(detectCommand("find . -name '*.ts'").category).toBe(
      "directory-listing",
    );
  });

  test("tree src/ -> directory-listing", () => {
    expect(detectCommand("tree src/").category).toBe("directory-listing");
  });

  test("ls after pipe should NOT be directory-listing", () => {
    expect(detectCommand("cat file.txt | ls").category).not.toBe(
      "directory-listing",
    );
  });

  // ── Search results ────────────────────────────────────────────

  test("grep -r 'foo' -> search-results", () => {
    expect(detectCommand("grep -r 'foo' src/").category).toBe("search-results");
  });

  test("rg pattern -> search-results", () => {
    expect(detectCommand("rg 'TODO' --type ts").category).toBe(
      "search-results",
    );
  });

  test("ag pattern -> search-results", () => {
    expect(detectCommand("ag 'fixme'").category).toBe("search-results");
  });

  // ── Build / lint ──────────────────────────────────────────────

  test("tsc --noEmit -> build-lint", () => {
    expect(detectCommand("tsc --noEmit").category).toBe("build-lint");
  });

  test("eslint src/ -> build-lint", () => {
    expect(detectCommand("eslint src/").category).toBe("build-lint");
  });

  test("cargo build -> build-lint", () => {
    expect(detectCommand("cargo build").category).toBe("build-lint");
  });

  test("cargo check -> build-lint", () => {
    expect(detectCommand("cargo check").category).toBe("build-lint");
  });

  test("cargo clippy -> build-lint", () => {
    expect(detectCommand("cargo clippy").category).toBe("build-lint");
  });

  test("npm run build -> build-lint", () => {
    expect(detectCommand("npm run build").category).toBe("build-lint");
  });

  test("npm run lint -> build-lint", () => {
    expect(detectCommand("npm run lint").category).toBe("build-lint");
  });

  test("ruff check . -> build-lint", () => {
    expect(detectCommand("ruff check .").category).toBe("build-lint");
  });

  // ── Command chains (cd foo &&) ────────────────────────────────

  test("cd /app && cargo test -> test-runner", () => {
    expect(detectCommand("cd /app && cargo test").category).toBe("test-runner");
  });

  test("cd src && cd lib && jest -> test-runner", () => {
    expect(detectCommand("cd src && cd lib && jest").category).toBe(
      "test-runner",
    );
  });

  // ── Env var prefixes ──────────────────────────────────────────

  test("CI=1 jest --coverage -> test-runner", () => {
    expect(detectCommand("CI=1 jest --coverage").category).toBe("test-runner");
  });

  test("NODE_ENV=test npx vitest -> test-runner", () => {
    expect(detectCommand("NODE_ENV=test npx vitest").category).toBe(
      "test-runner",
    );
  });

  // ── sudo ──────────────────────────────────────────────────────

  test("sudo cargo test -> test-runner", () => {
    expect(detectCommand("sudo cargo test").category).toBe("test-runner");
  });

  // ── Pipes ─────────────────────────────────────────────────────

  test("git diff | head -50 -> git-diff", () => {
    expect(detectCommand("git diff | head -50").category).toBe("git-diff");
  });

  test("pytest | tee output.log -> test-runner", () => {
    expect(detectCommand("pytest | tee output.log").category).toBe(
      "test-runner",
    );
  });

  // ── Unknown commands ──────────────────────────────────────────

  test("docker ps -> unknown", () => {
    expect(detectCommand("docker ps").category).toBe("unknown");
  });

  test("curl https://example.com -> unknown", () => {
    expect(detectCommand("curl https://example.com").category).toBe("unknown");
  });

  test("echo hello -> unknown", () => {
    expect(detectCommand("echo hello").category).toBe("unknown");
  });

  // ── Empty / whitespace ────────────────────────────────────────

  test("empty string -> unknown", () => {
    const result = detectCommand("");
    expect(result.category).toBe("unknown");
    expect(result.commandName).toBe("");
  });

  test("whitespace only -> unknown", () => {
    const result = detectCommand("   ");
    expect(result.category).toBe("unknown");
    expect(result.commandName).toBe("");
  });

  // ── ANSI escape codes ─────────────────────────────────────────

  test("command with ANSI codes -> correctly classified", () => {
    expect(detectCommand("\x1B[32mpytest\x1B[0m -v").category).toBe(
      "test-runner",
    );
  });

  // ── commandName field ─────────────────────────────────────────

  test("returns commandName for matched commands", () => {
    expect(detectCommand("cargo test --release").commandName).toBe(
      "cargo test",
    );
  });

  test("returns empty commandName for unknown", () => {
    expect(detectCommand("docker ps").commandName).toBe("");
  });
});
