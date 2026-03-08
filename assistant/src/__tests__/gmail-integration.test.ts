import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, mock, test } from "bun:test";

mock.module("../config/env.js", () => ({ isHttpAuthDisabled: () => true }));

const __dirname = dirname(fileURLToPath(import.meta.url));
const toolsManifestPath = resolve(
  __dirname,
  "../skills/bundled-skills/messaging/TOOLS.json",
);
const toolsManifest = JSON.parse(readFileSync(toolsManifestPath, "utf-8"));
const slackToolsManifestPath = resolve(
  __dirname,
  "../skills/bundled-skills/slack/TOOLS.json",
);
const slackToolsManifest = JSON.parse(
  readFileSync(slackToolsManifestPath, "utf-8"),
);

describe("Messaging tool contract", () => {
  const expectedGmailToolNames = [
    "gmail_archive",
    "gmail_batch_archive",
    "gmail_archive_by_query",
    "gmail_label",
    "gmail_batch_label",
    "gmail_trash",
    "gmail_draft",
    "gmail_unsubscribe",
    "gmail_list_attachments",
    "gmail_download_attachment",
    "gmail_send_with_attachments",
    "gmail_forward",
    "gmail_summarize_thread",
    "gmail_follow_up",
    "gmail_triage",
    "gmail_filters",
    "gmail_vacation",
    "gmail_sender_digest",
    "gmail_outreach_scan",
    "google_contacts",
  ];

  const expectedMessagingToolNames = [
    "messaging_auth_test",
    "messaging_list_conversations",
    "messaging_read",
    "messaging_search",
    "messaging_send",
    "messaging_reply",
    "messaging_mark_read",
    "messaging_analyze_activity",
    "messaging_analyze_style",
    "messaging_draft",
  ];

  const expectedSlackToolNames = ["slack_add_reaction", "slack_leave_channel"];

  test("TOOLS.json manifest contains all expected gmail_* tool names", () => {
    const manifestToolNames: string[] = toolsManifest.tools.map(
      (t: { name: string }) => t.name,
    );
    for (const name of expectedGmailToolNames) {
      expect(manifestToolNames).toContain(name);
    }
  });

  test("TOOLS.json manifest contains all expected messaging_* tool names", () => {
    const manifestToolNames: string[] = toolsManifest.tools.map(
      (t: { name: string }) => t.name,
    );
    for (const name of expectedMessagingToolNames) {
      expect(manifestToolNames).toContain(name);
    }
  });

  test("TOOLS.json manifest contains all expected slack_* tool names", () => {
    const slackToolNames: string[] = slackToolsManifest.tools.map(
      (t: { name: string }) => t.name,
    );
    for (const name of expectedSlackToolNames) {
      expect(slackToolNames).toContain(name);
    }
  });

  test("TOOLS.json manifests contain at least the expected number of tools", () => {
    const expectedMinimum =
      expectedGmailToolNames.length +
      expectedMessagingToolNames.length +
      expectedSlackToolNames.length;
    const totalTools =
      toolsManifest.tools.length + slackToolsManifest.tools.length;
    expect(totalTools).toBeGreaterThanOrEqual(expectedMinimum);
  });
});
