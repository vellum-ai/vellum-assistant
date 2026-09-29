import { describe, expect, test } from "bun:test";

import type { ChatMessageToolCall } from "@/domains/chat/api/event-types";
import type { ConversationContentBlock } from "@vellumai/assistant-api";
import {
  finalResponseStartIndex,
  groupContentBlocks,
} from "@/domains/chat/transcript/message-content";
import {
  credentialServiceOf,
  currentQuietStep,
  describeQuietStep,
  firstToolGroupIndex,
  quietTurnHiddenGroups,
  serviceDisplayName,
} from "@/domains/chat/transcript/quiet-turn";

function call(
  name: string,
  input: Record<string, unknown> = {},
  id = `call-${name}`,
): ChatMessageToolCall {
  return { id, name, input, completedAt: 1 };
}

describe("describeQuietStep", () => {
  test("names the service a shell command reaches through a stored credential", () => {
    // GIVEN a bash call that reveals the Slack credential before calling the API
    const toolCall = call("bash", {
      command:
        "TOKEN=$(assistant credentials reveal --service slack_channel --field bot_token)\ncurl -s https://slack.com/api/conversations.list",
      activity: "listing Slack DM channels",
    });

    // WHEN the step is described
    // THEN it names Slack rather than the terminal
    expect(describeQuietStep(toolCall)).toEqual({
      verb: "checking",
      place: { kind: "named", name: "Slack" },
    });
  });

  test("treats plain shell work as the terminal and reads the verb from the activity", () => {
    // GIVEN a bash call whose activity sentence says it writes something
    const toolCall = call("bash", {
      command: "python3 recover.py",
      activity: "writing recovered entry files",
    });

    // WHEN the step is described
    // THEN it is terminal work that updates
    expect(describeQuietStep(toolCall)).toEqual({
      verb: "updating",
      place: { kind: "terminal" },
    });
  });

  test("file edits update, and paths under memory/ are memory", () => {
    // GIVEN edits to a workspace file and to a memory page
    const workspaceEdit = call("file_edit", { path: "procs/work-journal.md" });
    const memoryRead = call("file_read", {
      path: "memory/concepts/work-journal.md",
    });

    // WHEN each step is described
    // THEN the edit updates files and the memory read checks memory
    expect(describeQuietStep(workspaceEdit)).toEqual({
      verb: "updating",
      place: { kind: "files" },
    });
    expect(describeQuietStep(memoryRead)).toEqual({
      verb: "checking",
      place: { kind: "memory" },
    });
  });

  test("names MCP servers, the web, and the user's Mac", () => {
    // GIVEN calls to an MCP server, a web search, and a host shell
    // WHEN each step is described
    // THEN each names where it works
    expect(describeQuietStep(call("mcp__github__list_issues"))?.place).toEqual({
      kind: "named",
      name: "GitHub",
    });
    expect(describeQuietStep(call("web_search"))?.place).toEqual({
      kind: "web",
    });
    expect(
      describeQuietStep(call("host_bash", { command: "ls" }))?.place,
    ).toEqual({ kind: "mac" });
  });

  test("names nothing for the reply tool, surfaces, and skill loads", () => {
    // GIVEN calls that work nowhere a user would name
    // WHEN each step is described
    // THEN none produces a line
    expect(describeQuietStep(call("send_user_message"))).toBeNull();
    expect(describeQuietStep(call("ui_show"))).toBeNull();
    expect(describeQuietStep(call("skill_load"))).toBeNull();
  });
});

describe("currentQuietStep", () => {
  test("reads the newest call that names a place", () => {
    // GIVEN a Slack call followed by a skill load that names nothing
    const calls = [
      call("file_read", { path: "notes.md" }, "a"),
      call(
        "bash",
        { command: "assistant credentials reveal --service slack_channel" },
        "b",
      ),
      call("skill_load", {}, "c"),
    ];

    // WHEN the current step is read
    // THEN the line stays on Slack
    expect(currentQuietStep(calls)?.place).toEqual({
      kind: "named",
      name: "Slack",
    });
  });

  test("is null when no call names a place", () => {
    expect(currentQuietStep([call("skill_load")])).toBeNull();
  });
});

describe("credentialServiceOf and serviceDisplayName", () => {
  test("parse the service flag in either spelling", () => {
    expect(
      credentialServiceOf("assistant credentials reveal --service=gmail"),
    ).toBe("Gmail");
    expect(credentialServiceOf("curl https://example.com")).toBeNull();
  });

  test("capitalize the first word of a service id", () => {
    expect(serviceDisplayName("google-calendar")).toBe("Google");
    expect(serviceDisplayName("notion")).toBe("Notion");
  });
});

describe("quietTurnHiddenGroups", () => {
  // ack, tools, narration, tools, answer: the shape of a multi-step turn
  const blocks: ConversationContentBlock[] = [
    { type: "text", text: "let me check what happened." },
    { type: "tool_use", toolCall: call("bash", { command: "ls" }, "t1") },
    { type: "text", text: "found the likely culprit." },
    { type: "tool_use", toolCall: call("file_edit", { path: "a.md" }, "t2") },
    { type: "text", text: "Recovered all 33 entries." },
  ];
  const groups = groupContentBlocks(blocks);
  const finalResponseIndex = finalResponseStartIndex(groups, () => true);

  test("a settled turn shows its opening and its answer", () => {
    // GIVEN the settled turn
    // WHEN the hidden groups are computed
    const hidden = quietTurnHiddenGroups({
      groups,
      finalResponseIndex,
      live: false,
      isPinned: () => false,
    });

    // THEN only the tool runs and the narration between them are hidden
    expect(firstToolGroupIndex(groups)).toBe(1);
    expect([...hidden].sort()).toEqual([1, 2, 3]);
  });

  test("a live turn hides everything after its first tool call", () => {
    // GIVEN the same turn still streaming
    // WHEN the hidden groups are computed
    const hidden = quietTurnHiddenGroups({
      groups,
      finalResponseIndex,
      live: true,
      isPinned: () => false,
    });

    // THEN the last text is held back too, since it may not be the answer
    expect([...hidden].sort()).toEqual([1, 2, 3, 4]);
  });

  test("pinned groups stay in view", () => {
    // GIVEN a caller that pins the first tool run (a pending confirmation)
    // WHEN the hidden groups are computed
    const hidden = quietTurnHiddenGroups({
      groups,
      finalResponseIndex,
      live: true,
      isPinned: (_, index) => index === 1,
    });

    // THEN that run renders
    expect(hidden.has(1)).toBe(false);
  });

  test("a turn without tools hides nothing", () => {
    // GIVEN a plain reply
    const plain = groupContentBlocks([{ type: "text", text: "Sunday." }]);

    // WHEN the hidden groups are computed
    // THEN nothing is hidden
    expect(
      quietTurnHiddenGroups({
        groups: plain,
        finalResponseIndex: 0,
        live: true,
        isPinned: () => false,
      }).size,
    ).toBe(0);
  });
});
