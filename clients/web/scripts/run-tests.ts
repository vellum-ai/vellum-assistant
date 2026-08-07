import { runIsolatedTests } from "../../../scripts/run-isolated-tests";

await runIsolatedTests({
  cwd: import.meta.dir + "/..",
  patterns: [
    "src/**/*.test.{ts,tsx}",
    // The custom ESLint rules in `eslint-rules/` gate real conventions
    // (cross-domain imports, untranslated copy), so their RuleTester suites
    // belong in CI alongside the app's own tests.
    "eslint-rules/**/*.test.mjs",
  ],
});
