/**
 * Default `attachment-read-hint` hook: when the turn's resolved model is one
 * that under-prioritizes attachments and the tail user message carries image
 * or file blocks, append a short hint steering the model to read the attached
 * content before running discovery tools.
 *
 * Gated on the resolved model so models that already read attachments first
 * pay no token cost. Runs after the memory-retrieval and history-repair
 * defaults, so the hint lands on the fully assembled, normalized tail
 * message.
 */

import type {
  PluginHookFn,
  UserPromptSubmitContext,
} from "@vellumai/plugin-api";

import {
  injectAttachmentReadHint,
  modelNeedsAttachmentReadHint,
} from "../inject.js";

const userPromptSubmit: PluginHookFn<UserPromptSubmitContext> = async (ctx) => {
  if (!modelNeedsAttachmentReadHint(ctx.resolvedModel)) return;
  const tailIndex = ctx.latestMessages.length - 1;
  const tail = ctx.latestMessages[tailIndex];
  if (!tail || tail.role !== "user") return;
  const withHint = injectAttachmentReadHint(tail);
  if (withHint === tail) return;
  ctx.latestMessages[tailIndex] = withHint;
  ctx.logger.info(
    { plugin: "attachment-read-hint", model: ctx.resolvedModel },
    "Appended attachment-read hint to tail user message",
  );
};

export default userPromptSubmit;
