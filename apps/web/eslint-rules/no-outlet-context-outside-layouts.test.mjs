/**
 * Unit tests for the no-outlet-context-outside-layouts ESLint rule.
 *
 * Run with: `bun test eslint-rules/no-outlet-context-outside-layouts.test.mjs`
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RuleTester } from "eslint";

import { noOutletContextOutsideLayouts } from "./no-outlet-context-outside-layouts.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(__dirname, "..");

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: "latest",
    sourceType: "module",
  },
});

const filePath = (...parts) => path.join(WEB_ROOT, "src", ...parts);

ruleTester.run(
  "no-outlet-context-outside-layouts",
  noOutletContextOutsideLayouts,
  {
    valid: [
      // Layout files may use useOutletContext().
      {
        filename: filePath("domains", "chat", "chat-layout.tsx"),
        code: `const ctx = useOutletContext();`,
      },
      {
        filename: filePath("root-layout.tsx"),
        code: `const ctx = useOutletContext();`,
      },
      // Non-useOutletContext code is unaffected anywhere.
      {
        filename: filePath("domains", "chat", "chat-page.tsx"),
        code: `const x = useState(0);`,
      },
      // Different function with similar name is fine.
      {
        filename: filePath("domains", "chat", "chat-page.tsx"),
        code: `const ctx = myOutletContext();`,
      },
    ],
    invalid: [
      // Non-layout file using useOutletContext is flagged.
      {
        filename: filePath("domains", "chat", "chat-page.tsx"),
        code: `const ctx = useOutletContext();`,
        errors: [{ messageId: "outsideLayout" }],
      },
      {
        filename: filePath("home-page-route.tsx"),
        code: `const ctx = useOutletContext();`,
        errors: [{ messageId: "outsideLayout" }],
      },
      // Member-expression form.
      {
        filename: filePath("domains", "chat", "chat-page.tsx"),
        code: `const ctx = ReactRouter.useOutletContext();`,
        errors: [{ messageId: "outsideLayout" }],
      },
    ],
  },
);
