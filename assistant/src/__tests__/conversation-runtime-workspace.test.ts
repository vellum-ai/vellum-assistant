import { describe, expect, test } from "bun:test";

import {
  applyRuntimeInjections,
  injectWorkspaceTopLevelContext,
  stripWorkspaceTopLevelContext,
} from "../daemon/conversation-runtime-assembly.js";
import type { Message } from "../providers/types.js";

// ---------------------------------------------------------------------------
// Fixture messages
// ---------------------------------------------------------------------------

function userMsg(text: string): Message {
  return { role: "user", content: [{ type: "text", text }] };
}

function assistantMsg(text: string): Message {
  return { role: "assistant", content: [{ type: "text", text }] };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const sampleContext =
  "<workspace_top_level>\nRoot: /sandbox\nDirectories: src, lib, tests\n</workspace_top_level>";

describe("Workspace top-level context — injection", () => {
  test("prepends workspace block to user message content", () => {
    const original = userMsg("Hello");
    const injected = injectWorkspaceTopLevelContext(original, sampleContext);

    expect(injected.content).toHaveLength(2);
    expect(injected.content[0]).toEqual({ type: "text", text: sampleContext });
    expect(injected.content[1]).toEqual({ type: "text", text: "Hello" });
  });

  test("preserves multi-block user content after prepend", () => {
    const original: Message = {
      role: "user",
      content: [
        { type: "text", text: "First" },
        { type: "text", text: "Second" },
      ],
    };
    const injected = injectWorkspaceTopLevelContext(original, sampleContext);

    expect(injected.content).toHaveLength(3);
    expect(injected.content[0].type).toBe("text");
    expect((injected.content[0] as { text: string }).text).toBe(sampleContext);
    expect((injected.content[1] as { text: string }).text).toBe("First");
    expect((injected.content[2] as { text: string }).text).toBe("Second");
  });

  test("does not mutate original message", () => {
    const original = userMsg("Hello");
    const originalContentLength = original.content.length;
    injectWorkspaceTopLevelContext(original, sampleContext);

    expect(original.content).toHaveLength(originalContentLength);
  });
});

describe("Workspace top-level context — stripping", () => {
  test("strips injected workspace block from user messages", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [
          { type: "text", text: sampleContext },
          { type: "text", text: "Hello" },
        ],
      },
      assistantMsg("Hi there"),
    ];

    const stripped = stripWorkspaceTopLevelContext(messages);

    expect(stripped).toHaveLength(2);
    expect(stripped[0].content).toHaveLength(1);
    expect((stripped[0].content[0] as { text: string }).text).toBe("Hello");
  });

  test("does not strip non-workspace text blocks", () => {
    const messages: Message[] = [
      userMsg("Regular message"),
      assistantMsg("Response"),
    ];

    const stripped = stripWorkspaceTopLevelContext(messages);
    expect(stripped).toEqual(messages);
  });

  test("removes user message entirely when only workspace block remains", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: sampleContext }] },
      assistantMsg("Response"),
    ];

    const stripped = stripWorkspaceTopLevelContext(messages);
    expect(stripped).toHaveLength(1);
    expect(stripped[0].role).toBe("assistant");
  });

  test("does not strip from assistant messages", () => {
    const messages: Message[] = [assistantMsg(sampleContext)];

    const stripped = stripWorkspaceTopLevelContext(messages);
    expect(stripped).toHaveLength(1);
    expect((stripped[0].content[0] as { text: string }).text).toBe(
      sampleContext,
    );
  });

  test("preserves tool_result blocks during stripping", () => {
    const messages: Message[] = [
      {
        role: "user",
        content: [
          { type: "text", text: sampleContext },
          {
            type: "tool_result",
            tool_use_id: "tu_1",
            content: "result",
            is_error: false,
          },
        ],
      },
    ];

    const stripped = stripWorkspaceTopLevelContext(messages);
    expect(stripped).toHaveLength(1);
    expect(stripped[0].content).toHaveLength(1);
    expect(stripped[0].content[0].type).toBe("tool_result");
  });

  test("no empty-message artifacts after stripping", () => {
    const messages: Message[] = [
      userMsg("Before"),
      { role: "user", content: [{ type: "text", text: sampleContext }] },
      assistantMsg("After"),
    ];

    const stripped = stripWorkspaceTopLevelContext(messages);
    expect(stripped).toHaveLength(2);
    expect(stripped[0].role).toBe("user");
    expect(stripped[1].role).toBe("assistant");
  });
});

describe("applyRuntimeInjections — workspace top-level context", () => {
  test("injects workspace context when provided", () => {
    const messages: Message[] = [userMsg("Hello")];
    const result = applyRuntimeInjections(messages, {
      workspaceTopLevelContext: sampleContext,
    });

    expect(result).toHaveLength(1);
    expect(result[0].content).toHaveLength(2);
    expect((result[0].content[0] as { text: string }).text).toBe(sampleContext);
    expect((result[0].content[1] as { text: string }).text).toBe("Hello");
  });

  test("does not inject when workspace context is null", () => {
    const messages: Message[] = [userMsg("Hello")];
    const result = applyRuntimeInjections(messages, {
      workspaceTopLevelContext: null,
    });

    expect(result).toHaveLength(1);
    expect(result[0].content).toHaveLength(1);
  });

  test("workspace context appears before active surface context in content", () => {
    const messages: Message[] = [userMsg("Hello")];
    const result = applyRuntimeInjections(messages, {
      activeSurface: { surfaceId: "sf_1", html: "<div>test</div>" },
      workspaceTopLevelContext: sampleContext,
    });

    // Workspace is injected last (in applyRuntimeInjections order) so it
    // prepends to whatever was already prepended by activeSurface.
    // Result: [workspace, activeSurface, original]
    expect(result[0].content).toHaveLength(3);
    expect((result[0].content[0] as { text: string }).text).toBe(sampleContext);
    expect((result[0].content[1] as { text: string }).text).toContain(
      "<active_workspace>",
    );
    expect((result[0].content[2] as { text: string }).text).toBe("Hello");
  });
});

describe("applyRuntimeInjections — minimal mode skips workspace blocks", () => {
  test("minimal mode skips workspace top-level context", () => {
    const messages: Message[] = [userMsg("Hello")];
    const result = applyRuntimeInjections(messages, {
      workspaceTopLevelContext: sampleContext,
      mode: "minimal",
    });

    expect(result).toHaveLength(1);
    expect(result[0].content).toHaveLength(1);
    expect((result[0].content[0] as { text: string }).text).toBe("Hello");
  });

  test("minimal mode skips active surface context", () => {
    const messages: Message[] = [userMsg("Hello")];
    const result = applyRuntimeInjections(messages, {
      activeSurface: { surfaceId: "sf_1", html: "<div>test</div>" },
      mode: "minimal",
    });

    expect(result).toHaveLength(1);
    expect(result[0].content).toHaveLength(1);
    expect((result[0].content[0] as { text: string }).text).toBe("Hello");
  });

  test("full mode (default) still includes workspace blocks", () => {
    const messages: Message[] = [userMsg("Hello")];
    const result = applyRuntimeInjections(messages, {
      workspaceTopLevelContext: sampleContext,
      activeSurface: { surfaceId: "sf_1", html: "<div>test</div>" },
    });

    expect(result[0].content).toHaveLength(3);
    expect((result[0].content[0] as { text: string }).text).toBe(sampleContext);
    expect((result[0].content[1] as { text: string }).text).toContain(
      "<active_workspace>",
    );
  });
});
