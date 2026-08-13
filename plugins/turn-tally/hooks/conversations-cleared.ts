/**
 * `conversations-cleared` hook: wipes every tally when the clear-all
 * reset removes every conversation at once. The context carries no
 * conversation id, so per-conversation state is dropped wholesale.
 */

import type {
  ConversationsClearedContext,
  HookFunction,
} from "@vellumai/plugin-api";

import { purgeAll } from "../src/tally-store.js";

const conversationsCleared: HookFunction<ConversationsClearedContext> = async (
  _ctx,
) => {
  purgeAll();
};

export default conversationsCleared;
