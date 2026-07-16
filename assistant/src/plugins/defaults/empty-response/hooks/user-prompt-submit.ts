/**
 * Default `user-prompt-submit` hook: at turn start, drop every previously-
 * refused exchange from the working history so a safety-classifier refusal on
 * one turn doesn't poison the whole conversation by re-sending (and re-tripping
 * on) the flagged prompt every turn.
 *
 * Detection keys on the plugin's own persisted `REFUSAL_FALLBACK_TEXT` marker
 * (an exact whole-message match), so the sweep is self-limiting to exchanges
 * this plugin already rewrote. Mirrors the `image-fallback` turn-start sweep.
 * Registered before `history-repair`, whose normalization pass cleans up any
 * role-alternation artifact left by a dropped run.
 */

import type {
  HookFunction,
  UserPromptSubmitContext,
} from "@vellumai/plugin-api";

import { quarantineRefusedExchanges } from "../refusal-quarantine.js";

const userPromptSubmit: HookFunction<UserPromptSubmitContext> = async (ctx) => {
  const { messages, droppedExchanges } = quarantineRefusedExchanges(
    ctx.latestMessages,
  );
  if (droppedExchanges > 0) {
    ctx.latestMessages = messages;
    ctx.logger.warn(
      {
        plugin: "empty-response",
        conversationId: ctx.conversationId,
        droppedExchanges,
      },
      "Quarantined previously-refused exchange(s) from working history before provider call",
    );
  }
};

export default userPromptSubmit;
