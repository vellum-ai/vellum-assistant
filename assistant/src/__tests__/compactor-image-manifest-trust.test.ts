/**
 * Compaction must not surface guardian-only images to untrusted actors.
 *
 * `loadFromDb` hides guardian-provenance messages (and their images) from
 * untrusted actors. The compaction image manifest reads the DB directly, so
 * without the same provenance filter an untrusted actor's compaction turn
 * could list a guardian image, retain it, and re-attach its bytes — leaking
 * content the actor was never allowed to see. `collectImageManifest` applies
 * the identical trust filter so this cannot happen.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    ui: {},
    model: "test",
    provider: "test",
    memory: { enabled: false },
  }),
}));

import { collectImageManifest } from "../context/compactor.js";
import { attachInlineAttachmentToMessage } from "../memory/attachments-store.js";
import { addMessage, createConversation } from "../memory/conversation-crud.js";
import { getDb } from "../memory/db-connection.js";
import { initializeDb } from "../memory/db-init.js";

initializeDb();

// 1x1 transparent PNG.
const PNG_1X1_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

function resetTables(): void {
  const db = getDb();
  db.run("DELETE FROM message_attachments");
  db.run("DELETE FROM attachments");
  db.run("DELETE FROM messages");
  db.run("DELETE FROM conversations");
}

async function addImageMessage(
  conversationId: string,
  provenanceTrustClass: "guardian" | "trusted_contact" | "unknown",
  filename: string,
): Promise<void> {
  const inserted = await addMessage(
    conversationId,
    "user",
    JSON.stringify([{ type: "text", text: filename }]),
    {
      metadata: { provenanceTrustClass },
      skipIndexing: true,
    },
  );
  attachInlineAttachmentToMessage(
    inserted.id,
    0,
    filename,
    "image/png",
    PNG_1X1_BASE64,
  );
}

describe("collectImageManifest trust filtering", () => {
  beforeEach(resetTables);

  test("untrusted actor manifest excludes guardian images", async () => {
    // GIVEN a conversation with a guardian image and an unknown-actor image
    const conv = createConversation();
    await addImageMessage(conv.id, "guardian", "guardian-secret.png");
    await addImageMessage(conv.id, "unknown", "visitor.png");

    // WHEN the manifest is built for an untrusted ("unknown") actor
    const manifest = collectImageManifest(conv.id, "unknown");

    // THEN only the untrusted actor's own image is listed
    const filenames = manifest.map((e) => e.filename);
    expect(filenames).toContain("visitor.png");
    expect(filenames).not.toContain("guardian-secret.png");
  });

  test("guardian actor manifest includes all images", async () => {
    // GIVEN a conversation with a guardian image and an unknown-actor image
    const conv = createConversation();
    await addImageMessage(conv.id, "guardian", "guardian-secret.png");
    await addImageMessage(conv.id, "unknown", "visitor.png");

    // WHEN the manifest is built for the guardian
    const manifest = collectImageManifest(conv.id, "guardian");

    // THEN every image is listed
    const filenames = manifest.map((e) => e.filename);
    expect(filenames).toContain("guardian-secret.png");
    expect(filenames).toContain("visitor.png");
  });

  test("omitted trust class defaults to the untrusted filter", async () => {
    // GIVEN a conversation containing a guardian image
    const conv = createConversation();
    await addImageMessage(conv.id, "guardian", "guardian-secret.png");
    await addImageMessage(conv.id, "trusted_contact", "contact.png");

    // WHEN the manifest is built without an explicit trust class
    const manifest = collectImageManifest(conv.id);

    // THEN the guardian image is excluded (fail-closed, mirroring loadFromDb)
    const filenames = manifest.map((e) => e.filename);
    expect(filenames).toContain("contact.png");
    expect(filenames).not.toContain("guardian-secret.png");
  });
});
