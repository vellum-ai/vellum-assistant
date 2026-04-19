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
const sequencesManifest = loadManifest("sequences");
describe("Messaging skill split", () => {
  const expectedMessagingToolNames = [
    "messaging_auth_test",
    "messaging_list_conversations",
    "messaging_read",
    "messaging_search",
    "messaging_send",
    "messaging_mark_read",
    "messaging_analyze_style",
    "messaging_draft",
    "messaging_sender_digest",
    "messaging_archive_by_sender",
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

  test("sequences/TOOLS.json contains all expected sequence_* tool names", () => {
    const names: string[] = sequencesManifest.tools.map(
      (t: { name: string }) => t.name,
    );
    expect(names).toHaveLength(expectedSequenceToolNames.length);
    for (const name of expectedSequenceToolNames) {
      expect(names).toContain(name);
    }
  });

  test("total tools across all manifests meets expected minimum", () => {
    const expectedMinimum =
      expectedMessagingToolNames.length + expectedSequenceToolNames.length;
    const totalTools =
      messagingManifest.tools.length + sequencesManifest.tools.length;
    expect(totalTools).toBeGreaterThanOrEqual(expectedMinimum);
  });

  test("no tool name collisions across messaging and sequences manifests", () => {
    const allNames = [
      ...messagingManifest.tools.map((t: { name: string }) => t.name),
      ...sequencesManifest.tools.map((t: { name: string }) => t.name),
    ];
    const unique = new Set(allNames);
    expect(unique.size).toBe(allNames.length);
  });
});
