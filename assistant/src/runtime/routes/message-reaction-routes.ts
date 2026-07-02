/**
 * Route handler for user-placed message reactions.
 *
 * POST /v1/message-reactions — add or remove the user's emoji reaction on an
 * assistant message.
 *
 * Alongside the metadata write, an `add` persists a compact hidden user row
 * (`<user_reaction …>`) so the reaction reaches the model's context on its
 * next turn: hidden rows stay in the LLM-side history but are filtered from
 * the UI transcript, whose reaction display is the chip driven by the target
 * message's `reactions` metadata. Reactions are a silent signal — persisting
 * one never triggers an agent turn (mirrors the Slack reaction-intercept
 * precedent).
 */

import { z } from "zod";

import { ConversationMessageReactionSchema } from "../../api/responses/conversation-message.js";
import { getConfig } from "../../config/loader.js";
import { isMessageReactionsEnabled } from "../../config/message-reactions-gate.js";
import {
  addMessage,
  appendMessageReaction,
  getMessageById,
  type MessageReaction,
  removeMessageReaction,
} from "../../persistence/conversation-crud.js";
import { isSingleEmoji } from "../../util/emoji.js";
import { ACTOR_PRINCIPALS } from "../auth/route-policy.js";
import { publishMessageReactionUpdated } from "../sync/message-reaction-events.js";
import { BadRequestError, NotFoundError } from "./errors.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

/** Actor recorded on reactions placed through this route. */
const USER_REACTION_ACTOR = "user";

/** Max characters of target-message text quoted in the context signal row. */
const SNIPPET_MAX_LENGTH = 80;

/**
 * Short plain-text excerpt of a persisted message body, for quoting in the
 * hidden context row. Joins the text blocks of a content-block array;
 * non-JSON content is treated as plain text.
 */
export function messageSnippet(content: string): string {
  let text = content;
  try {
    const parsed = JSON.parse(content) as unknown;
    if (Array.isArray(parsed)) {
      text = parsed
        .filter(
          (block): block is { type: "text"; text: string } =>
            typeof block === "object" &&
            block !== null &&
            (block as { type?: unknown }).type === "text" &&
            typeof (block as { text?: unknown }).text === "string",
        )
        .map((block) => block.text)
        .join(" ");
    }
  } catch {
    // Plain-string content is already text.
  }
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length > SNIPPET_MAX_LENGTH
    ? `${collapsed.slice(0, SNIPPET_MAX_LENGTH)}…`
    : collapsed;
}

/**
 * Persist the hidden `<user_reaction>` signal row that carries the reaction
 * into the model's context. The row is `hidden` (LLM-visible, UI-filtered)
 * and skips lexical indexing — it is a signal, not searchable content.
 */
async function persistReactionContextRow(
  conversationId: string,
  emoji: string,
  op: "add" | "remove",
  snippet: string,
): Promise<void> {
  const quoted = snippet ? `: "${snippet}"` : "";
  const text =
    op === "add"
      ? `<user_reaction emoji="${emoji}">The user reacted with ${emoji} to your message${quoted}</user_reaction>`
      : `<user_reaction emoji="${emoji}" removed="true">The user removed their ${emoji} reaction from your message${quoted}</user_reaction>`;
  await addMessage(
    conversationId,
    "user",
    JSON.stringify([{ type: "text", text }]),
    { metadata: { hidden: true }, skipIndexing: true },
  );
}

async function handleSetMessageReaction({ body = {} }: RouteHandlerArgs): Promise<{
  messageId: string;
  reactions: MessageReaction[];
}> {
  // Flag-off reads as endpoint-absent (404), which the web client already
  // treats as "this assistant doesn't support reactions".
  if (!isMessageReactionsEnabled(getConfig())) {
    throw new NotFoundError("Message reactions are not enabled");
  }

  const conversationId = body.conversationId as string | undefined;
  const messageId = body.messageId as string | undefined;
  const emoji = typeof body.emoji === "string" ? body.emoji.trim() : undefined;
  const op = (body.op as "add" | "remove" | undefined) ?? "add";

  if (!conversationId || typeof conversationId !== "string") {
    throw new BadRequestError("conversationId is required");
  }
  if (!messageId || typeof messageId !== "string") {
    throw new BadRequestError("messageId is required");
  }
  if (op !== "add" && op !== "remove") {
    throw new BadRequestError('op must be "add" or "remove"');
  }
  if (!emoji || !isSingleEmoji(emoji)) {
    throw new BadRequestError("emoji must be a single Unicode emoji");
  }

  const target = getMessageById(messageId, conversationId);
  if (!target) {
    throw new NotFoundError(
      `Message ${messageId} not found in conversation ${conversationId}`,
    );
  }
  if (target.role !== "assistant") {
    throw new BadRequestError(
      "User reactions can only be placed on assistant messages",
    );
  }

  const reaction = { emoji, actor: USER_REACTION_ACTOR };
  const before = target.metadata;
  const reactions =
    op === "add"
      ? appendMessageReaction(messageId, { ...reaction, createdAt: Date.now() })
      : removeMessageReaction(messageId, reaction);
  if (!reactions) {
    throw new NotFoundError(`Message ${messageId} no longer exists`);
  }

  // Only a state change publishes and signals the model — an idempotent
  // repeat (re-adding an existing reaction, removing an absent one) is a
  // no-op so rapid toggles don't stack duplicate context rows.
  const after = getMessageById(messageId, conversationId)?.metadata;
  if (after !== before) {
    publishMessageReactionUpdated(conversationId, messageId, reactions);
    await persistReactionContextRow(
      conversationId,
      emoji,
      op,
      messageSnippet(target.content),
    );
  }

  return { messageId, reactions };
}

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "message_reactions_set",
    endpoint: "message-reactions",
    method: "POST",
    policy: {
      requiredScopes: ["chat.write"],
      allowedPrincipalTypes: ACTOR_PRINCIPALS,
    },
    summary: "Add or remove a user reaction on a message",
    description:
      "Add (default) or remove the user's emoji reaction on an assistant message. Idempotent per (emoji, op) — repeating an operation returns the current reaction set unchanged.",
    tags: ["messages"],
    requestBody: z.object({
      conversationId: z.string(),
      messageId: z.string(),
      emoji: z.string(),
      op: z.enum(["add", "remove"]).optional(),
    }),
    responseBody: z.object({
      messageId: z.string(),
      reactions: z.array(ConversationMessageReactionSchema),
    }),
    handler: handleSetMessageReaction,
  },
];
