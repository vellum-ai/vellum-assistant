/**
 * Applies the "Create my personality" slider choices to the assistant.
 *
 * SPIKE — research-onboarding flow.
 *
 * The personality step collects five 0–100 trait sliders. On continue we hand
 * them to the real hatched assistant as a system-message that asks it to
 * rewrite its identity files (IDENTITY.md / SOUL.md / users/guardian.md) in a
 * voice matching the new personality — the durable way to reshape its persona,
 * since those files feed every future conversation's system prompt.
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
  conversationsByIdArchivePost,
  conversationsPost,
  messagesGet,
  messagesPost,
} from "@/generated/daemon/sdk.gen";
import type {
  MessagesGetResponses,
  MessagesPostData,
} from "@/generated/daemon/types.gen";
import { captureError } from "@/lib/sentry/capture-error";

/**
 * Axis ids the personality step keys its slider values by. Mirror
 * `PERSONALITY_AXES` in `screens/create-personality-step.tsx`; each is 0–100
 * with 0 = the left label and 100 = the right label.
 */
const AXIS = {
  companionCoworker: "companion-coworker",
  genzBoomer: "genz-boomer",
  executeCollaborate: "execute-collaborate",
  playfulSerious: "playful-serious",
  politeUnfiltered: "polite-unfiltered",
} as const;

/** Poll cadence + ceiling while waiting for the rewrite turn to land. */
const POLL_INTERVAL_MS = 1500;
const MAX_POLL_MS = 120_000;
/** Consecutive identical assistant reads that mark the rewrite turn settled. */
const STABLE_READS_TO_SETTLE = 2;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const clamp = (n: number): number => Math.max(0, Math.min(100, Math.round(n)));

/**
 * Render the personality system-message from the five slider values. Pure, so
 * it's unit-testable without the daemon. Each slider's two ends become explicit
 * 0–100 scores (a slider at 70 toward "Coworker" → Companion 30 / Coworker 70).
 */
export function buildPersonalityMessage(
  values: Record<string, number>,
  userName?: string,
): string {
  const v = (id: string): number => clamp(values[id] ?? 50);
  const companionCoworker = v(AXIS.companionCoworker); // 100 = Coworker
  const executeCollaborate = v(AXIS.executeCollaborate); // 100 = Collaborate
  const playfulSerious = v(AXIS.playfulSerious); // 100 = Serious
  const politeUnfiltered = v(AXIS.politeUnfiltered); // 100 = Unfiltered

  const who = userName?.trim() || "The user";
  return `<system-message>
${who} wants to customize your personality.
This is what they want you to be:
Companion (0-100): ${100 - companionCoworker}
Coworker (0-100): ${companionCoworker}
Voice Style (0 = Gen Z, 100 = Boomer): ${v(AXIS.genzBoomer)}
Execute Independently (0 - 100): ${100 - executeCollaborate}
Collaborative (0 - 100): ${executeCollaborate}
Playfulness (0 - 100): ${100 - playfulSerious}
Seriousness (0 - 100): ${playfulSerious}
Politeness (0 - 100): ${100 - politeUnfiltered}
Unfiltered Rawness/Crassness (0 - 100): ${politeUnfiltered}

Rewrite your identity files (IDENTITY.md, SOUL.md, users/guardian.md) to reflect your new personality. Write them in first person in a voice and style that matches your new personality.
</system-message>`;
}

type GetMessage = MessagesGetResponses[200]["messages"][number];

/** Latest assistant reply text (text blocks, then legacy flat content). */
function latestAssistantText(messages: GetMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!m || m.role !== "assistant") continue;
    const blocks = m.contentBlocks;
    if (blocks && blocks.length > 0) {
      const text = blocks
        .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
        .map((b) => b.text)
        .join("\n")
        .trim();
      if (text) return text;
    }
    return (m.content ?? "").trim();
  }
  return "";
}

export interface ApplyPersonalityOptions {
  /** Resolves with the hatched assistant id once it's healthy. */
  awaitAssistantId: () => Promise<string>;
  /** The five slider values, keyed by axis id (see `AXIS`). */
  values: Record<string, number>;
  /** The user's name, woven into the system-message. */
  userName?: string;
}

/**
 * Apply the personality on a throwaway side conversation. Resolves once the
 * conversation has been archived (or immediately on any failure); never throws.
 */
export async function applyPersonality({
  awaitAssistantId,
  values,
  userName,
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
      content: buildPersonalityMessage(values, userName),
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
    // could drop the identity edits. Settle once the reply stops changing.
    const deadline = Date.now() + MAX_POLL_MS;
    let lastText = "";
    let stableReads = 0;
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
        if (stableReads >= STABLE_READS_TO_SETTLE) break;
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
