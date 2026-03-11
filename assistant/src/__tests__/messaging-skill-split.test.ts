import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, mock, test } from "bun:test";

mock.module("../config/env.js", () => ({ isHttpAuthDisabled: () => true }));

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadManifest(skillDir: string) {
  const manifestPath = resolve(
    __dirname,
    `../config/bundled-skills/${skillDir}/TOOLS.json`,
  );
  return JSON.parse(readFileSync(manifestPath, "utf-8"));
}

const messagingManifest = loadManifest("messaging");
const gmailManifest = loadManifest("gmail");
const sequencesManifest = loadManifest("sequences");
const slackManifest = loadManifest("slack");

describe("Messaging skill split", () => {
  const expectedMessagingToolNames = [
    "messaging_auth_test",
    "messaging_list_conversations",
    "messaging_read",
    "messaging_search",
    "messaging_send",
    "messaging_reply",
    "messaging_mark_read",
    "messaging_analyze_style",
    "messaging_draft",
    "messaging_sender_digest",
    "messaging_archive_by_sender",
  ];

  const expectedGmailToolNames = [
    "gmail_archive",
    "gmail_batch_archive",
    "gmail_archive_by_query",
    "gmail_label",
    "gmail_batch_label",
    "gmail_trash",
    "gmail_unsubscribe",
    "gmail_draft",
    "gmail_send_draft",
    "gmail_list_attachments",
    "gmail_download_attachment",
    "gmail_send_with_attachments",
    "gmail_forward",
    "gmail_follow_up",
    "gmail_triage",
    "gmail_filters",
    "gmail_vacation",
    "gmail_sender_digest",
    "gmail_outreach_scan",
    "google_contacts",
  ];

  const expectedSequenceToolNames = [
    "sequence_create",
    "sequence_list",
    "sequence_get",
    "sequence_update",
    "sequence_delete",
    "sequence_enroll",
    "sequence_enrollment_list",
    "sequence_import",
    "sequence_analytics",
  ];

  const expectedSlackToolNames = ["slack_add_reaction", "slack_leave_channel"];

  test("messaging/TOOLS.json contains all expected messaging_* tool names", () => {
    const names: string[] = messagingManifest.tools.map(
      (t: { name: string }) => t.name,
    );
    for (const name of expectedMessagingToolNames) {
      expect(names).toContain(name);
    }
  });

  test("messaging/TOOLS.json contains NO gmail_*, sequence_*, or google_contacts tools", () => {
    const names: string[] = messagingManifest.tools.map(
      (t: { name: string }) => t.name,
    );
    for (const name of names) {
      expect(name).not.toMatch(/^gmail_/);
      expect(name).not.toMatch(/^sequence_/);
      expect(name).not.toBe("google_contacts");
    }
  });

  test("gmail/TOOLS.json contains all expected gmail_* tool names", () => {
    const names: string[] = gmailManifest.tools.map(
      (t: { name: string }) => t.name,
    );
    for (const name of expectedGmailToolNames) {
      expect(names).toContain(name);
    }
  });

  test("sequences/TOOLS.json contains all 9 expected sequence_* tool names", () => {
    const names: string[] = sequencesManifest.tools.map(
      (t: { name: string }) => t.name,
    );
    expect(names).toHaveLength(9);
    for (const name of expectedSequenceToolNames) {
      expect(names).toContain(name);
    }
  });

  test("slack/TOOLS.json contains all expected slack_* tool names", () => {
    const names: string[] = slackManifest.tools.map(
      (t: { name: string }) => t.name,
    );
    for (const name of expectedSlackToolNames) {
      expect(names).toContain(name);
    }
  });

  test("total tools across all manifests meets expected minimum", () => {
    const expectedMinimum =
      expectedMessagingToolNames.length +
      expectedGmailToolNames.length +
      expectedSequenceToolNames.length +
      expectedSlackToolNames.length;
    const totalTools =
      messagingManifest.tools.length +
      gmailManifest.tools.length +
      sequencesManifest.tools.length +
      slackManifest.tools.length;
    expect(totalTools).toBeGreaterThanOrEqual(expectedMinimum);
  });

  test("no tool name collisions across messaging, gmail, and sequences manifests", () => {
    const allNames = [
      ...messagingManifest.tools.map((t: { name: string }) => t.name),
      ...gmailManifest.tools.map((t: { name: string }) => t.name),
      ...sequencesManifest.tools.map((t: { name: string }) => t.name),
    ];
    const unique = new Set(allNames);
    expect(unique.size).toBe(allNames.length);
  });
});
