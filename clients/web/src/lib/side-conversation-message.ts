/**
 * Builds the `POST /messages` body for a throwaway side conversation.
 *
 * Onboarding research, the research correction, the personality apply, and the
 * identity rewrite each mint a conversation the user never opens, post one
 * prompt, wait for the turn, then archive it. Those prompts are machine
 * signals the user never typed, so they all post `hidden: true`. Hidden keeps
 * the prompt out of the visible transcript and is the marker the daemon's
 * assistant-reply push producer gates on, so the reply never notifies the user
 * with a deep link into an archived thread.
 *
 * Every such flow builds its body here, so a new one cannot drop the marker.
 *
 * They also all post `scripted: true` for the same reason, and it is a
 * SEPARATE marker from `hidden` rather than a synonym. `hidden` controls
 * transcript visibility and push suppression; `scripted` tells turn telemetry
 * the turn was auto-sent, so activation metrics exclude it. The two diverge in
 * both directions: the onboarding research prompt is visible AND scripted,
 * and a flow could in principle hide a turn the user really typed, so neither
 * can be inferred from the other. Without `scripted`, these turns are only
 * excluded from activation for owners whose diagnostics consent lets the
 * server-side trace classifier read their message text, which is the
 * measurement gap ANT-10 was filed for.
 */

import type { MessagesPostData } from "@/generated/daemon/types.gen";
import { detectClientOs } from "@/runtime/platform-detection";

export interface SideConversationMessageOptions {
  conversationId: string;
  content: string;
  /**
   * Wire transport. `"web"` additionally carries the real OS in `clientOs`, so
   * the assistant's per-turn `client_os` context stays correct without
   * affecting transport/host-proxy gating (mirrors
   * `domains/chat/api/messages.ts`).
   */
  transport: "vellum" | "web";
}

export function buildSideConversationMessageBody({
  conversationId,
  content,
  transport,
}: SideConversationMessageOptions): MessagesPostData["body"] {
  const body: MessagesPostData["body"] = {
    conversationId,
    content,
    sourceChannel: "vellum",
    interface: transport,
    hidden: true,
    // Auto-sent on the user's behalf, never typed. See the header. Excluded
    // from activation counts for every owner, not just the ones the
    // consent-gated trace classifier can see.
    scripted: true,
    clientMessageId: crypto.randomUUID(),
  };
  if (transport === "web") {
    body.clientOs = detectClientOs();
  }
  return body;
}
