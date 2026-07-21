/**
 * Runs a single identity-rewrite turn on a throwaway side conversation.
 *
 * The About Assistant surfaces reshape the assistant's persona the same way
 * research onboarding does: post a system-message that asks the assistant to
 * rewrite its own identity files (IDENTITY.md / SOUL.md), wait for the turn
 * to settle, then archive the conversation so it never shows in the user's
 * sidebar. The identity files feed every future conversation's system
 * prompt, which is what makes this durable.
 *
 * Unlike onboarding's fire-and-forget `applyPersonality`, callers here drive
 * visible UI (a saving state and a success/failure toast), so this resolves
 * `true` only when the rewrite turn actually settled and `false` on any
 * failure or timeout. Errors are reported to Sentry, never thrown.
 */

import {
  conversationsByIdArchivePost,
  conversationsPost,
  messagesGet,
  messagesPost,
} from "@/generated/daemon/sdk.gen";
import type { MessagesPostData } from "@/generated/daemon/types.gen";
import { shouldSettlePersonalityPoll } from "@/assistant/personality-rewrite";
import { captureError } from "@/lib/sentry/capture-error";
import { latestAssistantText } from "@/utils/latest-assistant-text";

/** Poll cadence + ceiling while waiting for the rewrite turn to land. */
const POLL_INTERVAL_MS = 1500;
const MAX_POLL_MS = 120_000;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export interface RunIdentityRewriteOptions {
  assistantId: string;
  /** The full `<system-message>…</system-message>` content to post. */
  content: string;
  /** Sidebar-invisible conversation title (useful in logs/inspector). */
  title: string;
  /** Sentry context tag for failures. */
  context: string;
}

export async function runIdentityRewrite({
  assistantId,
  content,
  title,
  context,
}: RunIdentityRewriteOptions): Promise<boolean> {
  let conversationId: string | undefined;
  let settled = false;
  try {
    const conversation = await conversationsPost({
      path: { assistant_id: assistantId },
      body: { conversationType: "standard", title },
      throwOnError: false,
    });
    conversationId = conversation.data?.id;
    if (!conversation.response?.ok || !conversationId) {
      return false;
    }

    const body: MessagesPostData["body"] = {
      conversationId,
      content,
      sourceChannel: "vellum",
      interface: "vellum",
      clientMessageId: crypto.randomUUID(),
    };
    const posted = await messagesPost({
      path: { assistant_id: assistantId },
      body,
      throwOnError: false,
    });
    if (!posted.response?.ok) {
      return false;
    }

    // Let the rewrite turn run before hiding the thread — archiving mid-turn
    // could drop the identity edits. Settle on the daemon's turn-completion
    // flag (see `shouldSettlePersonalityPoll`).
    const deadline = Date.now() + MAX_POLL_MS;
    let lastText = "";
    let stableReads = 0;
    let sawProcessing = false;
    while (Date.now() < deadline) {
      await sleep(POLL_INTERVAL_MS);
      const listed = await messagesGet({
        path: { assistant_id: assistantId },
        query: { conversationId },
        throwOnError: false,
      });
      const text = latestAssistantText(listed.data?.messages ?? []);
      if (text) {
        stableReads = text === lastText ? stableReads + 1 : 0;
        lastText = text;
      }
      if (listed.data?.processing === true) {
        sawProcessing = true;
      }
      if (
        shouldSettlePersonalityPoll({
          processing: listed.data?.processing,
          sawProcessing,
          hasReply: text.length > 0,
          stableReads,
        })
      ) {
        settled = true;
        break;
      }
    }
  } catch (err) {
    captureError(err, { context });
  } finally {
    // Archive the throwaway thread so it never appears in the sidebar.
    if (conversationId) {
      try {
        await conversationsByIdArchivePost({
          path: { assistant_id: assistantId, id: conversationId },
          throwOnError: false,
        });
      } catch (err) {
        captureError(err, { context: `${context}_archive` });
      }
    }
  }
  return settled;
}
