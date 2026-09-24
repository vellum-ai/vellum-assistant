import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "bun:test";

import { collectImageManifest } from "../context/compactor.js";
import { resolveAssistantAttachments } from "../daemon/conversation-attachments.js";
import { settleTurnContent } from "../daemon/conversation-turn-finalize.js";
import {
  createInlineAttachment,
  getAttachmentsForMessage,
  linkAttachmentToMessage,
} from "../persistence/attachments-store.js";
import {
  addMessage,
  createConversation,
  getMessageById,
  parseMessageMetadata,
} from "../persistence/conversation-crud.js";
import {
  getConversationDirPath,
  syncMessageToDisk,
} from "../persistence/conversation-disk-view.js";
import { computerUseScreenshotAttachmentIdsFromMetadata } from "../persistence/conversation-types.js";
import { getDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import { rawGet } from "../persistence/raw-query.js";
import type { ImageContent } from "../providers/types.js";
import { getLogger } from "../util/logger.js";
import { recoverConversationsFromDiskViewMigration } from "../workspace/migrations/028-recover-conversations-from-disk-view.js";
import { setConfig } from "./helpers/set-config.js";

setConfig("memory", { enabled: false });
await initializeDb();

const SCREENSHOT_BASE64 = Buffer.from("screenshot").toString("base64");
const rlog = getLogger("computer-use-screenshot-attachments-test");

function resetTables(): void {
  const db = getDb();
  db.run("DELETE FROM message_attachments");
  db.run("DELETE FROM attachments");
  db.run("DELETE FROM messages");
  db.run("DELETE FROM conversations");
}

describe("computer-use screenshot reply placement", () => {
  beforeEach(resetTables);

  test("links only the final canonical screenshot and reuses it on retry", async () => {
    const conversation = createConversation();
    const earlierToolRow = await addMessage(
      conversation.id,
      "user",
      "earlier tool result",
    );
    const finalToolRow = await addMessage(
      conversation.id,
      "user",
      "final tool result",
    );
    const reply = await addMessage(conversation.id, "assistant", "Done.");
    const earlier = await createInlineAttachment(
      conversation.id,
      conversation.createdAt,
      "computer-use-move.png",
      "image/png",
      Buffer.from("earlier").toString("base64"),
    );
    const final = await createInlineAttachment(
      conversation.id,
      conversation.createdAt,
      "computer-use-click.png",
      "image/png",
      SCREENSHOT_BASE64,
    );
    linkAttachmentToMessage(earlierToolRow.id, earlier.id, 0);
    linkAttachmentToMessage(finalToolRow.id, final.id, 0);
    const finalBlock: ImageContent = {
      type: "image",
      source: {
        type: "workspace_ref",
        media_type: "image/png",
        attachmentId: final.id,
        sizeBytes: final.sizeBytes,
        filename: "computer-use-click.png",
      },
    };

    const resolve = () =>
      resolveAssistantAttachments(
        [],
        [],
        [],
        tmpdir(),
        async () => true,
        reply.id,
        undefined,
        { toolName: "computer_use_click", block: finalBlock },
      );
    const first = await resolve();
    const retry = await resolve();

    expect(
      getAttachmentsForMessage(earlierToolRow.id).map((a) => a.id),
    ).toEqual([earlier.id]);
    expect(getAttachmentsForMessage(finalToolRow.id).map((a) => a.id)).toEqual([
      final.id,
    ]);
    expect(getAttachmentsForMessage(reply.id).map((a) => a.id)).toEqual([
      final.id,
    ]);
    expect(first.emittedAttachments).toEqual([
      expect.objectContaining({
        id: final.id,
        computerUseScreenshot: true,
      }),
    ]);
    expect(retry.emittedAttachments).toEqual([
      expect.objectContaining({
        id: final.id,
        computerUseScreenshot: true,
      }),
    ]);
    expect(first.linkedAttachmentIds).toEqual([final.id]);
    expect(retry.linkedAttachmentIds).toEqual([final.id]);
    expect(
      computerUseScreenshotAttachmentIdsFromMetadata(
        parseMessageMetadata(getMessageById(reply.id)?.metadata ?? null),
      ),
    ).toEqual([final.id]);
    const physicalCount = rawGet<{ count: number }>(
      "test:countComputerUseAttachments",
      "SELECT COUNT(*) AS count FROM attachments",
    );
    expect(physicalCount?.count).toBe(2);

    const manifestIds = collectImageManifest(conversation.id, "guardian").map(
      (entry) => entry.attachmentId,
    );
    expect(manifestIds).toEqual([earlier.id, final.id, final.id]);
    expect(new Set(manifestIds)).toEqual(new Set([earlier.id, final.id]));

    syncMessageToDisk(
      conversation.id,
      earlierToolRow.id,
      conversation.createdAt,
    );
    syncMessageToDisk(conversation.id, finalToolRow.id, conversation.createdAt);
    syncMessageToDisk(conversation.id, reply.id, conversation.createdAt);
    const diskDir = getConversationDirPath(
      conversation.id,
      conversation.createdAt,
    );
    const diskRows = readFileSync(`${diskDir}/messages.jsonl`, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { attachments?: string[] });
    expect(diskRows.map((row) => row.attachments?.length ?? 0)).toEqual([
      1, 1, 1,
    ]);
    rmSync(diskDir, { recursive: true, force: true });
  });

  test("keeps explicit attachment intent unflagged when content matches", async () => {
    const conversation = createConversation();
    const toolRow = await addMessage(conversation.id, "user", "tool result");
    const reply = await addMessage(conversation.id, "assistant", "Done.");
    const canonical = await createInlineAttachment(
      conversation.id,
      conversation.createdAt,
      "computer-use-click.png",
      "image/png",
      SCREENSHOT_BASE64,
    );
    linkAttachmentToMessage(toolRow.id, canonical.id, 0);
    const workingDir = mkdtempSync(join(tmpdir(), "vellum-cu-explicit-"));
    writeFileSync(join(workingDir, "selected.png"), "screenshot");

    try {
      const result = await resolveAssistantAttachments(
        [
          {
            source: "sandbox",
            path: "selected.png",
            filename: "selected.png",
            mimeType: "image/png",
          },
        ],
        [],
        [],
        workingDir,
        async () => true,
        reply.id,
        undefined,
        {
          toolName: "computer_use_click",
          block: {
            type: "image",
            source: {
              type: "workspace_ref",
              media_type: "image/png",
              attachmentId: canonical.id,
              sizeBytes: canonical.sizeBytes,
              filename: "computer-use-click.png",
            },
          },
        },
      );

      const replyAttachments = getAttachmentsForMessage(reply.id);
      expect(replyAttachments).toHaveLength(1);
      expect(replyAttachments[0]?.id).not.toBe(canonical.id);
      expect(
        result.emittedAttachments[0]?.computerUseScreenshot,
      ).toBeUndefined();
      expect(result.linkedAttachmentIds).toEqual([replyAttachments[0]!.id]);
      expect(
        computerUseScreenshotAttachmentIdsFromMetadata(
          parseMessageMetadata(getMessageById(reply.id)?.metadata ?? null),
        ),
      ).toEqual([]);
    } finally {
      rmSync(workingDir, { recursive: true, force: true });
    }
  });

  test("keeps unresolved inline fallback visible and unflagged", async () => {
    const conversation = createConversation();
    const reply = await addMessage(conversation.id, "assistant", "Done.");
    const result = await resolveAssistantAttachments(
      [],
      [],
      [],
      tmpdir(),
      async () => true,
      reply.id,
      undefined,
      {
        toolName: "computer_use_click",
        block: {
          type: "image",
          source: {
            type: "base64",
            media_type: "image/png",
            data: SCREENSHOT_BASE64,
          },
        },
      },
    );

    expect(result.emittedAttachments).toHaveLength(1);
    expect(result.emittedAttachments[0]?.computerUseScreenshot).toBeUndefined();
    expect(result.computerUseScreenshotAttachmentIds).toEqual([]);
    expect(result.linkedAttachmentIds).toEqual([
      result.emittedAttachments[0]!.id!,
    ]);
    expect(getAttachmentsForMessage(reply.id)).toHaveLength(1);
  });

  test("reports an ordinary tool attachment only after linking it", async () => {
    const conversation = createConversation();
    const reply = await addMessage(conversation.id, "assistant", "Done.");
    const result = await resolveAssistantAttachments(
      [],
      [
        {
          type: "image",
          source: {
            type: "base64",
            media_type: "image/png",
            data: SCREENSHOT_BASE64,
          },
        },
      ],
      [],
      tmpdir(),
      async () => true,
      reply.id,
      new Map([[0, "browser_screenshot"]]),
    );

    expect(result.computerUseScreenshotAttachmentIds).toEqual([]);
    expect(result.linkedAttachmentIds).toEqual([
      result.emittedAttachments[0]!.id!,
    ]);
    expect(getAttachmentsForMessage(reply.id)).toHaveLength(1);
  });

  test("reports no linked attachments when resolution has no drafts", async () => {
    const conversation = createConversation();
    const reply = await addMessage(conversation.id, "assistant", "Done.");
    const result = await resolveAssistantAttachments(
      [],
      [],
      [],
      tmpdir(),
      async () => true,
      reply.id,
    );

    expect(result.assistantAttachments).toEqual([]);
    expect(result.linkedAttachmentIds).toEqual([]);
    expect(getAttachmentsForMessage(reply.id)).toEqual([]);
  });

  test("exports and recovers the final screenshot reply once", async () => {
    const conversation = createConversation();
    const reply = await addMessage(conversation.id, "assistant", "Done.");
    const diskDir = getConversationDirPath(
      conversation.id,
      conversation.createdAt,
    );

    try {
      await settleTurnContent({
        ctx: { conversationId: conversation.id, messages: [] },
        state: {
          lastAssistantMessageId: reply.id,
          assistantMessageIdsToSync: new Set([reply.id]),
          inflightWriters: new Map(),
        },
        rlog,
      });

      const diskRows = readFileSync(`${diskDir}/messages.jsonl`, "utf8")
        .trim()
        .split("\n");
      expect(diskRows).toHaveLength(1);

      resetTables();
      recoverConversationsFromDiskViewMigration.run(
        process.env.VELLUM_WORKSPACE_DIR!,
      );
      const recovered = rawGet<{ count: number }>(
        "test:countRecoveredFinalScreenshotReplies",
        "SELECT COUNT(*) AS count FROM messages WHERE conversation_id = ? AND role = 'assistant'",
        conversation.id,
      );
      expect(recovered?.count).toBe(1);
    } finally {
      rmSync(diskDir, { recursive: true, force: true });
    }
  });

  test("exports and recovers an earlier delivered reply and final private row once each", async () => {
    const conversation = createConversation();
    const deliveredReply = await addMessage(
      conversation.id,
      "assistant",
      "Here is the result.",
    );
    const finalPrivateRow = await addMessage(
      conversation.id,
      "assistant",
      "Finished delivery.",
    );
    const screenshot = await createInlineAttachment(
      conversation.id,
      conversation.createdAt,
      "computer-use-click.png",
      "image/png",
      SCREENSHOT_BASE64,
    );
    linkAttachmentToMessage(deliveredReply.id, screenshot.id, 0);
    const diskDir = getConversationDirPath(
      conversation.id,
      conversation.createdAt,
    );

    try {
      await settleTurnContent({
        ctx: { conversationId: conversation.id, messages: [] },
        state: {
          lastAssistantMessageId: finalPrivateRow.id,
          assistantMessageIdsToSync: new Set([deliveredReply.id]),
          inflightWriters: new Map(),
        },
        rlog,
      });

      const diskRows = readFileSync(`${diskDir}/messages.jsonl`, "utf8")
        .trim()
        .split("\n")
        .map(
          (line) =>
            JSON.parse(line) as { content?: string; attachments?: string[] },
        );
      expect(diskRows.map((row) => row.content)).toEqual([
        "Here is the result.",
        "Finished delivery.",
      ]);
      expect(diskRows.map((row) => row.attachments?.length ?? 0)).toEqual([
        1, 0,
      ]);

      resetTables();
      recoverConversationsFromDiskViewMigration.run(
        process.env.VELLUM_WORKSPACE_DIR!,
      );
      const recovered = rawGet<{ count: number }>(
        "test:countRecoveredDeliveredAndPrivateRows",
        "SELECT COUNT(*) AS count FROM messages WHERE conversation_id = ? AND role = 'assistant'",
        conversation.id,
      );
      expect(recovered?.count).toBe(2);
    } finally {
      rmSync(diskDir, { recursive: true, force: true });
    }
  });
});
