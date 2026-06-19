/**
 * Tests for the `exploration-drift` plugin's third trigger: empty-input
 * `skill_execute` loop → advisor escalation.
 *
 * The hook lazily imports the advisor gate and consult on the rare escalation
 * path, so both are mocked here to keep the provider graph out of the test and
 * to observe how often the consult runs.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

let consultCalls = 0;
let advisorEnabled = true;
let advisorReply =
  "Re-issue document_update with content set to the next section.";

mock.module("../plugins/defaults/advisor/advisor-gate.js", () => ({
  advisorEnabledForProfile: () => advisorEnabled,
}));
mock.module("../plugins/defaults/advisor/consult.js", () => ({
  consultAdvisor: async () => {
    consultCalls++;
    return advisorReply;
  },
}));

import type { PluginLogger, PostToolUseContext } from "../plugin-api/types.js";
import postToolUse, {
  EMPTY_INPUT_ESCALATE_THRESHOLD,
  resetExplorationDriftStateForTests,
} from "../plugins/defaults/exploration-drift/hooks/post-tool-use.js";
import type { Message, ToolResultContent } from "../providers/types.js";

const noopLogger: PluginLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

const MINIMAX_MODEL = "accounts/fireworks/models/minimax-m3";
const GENERIC_MODEL = "claude-test-model";
const INNER_TOOL = "document_update";

let conversationCounter = 0;
function freshConversationId(): string {
  conversationCounter++;
  return `conv-empty-input-${conversationCounter}`;
}

/** Assistant turn issuing a single empty-input `skill_execute` call. */
function emptyCallTurn(id: string, activity: string): Message {
  return {
    role: "assistant",
    content: [
      {
        type: "tool_use",
        id,
        name: "skill_execute",
        input: { tool: INNER_TOOL, input: "", activity },
      },
    ],
  };
}

/** Assistant turn issuing a populated (stringified-JSON) `skill_execute` call. */
function populatedCallTurn(id: string, activity: string): Message {
  return {
    role: "assistant",
    content: [
      {
        type: "tool_use",
        id,
        name: "skill_execute",
        input: {
          tool: INNER_TOOL,
          input: '{"content":"a section"}',
          activity,
        },
      },
    ],
  };
}

function erroredResultTurn(toolUseId: string): Message {
  return {
    role: "user",
    content: [
      {
        type: "tool_result",
        tool_use_id: toolUseId,
        content:
          'Invalid input for tool "document_update": content is required',
        is_error: true,
      },
    ],
  };
}

function currentResult(toolUseId: string, isError = true): ToolResultContent {
  return {
    type: "tool_result",
    tool_use_id: toolUseId,
    content: isError
      ? 'Invalid input for tool "document_update": content is required'
      : "ok",
    is_error: isError,
  };
}

function makeCtx(
  conversationId: string,
  toolResponse: ToolResultContent,
  messages: Message[],
  model: string = MINIMAX_MODEL,
): PostToolUseContext {
  return {
    conversationId,
    toolResponse,
    messages,
    additionalContext: null,
    model,
    maxInputTokens: 10_000,
    logger: noopLogger,
  };
}

/**
 * History of `priorEmpties` completed empty-input calls (each with a distinct
 * `activity`, proving the varying field does not defeat detection), then the
 * current call whose result arrives via `ctx.toolResponse`.
 */
function emptyInputHistory(priorEmpties: number): {
  messages: Message[];
  currentToolUseId: string;
} {
  const messages: Message[] = [];
  let n = 0;
  for (; n < priorEmpties; n++) {
    const id = `se-${n}`;
    messages.push(emptyCallTurn(id, `streaming chunk ${n}`));
    messages.push(erroredResultTurn(id));
  }
  const currentToolUseId = `se-${n}`;
  messages.push(emptyCallTurn(currentToolUseId, `streaming chunk ${n}`));
  return { messages, currentToolUseId };
}

describe("exploration-drift — empty-input skill_execute escalation", () => {
  beforeEach(() => {
    resetExplorationDriftStateForTests();
    consultCalls = 0;
    advisorEnabled = true;
    advisorReply =
      "Re-issue document_update with content set to the next section.";
  });

  test("threshold is 2 (escalate on the second empty call)", () => {
    expect(EMPTY_INPUT_ESCALATE_THRESHOLD).toBe(2);
  });

  test("stays silent on the first empty call (below threshold)", async () => {
    const { messages, currentToolUseId } = emptyInputHistory(0);
    const ctx = makeCtx(
      freshConversationId(),
      currentResult(currentToolUseId),
      messages,
    );
    await postToolUse(ctx);
    expect(ctx.additionalContext).toBeNull();
    expect(consultCalls).toBe(0);
  });

  test("escalates on the second empty call with advisor guidance", async () => {
    const { messages, currentToolUseId } = emptyInputHistory(1);
    const ctx = makeCtx(
      freshConversationId(),
      currentResult(currentToolUseId),
      messages,
    );
    await postToolUse(ctx);
    expect(consultCalls).toBe(1);
    expect(ctx.additionalContext).toContain("advisor model reviewed");
    expect(ctx.additionalContext).toContain(advisorReply);
    expect(ctx.additionalContext).toContain("empty parameters 2 times");
  });

  test("detection survives a varying activity field", async () => {
    // The two empties carry different `activity` strings; byte-identical
    // matching would miss them, the resolved-inner-tool match does not.
    const { messages, currentToolUseId } = emptyInputHistory(1);
    const firstCall = messages[0].content[0];
    const currentCall = messages[messages.length - 1].content[0];
    expect(firstCall.type).toBe("tool_use");
    expect(currentCall.type).toBe("tool_use");
    const ctx = makeCtx(
      freshConversationId(),
      currentResult(currentToolUseId),
      messages,
    );
    await postToolUse(ctx);
    expect(consultCalls).toBe(1);
  });

  test("does not fire on non-loop-prone models", async () => {
    const { messages, currentToolUseId } = emptyInputHistory(1);
    const ctx = makeCtx(
      freshConversationId(),
      currentResult(currentToolUseId),
      messages,
      GENERIC_MODEL,
    );
    await postToolUse(ctx);
    expect(ctx.additionalContext).toBeNull();
    expect(consultCalls).toBe(0);
  });

  test("does not fire when the empty call succeeded (no error)", async () => {
    const { messages, currentToolUseId } = emptyInputHistory(1);
    const ctx = makeCtx(
      freshConversationId(),
      currentResult(currentToolUseId, false),
      messages,
    );
    await postToolUse(ctx);
    expect(ctx.additionalContext).toBeNull();
    expect(consultCalls).toBe(0);
  });

  test("does not count populated (stringified-JSON) calls as empty", async () => {
    // A prior populated call plus a current populated call — never empty.
    const messages: Message[] = [
      populatedCallTurn("se-0", "chunk 0"),
      erroredResultTurn("se-0"),
      populatedCallTurn("se-1", "chunk 1"),
    ];
    const ctx = makeCtx(freshConversationId(), currentResult("se-1"), messages);
    await postToolUse(ctx);
    expect(ctx.additionalContext).toBeNull();
    expect(consultCalls).toBe(0);
  });

  test("falls back to a deterministic nudge when the advisor is disabled", async () => {
    advisorEnabled = false;
    const { messages, currentToolUseId } = emptyInputHistory(1);
    const ctx = makeCtx(
      freshConversationId(),
      currentResult(currentToolUseId),
      messages,
    );
    await postToolUse(ctx);
    expect(consultCalls).toBe(0);
    expect(ctx.additionalContext).toContain("Stop repeating the empty call");
    expect(ctx.additionalContext).not.toContain("advisor model reviewed");
  });

  test("escalates at most once per streak", async () => {
    const conversationId = freshConversationId();

    const first = emptyInputHistory(1);
    const ctx1 = makeCtx(
      conversationId,
      currentResult(first.currentToolUseId),
      first.messages,
    );
    await postToolUse(ctx1);
    expect(consultCalls).toBe(1);
    expect(ctx1.additionalContext).not.toBeNull();

    // A third empty call in the same streak must not re-consult.
    const third = emptyInputHistory(2);
    const ctx2 = makeCtx(
      conversationId,
      currentResult(third.currentToolUseId),
      third.messages,
    );
    await postToolUse(ctx2);
    expect(consultCalls).toBe(1);
    expect(ctx2.additionalContext).toBeNull();
  });

  test("re-escalates after the model recovered and looped again", async () => {
    const conversationId = freshConversationId();

    const first = emptyInputHistory(1);
    await postToolUse(
      makeCtx(
        conversationId,
        currentResult(first.currentToolUseId),
        first.messages,
      ),
    );
    expect(consultCalls).toBe(1);

    // The model sent the user text (turn boundary), then a fresh empty loop
    // starts. The trailing count resets below threshold, clearing the mark.
    const recovered: Message[] = [
      {
        role: "assistant",
        content: [{ type: "text", text: "Here is the draft." }],
      },
    ];
    await postToolUse(
      makeCtx(conversationId, currentResult("se-x", true), [
        ...recovered,
        emptyCallTurn("se-x", "new chunk"),
      ]),
    );
    expect(consultCalls).toBe(1); // first of the new streak — below threshold

    const again = emptyInputHistory(1);
    await postToolUse(
      makeCtx(conversationId, currentResult(again.currentToolUseId), [
        ...recovered,
        ...again.messages,
      ]),
    );
    expect(consultCalls).toBe(2);
  });
});
