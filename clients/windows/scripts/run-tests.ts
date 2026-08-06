import { runIsolatedTests } from "../../../scripts/run-isolated-tests";

await runIsolatedTests({
  cwd: import.meta.dir + "/..",
  patterns: ["src/**/*.test.ts", "scripts/**/*.test.ts"],
  extraFiles: [
    "../../packages/electron-utils/src/app-protocol.test.ts",
    "../../packages/electron-utils/src/auth-popup-session.test.ts",
  ],
});
