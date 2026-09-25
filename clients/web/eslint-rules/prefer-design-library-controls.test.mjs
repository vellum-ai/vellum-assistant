/**
 * Unit tests for the prefer-design-library-controls ESLint rule.
 *
 * Run with: `bun test eslint-rules/prefer-design-library-controls.test.mjs`
 *
 * A passing run prints "Ran 0 tests"; see no-em-dash.test.mjs for why that is
 * a reporting artifact and not a skip.
 */
import { RuleTester } from "eslint";
import tseslint from "typescript-eslint";

import { preferDesignLibraryControls } from "./prefer-design-library-controls.mjs";

const ruleTester = new RuleTester({
  languageOptions: {
    parser: tseslint.parser,
    ecmaVersion: "latest",
    sourceType: "module",
    parserOptions: { ecmaFeatures: { jsx: true } },
  },
});

ruleTester.run("prefer-design-library-controls", preferDesignLibraryControls, {
  valid: [
    "const a = <Button onClick={go}>Go</Button>;",
    "const a = <Button loading={busy} leftIcon={<Save />}>Save</Button>;",
    "const a = <Button variant=\"link\">Skip</Button>;",
    "const a = <ExternalAnchor href={url}>Docs</ExternalAnchor>;",
    "const a = <a href=\"/in-app\">Inside</a>;",
    "const a = <a href={url} target={target}>dynamic target is not our call</a>;",
    "const a = <Menu.Item onSelect={go}>Rename</Menu.Item>;",
    "const a = <div role=\"dialog\" />;",
    "const a = <div className=\"keyboard-focus:ring-2 keyboard-focus:ring-[var(--ring)]\" />;",
    "const a = <div className={cn(\"rounded\", open && \"keyboard-focus:ring-2\")} />;",
    // A spinner that is not inside a Button is fine.
    "const a = <div><Loader2 className=\"animate-spin\" /></div>;",
    // A spinner as a Button's own child is reported; as a sibling it is not.
    "const a = <><Loader2 /><Button>Go</Button></>;",
  ],
  invalid: [
    {
      code: "const a = <button type=\"button\" onClick={go}>Go</button>;",
      errors: [{ messageId: "rawButton" }],
    },
    {
      code: "const a = <a href={url} target=\"_blank\" rel=\"noopener noreferrer\">Out</a>;",
      errors: [{ messageId: "blankAnchor" }],
    },
    {
      code: "const a = <a href={url} target={\"_blank\"}>Out</a>;",
      errors: [{ messageId: "blankAnchor" }],
    },
    {
      code: "const a = <div role=\"button\" tabIndex={0} onClick={go} />;",
      errors: [{ messageId: "roleButton" }],
    },
    {
      code: "const a = <div className=\"p-2 focus-visible:ring-2\" />;",
      errors: [{ messageId: "focusVisible" }],
    },
    {
      code: "const a = <div className={cn(\"p-2\", active && \"focus-visible:outline\")} />;",
      errors: [{ messageId: "focusVisible" }],
    },
    {
      code: "const a = <div className={`p-2 ${x} focus-visible:ring-1`} />;",
      errors: [{ messageId: "focusVisible" }],
    },
    {
      code: "const a = <Button leftIcon={busy ? <Loader2 className=\"animate-spin\" /> : <Save />}>Save</Button>;",
      errors: [{ messageId: "spinnerInButton" }],
    },
    {
      code: "const a = <Button iconOnly={<LoaderCircle />} aria-label=\"Working\" />;",
      errors: [{ messageId: "spinnerInButton" }],
    },
    {
      code: "const a = <Button>{busy && <Loader2 />}Save</Button>;",
      errors: [{ messageId: "spinnerInButton" }],
    },
    {
      // Several shapes on one element report each once.
      code: "const a = <button role=\"button\" className=\"focus-visible:ring-2\">x</button>;",
      errors: [
        { messageId: "rawButton" },
        { messageId: "roleButton" },
        { messageId: "focusVisible" },
      ],
    },
  ],
});
