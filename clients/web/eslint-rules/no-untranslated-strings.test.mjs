/**
 * Unit tests for the no-untranslated-strings ESLint rule.
 *
 * Run with: `bun test eslint-rules/no-untranslated-strings.test.mjs`
 *
 * A passing run prints "Ran 0 tests". That is a reporting artifact, not a
 * skip: bun does not expose `describe` / `it` as globals to `.mjs`, so
 * `RuleTester` falls back to its own inline runner and never registers with
 * bun's reporter. The cases still execute, a wrong expectation still throws,
 * and the process still exits non-zero, which is what `scripts/run-tests.ts`
 * gates on. Verify by breaking a case on purpose.
 *
 * The `valid` cases carry most of the weight here. A lint rule that fires on
 * legitimate code gets switched off rather than obeyed, so each one pins a
 * shape that must stay quiet: structural props, punctuation-only text, already
 * translated call sites, `<Trans>` children, and fixture files.
 */
import { RuleTester } from "eslint";
import tseslint from "typescript-eslint";

import { noUntranslatedStrings } from "./no-untranslated-strings.mjs";

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tseslint.parser,
    ecmaVersion: "latest",
    sourceType: "module",
    parserOptions: { ecmaFeatures: { jsx: true } },
  },
});

const COMPONENT = "/repo/clients/web/src/components/example.tsx";
const STORY = "/repo/clients/web/src/components/example.stories.tsx";
const TEST = "/repo/clients/web/src/components/example.test.tsx";

ruleTester.run("no-untranslated-strings", noUntranslatedStrings, {
  valid: [
    {
      name: "copy read through t()",
      filename: COMPONENT,
      code: `const C = () => <h1>{t("notFound.title")}</h1>;`,
    },
    {
      name: "a user-facing prop read through t()",
      filename: COMPONENT,
      code: `const C = () => <input placeholder={t("search.placeholder")} />;`,
    },
    {
      name: "structural props are not copy",
      filename: COMPONENT,
      code: `const C = () => <div className="flex gap-2" data-slot="row" id="root" />;`,
    },
    {
      name: "JSX text with no letters",
      filename: COMPONENT,
      code: `const C = () => <span>{value} / {other} &middot; 42</span>;`,
    },
    {
      name: "template literal assembling a path, not a sentence",
      filename: COMPONENT,
      code: `const C = () => <img alt={\`\${a}/\${b}\`} />;`,
    },
    {
      name: "Trans children hold their own default copy",
      filename: COMPONENT,
      code: `const C = () => <Trans i18nKey="terms">Read the <a href="/terms">terms</a> first</Trans>;`,
    },
    {
      name: "the JSX whitespace idiom",
      filename: COMPONENT,
      code: `const C = () => <span>{a}{" "}{b}</span>;`,
    },
    {
      name: "a JSX child expression holding a value, not copy",
      filename: COMPONENT,
      code: `const C = () => <span>{count}{user.name}</span>;`,
    },
    {
      name: "SVG geometry is not copy",
      filename: COMPONENT,
      code: `const C = () => <path d="M17 28.5L24.5 36L39 21" fill="none" />;`,
    },
    {
      name: "enum-ish prop values are not copy",
      filename: COMPONENT,
      code: `const C = () => <Button variant="primary" tone="error" size="compact" />;`,
    },
    {
      name: "toast copy read through t()",
      filename: COMPONENT,
      code: `toast.error(t("save.failed"));`,
    },
    {
      name: "story fixtures are not shipped copy",
      filename: STORY,
      code: `export const Default = { args: { label: "Save changes" } };`,
    },
    {
      name: "test fixtures are not shipped copy",
      filename: TEST,
      code: `const C = () => <h1>Page not found</h1>;`,
    },
  ],

  invalid: [
    {
      name: "bare JSX text",
      filename: COMPONENT,
      code: `const C = () => <h1>Page not found</h1>;`,
      errors: [{ messageId: "jsxText" }],
    },
    {
      name: "a user-facing prop given a literal",
      filename: COMPONENT,
      code: `const C = () => <input placeholder="Search skills" />;`,
      errors: [{ messageId: "prop" }],
    },
    {
      name: "an aria-label given a literal",
      filename: COMPONENT,
      code: `const C = () => <button aria-label="Close dialog" />;`,
      errors: [{ messageId: "prop" }],
    },
    {
      name: "a sentence assembled by template literal",
      filename: COMPONENT,
      // The shape that cannot be translated at all: word order is fixed by
      // the source, so no translator can move the count or the noun.
      code: `const C = () => <span aria-label={\`\${n} files selected\`} />;`,
      errors: [{ messageId: "prop" }],
    },
    {
      name: "a sentence assembled by template literal as a JSX child",
      filename: COMPONENT,
      // The shape `JSXText` cannot see: it is an expression container, so it
      // slips past both the text visitor and the prop allowlist.
      code: "const C = () => <span>{`Use ${name} for all schedules`}</span>;",
      errors: [{ messageId: "jsxText" }],
    },
    {
      name: "a string literal rendered as a JSX child",
      filename: COMPONENT,
      code: `const C = () => <span>{"No runs yet"}</span>;`,
      errors: [{ messageId: "jsxText" }],
    },
    {
      name: "copy chosen by a ternary",
      filename: COMPONENT,
      code: `const C = () => <button aria-label={open ? "Collapse" : "Expand"} />;`,
      errors: [{ messageId: "prop" }, { messageId: "prop" }],
    },
    {
      name: "copy used as a fallback",
      filename: COMPONENT,
      code: `const C = () => <span title={doc.title || "Untitled"} />;`,
      errors: [{ messageId: "prop" }],
    },
    {
      name: "copy on a prop outside any allowlist",
      filename: COMPONENT,
      // The shape the old allowlist could never cover: a bespoke prop name.
      code: `const C = () => <Form submitLabel="Complete signup" />;`,
      errors: [{ messageId: "prop" }],
    },
    {
      name: "toast copy as a literal",
      filename: COMPONENT,
      code: `toast.success("Assistant retired");`,
      errors: [{ messageId: "toast" }],
    },
    {
      name: "bare toast() call",
      filename: COMPONENT,
      code: `toast("Copied to clipboard");`,
      errors: [{ messageId: "toast" }],
    },
  ],
});
