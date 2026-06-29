/**
 * `channel` plugin injectors.
 *
 * Contributes the Slack channel per-turn injections: the chronological
 * transcript that replaces the conversation's run messages, and the
 * `<active_thread>` focus block for non-DM threads. Both read their inputs off
 * the {@link TurnContext}; see {@link DEFAULT_INJECTOR_ORDER} for the global
 * ordering contract.
 */

import {
  type InjectionBlock,
  type Injector,
  type TurnContext,
} from "../../types.js";
import { DEFAULT_INJECTOR_ORDER } from "../injector-order.js";

/**
 * `slack-messages` injector — order 60, replace-run-messages.
 *
 * Swaps the conversation's `runMessages` array with a pre-rendered
 * chronological Slack transcript built from the persisted message rows.
 * Applied to every Slack conversation (channels and DMs alike). The
 * orchestrator builds the transcript via `loadSlackChronologicalContext`
 * before the chain runs.
 *
 * Memory-block prepending is preserved across the replacement:
 * `extractMemoryPrefixBlocks` is re-applied to the Slack transcript's tail
 * user message inside `applyRuntimeInjections` when the replacement fires.
 *
 * Active in both `full` and `minimal` mode — Slack transcript replacement
 * is not a high-token optional block, it's the canonical view of Slack
 * history for the model.
 *
 * Gating:
 *  - `channelCapabilities.channel === "slack"`.
 *  - `slackChronologicalMessages` has at least one entry.
 */
const slackMessagesInjector: Injector = {
  name: "slack-messages",
  order: DEFAULT_INJECTOR_ORDER.slackMessages,
  async produce(ctx: TurnContext): Promise<InjectionBlock | null> {
    if (ctx.channelCapabilities?.channel !== "slack") return null;
    const messages = ctx.slackChronologicalMessages;
    if (!messages || messages.length === 0) return null;
    return {
      id: "slack-messages",
      // `text` is informational only — `replace-run-messages` placements
      // bypass the tail-user-message splice path. Kept non-empty so
      // `composeInjectorChain` (text-only consumers) still counts this
      // injector as contributing content.
      text: "[slack-chronological-transcript]",
      placement: "replace-run-messages",
      messagesOverride: messages,
    };
  },
};

/**
 * `thread-focus` injector — order 70, append-user-tail.
 *
 * Appends a non-persisted `<active_thread>` block listing the parent +
 * replies of the thread the current inbound user message belongs to, so
 * the model can orient even when the channel-wide chronological transcript
 * is long and interleaved.
 *
 * The orchestrator builds the block via `loadSlackActiveThreadFocusBlock`
 * (which short-circuits for DMs). This injector wraps the value so the
 * block is applied declaratively through the chain.
 *
 * Gating:
 *  - `mode === "full"`.
 *  - `channelCapabilities.channel === "slack"` and `chatType === "channel"`
 *    (non-DM Slack conversation).
 *  - `slackActiveThreadFocusBlock` is a non-empty string.
 */
const threadFocusInjector: Injector = {
  name: "thread-focus",
  order: DEFAULT_INJECTOR_ORDER.threadFocus,
  async produce(ctx: TurnContext): Promise<InjectionBlock | null> {
    const mode = ctx.mode ?? "full";
    if (mode !== "full") return null;
    const caps = ctx.channelCapabilities;
    if (!caps || caps.channel !== "slack" || caps.chatType !== "channel") {
      return null;
    }
    const block = ctx.slackActiveThreadFocusBlock;
    if (typeof block !== "string" || block.length === 0) return null;
    return {
      id: "thread-focus",
      text: block,
      placement: "append-user-tail",
    };
  },
};

/** The `channel` plugin's runtime injectors, in ascending `order`. */
export const channelInjectors: Injector[] = [
  slackMessagesInjector,
  threadFocusInjector,
];
