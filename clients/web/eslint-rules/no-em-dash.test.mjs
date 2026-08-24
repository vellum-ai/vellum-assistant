/**
 * Unit tests for the no-em-dash ESLint rule.
 *
 * Run with: `bun test eslint-rules/no-em-dash.test.mjs`
 *
 * A passing run prints "Ran 0 tests". That is a reporting artifact, not a
 * skip: bun does not expose `describe` / `it` as globals to `.mjs`, so
 * `RuleTester` falls back to its own inline runner and never registers with
 * bun's reporter. The cases still execute, a wrong expectation still throws,
 * and the process still exits non-zero, which is what `scripts/run-tests.ts`
 * gates on. Verify by breaking a case on purpose.
 *
 * Fixtures build the character with {@link DASH} rather than typing it, so
 * this file does not contain what it tests and needs no disable directive of
 * its own.
 */
import { RuleTester } from "eslint";
import tseslint from "typescript-eslint";

import { noEmDash } from "./no-em-dash.mjs";

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tseslint.parser,
    ecmaVersion: "latest",
    sourceType: "module",
    parserOptions: { ecmaFeatures: { jsx: true } },
  },
});

/** U+2014 EM DASH, kept out of this file's own source. */
const DASH = "\u2014";

/** `count` reports of the rule's only message. */
function errors(count) {
  return Array.from({ length: count }, () => ({ messageId: "emDash" }));
}

ruleTester.run("no-em-dash", noEmDash, {
  valid: [
    {
      name: "a hyphen is not an em dash",
      code: `// a plain hyphen - is fine\nconst a = "well-formed";`,
    },
    {
      name: "an en dash is left alone, since ranges are not the target",
      code: `const range = "1–2";`,
    },
    {
      name: "prose with permitted punctuation",
      code: [
        "/**",
        " * A sentence. Then another, with an aside (parenthesised), and a",
        " * colon: like this.",
        " */",
        'const label = "Open document";',
      ].join("\n"),
    },
    {
      name: "identifiers and numbers are untouched",
      code: "const emDashCount = 3;",
    },
  ],

  invalid: [
    {
      name: "line comment",
      code: `// an aside ${DASH} like this one`,
      errors: errors(1),
    },
    {
      name: "block comment, reported once per occurrence",
      code: `/* opening ${DASH} an aside ${DASH} and the rest */`,
      errors: errors(2),
    },
    {
      name: "jsdoc on a later line reports on that line",
      code: [
        "/**",
        " * First line is clean.",
        ` * Second line is not ${DASH} here it is.`,
        " */",
        "const x = 1;",
      ].join("\n"),
      errors: [{ messageId: "emDash", line: 3 }],
    },
    {
      name: "string literal",
      code: `const label = "Saved ${DASH} just now";`,
      errors: errors(1),
    },
    {
      name: "template literal static half",
      code: "const label = `Saved " + DASH + " ${when}`;",
      errors: errors(1),
    },
    {
      name: "jsx text",
      code: `const el = <p>Saved ${DASH} just now</p>;`,
      errors: errors(1),
    },
    {
      name: "jsx attribute string",
      code: `const el = <input placeholder="Name ${DASH} optional" />;`,
      errors: errors(1),
    },
    {
      name: "a comment and a string in one file are both reported",
      code: [
        `// a comment ${DASH} with one`,
        `const label = "and a string ${DASH} with another";`,
      ].join("\n"),
      errors: errors(2),
    },
  ],
});
