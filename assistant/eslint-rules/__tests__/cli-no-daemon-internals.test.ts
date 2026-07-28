import tsParser from "@typescript-eslint/parser";
import { RuleTester } from "eslint";

import rule from "../cli-no-daemon-internals.js";

const tester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: "module",
    parser: tsParser,
  },
});

// A command file two levels under src/cli (src/cli/commands/<file>.ts) and a
// nested one (src/cli/commands/oauth/<file>.ts) — the rule anchors `src/` off
// the `.../src/cli/` prefix, so a realistic absolute filename is required.
const FILE = "/repo/assistant/src/cli/commands/example.ts";
const NESTED = "/repo/assistant/src/cli/commands/oauth/example.ts";

tester.run("cli/no-daemon-internals", rule, {
  valid: [
    // Node/npm/scoped packages are always hoistable.
    {
      filename: FILE,
      code: `
        import { writeFileSync } from "node:fs";
        import { Command } from "commander";
        import { something } from "@vellumai/service-contracts";
      `,
    },
    // The IPC client and socket path (src/ipc) are shared leaf transport.
    {
      filename: FILE,
      code: `import { cliIpcCall } from "../../ipc/cli-client.js";`,
    },
    {
      filename: FILE,
      code: `import { getAssistantSocketPath } from "../../ipc/socket-path.js";`,
    },
    // The CLI's own tree (../logger, ../output, ../lib, sibling files).
    {
      filename: FILE,
      code: `
        import { log } from "../logger.js";
        import { writeOutput } from "../output.js";
        import { registerCommand } from "../lib/register-command.js";
        import { helper } from "./sibling.js";
      `,
    },
    // Shared leaf zones: util/, version.
    {
      filename: FILE,
      code: `
        import { getWorkspaceDir } from "../../util/platform.js";
        import { readStdinSync } from "../../util/read-stdin.js";
        import { APP_VERSION } from "../../version.js";
      `,
    },
    // Nested command file reaching the same leaf zones one level deeper.
    {
      filename: NESTED,
      code: `
        import { cliIpcCall } from "../../../ipc/cli-client.js";
        import { isWeakOpenModel } from "../../../util/weak-open-model.js";
      `,
    },
    // Type-only imports from daemon internals are erased — always fine.
    {
      filename: FILE,
      code: `import type { ComparisonReport } from "../../runtime/harness/runner.js";`,
    },
    // Inline all-type import from a daemon module is also erased.
    {
      filename: FILE,
      code: `import { type RepairContext } from "../../daemon/repair.js";`,
    },
    // Dynamic import() of a daemon module is the encouraged pattern — the rule
    // only inspects static ImportDeclarations, so this must not be flagged.
    {
      filename: FILE,
      code: `
        async function run() {
          const { doTheThing } = await import("../../runtime/foo.js");
          await doTheThing();
        }
      `,
    },
  ],
  invalid: [
    // Hoisting a daemon runtime module.
    {
      filename: FILE,
      code: `import { doTheThing } from "../../runtime/foo.js";`,
      errors: [{ messageId: "hoistedDaemonImport" }],
    },
    // Hoisting the persistence schema.
    {
      filename: FILE,
      code: `import { conversations } from "../../persistence/schema/conversations.js";`,
      errors: [{ messageId: "hoistedDaemonImport" }],
    },
    // Hoisting the platform client.
    {
      filename: NESTED,
      code: `import { VellumPlatformClient } from "../../../platform/client.js";`,
      errors: [{ messageId: "hoistedDaemonImport" }],
    },
    // A non-leaf module under providers/ is daemon-internal (only util/ etc.
    // are exempt, not providers/).
    {
      filename: FILE,
      code: `import { resolveProvider } from "../../providers/registry.js";`,
      errors: [{ messageId: "hoistedDaemonImport" }],
    },
    // Value import mixed with a type specifier still counts (not all-type).
    {
      filename: FILE,
      code: `import { run, type Opts } from "../../security/keys.js";`,
      errors: [{ messageId: "hoistedDaemonImport" }],
    },
  ],
});
