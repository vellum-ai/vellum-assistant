import tsParser from "@typescript-eslint/parser";
import { RuleTester } from "eslint";

import rule from "../typed-mock-module.js";

const tester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: "module",
    parser: tsParser,
  },
});

tester.run("mock/typed-module", rule, {
  valid: [
    // Factory return with satisfies — arrow expression body
    {
      code: `
        mock.module("../foo.js", () => ({
          bar: () => 42,
        } satisfies Partial<typeof import("../foo.js")>));
      `,
    },
    // Factory return with satisfies — block body
    {
      code: `
        mock.module("../foo.js", () => {
          return { bar: () => 42 } satisfies Partial<typeof import("../foo.js")>;
        });
      `,
    },
    // Factory delegates to a helper function (not an object literal)
    {
      code: `
        mock.module("../foo.js", () => createMock());
      `,
    },
    // Factory returns an identifier (not an object literal)
    {
      code: `
        const mockExports = { bar: () => 42 };
        mock.module("../foo.js", () => mockExports);
      `,
    },
    // mock.module with no factory (single arg) — skip
    {
      code: `
        mock.module("../foo.js");
      `,
    },
    // Not mock.module — different object
    {
      code: `
        other.module("../foo.js", () => ({ bar: 1 }));
      `,
    },
    // Not mock.module — different method
    {
      code: `
        mock.fn("../foo.js", () => ({ bar: 1 }));
      `,
    },
    // Spread of real module with satisfies
    {
      code: `
        mock.module("../foo.js", () => ({
          ...realModule,
          bar: () => 42,
        } satisfies Partial<typeof import("../foo.js")>));
      `,
    },
    // Template literal path (non-string-literal) — skip
    {
      code: `
        mock.module(\`../\${dir}/foo.js\`, () => ({ bar: 1 }));
      `,
    },
    // Factory is not a function expression — skip
    {
      code: `
        mock.module("../foo.js", factoryFn);
      `,
    },
  ],
  invalid: [
    // Bare object literal — arrow expression body
    {
      code: `
        mock.module("../daemon/process-message.js", () => ({
          processMessage: async () => ({ messageId: "msg-1" }),
        }));
      `,
      errors: [
        {
          messageId: "untypedMockModule",
          data: { path: "../daemon/process-message.js" },
        },
      ],
    },
    // Bare object literal — block body with return
    {
      code: `
        mock.module("../foo.js", () => {
          return {
            bar: () => 42,
          };
        });
      `,
      errors: [
        {
          messageId: "untypedMockModule",
          data: { path: "../foo.js" },
        },
      ],
    },
    // Regular function expression
    {
      code: `
        mock.module("../foo.js", function() {
          return { bar: () => 42 };
        });
      `,
      errors: [
        {
          messageId: "untypedMockModule",
          data: { path: "../foo.js" },
        },
      ],
    },
    // Spread of real module without satisfies
    {
      code: `
        mock.module("../foo.js", () => ({
          ...realModule,
          bar: () => 42,
        }));
      `,
      errors: [
        {
          messageId: "untypedMockModule",
          data: { path: "../foo.js" },
        },
      ],
    },
  ],
});
