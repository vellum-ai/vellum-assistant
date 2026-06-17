import { beforeEach, describe, expect, test } from "bun:test";

import type {
  PostModelCallContext,
  PreModelCallContext,
  UserPromptSubmitContext,
} from "@vellumai/plugin-api";

import type { Message } from "../../../../providers/types.js";
import {
  getCapture,
  resetAdvisorStateForTests,
} from "../advisor-state-store.js";
import postModelCall from "../hooks/post-model-call.js";
import preModelCall from "../hooks/pre-model-call.js";
import userPromptSubmit from "../hooks/user-prompt-submit.js";
import { STEERING_MARKER } from "../steering.js";

const logger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
};

const userMsg = (t: string): Message => ({
  role: "user",
  content: [{ type: "text", text: t }],
});

beforeEach(() => {
  resetAdvisorStateForTests();
});

describe("pre-model-call hook", () => {
  test("records the original system prompt and injects steering on mainAgent", async () => {
    const ctx = {
      conversationId: "c1",
      callSite: "mainAgent",
      systemPrompt: "BASE PROMPT",
      deferAssistantOutput: false,
      logger,
    } as unknown as PreModelCallContext;

    await preModelCall(ctx);

    // Steering appended to what the model sees...
    expect(ctx.systemPrompt).toContain(STEERING_MARKER);
    expect(ctx.systemPrompt?.startsWith("BASE PROMPT")).toBe(true);
    // ...but the *recorded* prompt is the original (steering stripped).
    expect(getCapture("c1")?.systemPrompt).toBe("BASE PROMPT");
  });

  test("is idempotent within a turn (no double steering)", async () => {
    const ctx = {
      conversationId: "c1",
      callSite: "mainAgent",
      systemPrompt: "BASE",
      deferAssistantOutput: false,
      logger,
    } as unknown as PreModelCallContext;

    await preModelCall(ctx);
    const afterFirst = ctx.systemPrompt;
    await preModelCall(ctx); // second provider call, same turn
    expect(ctx.systemPrompt).toBe(afterFirst);
    expect(getCapture("c1")?.systemPrompt).toBe("BASE");
  });

  test("ignores non-mainAgent calls (no capture, no mutation)", async () => {
    const ctx = {
      conversationId: "bg",
      callSite: "compactionAgent",
      systemPrompt: "BG",
      deferAssistantOutput: false,
      logger,
    } as unknown as PreModelCallContext;

    await preModelCall(ctx);
    expect(ctx.systemPrompt).toBe("BG");
    expect(getCapture("bg")).toBeUndefined();
  });
});

describe("post-model-call hook", () => {
  const base = {
    content: [],
    stopReason: "end_turn",
    decision: "stop" as const,
    logger,
  };

  test("snapshots the transcript on mainAgent", async () => {
    const messages = [userMsg("hi")];
    await postModelCall({
      ...base,
      conversationId: "c1",
      callSite: "mainAgent",
      messages,
    } as unknown as PostModelCallContext);
    expect(getCapture("c1")?.messages).toEqual(messages);
  });

  test("ignores provider-rejection outcomes", async () => {
    await postModelCall({
      ...base,
      conversationId: "c2",
      callSite: "mainAgent",
      messages: [userMsg("hi")],
      error: new Error("boom"),
      stopReason: null,
    } as unknown as PostModelCallContext);
    expect(getCapture("c2")).toBeUndefined();
  });

  test("ignores the advisor's own sub-call (recursion safety) and other call sites", async () => {
    for (const callSite of ["advisor", "subagentSpawn", "conversationTitle"]) {
      await postModelCall({
        ...base,
        conversationId: `cs-${callSite}`,
        callSite,
        messages: [userMsg("hi")],
      } as unknown as PostModelCallContext);
      expect(getCapture(`cs-${callSite}`)).toBeUndefined();
    }
  });
});

describe("user-prompt-submit hook", () => {
  test("seeds the capture with the inbound history", async () => {
    const messages = [userMsg("task")];
    await userPromptSubmit({
      conversationId: "c1",
      latestMessages: messages,
      originalMessages: messages,
      prompt: "task",
      userMessageId: "u1",
      requestId: "r1",
      modelProfileKey: null,
      isNonInteractive: false,
      logger,
    } as unknown as UserPromptSubmitContext);
    expect(getCapture("c1")?.messages).toEqual(messages);
  });
});
