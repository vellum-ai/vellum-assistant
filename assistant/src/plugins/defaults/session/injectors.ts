/**
 * `session` plugin injectors.
 *
 * Contributes the session-state per-turn injections: the `<background_turn>`
 * framing (the guardian isn't watching) and the `<active_subagents>` status
 * block. Both read their inputs off the {@link TurnContext}; see
 * {@link DEFAULT_INJECTOR_ORDER} for the global ordering contract.
 */

import { getConfig } from "../../../config/loader.js";
import {
  type InjectionBlock,
  type Injector,
  type TurnContext,
} from "../../types.js";
import { DEFAULT_INJECTOR_ORDER } from "../injector-order.js";

/**
 * `background-turn` injector — order 15, prepend-user-tail.
 *
 * Wraps the tail user message with a `<background_turn>` block that tells
 * the assistant the guardian isn't watching and that anything noteworthy
 * should be surfaced via the `notifications` skill. Fires only when (a) the
 * conversation's type is "background" or "scheduled" (see
 * `isBackgroundConversationType`) AND (b) no client is currently connected
 * (`isNonInteractive`). The second gate is what prevents the reminder from
 * firing on a manual follow-up the guardian sends into a background thread
 * — at that point the guardian IS watching, so the framing doesn't apply.
 *
 * The inner text is read from `config.conversations.backgroundInjection`, so
 * operators can edit the reminder without a code change. Setting it to the
 * empty string disables the injection entirely.
 */
const backgroundTurnInjector: Injector = {
  name: "background-turn",
  order: DEFAULT_INJECTOR_ORDER.backgroundTurn,
  async produce(ctx: TurnContext): Promise<InjectionBlock | null> {
    if (!ctx.isBackgroundConversation) return null;
    if (!ctx.isNonInteractive) return null;
    const inner = getConfig().conversations.backgroundInjection;
    if (!inner) return null;
    return {
      id: "background-turn",
      text: `<background_turn>\n${inner}\n</background_turn>`,
      placement: "prepend-user-tail",
    };
  },
};

/**
 * `subagent-status` injector — order 50, append-user-tail.
 *
 * Appends a pre-built `<active_subagents>` block to the tail user message
 * so the parent LLM has visibility into active/completed child subagents.
 *
 * `applyRuntimeInjections` resolves the block from the live subagent manager
 * before the chain runs; this injector is a thin passthrough that applies
 * gating and positioning.
 *
 * Gating:
 *  - `mode === "full"`.
 *  - `subagentStatusBlock` is a non-null, non-empty string.
 */
const subagentStatusInjector: Injector = {
  name: "subagent-status",
  order: DEFAULT_INJECTOR_ORDER.subagentStatus,
  async produce(ctx: TurnContext): Promise<InjectionBlock | null> {
    const mode = ctx.mode ?? "full";
    if (mode !== "full") return null;
    const block = ctx.subagentStatusBlock;
    if (!block) return null;
    return {
      id: "subagent-status",
      text: block,
      placement: "append-user-tail",
    };
  },
};

/** The `session` plugin's runtime injectors, in ascending `order`. */
export const sessionInjectors: Injector[] = [
  backgroundTurnInjector,
  subagentStatusInjector,
];
