import { beforeEach, describe, expect, test } from "bun:test";

import type {
  Message,
  PostModelCallContext,
  PreModelCallContext,
  UserPromptSubmitContext,
} from "@vellumai/plugin-api";

import {
  getCapture,
  resetAdvisorStateForTests,
} from "../advisor-state-store.js";
import postModelCall from "../hooks/post-model-call.js";
import preModelCall from "../hooks/pre-model-call.js";
import userPromptSubmit from "../hooks/user-prompt-submit.js";
import { STEERING_MARKER } from "../steering.js";

const logger = { info() {}, warn() {}, error() {}, debug() {} };
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

    expect(ctx.systemPrompt).toContain(STEERING_MARKER);
    expect(ctx.systemPrompt?.startsWith("BASE PROMPT")).toBe(true);
    expect(getCapture("c1")?.systemPrompt).toBe("BASE PROMPT");
  });

  test("ignores non-mainAgent calls", async () => {
    const ctx = {
      conversationId: "bg",
      callSite: "inference",
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

  test("appends the model's current turn (ctx.content) to the snapshot", async () => {
    const messages = [userMsg("task")];
    const assistantTurn: Message = {
      role: "assistant",
      content: [
        { type: "text", text: "thinking about it" },
        { type: "tool_use", id: "t1", name: "advisor", input: {} },
      ],
    };
    await postModelCall({
      ...base,
      content: assistantTurn.content,
      conversationId: "c4",
      callSite: "mainAgent",
      messages,
    } as unknown as PostModelCallContext);
    const captured = getCapture("c4")?.messages;
    expect(captured).toHaveLength(2);
    expect(captured?.[1]).toEqual(assistantTurn);
  });

  test("ignores the advisor's own inference sub-call (recursion safety) and errors", async () => {
    await postModelCall({
      ...base,
      conversationId: "c2",
      callSite: "inference",
      messages: [userMsg("hi")],
    } as unknown as PostModelCallContext);
    expect(getCapture("c2")).toBeUndefined();

    await postModelCall({
      ...base,
      conversationId: "c3",
      callSite: "mainAgent",
      messages: [userMsg("hi")],
      error: new Error("boom"),
      stopReason: null,
    } as unknown as PostModelCallContext);
    expect(getCapture("c3")).toBeUndefined();
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
