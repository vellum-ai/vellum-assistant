/**
 * Unit tests for the no-usereducer-for-client-state ESLint rule.
 *
 * Run with: `bun test eslint-rules/no-usereducer-for-client-state.test.mjs`
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RuleTester } from "eslint";

import { noUseReducerForClientState } from "./no-usereducer-for-client-state.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(__dirname, "..");

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: "latest",
    sourceType: "module",
  },
});

const filePath = (...parts) => path.join(WEB_ROOT, "src", ...parts);

ruleTester.run("no-usereducer-for-client-state", noUseReducerForClientState, {
  valid: [
    // Non-useReducer hooks are fine.
    {
      filename: filePath("domains", "chat", "chat-page.tsx"),
      code: `const [state, setState] = useState(0);`,
    },
    // Documented exception: terminal state lives in useReducer pending migration.
    {
      filename: filePath("domains", "terminal", "use-terminal-state.ts"),
      code: `const [state, dispatch] = useReducer(reducer, initial);`,
    },
    {
      filename: filePath("domains", "terminal", "use-terminal-session.ts"),
      code: `const [state, dispatch] = React.useReducer(reducer, initial);`,
    },
    // Different function with similar name is fine.
    {
      filename: filePath("domains", "chat", "chat-page.tsx"),
      code: `const x = myReducer(state, action);`,
    },
  ],
  invalid: [
    {
      filename: filePath("domains", "chat", "chat-page.tsx"),
      code: `const [state, dispatch] = useReducer(reducer, initial);`,
      errors: [{ messageId: "useReducer" }],
    },
    {
      filename: filePath("hooks", "use-something.ts"),
      code: `const [s, d] = React.useReducer(r, i);`,
      errors: [{ messageId: "useReducer" }],
    },
    // Even inside src/domains/terminal/, a non-state/session file shouldn't get a pass —
    // the exception is path-based on the `/domains/terminal/` fragment, so a sub-folder
    // file would still be exempt. (Documented; if that changes, narrow the exempt list.)
    // Stand-in: a file under domains/chat/ that imports the hook by name.
    {
      filename: filePath("domains", "chat", "chat-store.ts"),
      code: `import { useReducer } from "react"; const [s, d] = useReducer(r, i);`,
      errors: [{ messageId: "useReducer" }],
    },
  ],
});
