/**
 * Guard test: ensures no hardcoded user-facing copy creeps back into the
 * guardian action timeout/follow-up flow files.
 *
 * All user-visible text in the guardian timeout/follow-up path must go
 * through the `guardian-action-message-composer.ts` composition system
 * (which is intentionally excluded from scanning since that is where
 * deterministic fallback copy legitimately lives).
 *
 * The banned patterns below correspond to strings that were removed during
 * M3/M4/M7 of the guardian timeout feature in favour of generated messaging.
 */

import { describe, expect, test } from "bun:test";

import { readFileSync } from "fs";
import { join } from "path";

const SCANNED_FILES = [
  "calls/call-controller.ts",
  "calls/guardian-action-sweep.ts",
  "runtime/routes/inbound-message-handler.ts",
  "runtime/guardian-action-conversation-turn.ts",
  "daemon/conversation-process.ts",
];

const BANNED_PATTERNS: { pattern: RegExp; description: string }[] = [
  {
    pattern: /['"`]I'm sorry, I wasn't able to get that information in time/i,
    description: "removed M3 hardcoded timeout acknowledgment",
  },
  {
    pattern: /['"`].*already been answered from another channel/i,
    description:
      "stale-answered notice must go through composer (string literal)",
  },
  {
    pattern: /['"`]Failed to deliver your answer to the call/i,
    description:
      "answer-delivery failure notice must go through composer (string literal)",
  },
  {
    pattern: /['"`]I couldn't reach them in time/i,
    description: "removed M3 hardcoded timeout apology (string literal)",
  },
  {
    pattern: /['"`]The call has already ended/i,
    description: "call-ended notice must go through composer (string literal)",
  },
  {
    pattern: /['"`]Would you like to call them back or send/i,
    description: "follow-up prompt must go through composer (string literal)",
  },
  {
    pattern: /['"`]You have multiple expired guardian questions\./i,
    description:
      "expired disambiguation must go through composer (string literal)",
  },
  {
    pattern: /['"`]You have multiple pending follow-up questions\./i,
    description:
      "follow-up disambiguation must go through composer (string literal)",
  },
];

describe("guardian action no-hardcoded-copy guard", () => {
  for (const file of SCANNED_FILES) {
    test(`${file} does not contain banned guardian action copy literals`, () => {
      const content = readFileSync(join(__dirname, "..", file), "utf-8");
      for (const { pattern, description: _description } of BANNED_PATTERNS) {
        const match = content.match(pattern);
        expect(match).toBeNull();
      }
    });
  }
});
