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

tester.run("cli/no-daemon-internals", rule, {
  valid: [
    // ipc-tagged file importing only allowed sources
    {
      code: `
        import type { Command } from "commander";
        import { cliIpcCall } from "../../ipc/cli-client.js";
        import { log } from "../logger.js";
        import { printTable } from "../output.js";

        registerCommand(program, {
          name: "example",
          transport: "ipc",
          build: () => {},
        });
      `,
    },
    // local-tagged file importing allowed sources
    {
      code: `
        import type { Command } from "commander";
        import { loadRawConfig } from "../../config/loader.js";
        import { getWorkspaceDir } from "../../util/platform.js";

        registerCommand(program, {
          name: "local-example",
          transport: "local",
          build: () => {},
        });
      `,
    },
    // bootstrap-tagged file importing allowed sources
    {
      code: `
        import type { Command } from "commander";
        import { AssistantConfigSchema } from "../../config/schema.js";

        registerCommand(program, {
          name: "bootstrap-example",
          transport: "bootstrap",
          build: () => {},
        });
      `,
    },
    // ipc-tagged file importing from ../lib/ prefix (shared lib)
    {
      code: `
        import type { Command } from "commander";
        import { cliIpcCall } from "../../ipc/cli-client.js";
        import { readFileSync } from "../lib/daemon-credential-client.js";

        registerCommand(program, {
          name: "lib-example",
          transport: "ipc",
          build: () => {},
        });
      `,
    },
    // File with zero imports and no registerCommand — utility file
    {
      code: `
        function utilHelper() {
          return 42;
        }
        export { utilHelper };
      `,
    },
    // Helper module — has imports but does not call registerCommand directly.
    // Helper modules under commands/ (e.g. oauth/shared.ts, lib/cache-fs.ts)
    // are not command entries and the rule must not fire on them, even when
    // they import from outside the registrar allowlists.
    {
      code: `
        import type { Command } from "commander";
        import { getProvider } from "../../../oauth/oauth-store.js";

        export function buildAuthFlow(program) {
          // helper module — no registerCommand call here; the actual
          // command file imports this and calls registerCommand itself.
        }
      `,
    },
    // local-tagged file importing ../logger and ../output — both must be on
    // the local allowlist (regression test for the allowlist gap that
    // false-positived autonomy/config/completions/keys/credential-execution).
    {
      code: `
        import type { Command } from "commander";
        import { log } from "../logger.js";
        import { writeOutput } from "../output.js";

        registerCommand(program, {
          name: "local-with-output",
          transport: "local",
          build: () => {},
        });
      `,
    },
    // Type-only imports are erased at compile time and must not count as
    // runtime boundary violations, even when the source path is outside the
    // allowlist (e.g. `import type` from runtime/routes for response shapes).
    {
      code: `
        import type { Command } from "commander";
        import { cliIpcCall } from "../../ipc/cli-client.js";
        import type { MemoryV2Result } from "../../runtime/routes/memory-v2-routes.js";

        registerCommand(program, {
          name: "ipc-with-type-import",
          transport: "ipc",
          build: () => {},
        });
      `,
    },
    // Inline `import { type X }` form: importKind is set per specifier,
    // not on the declaration. When every specifier is type-only the import
    // is erased and must not flag a forbidden-runtime-import violation.
    {
      code: `
        import type { Command } from "commander";
        import { cliIpcCall } from "../../ipc/cli-client.js";
        import { type MemoryV2Result, type ScoreBreakdown } from "../../runtime/routes/memory-v2-routes.js";

        registerCommand(program, {
          name: "ipc-with-inline-type-import",
          transport: "ipc",
          build: () => {},
        });
      `,
    },
    // Chained registerCommand pattern: `registerCommand(...).command(...)`.
    // The outer call's callee is a MemberExpression whose object is the
    // inner registerCommand call. The AST walker must follow callee +
    // MemberExpression.object so findTransport() locates the registerCommand
    // call and applies the correct transport allowlist.
    {
      code: `
        import type { Command } from "commander";
        import { cliIpcCall } from "../../ipc/cli-client.js";

        registerCommand(program, {
          name: "ipc-chained",
          transport: "ipc",
          build: () => {},
        }).command("subcmd").description("desc");
      `,
    },
    // Sibling subcommand composition: an index file (e.g. oauth/index.ts)
    // imports sibling subcommand files (./connect.js, ./disconnect.js) to
    // attach them under a parent group. The imported file is itself a
    // command and the rule checks its imports independently, so this can't
    // smuggle daemon internals.
    {
      code: `
        import type { Command } from "commander";
        import { registerCommand } from "../../lib/register-command.js";
        import { setupConnect } from "./connect.js";
        import { setupDisconnect } from "./disconnect.js";

        registerCommand(program, {
          name: "ipc-index-composition",
          transport: "ipc",
          build: () => {},
        });
      `,
    },
    // Nested command file (commands/oauth/foo.ts) needs deeper relative
    // paths to the IPC client, lib/, logger, and output. Without the
    // depth-2 entries the rule would false-positive on every nested
    // command (oauth/*, platform/*).
    {
      code: `
        import type { Command } from "commander";
        import { cliIpcCall } from "../../../ipc/cli-client.js";
        import { registerCommand } from "../../lib/register-command.js";
        import { log } from "../../logger.js";
        import { writeOutput } from "../../output.js";

        registerCommand(program, {
          name: "ipc-nested",
          transport: "ipc",
          build: () => {},
        });
      `,
    },
    // Shared CLI utils (src/cli/utils/*) — sibling utility directory used
    // by task/ui/conversations-defer for ID resolution and parsing. Lives
    // alongside lib/ but historically wasn't on the allowlist.
    {
      code: `
        import type { Command } from "commander";
        import { cliIpcCall } from "../../ipc/cli-client.js";
        import { resolveConversationId } from "../utils/conversation-id.js";
        import { parseDuration } from "../utils/parse-duration.js";

        registerCommand(program, {
          name: "ipc-with-utils",
          transport: "ipc",
          build: () => {},
        });
      `,
    },
    // status.ts pattern: when the daemon is unreachable, the command falls
    // back to a local socket-path probe + platform helpers. Both imports
    // are part of the documented daemon-down fallback contract (§3.7).
    {
      code: `
        import type { Command } from "commander";
        import { cliIpcCall } from "../../ipc/cli-client.js";
        import { getSocketPath } from "../../ipc/socket-path.js";
        import { getWorkspaceDir } from "../../util/platform.js";

        registerCommand(program, {
          name: "ipc-status",
          transport: "ipc",
          build: () => {},
        });
      `,
    },
    // local-tagged keys.ts pattern: the secure-key helpers are designed to
    // run in-process (not over IPC), so direct security/* imports are part
    // of the contract.
    {
      code: `
        import type { Command } from "commander";
        import { credentialKey } from "../../security/credential-key.js";
        import { getSecureKeyAsync } from "../../security/secure-keys.js";

        registerCommand(program, {
          name: "local-keys",
          transport: "local",
          build: () => {},
        });
      `,
    },
    // local-tagged credential-execution.ts pattern: speaks to the CES
    // sidecar via service-contracts RPC; the daemon is not involved.
    {
      code: `
        import type { Command } from "commander";
        import { credentialRpc } from "@vellumai/service-contracts/credential-rpc";
        import { connect } from "../../credential-execution/client.js";

        registerCommand(program, {
          name: "local-ces",
          transport: "local",
          build: () => {},
        });
      `,
    },
    // local-tagged config.ts uses zod for schema validation and reaches
    // across to oauth/shared.ts for the managed-mode platform-connection
    // check (documented cross-namespace helper).
    {
      code: `
        import type { Command } from "commander";
        import { z } from "zod";
        import { loadRawConfig } from "../../config/loader.js";
        import { requirePlatformConnection } from "./oauth/shared.js";

        registerCommand(program, {
          name: "local-config",
          transport: "local",
          build: () => {},
        });
      `,
    },
  ],

  invalid: [
    // registerCommand called without a string transport prop — the actual
    // missingTransport case (command-entry file forgot to declare its class).
    {
      code: `
        import type { Command } from "commander";
        import { cliIpcCall } from "../../ipc/cli-client.js";

        registerCommand(program, {
          name: "no-transport",
          build: () => {},
        });
      `,
      errors: [
        {
          messageId: "missingTransport",
        },
      ],
    },
    // ipc-tagged file importing a forbidden runtime route
    {
      code: `
        import type { Command } from "commander";
        import { cliIpcCall } from "../../ipc/cli-client.js";
        import { healthRoutes } from "../../runtime/routes/health-routes.js";

        registerCommand(program, {
          name: "bad-ipc",
          transport: "ipc",
          build: () => {},
        });
      `,
      errors: [
        {
          messageId: "forbiddenImport",
          data: {
            transport: "ipc",
            source: "../../runtime/routes/health-routes.js",
          },
        },
      ],
    },
    // ipc-tagged file importing a skills catalog module
    {
      code: `
        import type { Command } from "commander";
        import { cliIpcCall } from "../../ipc/cli-client.js";
        import { SkillsCatalog } from "../../skills/catalog.js";

        registerCommand(program, {
          name: "bad-ipc-skills",
          transport: "ipc",
          build: () => {},
        });
      `,
      errors: [
        {
          messageId: "forbiddenImport",
          data: {
            transport: "ipc",
            source: "../../skills/catalog.js",
          },
        },
      ],
    },
    // local-tagged file importing a forbidden runtime route
    {
      code: `
        import type { Command } from "commander";
        import { loadRawConfig } from "../../config/loader.js";
        import { healthRoutes } from "../../runtime/routes/health-routes.js";

        registerCommand(program, {
          name: "bad-local",
          transport: "local",
          build: () => {},
        });
      `,
      errors: [
        {
          messageId: "forbiddenImport",
          data: {
            transport: "local",
            source: "../../runtime/routes/health-routes.js",
          },
        },
      ],
    },
    // Nested command file (commands/oauth/foo.ts) STILL rejects runtime
    // route imports. Locking in the boundary so the depth-2 allowlist
    // additions don't accidentally open daemon-internal namespaces.
    {
      code: `
        import type { Command } from "commander";
        import { cliIpcCall } from "../../../ipc/cli-client.js";
        import { healthRoutes } from "../../../runtime/routes/health-routes.js";

        registerCommand(program, {
          name: "bad-ipc-nested",
          transport: "ipc",
          build: () => {},
        });
      `,
      errors: [
        {
          messageId: "forbiddenImport",
          data: {
            transport: "ipc",
            source: "../../../runtime/routes/health-routes.js",
          },
        },
      ],
    },
    // services/, agents/, llm/ namespaces remain forbidden for ipc commands.
    {
      code: `
        import type { Command } from "commander";
        import { cliIpcCall } from "../../ipc/cli-client.js";
        import { dispatchAgent } from "../../agents/dispatcher.js";

        registerCommand(program, {
          name: "bad-ipc-agents",
          transport: "ipc",
          build: () => {},
        });
      `,
      errors: [
        {
          messageId: "forbiddenImport",
          data: {
            transport: "ipc",
            source: "../../agents/dispatcher.js",
          },
        },
      ],
    },
  ],
});
