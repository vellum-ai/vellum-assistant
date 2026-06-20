/**
 * Tests for attachment-id rehydration (Codex P2 — inline media_ref must survive
 * a reload).
 *
 * The persisted message JSON never carries `_attachmentId` (it is minted after
 * persistence and backfilled onto the in-memory block at send time). On a
 * conversation reload from the DB the in-memory block is reconstructed from JSON
 * and so loses the id — `rehydrateAttachmentIds` reapplies it from the
 * message_attachments links so the vision-perception markers can still surface a
 * usable `media_ref` for a non-vision backbone.
 *
 * `mock.module` is process-global, so the attachment-store stub (used only for
 * the marker filename lookup) lives in this one file.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { FileContent, ImageContent, Message } from "../providers/types.js";

// The marker renderer looks up the attachment's original filename. A missing id
// resolves to a generic label, matching the real store.
let attachmentRows: Record<string, { originalFilename: string; kind: string }> =
  {};
mock.module("../memory/attachments-store.js", () => ({
  getAttachmentById: (id: string) => attachmentRows[id] ?? null,
}));

// Drive marker resolution directly with controllable mocks so the rehydrated
// block can be threaded through the real marker rewrite without a live config.
mock.module("../config/loader.js", () => ({
  getConfig: () => ({ llm: { profiles: {}, default: {} } }),
}));
mock.module("../config/assistant-feature-flags.js", () => ({
  isAssistantFeatureFlagEnabled: () => true,
}));

const { rehydrateAttachmentIds, backfillAttachmentId } =
  await import("./attachments.js");
const { applyVisionPerceptionMarkers } =
  await import("../plugins/defaults/vision-perception/hooks/pre-model-call.js");

function imageBlock(): ImageContent {
  return {
    type: "image",
    source: { type: "base64", media_type: "image/png", data: "AAAA" },
  };
}

function fileBlock(mediaType = "application/pdf"): FileContent {
  return {
    type: "file",
    source: {
      type: "base64",
      media_type: mediaType,
      data: "AAAA",
      filename: "doc.pdf",
    },
  };
}

beforeEach(() => {
  attachmentRows = {
    "att-0": { originalFilename: "photo.png", kind: "image" },
    "att-1": { originalFilename: "second.png", kind: "image" },
    "vid-0": { originalFilename: "clip.mp4", kind: "video" },
  };
});

describe("rehydrateAttachmentIds", () => {
  test("maps ordered ids onto image/file blocks, skipping leading text", () => {
    const message: Message = {
      role: "user",
      content: [{ type: "text", text: "look" }, imageBlock(), imageBlock()],
    };
    rehydrateAttachmentIds(message, [
      { position: 0, attachmentId: "att-0" },
      { position: 1, attachmentId: "att-1" },
    ]);
    expect((message.content[1] as ImageContent)._attachmentId).toBe("att-0");
    expect((message.content[2] as ImageContent)._attachmentId).toBe("att-1");
  });

  test("uses the same indexing as backfillAttachmentId (n-th media block ← n-th id)", () => {
    const reloaded: Message = {
      role: "user",
      content: [{ type: "text", text: "look" }, imageBlock(), fileBlock()],
    };
    const liveBackfilled: Message = {
      role: "user",
      content: [{ type: "text", text: "look" }, imageBlock(), fileBlock()],
    };
    // Reload path: rehydrate from the positioned link list.
    rehydrateAttachmentIds(reloaded, [
      { position: 0, attachmentId: "att-0" },
      { position: 1, attachmentId: "vid-0" },
    ]);
    // Live path: backfill each index individually.
    backfillAttachmentId(liveBackfilled, 0, "att-0");
    backfillAttachmentId(liveBackfilled, 1, "vid-0");

    expect((reloaded.content[1] as ImageContent)._attachmentId).toBe(
      (liveBackfilled.content[1] as ImageContent)._attachmentId,
    );
    expect((reloaded.content[2] as FileContent)._attachmentId).toBe(
      (liveBackfilled.content[2] as FileContent)._attachmentId,
    );
  });

  test("places ids by stored position when an earlier upload was skipped (sparse)", () => {
    // Two media blocks persist, but the FIRST attachment was skipped at upload
    // time (unsupported MIME / no data), so message_attachments only has a row
    // for the second block, stored at position 1. The reload path must match the
    // live backfillAttachmentId(message, 1, ...) placement exactly.
    const reloaded: Message = {
      role: "user",
      content: [{ type: "text", text: "look" }, imageBlock(), imageBlock()],
    };
    const liveBackfilled: Message = {
      role: "user",
      content: [{ type: "text", text: "look" }, imageBlock(), imageBlock()],
    };
    // Sparse link list: only position 1 has a row (gap at position 0).
    rehydrateAttachmentIds(reloaded, [{ position: 1, attachmentId: "att-1" }]);
    backfillAttachmentId(liveBackfilled, 1, "att-1");

    // The SECOND media block gets the id; the first stays untagged — and the
    // reload placement is byte-for-byte identical to the live path.
    expect((reloaded.content[1] as ImageContent)._attachmentId).toBeUndefined();
    expect((reloaded.content[2] as ImageContent)._attachmentId).toBe("att-1");
    expect((reloaded.content[1] as ImageContent)._attachmentId).toBe(
      (liveBackfilled.content[1] as ImageContent)._attachmentId,
    );
    expect((reloaded.content[2] as ImageContent)._attachmentId).toBe(
      (liveBackfilled.content[2] as ImageContent)._attachmentId,
    );
  });

  test("never overwrites an id already present on a block", () => {
    const block = imageBlock();
    block._attachmentId = "already-set";
    const message: Message = { role: "user", content: [block] };
    rehydrateAttachmentIds(message, [{ position: 0, attachmentId: "att-0" }]);
    expect(block._attachmentId).toBe("already-set");
  });

  test("is a no-op for an empty link list", () => {
    const block = imageBlock();
    const message: Message = { role: "user", content: [block] };
    rehydrateAttachmentIds(message, []);
    expect(block._attachmentId).toBeUndefined();
  });

  test("ignores positions with no matching media block", () => {
    const message: Message = { role: "user", content: [imageBlock()] };
    rehydrateAttachmentIds(message, [
      { position: 0, attachmentId: "att-0" },
      { position: 1, attachmentId: "att-1" },
      { position: 2, attachmentId: "vid-0" },
    ]);
    expect((message.content[0] as ImageContent)._attachmentId).toBe("att-0");
  });
});

describe("reloaded inline upload still yields a media_ref marker", () => {
  test("a rehydrated image block becomes a marker with the real media_ref on a non-vision backbone", () => {
    // Simulate a conversation reloaded from the DB: the persisted JSON has no
    // _attachmentId, but the message_attachments link list does.
    const reloaded: Message = {
      role: "user",
      content: [{ type: "text", text: "what is this?" }, imageBlock()],
    };
    rehydrateAttachmentIds(reloaded, [{ position: 0, attachmentId: "att-0" }]);

    // Non-vision backbone: image is rewritten into an attachment-id marker.
    const out = applyVisionPerceptionMarkers([reloaded], false);
    const blocks = out[0].content;

    // Raw image gone; marker carries the rehydrated id as a usable media_ref.
    expect(blocks.some((b) => b.type === "image")).toBe(false);
    const marker = blocks.find(
      (b) => b.type === "text" && b.text.includes('media_ref="att-0"'),
    ) as { type: "text"; text: string } | undefined;
    expect(marker).toBeDefined();
    expect(marker!.text).toContain('id="att-0"');
    expect(marker!.text).toContain('file "photo.png"');
  });

  test("a rehydrated video file block becomes a vlm_video_log marker", () => {
    const reloaded: Message = {
      role: "user",
      content: [{ type: "text", text: "summarize" }, fileBlock("video/mp4")],
    };
    rehydrateAttachmentIds(reloaded, [{ position: 0, attachmentId: "vid-0" }]);

    const out = applyVisionPerceptionMarkers([reloaded], false);
    const blocks = out[0].content;
    expect(blocks.some((b) => b.type === "file")).toBe(false);
    const marker = blocks.find(
      (b) => b.type === "text" && b.text.includes("vlm_video_log"),
    ) as { type: "text"; text: string } | undefined;
    expect(marker).toBeDefined();
    expect(marker!.text).toContain('media_ref="vid-0"');
  });

  test("without rehydration a reloaded block has no media_ref (regression guard)", () => {
    // The pre-fix behavior: a reloaded block with no _attachmentId is left
    // intact (no usable media_ref), proving the rehydration is load-bearing.
    const reloaded: Message = {
      role: "user",
      content: [{ type: "text", text: "what is this?" }, imageBlock()],
    };
    const messages = [reloaded];
    const out = applyVisionPerceptionMarkers(messages, false);
    // Same reference back — nothing was replaceable without an id, so the raw
    // image survives with no media_ref (this is what the rehydration fixes).
    expect(out).toBe(messages);
    expect(out[0].content.some((b) => b.type === "image")).toBe(true);
  });
});
