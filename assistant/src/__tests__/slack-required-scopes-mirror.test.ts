import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

/**
 * The required-scope list in `channel-readiness-service.ts` is a third copy of
 * data owned by the Slack manifest — the web helper and the skill script hold
 * the other two. Copies drift silently, and a stale list here would either miss
 * a real gap or flag a scope the manifest stopped asking for, so pin it to the
 * canonical source rather than trusting a comment to hold the line.
 */
const REPO_ROOT = join(import.meta.dir, "..", "..", "..");

const MANIFEST_SOURCE = readFileSync(
  join(REPO_ROOT, "skills/slack-app-setup/scripts/build-manifest.ts"),
  "utf-8",
);
const READINESS_SOURCE = readFileSync(
  join(import.meta.dir, "..", "runtime", "channel-readiness-service.ts"),
  "utf-8",
);
const WEB_HELPER_SOURCE = readFileSync(
  join(REPO_ROOT, "clients/web/src/utils/slack-manifest.ts"),
  "utf-8",
);

/** Pull the quoted strings out of the array introduced by `opener`. */
function scopeArrayAfter(source: string, opener: string): string[] {
  const start = source.indexOf(opener);
  if (start === -1) {
    throw new Error(`Not found: ${opener}`);
  }
  const from = start + opener.length;
  const end = source.indexOf("]", from);
  if (end === -1) {
    throw new Error(`Unterminated array after: ${opener}`);
  }
  return [...source.slice(from, end).matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

const bot = scopeArrayAfter(MANIFEST_SOURCE, "bot: [");
const botOptional = scopeArrayAfter(MANIFEST_SOURCE, "bot_optional: [");
const required = scopeArrayAfter(
  READINESS_SOURCE,
  "const SLACK_REQUIRED_BOT_SCOPES = [",
);
const webBot = scopeArrayAfter(
  WEB_HELPER_SOURCE,
  "export const SLACK_MANIFEST_BOT_SCOPES = [",
);
const webBotOptional = scopeArrayAfter(
  WEB_HELPER_SOURCE,
  "const SLACK_MANIFEST_BOT_SCOPES_OPTIONAL = [",
);

describe("required Slack scopes stay in sync with the manifest", () => {
  test("the manifest source parses into usable scope arrays", () => {
    expect(bot.length).toBeGreaterThan(0);
    expect(botOptional.length).toBeGreaterThan(0);
    // Guards the extraction itself, and the manifest's own subset contract.
    expect(botOptional.every((scope) => bot.includes(scope))).toBe(true);
  });

  test("readiness requires exactly the non-declinable bot scopes", () => {
    const expected = bot.filter((scope) => !botOptional.includes(scope)).sort();

    expect([...required].sort()).toEqual(expected);
  });

  test("readiness never demands a scope the workspace may decline", () => {
    expect(required.filter((scope) => botOptional.includes(scope))).toEqual([]);
  });

  // The web helper is the third copy. Both mirrors are asserted to emit
  // identical manifest JSON elsewhere, but that check lives in the web package
  // and cannot see this one, so pin the scope arrays here too.
  test("the web helper requests the same bot scopes as the skill script", () => {
    expect([...webBot].sort()).toEqual([...bot].sort());
    expect([...webBotOptional].sort()).toEqual([...botOptional].sort());
  });
});
