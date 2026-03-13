import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

/**
 * Guard test: domain-specific skill routing must live in skill frontmatter
 * (activation-hints / avoid-when), NOT in system prompt builder code.
 *
 * Routing sections were migrated to skill frontmatter so they get projected
 * into <available_skills> XML. This guard prevents them from being re-added
 * to the system prompt source files.
 */

const PROMPT_DIR = join(import.meta.dirname, "../prompts");

const BANNED_FUNCTION_NAMES = [
  "buildVerificationRoutingSection",
  "buildVoiceSetupRoutingSection",
  "buildPhoneCallsRoutingSection",
  "buildStarterTaskRoutingSection",
  "buildChannelCommandIntentSection",
];

const BANNED_SECTION_HEADINGS = [
  "## Routing: Guardian Verification",
  "## Routing: Voice Setup",
  "## Routing: Phone Calls",
  "## Routing: Starter Tasks",
  "## Channel Command Intents",
];

const FILES_TO_CHECK = [
  join(PROMPT_DIR, "system-prompt.ts"),
  join(PROMPT_DIR, "sections/routing.ts"),
  join(PROMPT_DIR, "sections/operations.ts"),
];

describe("no domain routing in system prompt guard", () => {
  for (const filePath of FILES_TO_CHECK) {
    const fileName = filePath.split("/prompts/")[1] ?? filePath;
    const content = readFileSync(filePath, "utf-8");

    test(`${fileName} does not contain banned routing function names`, () => {
      const found = BANNED_FUNCTION_NAMES.filter((name) =>
        content.includes(name),
      );
      if (found.length > 0) {
        throw new Error(
          `Found banned routing functions in ${fileName}: ${found.join(", ")}.\n` +
            "Domain routing now lives in skill frontmatter (activation-hints / avoid-when).\n" +
            "Add routing cues to the skill's SKILL.md frontmatter instead.",
        );
      }
    });

    test(`${fileName} does not contain banned routing section headings`, () => {
      const found = BANNED_SECTION_HEADINGS.filter((heading) =>
        content.includes(heading),
      );
      if (found.length > 0) {
        throw new Error(
          `Found banned routing section headings in ${fileName}: ${found.join(", ")}.\n` +
            "Domain routing now lives in skill frontmatter (activation-hints / avoid-when).\n" +
            "Add routing cues to the skill's SKILL.md frontmatter instead.",
        );
      }
    });
  }
});
