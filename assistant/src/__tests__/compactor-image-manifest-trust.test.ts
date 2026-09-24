/**
 * Compaction must not surface images an actor cannot see.
 *
 * `loadFromDb` scopes an actor's history to the rows it may see. The
 * compaction image manifest reads the DB directly, so without the same scoping
 * an untrusted actor's compaction turn could list a guardian image, retain it,
 * and re-attach its bytes, leaking content the actor was never allowed to see.
 * `collectImageManifest` scopes its rows the way the history load does, so it
 * offers exactly the images the actor's history holds.
 */
import { beforeEach, describe, expect, test } from "bun:test";

import { collectImageManifest } from "../context/compactor.js";
import type { TrustContext } from "../daemon/trust-context-types.js";
import { attachInlineAttachmentToMessage } from "../persistence/attachments-store.js";
import {
  addMessage,
  createConversation,
  updateMessageContent,
} from "../persistence/conversation-crud.js";
import { addParticipant } from "../persistence/conversation-participants.js";
import { getDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";

await initializeDb();

// 1x1 transparent PNG.
const PNG_1X1_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

function resetTables(): void {
  const db = getDb();
  db.run("DELETE FROM conversation_participants");
  db.run("DELETE FROM message_attachments");
  db.run("DELETE FROM attachments");
  db.run("DELETE FROM messages");
  db.run("DELETE FROM conversations");
}

async function addImageMessage(
  conversationId: string,
  provenanceTrustClass:
    | "guardian"
    | "trusted_contact"
    | "unverified_contact"
    | "unknown",
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
  await attachInlineAttachmentToMessage(
    inserted.id,
    0,
    filename,
    "image/png",
    PNG_1X1_BASE64,
  );
}

function trust(trustClass: TrustContext["trustClass"]): TrustContext {
  return { sourceChannel: "vellum", trustClass };
}

describe("collectImageManifest trust filtering", () => {
  beforeEach(resetTables);

  test("untrusted actor manifest excludes guardian images", async () => {
    // GIVEN a conversation with a guardian image and an unknown-actor image
    const conv = createConversation();
    await addImageMessage(conv.id, "guardian", "guardian-secret.png");
    await addImageMessage(conv.id, "unknown", "visitor.png");

    // WHEN the manifest is built for an untrusted ("unknown") actor
    const manifest = collectImageManifest(conv.id, trust("unknown"));

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
    const manifest = collectImageManifest(conv.id, trust("guardian"));

    // THEN every image is listed
    const filenames = manifest.map((e) => e.filename);
    expect(filenames).toContain("guardian-secret.png");
    expect(filenames).toContain("visitor.png");
  });

  test("omitted trust defaults to the untrusted filter", async () => {
    // GIVEN a conversation containing a guardian image
    const conv = createConversation();
    await addImageMessage(conv.id, "guardian", "guardian-secret.png");
    await addImageMessage(conv.id, "trusted_contact", "contact.png");

    // WHEN the manifest is built without an actor trust
    const manifest = collectImageManifest(conv.id);

    // THEN the guardian image is excluded (fail-closed, mirroring loadFromDb)
    const filenames = manifest.map((e) => e.filename);
    expect(filenames).toContain("contact.png");
    expect(filenames).not.toContain("guardian-secret.png");
  });

  test("unverified_contact actor manifest excludes guardian images but keeps unverified-provenance images", async () => {
    // GIVEN a conversation with a guardian image and an unverified-contact image
    const conv = createConversation();
    await addImageMessage(conv.id, "guardian", "guardian-secret.png");
    await addImageMessage(conv.id, "unverified_contact", "unverified.png");

    // WHEN the manifest is built for an unverified_contact actor
    const manifest = collectImageManifest(conv.id, trust("unverified_contact"));

    // THEN the unverified-provenance image is listed and the guardian image
    // is excluded — unverified_contact is treated as untrusted downstream.
    const filenames = manifest.map((e) => e.filename);
    expect(filenames).toContain("unverified.png");
    expect(filenames).not.toContain("guardian-secret.png");
  });
});

describe("collectImageManifest fixed-boundary row bound", () => {
  beforeEach(resetTables);

  test("endRowIndex excludes images at and after the boundary row", async () => {
    // GIVEN three image messages (rows 0, 1, 2)
    const conv = createConversation();
    await addImageMessage(conv.id, "guardian", "head-1.png");
    await addImageMessage(conv.id, "guardian", "head-2.png");
    await addImageMessage(conv.id, "guardian", "tail.png");

    // WHEN the manifest is bounded to rows before index 2
    const manifest = collectImageManifest(conv.id, trust("guardian"), 2);

    // THEN only head images are offered for retention
    const filenames = manifest.map((e) => e.filename);
    expect(filenames).toEqual(["head-1.png", "head-2.png"]);
  });

  test("omitted endRowIndex keeps the whole-conversation manifest", async () => {
    // GIVEN two image messages
    const conv = createConversation();
    await addImageMessage(conv.id, "guardian", "first.png");
    await addImageMessage(conv.id, "guardian", "second.png");

    // WHEN the manifest is built without a boundary (auto-compaction path)
    const manifest = collectImageManifest(conv.id, trust("guardian"));

    // THEN every image is listed
    expect(manifest.map((e) => e.filename)).toEqual([
      "first.png",
      "second.png",
    ]);
  });

  test("boundary slices the full row list before the trust filter", async () => {
    // GIVEN guardian and unknown images interleaved across rows 0-2
    const conv = createConversation();
    await addImageMessage(conv.id, "guardian", "guardian-head.png");
    await addImageMessage(conv.id, "unknown", "visitor-head.png");
    await addImageMessage(conv.id, "unknown", "visitor-tail.png");

    // WHEN an untrusted manifest is bounded to rows before index 2
    const manifest = collectImageManifest(conv.id, trust("unknown"), 2);

    // THEN the boundary indexes the unfiltered row list (row 2 sliced away)
    // and trust filtering still hides the guardian image from row 0
    expect(manifest.map((e) => e.filename)).toEqual(["visitor-head.png"]);
  });
});

describe("collectImageManifest for a shared-conversation participant", () => {
  beforeEach(resetTables);

  const ALICE = "principal-alice";
  const BOB = "principal-bob";

  const aliceTrust: TrustContext = {
    sourceChannel: "vellum-shared",
    trustClass: "trusted_contact",
    requesterExternalUserId: ALICE,
    requesterChatId: ALICE,
  };

  const aliceTurnMetadata = {
    provenanceTrustClass: "trusted_contact",
    provenanceSourceChannel: "vellum-shared",
    provenanceRequesterIdentifier: ALICE,
  };

  /**
   * A row whose linked image is carried in its content the way the persist
   * path stores it: a `workspace_ref` block, at the top level or nested in a
   * tool result.
   */
  async function addCarriedImage(
    conversationId: string,
    role: "user" | "assistant",
    metadata: Record<string, unknown>,
    filename: string,
    placement: "top-level" | "tool-result" | "not-carried",
  ): Promise<void> {
    const inserted = await addMessage(
      conversationId,
      role,
      JSON.stringify([{ type: "text", text: filename }]),
      { metadata, skipIndexing: true },
    );
    const attachment = await attachInlineAttachmentToMessage(
      inserted.id,
      0,
      filename,
      "image/png",
      PNG_1X1_BASE64,
    );
    const image = {
      type: "image",
      source: {
        type: "workspace_ref",
        media_type: "image/png",
        attachmentId: attachment.id,
        sizeBytes: attachment.sizeBytes,
        filename,
      },
    };
    const content =
      placement === "top-level"
        ? [{ type: "text", text: filename }, image]
        : placement === "tool-result"
          ? [
              {
                type: "tool_result",
                tool_use_id: "tool-1",
                content: filename,
                contentBlocks: [image],
              },
            ]
          : [{ type: "text", text: filename }];
    updateMessageContent(inserted.id, JSON.stringify(content));
  }

  async function seedSharedConversation(): Promise<string> {
    const conv = createConversation();
    addParticipant({
      conversationId: conv.id,
      principalId: ALICE,
      role: "participant",
    });
    return conv.id;
  }

  test("offers a guardian image the shared transcript shows", async () => {
    // GIVEN a shared conversation where the guardian posted an image
    const conversationId = await seedSharedConversation();
    await addCarriedImage(
      conversationId,
      "user",
      { provenanceTrustClass: "guardian" },
      "launch-plan.png",
      "top-level",
    );

    // WHEN the manifest is built for Alice's turn
    const manifest = collectImageManifest(conversationId, aliceTrust);

    // THEN the image her history holds is offered for retention
    expect(manifest.map((e) => e.filename)).toEqual(["launch-plan.png"]);
  });

  test("leaves out guardian images the shared transcript does not show", async () => {
    // GIVEN guardian rows whose images the contact projection drops: one
    // inside a tool result, one linked but never carried in the content, and
    // one on a row restricted to another reader
    const conversationId = await seedSharedConversation();
    await addCarriedImage(
      conversationId,
      "user",
      { provenanceTrustClass: "guardian" },
      "private-screenshot.png",
      "tool-result",
    );
    await addCarriedImage(
      conversationId,
      "user",
      { provenanceTrustClass: "guardian" },
      "linked-only.png",
      "not-carried",
    );
    await addCarriedImage(
      conversationId,
      "assistant",
      {
        provenanceTrustClass: "guardian",
        audience: { kind: "oneReader", userId: BOB },
      },
      "for-bob.png",
      "top-level",
    );
    await addCarriedImage(
      conversationId,
      "user",
      { provenanceTrustClass: "guardian" },
      "visible.png",
      "top-level",
    );

    // WHEN the manifest is built for Alice's turn
    const manifest = collectImageManifest(conversationId, aliceTrust);

    // THEN only the image her projected history carries is offered
    expect(manifest.map((e) => e.filename)).toEqual(["visible.png"]);
  });

  test("offers the images Alice's own turns hold, tool results included", async () => {
    // GIVEN Alice's own turn, which loads as stored, with a screenshot in a
    // tool result
    const conversationId = await seedSharedConversation();
    await addCarriedImage(
      conversationId,
      "user",
      aliceTurnMetadata,
      "alice-upload.png",
      "top-level",
    );
    await addCarriedImage(
      conversationId,
      "user",
      aliceTurnMetadata,
      "alice-screenshot.png",
      "tool-result",
    );

    // WHEN the manifest is built for Alice's turn
    const manifest = collectImageManifest(conversationId, aliceTrust);

    // THEN both are offered
    expect(manifest.map((e) => e.filename)).toEqual([
      "alice-upload.png",
      "alice-screenshot.png",
    ]);
  });

  test("a contact who is not a participant gets the provenance filter", async () => {
    // GIVEN a conversation Alice is not a participant in, holding a visible
    // guardian image
    const conv = createConversation();
    await addCarriedImage(
      conv.id,
      "user",
      { provenanceTrustClass: "guardian" },
      "launch-plan.png",
      "top-level",
    );

    // WHEN the manifest is built for Alice's turn
    const manifest = collectImageManifest(conv.id, aliceTrust);

    // THEN the guardian image is not offered
    expect(manifest).toEqual([]);
  });
});
