import { readFile } from "node:fs/promises";
import { basename } from "node:path";

import {
  createDraft,
  createDraftRaw,
} from "../../../../messaging/providers/gmail/client.js";
import { buildMultipartMime } from "../../../../messaging/providers/gmail/mime-builder.js";
import type {
  ToolContext,
  ToolExecutionResult,
} from "../../../../tools/types.js";
import { guessMimeType } from "./gmail-mime-helpers.js";
import { err, ok, resolveProvider, withProviderToken } from "./shared.js";

export async function run(
  input: Record<string, unknown>,
  context: ToolContext,
): Promise<ToolExecutionResult> {
  const platform = input.platform as string | undefined;
  const conversationId = input.conversation_id as string;
  const text = input.text as string;
  const subject = input.subject as string | undefined;
  const inReplyTo = input.in_reply_to as string | undefined;
  const attachmentPaths = input.attachment_paths as string[] | undefined;
  const threadId = input.thread_id as string | undefined;

  if (!conversationId) {
    return err("conversation_id is required.");
  }
  if (!text) {
    return err("text is required.");
  }

  try {
    const provider = resolveProvider(platform);

    // Non-Gmail platforms: reject attachment_paths
    if (provider.id !== "gmail" && attachmentPaths?.length) {
      return err("Attachments are only supported on Gmail.");
    }

    // Gmail: create a draft instead of sending directly
    if (provider.id === "gmail") {
      return withProviderToken(provider, async (token) => {
        // With attachments: build multipart MIME and use createDraftRaw
        if (attachmentPaths?.length) {
          const attachments = await Promise.all(
            attachmentPaths.map(async (filePath) => {
              const data = await readFile(filePath);
              const filename = basename(filePath);
              const mimeType = guessMimeType(filePath);
              return { filename, mimeType, data };
            }),
          );

          const raw = buildMultipartMime({
            to: conversationId,
            subject: subject ?? "",
            body: text,
            inReplyTo,
            attachments,
          });
          const draft = await createDraftRaw(token, raw, threadId);

          const filenames = attachments.map((a) => a.filename).join(", ");
          return ok(
            `Gmail draft created with ${attachments.length} attachment(s): ${filenames} (Draft ID: ${draft.id}). Review in Gmail Drafts, then tell me to send it or send it yourself.`,
          );
        }

        // Without attachments: use standard createDraft
        const draft = await createDraft(
          token,
          conversationId,
          subject ?? "",
          text,
          inReplyTo,
        );
        return ok(
          `Gmail draft created (ID: ${draft.id}). Review it in your Gmail Drafts, then tell me to send it or send it yourself from Gmail.`,
        );
      });
    }

    return withProviderToken(provider, async (token) => {
      const result = await provider.sendMessage(token, conversationId, text, {
        subject,
        inReplyTo,
        assistantId: context.assistantId,
      });

      const threadSuffix = result.threadId
        ? `, "thread_id": "${result.threadId}"`
        : "";
      return ok(`Message sent (ID: ${result.id}${threadSuffix}).`);
    });
  } catch (e) {
    return err(e instanceof Error ? e.message : String(e));
  }
}
