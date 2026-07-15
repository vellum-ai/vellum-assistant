/**
 * Applies the "Create my personality" slider choices to the assistant.
 *
 * SPIKE — research-onboarding flow.
 *
 * The personality step collects five 0–100 trait sliders. On continue we hand
 * them to the real hatched assistant as a system-message that asks it to
 * rewrite its own identity files (IDENTITY.md / SOUL.md) in a voice matching
 * the new personality (see `@/assistant/personality-rewrite` for the message
 * and settle logic, shared with the About Assistant personality page). The
 * user's profile (users/guardian.md) is left untouched.
 *
 * Like the research turn (`research-runner.ts`) and the check-in
 * (`checkin-scheduler.ts`), this runs on a dedicated throwaway side
 * conversation: we await hatch readiness, mint a conversation, post the prompt,
 * let the rewrite turn settle, then archive it so it never shows in the user's
 * sidebar. Talks to the daemon through the generated SDK directly
 * (`@/domains/chat/api/*` is import-banned from onboarding).
 *
 * Best-effort and fire-and-forget: a failure here must never block or surface
 * in the onboarding flow. Every error is swallowed (reported to Sentry).
 */

import {
  buildPersonalityMessage,
  shouldSettlePersonalityPoll,
} from "@/assistant/personality-rewrite";
import {
  conversationsByIdArchivePost,
  conversationsPost,
  messagesGet,
  messagesPost,
} from "@/generated/daemon/sdk.gen";
import type { MessagesPostData } from "@/generated/daemon/types.gen";
import { captureError } from "@/lib/sentry/capture-error";
import { latestAssistantText } from "@/utils/latest-assistant-text";

export {
  buildPersonalityMessage,
  shouldSettlePersonalityPoll,
} from "@/assistant/personality-rewrite";

/** Poll cadence + ceiling while waiting for the rewrite turn to land. */
const POLL_INTERVAL_MS = 1500;
const MAX_POLL_MS = 120_000;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export interface ApplyPersonalityOptions {
  /** Resolves with the hatched assistant id once it's healthy. */
  awaitAssistantId: () => Promise<string>;
  /** The five slider values, keyed by axis id (see `PERSONALITY_AXIS_IDS`). */
  values: Record<string, number>;
  /** The user's name, woven into the system-message. */
  userName?: string;
  /**
   * The assistant name picked on the face screen. Passed through so the
   * rewrite writes the chosen name instead of trusting its (possibly stale)
   * system-prompt copy of IDENTITY.md.
   */
  assistantName?: string;
}

/**
 * Apply the personality on a throwaway side conversation. Resolves once the
 * conversation has been archived (or immediately on any failure); never throws.
 */
export async function applyPersonality({
  awaitAssistantId,
  values,
  userName,
  assistantName,
}: ApplyPersonalityOptions): Promise<void> {
  let assistantId: string | undefined;
  let conversationId: string | undefined;
  try {
    assistantId = await awaitAssistantId();

    const conversation = await conversationsPost({
      path: { assistant_id: assistantId },
      body: { conversationType: "standard", title: "Updating personality" },
      throwOnError: false,
    });
    conversationId = conversation.data?.id;
    if (!conversation.response?.ok || !conversationId) return;

    const body: MessagesPostData["body"] = {
      conversationId,
      content: buildPersonalityMessage(values, userName, assistantName),
      sourceChannel: "vellum",
      interface: "vellum",
      clientMessageId: crypto.randomUUID(),
    };
    const posted = await messagesPost({
      path: { assistant_id: assistantId },
      body,
      throwOnError: false,
    });
    if (!posted.response?.ok) return;

    // Let the rewrite turn run before hiding the thread — archiving mid-turn
    // could drop the identity edits, and the chat handoff awaits this promise
    // so the first greeting must not start until the identity files are
    // written. Settle on the daemon's turn-completion flag (see
    // `shouldSettlePersonalityPoll`).
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
        break;
      }
    }
  } catch (err) {
    captureError(err, { context: "research_onboarding_personality" });
  } finally {
    // Archive the throwaway thread so it never appears in the sidebar.
    if (assistantId && conversationId) {
      try {
        await conversationsByIdArchivePost({
          path: { assistant_id: assistantId, id: conversationId },
          throwOnError: false,
        });
      } catch (err) {
        captureError(err, { context: "research_onboarding_personality_archive" });
      }
    }
  }
}
