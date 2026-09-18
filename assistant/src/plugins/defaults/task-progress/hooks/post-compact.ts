import {
  type HookFunction,
  type PostCompactContext,
} from "@vellumai/plugin-api";

import { applyTaskProgressContext } from "../src/apply-task-progress-context.js";

const postCompact: HookFunction<PostCompactContext> = async (ctx) => {
  try {
    ctx.history = applyTaskProgressContext(ctx.conversationId, ctx.history);
  } catch (err) {
    ctx.logger.warn(
      { err, conversationId: ctx.conversationId },
      "Failed to apply task-progress context; leaving compacted history unchanged",
    );
  }
};

export default postCompact;
