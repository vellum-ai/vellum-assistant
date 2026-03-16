import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

/**
 * Guard test: domain-specific routing sections must NOT appear in the system
 * prompt source file. Routing cues now live in skill frontmatter
 * (`activation-hints` / `avoid-when`) and are projected into `<available_skills>` XML.
 *
 * If this test fails, you are re-introducing hardcoded routing into the system
 * prompt. Instead, add `activation-hints` to the skill's SKILL.md frontmatter.
 */

const SYSTEM_PROMPT_PATH = join(
  import.meta.dirname,
  "../prompts/system-prompt.ts",
);

const source = readFileSync(SYSTEM_PROMPT_PATH, "utf-8");

/** Function names that must not exist in the system prompt source. */
const BANNED_FUNCTIONS = [
  "buildVerificationRoutingSection",
  "buildVoiceSetupRoutingSection",
  "buildPhoneCallsRoutingSection",
  "buildStarterTaskRoutingSection",
  "buildChannelCommandIntentSection",
];

/** Section headings that must not appear as string literals. */
const BANNED_HEADINGS = [
  "## Routing: Guardian Verification",
  "## Routing: Voice Setup",
  "## Routing: Phone Calls",
  "## Routing: Starter Tasks",
  "## Channel Command Intents",
];

describe("no domain routing in system prompt", () => {
  for (const fn of BANNED_FUNCTIONS) {
    test(`source does not contain function "${fn}"`, () => {
      expect(source).not.toContain(fn);
    });
  }

  for (const heading of BANNED_HEADINGS) {
    test(`source does not contain heading "${heading}"`, () => {
      expect(source).not.toContain(heading);
    });
  }
});
