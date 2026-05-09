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
  ],

  invalid: [
    // File with imports but no registerCommand call
    {
      code: `
        import type { Command } from "commander";
        import { cliIpcCall } from "../../ipc/cli-client.js";

        export function registerMyCommand(program) {
          // forgot to call registerCommand
        }
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
  ],
});
