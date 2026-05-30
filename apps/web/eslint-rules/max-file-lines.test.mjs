/**
 * Unit tests for the max-file-lines ESLint rule.
 *
 * Run with: `bun test eslint-rules/max-file-lines.test.mjs`
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RuleTester } from "eslint";

import { maxFileLines } from "./max-file-lines.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = path.resolve(__dirname, "..");

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: "latest",
    sourceType: "module",
  },
});

const filePath = (...parts) => path.join(WEB_ROOT, "src", ...parts);

function lines(count) {
  // Each `const x = 1;` line is one line; join produces (count - 1)
  // newlines so the file has exactly `count` lines.
  return Array.from({ length: count }, (_, i) => `const x${i} = ${i};`).join(
    "\n",
  );
}

ruleTester.run("max-file-lines", maxFileLines, {
  valid: [
    // Short file is fine.
    {
      filename: filePath("domains", "chat", "chat-page.tsx"),
      code: lines(100),
    },
    // Exactly at the default limit (300) is allowed.
    {
      filename: filePath("domains", "chat", "chat-page.tsx"),
      code: lines(300),
    },
    // Generated files are exempt regardless of length.
    {
      filename: filePath("generated", "api", "sdk.gen.ts"),
      code: lines(5000),
    },
    // Catalog data files are exempt.
    {
      filename: filePath(
        "domains",
        "chat",
        "components",
        "chat-composer",
        "emoji-catalog-data.ts",
      ),
      code: lines(2000),
    },
    {
      filename: filePath("assistant", "llm-model-catalog.ts"),
      code: lines(800),
    },
    // Test files are exempt — tests are as long as the behavior they cover.
    {
      filename: filePath("assistant", "lifecycle-service.test.ts"),
      code: lines(700),
    },
    // Custom limit via options.
    {
      filename: filePath("domains", "chat", "chat-page.tsx"),
      code: lines(500),
      options: [{ limit: 1000 }],
    },
  ],
  invalid: [
    // One line over the default limit triggers.
    {
      filename: filePath("domains", "chat", "chat-page.tsx"),
      code: lines(301),
      errors: [{ messageId: "tooLong" }],
    },
    // Way over the limit also triggers (single message, not one per line).
    {
      filename: filePath("domains", "chat", "chat-page.tsx"),
      code: lines(1800),
      errors: [{ messageId: "tooLong" }],
    },
    // Custom limit honored.
    {
      filename: filePath("domains", "chat", "chat-page.tsx"),
      code: lines(101),
      options: [{ limit: 100 }],
      errors: [{ messageId: "tooLong" }],
    },
  ],
});
