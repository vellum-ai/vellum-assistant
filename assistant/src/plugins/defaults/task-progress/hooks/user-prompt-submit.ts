import {
  type HookFunction,
  type UserPromptSubmitContext,
} from "@vellumai/plugin-api";

import { applyTaskProgressContext } from "../src/apply-task-progress-context.js";

const userPromptSubmit: HookFunction<UserPromptSubmitContext> = async (
  ctx,
) => {
  try {
    ctx.latestMessages = applyTaskProgressContext(
      ctx.conversationId,
      ctx.latestMessages,
    );
  } catch (err) {
    ctx.logger.warn(
      { err, conversationId: ctx.conversationId },
      "Failed to apply task-progress context; leaving working history unchanged",
    );
  }
};

export default userPromptSubmit;
