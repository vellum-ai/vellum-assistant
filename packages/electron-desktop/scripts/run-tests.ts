import { runIsolatedTests } from "../../../scripts/run-isolated-tests";

await runIsolatedTests({
  cwd: import.meta.dir + "/..",
  patterns: ["src/**/*.test.ts"],
});
