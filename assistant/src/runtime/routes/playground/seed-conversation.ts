/**
 * POST /v1/playground/seed-conversation
 *
 * Creates a synthetic conversation for compaction testing. Inserts N
 * user/assistant message pairs of roughly `avgTokensPerTurn` tokens each and
 * returns the new conversation id plus an estimated prompt-token count.
 *
 * Seeded conversations are prefixed with `[Playground] ` so other playground
 * endpoints (e.g. seeded-conversations list/delete) can filter by prefix.
 */

import { z } from "zod";

import { estimatePromptTokens } from "../../../context/token-estimator.js";
import type { Message } from "../../../providers/types.js";
import { BadRequestError } from "../errors.js";
import type { RouteDefinition } from "../types.js";
import { assertPlaygroundEnabled } from "./guard.js";
import { addPlaygroundMessage, createPlaygroundConversation } from "./helpers.js";

/**
 * Title prefix applied to every seeded-playground conversation. Exported so
 * sibling playground endpoints (list/delete) can share the exact string
 * rather than duplicating a literal.
 */
export const PLAYGROUND_TITLE_PREFIX = "[Playground] ";

const SeedBodySchema = z.object({
  turns: z.number().int().positive().max(500),
  avgTokensPerTurn: z
    .number()
    .int()
    .positive()
    .max(5000)
    .optional()
    .default(500),
  title: z.string().trim().max(120).optional(),
});

const LOREM_BASE =
  "Lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. ";

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "playgroundSeedConversation",
    endpoint: "playground/seed-conversation",
    method: "POST",
    policyKey: "playground/seed-conversation",
    summary: "Create a synthetic seeded conversation for compaction testing",
    tags: ["playground"],
    requestBody: SeedBodySchema,
    handler: async ({ body }) => {
      assertPlaygroundEnabled();

      const parsed = SeedBodySchema.safeParse(body);
      if (!parsed.success) {
        throw new BadRequestError(parsed.error.message);
      }
      const { turns, avgTokensPerTurn, title } = parsed.data;

      const userSuppliedTitle =
        title && title.length > 0
          ? title
          : new Date().toISOString().slice(0, 19);
      const withoutPrefix = userSuppliedTitle.startsWith(
        PLAYGROUND_TITLE_PREFIX,
      )
        ? userSuppliedTitle.slice(PLAYGROUND_TITLE_PREFIX.length)
        : userSuppliedTitle;
      const effectiveTitle = PLAYGROUND_TITLE_PREFIX + withoutPrefix;

      const { id: conversationId } =
        createPlaygroundConversation(effectiveTitle);

      const charsPerMessage = avgTokensPerTurn * 4;

      const messages: Array<{ role: "user" | "assistant"; text: string }> = [];
      for (let i = 0; i < turns; i++) {
        const userBase = `Turn ${i + 1} user message: ` + LOREM_BASE;
        const userText = userBase
          .repeat(Math.ceil(charsPerMessage / userBase.length))
          .slice(0, charsPerMessage);
        const asstBase = `Turn ${i + 1} assistant response: ` + LOREM_BASE;
        const asstText = asstBase
          .repeat(Math.ceil(charsPerMessage / asstBase.length))
          .slice(0, charsPerMessage);
        messages.push({ role: "user", text: userText });
        messages.push({ role: "assistant", text: asstText });
      }

      for (const msg of messages) {
        const contentJson = JSON.stringify([
          { type: "text", text: msg.text },
        ]);
        await addPlaygroundMessage(conversationId, msg.role, contentJson, {
          skipIndexing: true,
        });
      }

      const estimatorMessages: Message[] = messages.map((m) => ({
        role: m.role,
        content: [{ type: "text", text: m.text }],
      }));
      const estimatedTokens = estimatePromptTokens(estimatorMessages);

      return {
        conversationId,
        messagesInserted: messages.length,
        estimatedTokens,
      };
    },
  },
];
