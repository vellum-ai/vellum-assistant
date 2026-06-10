/**
 * Tests for the default `attachment-read-hint` plugin's `user-prompt-submit`
 * hook.
 *
 * - Model gating: the hint fires only when the turn's resolved model is one
 *   that under-prioritizes attachments (Kimi K2.6, under both the Fireworks
 *   and Moonshot id schemes). Other models — including Kimi K2.5 — and an
 *   unresolved model leave the messages untouched.
 * - Attachment gating: the hint fires only when the tail user message carries
 *   an `image` or `file` block; text-only turns and non-user tails are
 *   untouched.
 * - End-to-end through `runHook` + the registry: registering the default
 *   plugin makes the hook fire and append the hint.
 */

import { beforeEach, describe, expect, test } from "bun:test";

import { HOOKS } from "../plugin-api/constants.js";
import type {
  PluginLogger,
  UserPromptSubmitContext,
} from "../plugin-api/types.js";
import userPromptSubmit from "../plugins/defaults/attachment-read-hint/hooks/user-prompt-submit.js";
import {
  ATTACHMENT_READ_HINT,
  injectAttachmentReadHint,
  modelNeedsAttachmentReadHint,
} from "../plugins/defaults/attachment-read-hint/inject.js";
import { defaultAttachmentReadHintPlugin } from "../plugins/defaults/index.js";
import { runHook } from "../plugins/pipeline.js";
import {
  registerPlugin,
  resetPluginRegistryForTests,
} from "../plugins/registry.js";
import type { Message } from "../providers/types.js";

const KIMI_K26_MOONSHOT = "moonshotai/kimi-k2.6";
const KIMI_K26_FIREWORKS = "accounts/fireworks/models/kimi-k2p6";

const noopLogger: PluginLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

function makeCtx(
  messages: Message[],
  resolvedModel: string | undefined,
): UserPromptSubmitContext {
  return {
    conversationId: "conv-test",
    userMessageId: "msg-test",
    requestId: "req-test",
    modelProfileKey: null,
    resolvedModel,
    isNonInteractive: false,
    prompt: "",
    originalMessages: messages,
    latestMessages: messages,
    logger: noopLogger,
  };
}

function imageTailMessages(): Message[] {
  return [
    {
      role: "user",
      content: [
        {
          type: "image",
          source: { type: "base64", media_type: "image/png", data: "AAAA" },
        },
        { type: "text", text: "what does this say" },
      ],
    },
  ];
}

function lastBlockText(messages: Message[]): string {
  const tail = messages[messages.length - 1];
  const last = tail?.content[tail.content.length - 1];
  return last?.type === "text" ? last.text : "";
}

describe("modelNeedsAttachmentReadHint", () => {
  test("matches Kimi K2.6 under both provider id schemes", () => {
    expect(modelNeedsAttachmentReadHint(KIMI_K26_MOONSHOT)).toBe(true);
    expect(modelNeedsAttachmentReadHint(KIMI_K26_FIREWORKS)).toBe(true);
  });

  test("rejects Kimi K2.5, other models, and an unresolved model", () => {
    expect(modelNeedsAttachmentReadHint("moonshotai/kimi-k2.5")).toBe(false);
    expect(
      modelNeedsAttachmentReadHint("accounts/fireworks/models/kimi-k2p5"),
    ).toBe(false);
    expect(modelNeedsAttachmentReadHint("claude-fable-5")).toBe(false);
    expect(modelNeedsAttachmentReadHint(undefined)).toBe(false);
  });
});

describe("injectAttachmentReadHint", () => {
  test("returns the same reference when no attachment is present", () => {
    const msg: Message = {
      role: "user",
      content: [{ type: "text", text: "Hello" }],
    };
    expect(injectAttachmentReadHint(msg)).toBe(msg);
  });

  test("appends the hint for a file block", () => {
    const msg: Message = {
      role: "user",
      content: [
        {
          type: "file",
          source: {
            type: "base64",
            media_type: "application/pdf",
            data: "AAAA",
            filename: "report.pdf",
          },
        },
        { type: "text", text: "summarize" },
      ],
    };
    const result = injectAttachmentReadHint(msg);
    expect(result).not.toBe(msg);
    expect(result.content.length).toBe(3);
    expect(lastBlockText([result])).toBe(ATTACHMENT_READ_HINT);
  });
});

describe("attachment-read-hint user-prompt-submit hook — direct", () => {
  test("appends the hint for Kimi K2.6 with an image attachment", async () => {
    const ctx = makeCtx(imageTailMessages(), KIMI_K26_MOONSHOT);
    await userPromptSubmit(ctx);
    expect(ctx.latestMessages[0]?.content.length).toBe(3);
    expect(lastBlockText(ctx.latestMessages)).toBe(ATTACHMENT_READ_HINT);
  });

  test("appends the hint under the Fireworks model id", async () => {
    const ctx = makeCtx(imageTailMessages(), KIMI_K26_FIREWORKS);
    await userPromptSubmit(ctx);
    expect(lastBlockText(ctx.latestMessages)).toBe(ATTACHMENT_READ_HINT);
  });

  test("is a no-op for models outside the gate", async () => {
    for (const model of ["claude-fable-5", "moonshotai/kimi-k2.5", undefined]) {
      const messages = imageTailMessages();
      const ctx = makeCtx(messages, model);
      await userPromptSubmit(ctx);
      expect(ctx.latestMessages).toBe(messages);
      expect(ctx.latestMessages[0]?.content.length).toBe(2);
    }
  });

  test("is a no-op for Kimi K2.6 without an attachment", async () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "Hello" }] },
    ];
    const ctx = makeCtx(messages, KIMI_K26_MOONSHOT);
    await userPromptSubmit(ctx);
    expect(ctx.latestMessages[0]?.content.length).toBe(1);
  });

  test("is a no-op when the tail message is not a user message", async () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: "image/png", data: "AAAA" },
          },
        ],
      },
      { role: "assistant", content: [{ type: "text", text: "Looking." }] },
    ];
    const ctx = makeCtx(messages, KIMI_K26_MOONSHOT);
    await userPromptSubmit(ctx);
    expect(ctx.latestMessages[1]?.content.length).toBe(1);
  });
});

describe("attachment-read-hint hook — through runHook + registry", () => {
  beforeEach(() => {
    resetPluginRegistryForTests();
  });

  test("registered default plugin appends the hint for Kimi K2.6", async () => {
    registerPlugin(defaultAttachmentReadHintPlugin);
    const ctx = makeCtx(imageTailMessages(), KIMI_K26_MOONSHOT);
    const finalCtx = await runHook(HOOKS.USER_PROMPT_SUBMIT, ctx);
    expect(lastBlockText(finalCtx.latestMessages)).toBe(ATTACHMENT_READ_HINT);
  });
});
