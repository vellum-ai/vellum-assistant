/** Release memory work that a terminal voice front-door outcome will not use. */

import type {
  HookFunction,
  VoiceFrontDoorSettledContext,
} from "@vellumai/plugin-api";

import { cancelVoiceMemoryV3Prefetch } from "../v3/voice-prefetch.js";

const voiceFrontDoorSettled: HookFunction<
  VoiceFrontDoorSettledContext
> = async (ctx): Promise<void> => {
  if (ctx.outcome !== "escalate") {
    cancelVoiceMemoryV3Prefetch(ctx.conversationId);
  }
};

export default voiceFrontDoorSettled;
