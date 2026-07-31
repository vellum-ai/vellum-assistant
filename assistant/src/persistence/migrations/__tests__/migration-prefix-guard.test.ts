import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

/**
 * Migration filename prefixes are the at-a-glance ordering signal for this
 * directory. Execution order and checkpointing are driven by the
 * `migrationSteps` array in `steps.ts` (checkpointed by function name), so a
 * duplicate prefix does not break installs — but it makes two unrelated
 * migrations read as one step and hides where each sits in the sequence. The
 * groups below shipped sharing a prefix and are frozen as-is (migrations are
 * append-only and never renamed): a new migration must take a fresh, unused
 * prefix, and no file may join one of these groups.
 */
const FROZEN_DUPLICATE_PREFIX_GROUPS: Record<string, readonly string[]> = {
  "028": [
    "028-call-session-mode.ts",
    "028-notification-delivery-client-ack.ts",
  ],
  "030": [
    "030-guardian-action-followup.ts",
    "030-guardian-verification-purpose.ts",
  ],
  "032": [
    "032-guardian-delivery-conversation-index.ts",
    "032-notification-delivery-thread-decision.ts",
  ],
  "196": [
    "196-messages-conversation-created-at-index.ts",
    "196-strip-integration-prefix-from-provider-keys.ts",
  ],
  "202": [
    "202-drop-callback-transport-column.ts",
    "202-memory-graph-tables.ts",
  ],
  "206": [
    "206-memory-graph-node-edits.ts",
    "206-scrub-corrupted-image-attachments.ts",
  ],
  "235": ["235-llm-usage-attribution.ts", "235-slack-compaction-watermark.ts"],
  "253": [
    "253-conversation-last-notified-profile.ts",
    "253-document-comments.ts",
  ],
  "270": [
    "270-messages-role-created-at-index.ts",
    "270-schedule-description.ts",
    "270-schedule-source-conversation.ts",
  ],
};

const MIGRATION_FILE_PATTERN = /^(\d+[a-z]?)-.+\.ts$/;

function collectPrefixGroups(): Map<string, string[]> {
  const migrationsDir = join(import.meta.dir, "..");
  const groups = new Map<string, string[]>();
  for (const fileName of readdirSync(migrationsDir).sort()) {
    if (fileName.endsWith(".test.ts")) {
      continue;
    }
    const match = MIGRATION_FILE_PATTERN.exec(fileName);
    if (!match) {
      continue;
    }
    const prefix = match[1];
    const group = groups.get(prefix) ?? [];
    group.push(fileName);
    groups.set(prefix, group);
  }
  return groups;
}

describe("migration filename prefix guard", () => {
  test("every new migration takes a fresh numeric prefix", () => {
    const violations: string[] = [];
    for (const [prefix, files] of collectPrefixGroups()) {
      if (files.length < 2 || prefix in FROZEN_DUPLICATE_PREFIX_GROUPS) {
        continue;
      }
      violations.push(`${prefix}: ${files.join(", ")}`);
    }
    expect(
      violations,
      "Migration filename prefixes collide. Renumber the new migration to the next unused prefix.",
    ).toEqual([]);
  });

  test("frozen duplicate groups keep their exact membership", () => {
    const groups = collectPrefixGroups();
    for (const [prefix, frozen] of Object.entries(
      FROZEN_DUPLICATE_PREFIX_GROUPS,
    )) {
      expect(
        groups.get(prefix)?.sort() ?? [],
        `Frozen duplicate-prefix group ${prefix} changed. Migrations are append-only — restore the file or update the frozen list only for a deliberate rename.`,
      ).toEqual([...frozen].sort());
    }
  });
});
