/**
 * Starting a conversation the user is not looking at.
 *
 * A background launch creates a conversation, links it somewhere, and sends
 * one prompt into it, all while the surface that triggered it stays on screen
 * and the visible conversation is left alone. That is deliberately NOT
 * `prepareFreshConversation()` from `conversation-navigation.ts`: that helper
 * selects the new draft and reveals the chat, which is right for "new chat"
 * and wrong here, since it would swap the transcript under an open modal while
 * the URL still points at the conversation the user was reading.
 *
 * The conversation is created by the daemon up front rather than minted
 * client-side. A caller that has to record a link BEFORE the prompt is sent
 * needs an id the daemon can already resolve: `POST /v1/messages` looks a
 * `conversationId` up strictly and 404s on a miss (see
 * `lib/backwards-compat/conversation-id-wire-field.ts`), and its
 * create-on-first-send branches either mint their own id or key off an
 * external `conversationKey`. One extra round trip buys an id that the link
 * and the send agree about.
 *
 * The seam lives in `lib/` rather than `utils/` because it does network I/O
 * and reaches into the chat domain's message API, neither of which belongs in
 * a directory reserved for pure functions. The conversation is a real
 * conversation: it is in the sidebar list from the moment it exists, and
 * opening it later streams like any other.
 */

import {
  postChatMessage,
  type PostMessageResult,
} from "@/domains/chat/api/messages";
import {
  conversationsByIdDelete,
  conversationsPost,
} from "@/generated/daemon/sdk.gen";
import { extractErrorMessage } from "@/utils/api-errors";

export type CreateBackgroundConversationResult =
  | { ok: true; conversationId: string }
  | { ok: false; error: string };

export interface CreateBackgroundConversationArgs {
  assistantId: string;
  /**
   * Copy to show when the failure carried no message of its own. Supplied by
   * the caller because the error is displayed by a feature surface and this
   * seam sits below any locale namespace a domain owns.
   */
  fallback: string;
}

/**
 * Create the conversation a background turn will run in.
 *
 * `standard` (the daemon's default) on purpose: this is a conversation the
 * user is meant to be able to open, unlike the `background` rows the
 * onboarding and identity flows create for work nobody should ever see. No
 * title either, so the auto titler names it from the turn once it runs.
 *
 * Never throws: a transport failure comes back as `ok: false` so a caller's
 * result contract holds on every path.
 */
export async function createBackgroundConversation({
  assistantId,
  fallback,
}: CreateBackgroundConversationArgs): Promise<CreateBackgroundConversationResult> {
  try {
    const { data, error, response } = await conversationsPost({
      path: { assistant_id: assistantId },
      body: {},
      throwOnError: false,
    });
    const conversationId = data?.id;
    if (!response?.ok || !conversationId) {
      return {
        ok: false,
        error: extractErrorMessage(error, response, fallback),
      };
    }
    return { ok: true, conversationId };
  } catch (error) {
    return {
      ok: false,
      error: extractErrorMessage(error, undefined, fallback),
    };
  }
}

/**
 * Give back a background conversation nothing will ever use.
 *
 * Only for the window between creating a conversation and the caller deciding
 * it has no owner: an empty row left behind sits in the sidebar as a
 * conversation the user never started. A conversation that has been linked to
 * something, or that carries a message, belongs to whoever linked it.
 *
 * Never throws and never reports: the caller has already failed at something
 * more important, and a leftover empty conversation costs one stray row.
 */
export async function discardBackgroundConversation(
  assistantId: string,
  conversationId: string,
): Promise<void> {
  try {
    await conversationsByIdDelete({
      path: { assistant_id: assistantId, id: conversationId },
      throwOnError: false,
    });
  } catch {
    // Best effort by contract.
  }
}

export interface SendBackgroundPromptArgs {
  assistantId: string;
  /** A conversation from {@link createBackgroundConversation}. */
  conversationId: string;
  prompt: string;
  /**
   * Whether the words are generated rather than typed. `true` for a prompt a
   * surface supplies, where the user chose the button and not the sentence;
   * `false` for text the user wrote into a field, which is typed engagement
   * however it is sent.
   *
   * Required rather than defaulted: the marker is what activation analytics
   * excludes on, and an omitted marker reads as unknown rather than false, so
   * a caller that forgets it either loses a real turn from the numbers or
   * leaves a generated one counted as engagement.
   */
  scripted: boolean;
}

/**
 * Send one prompt into a background conversation.
 *
 * The id names a row the daemon already holds, so the strict `conversationId`
 * wire field resolves it on assistants that use it and the legacy
 * `conversationKey` lookup finds it on assistants that do not.
 */
export async function sendBackgroundPrompt({
  assistantId,
  conversationId,
  prompt,
  scripted,
}: SendBackgroundPromptArgs): Promise<PostMessageResult> {
  return postChatMessage(assistantId, conversationId, prompt, { scripted });
}
