import { describe, expect, test } from "bun:test";

import type {
  Message,
  ToolResultContent,
  ToolUseContent,
} from "../../providers/types.js";
import { microcompact } from "../microcompact.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function userText(text: string): Message {
  return { role: "user", content: [{ type: "text", text }] };
}

function assistantToolUse(
  id: string,
  name: string,
  input: Record<string, unknown> = {},
): Message {
  const block: ToolUseContent = { type: "tool_use", id, name, input };
  return { role: "assistant", content: [block] };
}

function toolResult(
  tool_use_id: string,
  content: string,
  extras: Partial<
    Omit<ToolResultContent, "type" | "tool_use_id" | "content">
  > = {},
): Message {
  const block: ToolResultContent = {
    type: "tool_result",
    tool_use_id,
    content,
    ...extras,
  };
  return { role: "user", content: [block] };
}

/**
 * Build a realistic multi-turn conversation where every "exchange" is a
 * user text message followed by a tool_use + tool_result pair.
 *
 * turns[i].tool = the tool name used on turn i.
 * turns[i].resultBody = the text of the tool_result for that turn.
 */
function buildConversation(
  turns: Array<{ tool: string; resultBody: string; userText?: string }>,
): Message[] {
  const out: Message[] = [];
  for (let i = 0; i < turns.length; i++) {
    const t = turns[i];
    const id = `tu-${i}`;
    out.push(userText(t.userText ?? `user says ${i}`));
    out.push(assistantToolUse(id, t.tool));
    out.push(toolResult(id, t.resultBody));
  }
  return out;
}

/** Large payload sized to dominate the token budget. */
function big(label: string, size = 10_000): string {
  return `${label}:${"x".repeat(size)}`;
}

/** Count tool_result blocks whose content equals the cleared placeholder. */
function countClearedToolResults(messages: Message[]): number {
  let n = 0;
  for (const m of messages) {
    for (const b of m.content) {
      if (
        b.type === "tool_result" &&
        b.content === "[Old tool result content cleared]"
      ) {
        n += 1;
      }
    }
  }
  return n;
}

function findToolResults(messages: Message[]): ToolResultContent[] {
  const out: ToolResultContent[] = [];
  for (const m of messages) {
    for (const b of m.content) {
      if (b.type === "tool_result") out.push(b);
    }
  }
  return out;
}

function findToolUses(messages: Message[]): ToolUseContent[] {
  const out: ToolUseContent[] = [];
  for (const m of messages) {
    for (const b of m.content) {
      if (b.type === "tool_use") out.push(b);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// (a) last-N-turns-protected invariant
// ---------------------------------------------------------------------------

describe("microcompact — protectRecentTurns invariant", () => {
  test("leaves the last N user turns untouched", () => {
    const turns = Array.from({ length: 8 }, () => ({
      tool: "Bash",
      resultBody: big("stale"),
    }));
    const messages = buildConversation(turns);

    // Cleared count *in the stripped region* should be exactly 8 - 4 = 4
    // when protectRecentTurns = 4 (default).
    const result = microcompact(messages);

    expect(result.clearedToolResults).toBe(4);
    expect(result.reclaimedTokens).toBeGreaterThan(0);

    // The last 4 user turns occupy indices 12..23 of a 24-message array
    // (3 messages per turn × 8 turns). Every tool_result at index >= 12
    // must still contain the original body.
    const trs = findToolResults(result.messages);
    // tool_results are at message indices 2,5,8,...23 — the 4 newest are
    // at positions 4..7 in this list (i.e. turns 4..7).
    for (let i = 0; i < 4; i++) {
      expect(trs[i].content).toBe("[Old tool result content cleared]");
    }
    for (let i = 4; i < 8; i++) {
      expect(trs[i].content.startsWith("stale:")).toBe(true);
    }
  });

  test("when history has fewer turns than protectRecentTurns, nothing is cleared", () => {
    const messages = buildConversation([
      { tool: "Bash", resultBody: big("stale") },
      { tool: "Bash", resultBody: big("stale") },
    ]);
    const result = microcompact(messages, { protectRecentTurns: 4 });
    expect(result.clearedToolResults).toBe(0);
    expect(result.reclaimedTokens).toBe(0);
    expect(result.messages).toBe(messages);
  });

  test("tool_result-only user messages do not count as a user turn", () => {
    // A single exchange where the user sends text, then the model makes 3
    // separate tool calls. Providers emit one user message per tool_result,
    // all of which are tool_result-only. Those should not each count as a
    // user turn — otherwise protectRecentTurns=1 would protect everything.
    const msgs: Message[] = [
      userText("first real user turn"),
      assistantToolUse("tu-1", "Bash"),
      toolResult("tu-1", big("body-1")),
      assistantToolUse("tu-2", "Bash"),
      toolResult("tu-2", big("body-2")),
      assistantToolUse("tu-3", "Bash"),
      toolResult("tu-3", big("body-3")),
      userText("second real user turn"),
      assistantToolUse("tu-4", "Bash"),
      toolResult("tu-4", big("body-4")),
    ];
    // protectRecentTurns=1 should protect ONLY the "second real user turn"
    // and its tool_result (tu-4). tu-1..tu-3 should be cleared.
    const result = microcompact(msgs, { protectRecentTurns: 1 });
    expect(result.clearedToolResults).toBe(3);

    const trs = findToolResults(result.messages);
    expect(trs[0].content).toBe("[Old tool result content cleared]");
    expect(trs[1].content).toBe("[Old tool result content cleared]");
    expect(trs[2].content).toBe("[Old tool result content cleared]");
    expect(trs[3].content.startsWith("body-4:")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// (b) protected tools never cleared
// ---------------------------------------------------------------------------

describe("microcompact — protected tools", () => {
  test("never replaces the body of a tool_result from a protected tool", () => {
    // 6 turns: 1 Task, 1 subagent, 1 skill, 3 Bash — plus 4 protected turns
    // at the tail to push the first 6 into the stripped region.
    const turns = [
      { tool: "Task", resultBody: big("task-result") },
      { tool: "subagent", resultBody: big("subagent-result") },
      { tool: "skill", resultBody: big("skill-result") },
      { tool: "Bash", resultBody: big("bash-1") },
      { tool: "Bash", resultBody: big("bash-2") },
      { tool: "Bash", resultBody: big("bash-3") },
      // Protected tail — 4 recent turns.
      { tool: "Bash", resultBody: "recent-1" },
      { tool: "Bash", resultBody: "recent-2" },
      { tool: "Bash", resultBody: "recent-3" },
      { tool: "Bash", resultBody: "recent-4" },
    ];
    const messages = buildConversation(turns);
    const result = microcompact(messages);

    // Only the 3 Bash calls in the stripped region should have been cleared.
    expect(result.clearedToolResults).toBe(3);

    const trs = findToolResults(result.messages);
    // Turn 0 (Task) — body preserved
    expect(trs[0].content.startsWith("task-result:")).toBe(true);
    // Turn 1 (subagent) — body preserved
    expect(trs[1].content.startsWith("subagent-result:")).toBe(true);
    // Turn 2 (skill) — body preserved
    expect(trs[2].content.startsWith("skill-result:")).toBe(true);
    // Turns 3,4,5 — cleared
    expect(trs[3].content).toBe("[Old tool result content cleared]");
    expect(trs[4].content).toBe("[Old tool result content cleared]");
    expect(trs[5].content).toBe("[Old tool result content cleared]");
  });

  test("custom protectedTools override the default list", () => {
    const turns = [
      { tool: "Task", resultBody: big("task-body") },
      { tool: "MyTool", resultBody: big("mytool-body") },
      // Protected tail
      { tool: "Bash", resultBody: "recent-1" },
      { tool: "Bash", resultBody: "recent-2" },
      { tool: "Bash", resultBody: "recent-3" },
      { tool: "Bash", resultBody: "recent-4" },
    ];
    const messages = buildConversation(turns);
    const result = microcompact(messages, { protectedTools: ["MyTool"] });

    const trs = findToolResults(result.messages);
    // Task is NO LONGER protected (not in the custom list) — should be cleared.
    expect(trs[0].content).toBe("[Old tool result content cleared]");
    // MyTool is protected — body preserved.
    expect(trs[1].content.startsWith("mytool-body:")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// (c) idempotency
// ---------------------------------------------------------------------------

describe("microcompact — idempotency", () => {
  test("running twice produces zero incremental reclaim", () => {
    const turns = Array.from({ length: 8 }, () => ({
      tool: "Bash",
      resultBody: big("stale"),
    }));
    const messages = buildConversation(turns);

    const first = microcompact(messages);
    expect(first.reclaimedTokens).toBeGreaterThan(0);
    expect(first.clearedToolResults).toBeGreaterThan(0);

    const second = microcompact(first.messages);
    expect(second.reclaimedTokens).toBe(0);
    expect(second.clearedToolResults).toBe(0);
    // Second pass returns the same reference when there's nothing to do.
    expect(second.messages).toBe(first.messages);
  });
});

// ---------------------------------------------------------------------------
// (d) minGainTokens no-op
// ---------------------------------------------------------------------------

describe("microcompact — minGainTokens", () => {
  test("returns original messages when reclaim is below the floor", () => {
    // Tiny bodies — stale region exists but compaction saves very little.
    const turns = Array.from({ length: 8 }, (_, i) => ({
      tool: "Bash",
      resultBody: `tiny-${i}`,
    }));
    const messages = buildConversation(turns);

    const result = microcompact(messages, { minGainTokens: 10_000 });
    expect(result.reclaimedTokens).toBe(0);
    expect(result.clearedToolResults).toBe(0);
    // Original reference returned verbatim.
    expect(result.messages).toBe(messages);
  });

  test("returns compacted messages when reclaim meets the floor", () => {
    const turns = Array.from({ length: 8 }, () => ({
      tool: "Bash",
      resultBody: big("stale"),
    }));
    const messages = buildConversation(turns);

    const result = microcompact(messages, { minGainTokens: 100 });
    expect(result.reclaimedTokens).toBeGreaterThanOrEqual(100);
    expect(result.messages).not.toBe(messages);
  });
});

// ---------------------------------------------------------------------------
// (e) <ax-tree> block stripping
// ---------------------------------------------------------------------------

describe("microcompact — ax-tree stripping", () => {
  test("strips ax-tree blocks from protected tool_results in the stripped region", () => {
    // Place a protected (Task) tool_result in the stripped region and verify
    // that its ax-tree is collapsed even though the rest of its body is
    // preserved.
    const axTreeBody = `Task output before.\n<ax-tree>\n${"<node/>".repeat(
      1000,
    )}\n</ax-tree>\nTask output after.`;

    const turns = [
      { tool: "Task", resultBody: axTreeBody },
      // Protected tail
      { tool: "Bash", resultBody: "recent-1" },
      { tool: "Bash", resultBody: "recent-2" },
      { tool: "Bash", resultBody: "recent-3" },
      { tool: "Bash", resultBody: "recent-4" },
    ];
    const messages = buildConversation(turns);
    const result = microcompact(messages, { minGainTokens: 100 });

    const trs = findToolResults(result.messages);
    // Task body preserved (it's protected), but ax-tree is collapsed.
    expect(trs[0].content).not.toContain("<ax-tree>");
    expect(trs[0].content).not.toContain("</ax-tree>");
    expect(trs[0].content).toContain("<ax_tree_omitted />");
    expect(trs[0].content).toContain("Task output before.");
    expect(trs[0].content).toContain("Task output after.");
  });

  test("leaves ax-tree blocks in the protected tail untouched", () => {
    const axTreeBody = `recent output.\n<ax-tree>\n${"<node/>".repeat(
      500,
    )}\n</ax-tree>`;

    // Only 2 turns — protectRecentTurns defaults to 4, so everything is
    // protected and ax-trees must not be touched.
    const messages = buildConversation([
      { tool: "Task", resultBody: axTreeBody },
      { tool: "Task", resultBody: axTreeBody },
    ]);
    const result = microcompact(messages);

    const trs = findToolResults(result.messages);
    expect(trs[0].content).toContain("<ax-tree>");
    expect(trs[1].content).toContain("<ax-tree>");
  });
});

// ---------------------------------------------------------------------------
// (f) image / file block stubbing
// ---------------------------------------------------------------------------

describe("microcompact — image/file stubbing", () => {
  test("replaces image and file blocks in the stripped region with text stubs", () => {
    const bigBase64 = "A".repeat(20_000);

    const msgs: Message[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "look at these" },
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: bigBase64,
            },
          },
          {
            type: "file",
            source: {
              type: "base64",
              media_type: "application/pdf",
              data: bigBase64,
              filename: "report.pdf",
            },
          },
        ],
      },
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
      // Push 4 follow-up user turns so the image-bearing message is in the
      // stripped region.
      userText("t1"),
      { role: "assistant", content: [{ type: "text", text: "r1" }] },
      userText("t2"),
      { role: "assistant", content: [{ type: "text", text: "r2" }] },
      userText("t3"),
      { role: "assistant", content: [{ type: "text", text: "r3" }] },
      userText("t4"),
      { role: "assistant", content: [{ type: "text", text: "r4" }] },
    ];

    const result = microcompact(msgs);

    expect(result.clearedMedia).toBe(2);
    expect(result.reclaimedTokens).toBeGreaterThan(0);

    // The image and file blocks should be replaced with text stubs.
    const first = result.messages[0];
    expect(first.content[0]).toEqual({ type: "text", text: "look at these" });
    expect(first.content[1]).toEqual({ type: "text", text: "[image omitted]" });
    expect(first.content[2]).toEqual({ type: "text", text: "[file omitted]" });

    // No image or file blocks remain anywhere in the output.
    const hasImageOrFile = result.messages.some((m) =>
      m.content.some((b) => b.type === "image" || b.type === "file"),
    );
    expect(hasImageOrFile).toBe(false);
  });

  test("leaves image blocks in the protected tail untouched", () => {
    const bigBase64 = "A".repeat(5_000);

    const msgs: Message[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "recent user turn" },
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: bigBase64,
            },
          },
        ],
      },
      { role: "assistant", content: [{ type: "text", text: "ok" }] },
    ];

    const result = microcompact(msgs);
    expect(result.clearedMedia).toBe(0);
    expect(result.messages).toBe(msgs);

    const firstBlocks = result.messages[0].content;
    expect(firstBlocks[1].type).toBe("image");
  });
});

// ---------------------------------------------------------------------------
// (g) tool_use / tool_result pairing invariant
// ---------------------------------------------------------------------------

describe("microcompact — tool_use/tool_result pairing", () => {
  test("every tool_use retains a matching tool_result after compaction", () => {
    const turns = Array.from({ length: 8 }, () => ({
      tool: "Bash",
      resultBody: big("stale"),
    }));
    const messages = buildConversation(turns);
    const result = microcompact(messages);

    const tuIds = new Set(findToolUses(result.messages).map((b) => b.id));
    const trIds = new Set(
      findToolResults(result.messages).map((b) => b.tool_use_id),
    );

    expect(tuIds.size).toBe(8);
    expect(trIds.size).toBe(8);
    for (const id of tuIds) {
      expect(trIds.has(id)).toBe(true);
    }
  });

  test("message roles and block types are preserved — only bodies mutate", () => {
    const turns = Array.from({ length: 6 }, () => ({
      tool: "Bash",
      resultBody: big("stale"),
    }));
    const messages = buildConversation(turns);
    const result = microcompact(messages);

    expect(result.messages.length).toBe(messages.length);
    for (let i = 0; i < messages.length; i++) {
      expect(result.messages[i].role).toBe(messages[i].role);
      expect(result.messages[i].content.length).toBe(
        messages[i].content.length,
      );
      for (let j = 0; j < messages[i].content.length; j++) {
        expect(result.messages[i].content[j].type).toBe(
          messages[i].content[j].type,
        );
      }
    }

    // And every cleared tool_result retains its tool_use_id.
    const resultTrs = findToolResults(result.messages);
    const originalTrs = findToolResults(messages);
    for (let i = 0; i < resultTrs.length; i++) {
      expect(resultTrs[i].tool_use_id).toBe(originalTrs[i].tool_use_id);
    }
  });

  test("preserves is_error flag when clearing", () => {
    const messages: Message[] = [
      userText("initial"),
      assistantToolUse("tu-err", "Bash"),
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu-err",
            content: big("error-body"),
            is_error: true,
          },
        ],
      },
      // Push 4 turns to strip the first.
      userText("t1"),
      { role: "assistant", content: [{ type: "text", text: "r1" }] },
      userText("t2"),
      { role: "assistant", content: [{ type: "text", text: "r2" }] },
      userText("t3"),
      { role: "assistant", content: [{ type: "text", text: "r3" }] },
      userText("t4"),
      { role: "assistant", content: [{ type: "text", text: "r4" }] },
    ];

    const result = microcompact(messages);
    const errBlock = result.messages[2].content[0] as ToolResultContent;
    expect(errBlock.type).toBe("tool_result");
    expect(errBlock.content).toBe("[Old tool result content cleared]");
    expect(errBlock.is_error).toBe(true);
  });

  test("strips contentBlocks (rich content) from cleared tool_results", () => {
    const messages: Message[] = [
      userText("initial"),
      assistantToolUse("tu-rich", "Bash"),
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu-rich",
            content: big("body"),
            contentBlocks: [
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: "image/png",
                  data: "X".repeat(10_000),
                },
              },
            ],
          } as ToolResultContent,
        ],
      },
      // Push 4 turns to strip the first.
      userText("t1"),
      { role: "assistant", content: [{ type: "text", text: "r1" }] },
      userText("t2"),
      { role: "assistant", content: [{ type: "text", text: "r2" }] },
      userText("t3"),
      { role: "assistant", content: [{ type: "text", text: "r3" }] },
      userText("t4"),
      { role: "assistant", content: [{ type: "text", text: "r4" }] },
    ];

    const result = microcompact(messages);
    const cleared = result.messages[2].content[0] as ToolResultContent;
    expect(cleared.contentBlocks).toBeUndefined();
    expect(cleared.content).toBe("[Old tool result content cleared]");
  });

  test("preserves text entries in contentBlocks on protected tool_results, drops media", () => {
    // A protected (Task) tool_result in the stripped region carrying both a
    // text entry AND an image entry in its `contentBlocks`. Before the P2
    // fix, BOTH were dropped; text entries can be meaningful (protected-tool
    // narration) and must survive.
    const messages: Message[] = [
      userText("initial"),
      assistantToolUse("tu-prot", "Task"),
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu-prot",
            content: big("task-body"),
            contentBlocks: [
              { type: "text", text: "important narration from subagent" },
              {
                type: "image",
                source: {
                  type: "base64",
                  media_type: "image/png",
                  data: "X".repeat(10_000),
                },
              },
            ],
          } as ToolResultContent,
        ],
      },
      // Push 4 turns to strip the first.
      userText("t1"),
      { role: "assistant", content: [{ type: "text", text: "r1" }] },
      userText("t2"),
      { role: "assistant", content: [{ type: "text", text: "r2" }] },
      userText("t3"),
      { role: "assistant", content: [{ type: "text", text: "r3" }] },
      userText("t4"),
      { role: "assistant", content: [{ type: "text", text: "r4" }] },
    ];

    const result = microcompact(messages);
    const preserved = result.messages[2].content[0] as ToolResultContent;

    // Body is preserved (protected tool — ax-tree stripping only, body kept).
    expect(preserved.type).toBe("tool_result");
    expect(preserved.content.startsWith("task-body:")).toBe(true);

    // Text contentBlock entry survives.
    expect(preserved.contentBlocks).toBeDefined();
    expect(preserved.contentBlocks!.length).toBe(1);
    expect(preserved.contentBlocks![0]).toEqual({
      type: "text",
      text: "important narration from subagent",
    });

    // Media entry was dropped, which saved tokens.
    expect(result.reclaimedTokens).toBeGreaterThan(0);
  });

  test("protected tool_result with only text contentBlocks is a no-op (body unchanged, text kept)", () => {
    // No media to strip and no ax-tree in body — nothing should change.
    const messages: Message[] = [
      userText("initial"),
      assistantToolUse("tu-prot-txt", "Task"),
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu-prot-txt",
            content: "task body without ax-tree",
            contentBlocks: [
              { type: "text", text: "only a text attachment here" },
            ],
          } as ToolResultContent,
        ],
      },
      userText("t1"),
      { role: "assistant", content: [{ type: "text", text: "r1" }] },
      userText("t2"),
      { role: "assistant", content: [{ type: "text", text: "r2" }] },
      userText("t3"),
      { role: "assistant", content: [{ type: "text", text: "r3" }] },
      userText("t4"),
      { role: "assistant", content: [{ type: "text", text: "r4" }] },
    ];

    const result = microcompact(messages, { minGainTokens: 0 });
    // No reclaim for the protected tool_result, so it keeps its original text
    // entries and body.
    const kept = result.messages[2].content[0] as ToolResultContent;
    expect(kept.content).toBe("task body without ax-tree");
    expect(kept.contentBlocks).toBeDefined();
    expect(kept.contentBlocks!.length).toBe(1);
    expect(kept.contentBlocks![0]).toEqual({
      type: "text",
      text: "only a text attachment here",
    });
  });
});

// ---------------------------------------------------------------------------
// (h) web_search_tool_result & system_notice classifier
// ---------------------------------------------------------------------------

describe("microcompact — tool-response-only user message classifier", () => {
  test("web_search_tool_result-only user messages do not count as a user turn", () => {
    // Single real user turn followed by an assistant server_tool_use and a
    // web_search_tool_result-only user message. protectRecentTurns=1 should
    // still protect the single real user turn plus its trailing assistant
    // response — NOT wastefully also protect the web_search_tool_result
    // message (which would push the real tool_result on the prior turn out of
    // reach).
    const msgs: Message[] = [
      userText("first real user turn"),
      assistantToolUse("tu-old", "Bash"),
      toolResult("tu-old", big("old-body")),
      userText("second real user turn"),
      {
        role: "assistant",
        content: [
          {
            type: "server_tool_use",
            id: "srv-1",
            name: "web_search",
            input: { query: "x" },
          },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "web_search_tool_result",
            tool_use_id: "srv-1",
            content: [],
          },
        ],
      },
      { role: "assistant", content: [{ type: "text", text: "done" }] },
    ];

    // protectRecentTurns=1 should protect ONLY "second real user turn" and
    // everything after. tu-old (attached to "first real user turn") should be
    // cleared.
    const result = microcompact(msgs, { protectRecentTurns: 1 });
    expect(result.clearedToolResults).toBe(1);

    const trs = findToolResults(result.messages);
    expect(trs[0].content).toBe("[Old tool result content cleared]");
  });

  test("system_notice-only text user messages do not count as a user turn", () => {
    // System notices (retry nudges / progress checks) are injected as
    // user-role text blocks wrapped in <system_notice>...</system_notice>.
    // They must not be treated as real user turns.
    const msgs: Message[] = [
      userText("first real user turn"),
      assistantToolUse("tu-old", "Bash"),
      toolResult("tu-old", big("old-body")),
      userText("second real user turn"),
      {
        role: "assistant",
        content: [{ type: "text", text: "some response" }],
      },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "<system_notice>please continue</system_notice>",
          },
        ],
      },
    ];

    const result = microcompact(msgs, { protectRecentTurns: 1 });
    expect(result.clearedToolResults).toBe(1);

    const trs = findToolResults(result.messages);
    expect(trs[0].content).toBe("[Old tool result content cleared]");
  });

  test("mixed user message (real text + tool_result) still counts as a user turn", () => {
    // A user message containing both real text AND tool-response blocks is
    // still a real user turn — don't misclassify.
    const msgs: Message[] = [
      userText("older turn"),
      assistantToolUse("tu-old", "Bash"),
      toolResult("tu-old", big("old-body")),
      {
        role: "user",
        content: [
          { type: "text", text: "new user message with context" },
          {
            type: "tool_result",
            tool_use_id: "tu-old",
            content: "inline result",
          } as ToolResultContent,
        ],
      },
      { role: "assistant", content: [{ type: "text", text: "response" }] },
    ];

    // protectRecentTurns=1 should protect the mixed message + trailing
    // assistant response; the older turn's tool_result should be cleared.
    const result = microcompact(msgs, { protectRecentTurns: 1 });
    expect(result.clearedToolResults).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Summary counters sanity
// ---------------------------------------------------------------------------

describe("microcompact — counter sanity", () => {
  test("counts match what was actually cleared", () => {
    const messages = buildConversation(
      Array.from({ length: 8 }, () => ({
        tool: "Bash",
        resultBody: big("stale"),
      })),
    );
    const result = microcompact(messages);
    expect(countClearedToolResults(result.messages)).toBe(
      result.clearedToolResults,
    );
  });

  test("empty input returns zero counters and original reference", () => {
    const result = microcompact([]);
    expect(result.reclaimedTokens).toBe(0);
    expect(result.clearedToolResults).toBe(0);
    expect(result.clearedMedia).toBe(0);
  });
});
