/**
 * Root-level test preload — prevents accidental `bun test` from the repo root.
 *
 * Each package (assistant/, gateway/, cli/) has its own test configuration
 * including isolation preloads that redirect state directories to temp dirs.
 * Running `bun test` from the repo root skips those package-level preloads,
 * which can cause tests to read/write production data (databases, credentials,
 * contacts, etc.).
 *
 * This preload is registered in the root bunfig.toml and will throw immediately
 * if bun test is invoked from the repo root, directing the developer to cd into
 * the correct package directory first.
 */

throw new Error(
  [
    "Do not run `bun test` from the repo root.",
    "Each package has its own test isolation preload that protects production state.",
    "Run tests from the correct package directory instead:",
    "",
    "  cd assistant && bun test src/path/to/file.test.ts",
    "  cd gateway   && bun test src/path/to/file.test.ts",
    "  cd cli       && bun test src/path/to/file.test.ts",
  ].join("\n"),
);
