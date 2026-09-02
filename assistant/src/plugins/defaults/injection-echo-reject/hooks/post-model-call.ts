/**
 * Default `post-model-call` hook: when a user-facing completion opens with a
 * reserved runtime-injection envelope, discard the whole reply (text and tool
 * calls) and re-query with a rejection notice in context.
 *
 * Completers continue the tail user message, which carries platform injection
 * wrappers (`<turn_context>`, `<memory>`, `<memory_spotlight>`, …). Opening a
 * reply with one of those tags is a leaked envelope, not a user-facing answer.
 * Mid-message XML and quoted tag names are left alone.
 *
 * The leaked body is not written back into history (that would re-teach the
 * template). The nudge names the reserved tag and asks for a normal reply.
 * Tool calls that arrived with the leak are dropped so the loop does not
 * execute them. Main-agent turns only. Bounded to one pass per run; the
 * sibling `stop` hook clears the mark when the turn terminates.
 */

import {
  type HookFunction,
  INTERNAL_NUDGE_OUTPUT_SUPPRESSION,
  type PostModelCallContext,
} from "@vellumai/plugin-api";

import {
  classifyLeadingReservedInjection,
  concatenateAssistantText,
} from "../../../../context/reserved-injection-envelope.js";
import {
  isInjectionEchoRejected,
  markInjectionEchoRejected,
} from "../reject-state-store.js";

/**
 * Rejection notice appended as a user turn so the next model call sees why
 * the previous completion was discarded. Shown to the LLM, not the user.
 */
export function buildInjectionEchoNudgeText(tag: string): string {
  return (
    `<system_notice>Your previous reply was rejected because it opened with a reserved runtime-injection envelope (<${tag}>). Never emit reserved platform injection tags such as <turn_context>, <memory>, <memory_spotlight>, or <system_notice>. Reply to the user normally.` +
    INTERNAL_NUDGE_OUTPUT_SUPPRESSION +
    "</system_notice>"
  );
}

const postModelCall: HookFunction<PostModelCallContext> = async (ctx) => {
  if (ctx.error) {
    return;
  }
  if (ctx.callSite !== "mainAgent") {
    return;
  }

  const classification = classifyLeadingReservedInjection(
    concatenateAssistantText(ctx.content),
    { complete: true },
  );
  if (classification.status !== "reserved") {
    return;
  }

  // Drop the leaked completion before any retry decision so a refused
  // continue still cannot persist the envelope or execute its tool calls.
  ctx.content = [];

  if (isInjectionEchoRejected(ctx.conversationId)) {
    ctx.logger.error(
      {
        plugin: "injection-echo-reject",
        conversationId: ctx.conversationId,
        tag: classification.tag,
      },
      "Model opened with a reserved runtime-injection envelope — retries exhausted",
    );
    return;
  }

  markInjectionEchoRejected(ctx.conversationId);
  ctx.messages.push({
    role: "user",
    content: [
      { type: "text", text: buildInjectionEchoNudgeText(classification.tag) },
    ],
  });
  ctx.decision = "continue";
  ctx.logger.warn(
    {
      plugin: "injection-echo-reject",
      conversationId: ctx.conversationId,
      tag: classification.tag,
    },
    "Model opened with a reserved runtime-injection envelope — rejecting and retrying",
  );
};

export default postModelCall;
