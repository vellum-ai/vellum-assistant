import { beforeEach, describe, expect, test } from "bun:test";

import { renderHistoryContent } from "../daemon/handlers/shared.js";
import type { ToolActivityMetadata } from "../daemon/message-types/web-activity.js";
import {
  getAttachmentsForMessage,
  linkAttachmentToMessage,
  uploadAttachment,
} from "../persistence/attachments-store.js";
import {
  addMessage,
  createConversation,
} from "../persistence/conversation-crud.js";
import { getDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
await initializeDb();

describe("renderHistoryContent", () => {
  test("renders text-only content unchanged", () => {
    const output = renderHistoryContent([
      { type: "text", text: "hello " },
      { type: "text", text: "world" },
    ]);
    expect(output.text).toBe("hello world");
    expect(output.toolCalls).toEqual([]);
  });

  test("renders file attachments for attachment-only turns", () => {
    const output = renderHistoryContent([
      {
        type: "file",
        source: {
          type: "base64",
          media_type: "application/pdf",
          filename: "spec.pdf",
          data: Buffer.from("hello").toString("base64"),
        },
        extracted_text: "Important requirement from the attachment.",
      },
    ]);

    expect(output.text).toContain("[File attachment] spec.pdf");
    expect(output.text).toContain("type=application/pdf");
    expect(output.text).toContain("size=5 B");
    expect(output.text).toContain(
      "Attachment text: Important requirement from the attachment.",
    );
  });

  test("skips image attachment placeholder text (images sent as separate attachments)", () => {
    const output = renderHistoryContent([
      {
        type: "image",
        source: {
          type: "base64",
          media_type: "image/png",
          data: Buffer.from("hello").toString("base64"),
        },
      },
    ]);

    expect(output.text).toBe("");
  });

  test("appends attachment lines after text content", () => {
    const output = renderHistoryContent([
      { type: "text", text: "please review the file" },
      {
        type: "file",
        source: {
          type: "base64",
          media_type: "text/plain",
          filename: "notes.txt",
          data: Buffer.from("hello").toString("base64"),
        },
      },
    ]);

    expect(output.text).toContain(
      "please review the file\n[File attachment] notes.txt",
    );
  });

  test("emits attachment:N entries in contentOrder for interleaved file blocks", () => {
    const output = renderHistoryContent([
      { type: "text", text: "first paragraph" },
      {
        type: "file",
        source: {
          type: "base64",
          media_type: "text/markdown",
          filename: "dream-015.md",
          data: Buffer.from("a").toString("base64"),
        },
        _attachmentId: "att-015",
      },
      {
        type: "file",
        source: {
          type: "base64",
          media_type: "text/markdown",
          filename: "dream-016.md",
          data: Buffer.from("b").toString("base64"),
        },
        _attachmentId: "att-016",
      },
      { type: "text", text: "trailing paragraph" },
    ]);

    expect(output.contentOrder).toEqual([
      "text:0",
      "attachment:0",
      "attachment:1",
      "text:1",
    ]);
    expect(output.attachments).toEqual([
      {
        attachmentId: "att-015",
        filename: "dream-015.md",
        mimeType: "text/markdown",
        sizeBytes: 1,
      },
      {
        attachmentId: "att-016",
        filename: "dream-016.md",
        mimeType: "text/markdown",
        sizeBytes: 1,
      },
    ]);
    // Trailing-segment summary is preserved for legacy channel-reply
    // delivery (Slack/Telegram outbound text) and iOS rehydrate.
    expect(output.textSegments[1]).toContain("[File attachment] dream-015.md");
  });

  test("omits attachmentId when file block has no _attachmentId", () => {
    const output = renderHistoryContent([
      {
        type: "file",
        source: {
          type: "base64",
          media_type: "application/pdf",
          filename: "legacy.pdf",
          data: Buffer.from("x").toString("base64"),
        },
      },
    ]);

    // attachment:0 marks the file's inline position; text:0 follows because
    // the legacy summary append (for Slack/iOS) opens a trailing segment.
    expect(output.contentOrder).toEqual(["attachment:0", "text:0"]);
    expect(output.attachments).toEqual([
      {
        filename: "legacy.pdf",
        mimeType: "application/pdf",
        sizeBytes: 1,
      },
    ]);
  });

  test("falls back to string conversion for non-array content", () => {
    expect(renderHistoryContent("raw string").text).toBe("raw string");
    expect(renderHistoryContent(null).text).toBe("");
    expect(renderHistoryContent(undefined).text).toBe("");
    expect(renderHistoryContent(42).text).toBe("42");
  });

  test("unwraps complete legacy external_content envelopes for plain string content", () => {
    const output = renderHistoryContent(
      '<external_content source="slack">\nVisible Slack text\n</external_content>',
    );

    expect(output.text).toBe("Visible Slack text");
    expect(output.textSegments).toEqual(["Visible Slack text"]);
    expect(output.contentOrder).toEqual(["text:0"]);
  });

  test("unwraps complete legacy external_content envelopes in text blocks", () => {
    const output = renderHistoryContent([
      {
        type: "text",
        text: '<external_content source="slack">\nVisible block text\n</external_content>',
      },
      { type: "text", text: "Plain follow-up." },
    ]);

    expect(output.text).toBe("Visible block text Plain follow-up.");
    expect(output.textSegments).toEqual([
      "Visible block text Plain follow-up.",
    ]);
    expect(output.contentOrder).toEqual(["text:0"]);
  });

  test("leaves malformed or mixed external_content text unchanged", () => {
    const malformed =
      '<external_content source="slack">Visible text</external_content>';
    const mixed =
      'prefix <external_content source="slack">\nVisible text\n</external_content>';

    const malformedOutput = renderHistoryContent([
      { type: "text", text: malformed },
    ]);
    expect(malformedOutput.text).toBe(malformed);
    expect(malformedOutput.textSegments).toEqual([malformed]);

    const mixedOutput = renderHistoryContent(mixed);
    expect(mixedOutput.text).toBe(mixed);
    expect(mixedOutput.textSegments).toEqual([mixed]);
  });

  test("preserves JSON object content as JSON string", () => {
    expect(renderHistoryContent({ foo: "bar" }).text).toBe('{"foo":"bar"}');
  });

  test("extracts tool_use blocks into toolCalls", () => {
    const output = renderHistoryContent([
      {
        type: "tool_use",
        id: "tu_1",
        name: "web_fetch",
        input: { url: "https://example.com" },
      },
    ]);

    expect(output.text).toBe("");
    expect(output.toolCalls).toEqual([
      { id: "tu_1", name: "web_fetch", input: { url: "https://example.com" } },
    ]);
    expect(output.toolCallsBeforeText).toBe(true);
  });

  test("pairs tool_result with matching tool_use by id", () => {
    const output = renderHistoryContent([
      { type: "tool_use", id: "tu_1", name: "bash", input: { command: "ls" } },
      {
        type: "tool_result",
        tool_use_id: "tu_1",
        content: "file1.txt\nfile2.txt",
        is_error: false,
      },
    ]);

    expect(output.toolCalls).toEqual([
      {
        id: "tu_1",
        name: "bash",
        input: { command: "ls" },
        result: "file1.txt\nfile2.txt",
        isError: false,
      },
    ]);
  });

  test("emits the attachment id for a workspace_ref tool-result image", () => {
    // "aGVsbG8=" = "hello" — a stand-in for screenshot bytes.
    const stored = uploadAttachment("shot.png", "image/png", "aGVsbG8=");
    const output = renderHistoryContent([
      { type: "tool_use", id: "tu_1", name: "browser_screenshot", input: {} },
      {
        type: "tool_result",
        tool_use_id: "tu_1",
        content: "captured",
        is_error: false,
        contentBlocks: [
          {
            type: "image",
            source: {
              type: "workspace_ref",
              media_type: "image/png",
              attachmentId: stored.id,
              sizeBytes: 5,
            },
          },
        ],
      },
    ]);

    // Referenced media emits its attachment id so clients fetch the bytes by
    // id on render instead of inlining base64 into the history wire; the
    // base64 fields stay empty for referenced images.
    expect(output.toolCalls[0].imageAttachmentIds).toEqual([stored.id]);
    expect(output.toolCalls[0].imageDataList).toBeUndefined();
    expect(output.toolCalls[0].imageData).toBeUndefined();
  });

  test("resolves an inline base64 tool-result image without an id", () => {
    const output = renderHistoryContent([
      { type: "tool_use", id: "tu_1", name: "browser_screenshot", input: {} },
      {
        type: "tool_result",
        tool_use_id: "tu_1",
        content: "captured",
        is_error: false,
        contentBlocks: [
          {
            type: "image",
            source: {
              type: "base64",
              media_type: "image/png",
              data: "aGVsbG8=",
            },
          },
        ],
      },
    ]);

    // Legacy inline base64 (no workspace reference) still resolves to the
    // base64 wire fields and carries no attachment id.
    expect(output.toolCalls[0].imageDataList).toEqual(["aGVsbG8="]);
    expect(output.toolCalls[0].imageData).toBe("aGVsbG8=");
    expect(output.toolCalls[0].imageAttachmentIds).toBeUndefined();
  });

  test("marks error tool results", () => {
    const output = renderHistoryContent([
      { type: "tool_use", id: "tu_1", name: "bash", input: { command: "bad" } },
      {
        type: "tool_result",
        tool_use_id: "tu_1",
        content: "command not found",
        is_error: true,
      },
    ]);

    expect(output.toolCalls).toEqual([
      {
        id: "tu_1",
        name: "bash",
        input: { command: "bad" },
        result: "command not found",
        isError: true,
      },
    ]);
  });

  test("omits id when the tool_use block carries none", () => {
    const output = renderHistoryContent([
      { type: "tool_use", name: "bash", input: { command: "ls" } },
    ]);

    // No provider id on the block — emit the entry without an `id` rather than
    // materializing an empty string, so clients fall back to a synthesized id.
    expect(output.toolCalls).toEqual([
      { name: "bash", input: { command: "ls" } },
    ]);
    expect(output.toolCalls[0]).not.toHaveProperty("id");
  });

  test("carries the provider id for server_tool_use blocks", () => {
    const output = renderHistoryContent([
      {
        type: "server_tool_use",
        id: "srvtu_1",
        name: "web_search",
        input: { query: "vellum" },
      },
    ]);

    expect(output.toolCalls).toEqual([
      { id: "srvtu_1", name: "web_search", input: { query: "vellum" } },
    ]);
  });

  test("synthesizes a positional id when a tool_use lacks a provider id", () => {
    const output = renderHistoryContent(
      [
        { type: "tool_use", name: "bash", input: { command: "ls" } },
        { type: "tool_use", name: "bash", input: { command: "pwd" } },
      ],
      undefined,
      "msg-1",
    );

    // Same positional scheme the web client used to synthesize, so snapshot and
    // stream tool calls stay keyed consistently and the client can drop its own
    // fallback once it no longer skews ahead of the daemon.
    expect(output.toolCalls.map((tc) => tc.id)).toEqual([
      "tool-history-msg-1-0",
      "tool-history-msg-1-1",
    ]);
  });

  test("keeps the provider id and only synthesizes for blocks missing one", () => {
    const output = renderHistoryContent(
      [
        {
          type: "tool_use",
          id: "tu_1",
          name: "bash",
          input: { command: "ls" },
        },
        { type: "tool_use", name: "bash", input: { command: "pwd" } },
      ],
      undefined,
      "msg-1",
    );

    expect(output.toolCalls.map((tc) => tc.id)).toEqual([
      "tu_1",
      "tool-history-msg-1-1",
    ]);
  });

  // ── Persisted risk-option ladders (Phase B of conflation track) ─────────────

  test("hydrates persisted _risk*Options annotations onto tool calls", () => {
    // Mirrors what `annotatePersistedAssistantMessage` writes to the DB so the
    // rule editor's chip ladder survives chat-history reload. Without these,
    // hydrated chips fall back to the synthesized `*` allowlist (see web's
    // `synthesizeFallbackOption` in RuleEditorModal.tsx).
    const scopeOptions = [
      { pattern: "exact", label: "exact: rm -rf /tmp" },
      { pattern: "by-program", label: "All rm" },
    ];
    const allowlistOptions = [
      { label: "exact", description: "exact match", pattern: "rm -rf /tmp" },
      { label: "All rm", description: "All rm commands", pattern: "rm *" },
    ];
    const directoryScopeOptions = [
      { scope: "/Users/me/code", label: "in code/" },
      { scope: "everywhere", label: "Everywhere" },
    ];

    const output = renderHistoryContent([
      {
        type: "tool_use",
        id: "tu_1",
        name: "bash",
        input: { command: "rm -rf /tmp" },
        _riskLevel: "high",
        _matchedTrustRuleId: "rule_42",
        _riskScopeOptions: scopeOptions,
        _riskAllowlistOptions: allowlistOptions,
        _riskDirectoryScopeOptions: directoryScopeOptions,
      },
    ]);

    const [entry] = output.toolCalls;
    expect(entry.riskLevel).toBe("high");
    expect(entry.matchedTrustRuleId).toBe("rule_42");
    expect(entry.riskScopeOptions).toEqual(scopeOptions);
    expect(entry.riskAllowlistOptions).toEqual(allowlistOptions);
    expect(entry.riskDirectoryScopeOptions).toEqual(directoryScopeOptions);
  });

  // ── Persisted tool activity (web_search / web_fetch) ────────────────────────

  test("hydrates persisted _activityMetadata onto a tool_use block", () => {
    // Mirrors what `annotatePersistedAssistantMessage` writes so the activity
    // card survives a history reopen instead of degrading to plain text.
    const activityMetadata: ToolActivityMetadata = {
      webSearch: {
        query: "vellum docs",
        provider: "brave",
        resultCount: 1,
        durationMs: 120,
        results: [
          {
            rank: 1,
            title: "Vellum",
            url: "https://vellum.ai",
            domain: "vellum.ai",
          },
        ],
      },
    };

    const output = renderHistoryContent([
      {
        type: "tool_use",
        id: "tu_1",
        name: "web_search",
        input: { query: "vellum docs" },
        _activityMetadata: activityMetadata,
      },
    ]);

    expect(output.toolCalls[0].activityMetadata).toEqual(activityMetadata);
  });

  test("hydrates persisted _activityMetadata onto a server_tool_use block", () => {
    const activityMetadata: ToolActivityMetadata = {
      webSearch: {
        query: "native search",
        provider: "anthropic-native",
        resultCount: 0,
        durationMs: 80,
        results: [],
      },
    };

    const output = renderHistoryContent([
      {
        type: "server_tool_use",
        id: "srvtu_1",
        name: "web_search",
        input: { query: "native search" },
        _activityMetadata: activityMetadata,
      },
    ]);

    expect(output.toolCalls[0].activityMetadata).toEqual(activityMetadata);
  });

  test("ignores non-object _activityMetadata annotations", () => {
    const output = renderHistoryContent([
      {
        type: "tool_use",
        id: "tu_1",
        name: "web_search",
        input: { query: "x" },
        _activityMetadata: "not an object",
      },
    ]);

    expect(output.toolCalls[0].activityMetadata).toBeUndefined();
  });

  test("ignores non-array _risk*Options annotations", () => {
    // Defensive: a malformed persisted block should not throw or coerce.
    const output = renderHistoryContent([
      {
        type: "tool_use",
        id: "tu_1",
        name: "bash",
        input: { command: "ls" },
        _riskLevel: "low",
        _riskScopeOptions: "not an array",
        _riskAllowlistOptions: { not: "an array" },
        _riskDirectoryScopeOptions: 42,
      },
    ]);

    const [entry] = output.toolCalls;
    expect(entry.riskLevel).toBe("low");
    expect(entry.riskScopeOptions).toBeUndefined();
    expect(entry.riskAllowlistOptions).toBeUndefined();
    expect(entry.riskDirectoryScopeOptions).toBeUndefined();
  });

  test("omits absent _risk*Options annotations", () => {
    const output = renderHistoryContent([
      {
        type: "tool_use",
        id: "tu_1",
        name: "bash",
        input: { command: "ls" },
        _riskLevel: "low",
      },
    ]);

    const [entry] = output.toolCalls;
    expect(entry.riskLevel).toBe("low");
    expect(entry.riskScopeOptions).toBeUndefined();
    expect(entry.riskAllowlistOptions).toBeUndefined();
    expect(entry.riskDirectoryScopeOptions).toBeUndefined();
  });

  test("reads back a persisted confirmation decision from the closed enum", () => {
    // GIVEN a persisted tool_use block stamped with a recorded decision
    const output = renderHistoryContent([
      {
        type: "tool_use",
        id: "tu_1",
        name: "bash",
        input: { command: "rm file" },
        _confirmationDecision: "denied",
        _confirmationLabel: "Run Command",
      },
    ]);

    // WHEN it is rendered into a history tool call
    const [entry] = output.toolCalls;

    // THEN the decision survives verbatim alongside its label
    expect(entry.confirmationDecision).toBe("denied");
    expect(entry.confirmationLabel).toBe("Run Command");
  });

  test("drops a _confirmationDecision outside the closed enum", () => {
    // GIVEN a malformed persisted decision the daemon never writes
    const output = renderHistoryContent([
      {
        type: "tool_use",
        id: "tu_1",
        name: "bash",
        input: { command: "ls" },
        _confirmationDecision: "bogus",
      },
    ]);

    // WHEN it is rendered into a history tool call
    const [entry] = output.toolCalls;

    // THEN the unknown value is not surfaced on the wire
    expect(entry.confirmationDecision).toBeUndefined();
  });

  test("handles mixed text and tool blocks", () => {
    const output = renderHistoryContent([
      { type: "text", text: "Let me look that up." },
      {
        type: "tool_use",
        id: "tu_1",
        name: "web_fetch",
        input: { url: "https://example.com" },
      },
      {
        type: "tool_result",
        tool_use_id: "tu_1",
        content: "page content here",
      },
    ]);

    expect(output.text).toBe("Let me look that up.");
    expect(output.toolCalls).toHaveLength(1);
    expect(output.toolCalls[0].name).toBe("web_fetch");
    expect(output.toolCalls[0].result).toBe("page content here");
    expect(output.toolCallsBeforeText).toBe(false);
  });

  test("sets toolCallsBeforeText true when tool_use precedes text", () => {
    const output = renderHistoryContent([
      { type: "tool_use", id: "tu_1", name: "bash", input: { command: "ls" } },
      { type: "tool_result", tool_use_id: "tu_1", content: "file.txt" },
      { type: "text", text: "Here are the files." },
    ]);

    expect(output.toolCallsBeforeText).toBe(true);
    expect(output.text).toBe("Here are the files.");
    expect(output.toolCalls).toHaveLength(1);
  });

  test("sets toolCallsBeforeText false when no tool calls exist", () => {
    const output = renderHistoryContent([{ type: "text", text: "Just text." }]);

    expect(output.toolCallsBeforeText).toBe(false);
  });

  test("drops orphan tool_result without matching tool_use", () => {
    const output = renderHistoryContent([
      { type: "tool_result", tool_use_id: "missing", content: "some result" },
    ]);

    // Orphans are dropped — without the parent tool_use we can't tell the user
    // what tool ran, so the result is meaningless. See shared.ts comment.
    expect(output.toolCalls).toEqual([]);
    expect(output.text).toBe("");
    expect(output.textSegments).toEqual([]);
    expect(output.contentOrder).toEqual([]);
  });

  test("produces textSegments for text-tool-text interleaving", () => {
    const output = renderHistoryContent([
      { type: "text", text: "What are you working on?" },
      {
        type: "tool_use",
        id: "tu_1",
        name: "memory_manage",
        input: { key: "task" },
      },
      { type: "tool_result", tool_use_id: "tu_1", content: "saved" },
      { type: "text", text: "Saved that to memory." },
    ]);

    expect(output.textSegments).toEqual([
      "What are you working on?",
      "Saved that to memory.",
    ]);
    expect(output.contentOrder).toEqual(["text:0", "tool:0", "text:1"]);
  });

  test("produces single segment for text-only content", () => {
    const output = renderHistoryContent([
      { type: "text", text: "Hello " },
      { type: "text", text: "world" },
    ]);

    expect(output.textSegments).toEqual(["Hello world"]);
    expect(output.contentOrder).toEqual(["text:0"]);
  });

  test("produces tool-only contentOrder for tool-only messages", () => {
    const output = renderHistoryContent([
      { type: "tool_use", id: "tu_1", name: "bash", input: { command: "ls" } },
    ]);

    expect(output.textSegments).toEqual([]);
    expect(output.contentOrder).toEqual(["tool:0"]);
  });

  test("produces segments for tool-text pattern", () => {
    const output = renderHistoryContent([
      { type: "tool_use", id: "tu_1", name: "bash", input: { command: "ls" } },
      { type: "tool_result", tool_use_id: "tu_1", content: "file.txt" },
      { type: "text", text: "Here are the files." },
    ]);

    expect(output.textSegments).toEqual(["Here are the files."]);
    expect(output.contentOrder).toEqual(["tool:0", "text:0"]);
  });

  test("produces segments for text-tool-tool-text pattern", () => {
    const output = renderHistoryContent([
      { type: "text", text: "Let me check." },
      { type: "tool_use", id: "tu_1", name: "bash", input: { command: "ls" } },
      { type: "tool_result", tool_use_id: "tu_1", content: "file.txt" },
      { type: "tool_use", id: "tu_2", name: "bash", input: { command: "pwd" } },
      { type: "tool_result", tool_use_id: "tu_2", content: "/home" },
      { type: "text", text: "Done." },
    ]);

    expect(output.textSegments).toEqual(["Let me check.", "Done."]);
    expect(output.contentOrder).toEqual([
      "text:0",
      "tool:0",
      "tool:1",
      "text:1",
    ]);
  });

  test("produces empty segments for non-array content", () => {
    const output = renderHistoryContent(null);
    expect(output.textSegments).toEqual([]);
    expect(output.contentOrder).toEqual([]);

    const output2 = renderHistoryContent("raw string");
    expect(output2.textSegments).toEqual(["raw string"]);
    expect(output2.contentOrder).toEqual(["text:0"]);
  });

  test("skips empty text blocks between consecutive tool_use blocks (consolidated message scenario)", () => {
    // Simulates message consolidation where empty text blocks from intermediate
    // API turns end up between tool_use blocks. Without the fix, these create
    // phantom text segments that break tool-call grouping in the UI.
    const output = renderHistoryContent([
      { type: "text", text: "Let me check." },
      { type: "tool_use", id: "tu_1", name: "bash", input: { command: "ls" } },
      { type: "tool_result", tool_use_id: "tu_1", content: "file.txt" },
      { type: "text", text: "" },
      { type: "tool_use", id: "tu_2", name: "bash", input: { command: "pwd" } },
      { type: "tool_result", tool_use_id: "tu_2", content: "/home" },
      { type: "text", text: "Done." },
    ]);

    expect(output.textSegments).toEqual(["Let me check.", "Done."]);
    expect(output.contentOrder).toEqual([
      "text:0",
      "tool:0",
      "tool:1",
      "text:1",
    ]);
  });

  test("skips whitespace-only text blocks between consecutive tool_use blocks", () => {
    const output = renderHistoryContent([
      { type: "tool_use", id: "tu_1", name: "bash", input: { command: "ls" } },
      { type: "tool_result", tool_use_id: "tu_1", content: "file.txt" },
      { type: "text", text: "   \n  " },
      { type: "tool_use", id: "tu_2", name: "bash", input: { command: "pwd" } },
      { type: "tool_result", tool_use_id: "tu_2", content: "/home" },
    ]);

    expect(output.textSegments).toEqual([]);
    expect(output.contentOrder).toEqual(["tool:0", "tool:1"]);
  });

  test("preserves non-empty text blocks between tool_use blocks", () => {
    const output = renderHistoryContent([
      { type: "tool_use", id: "tu_1", name: "bash", input: { command: "ls" } },
      { type: "tool_result", tool_use_id: "tu_1", content: "file.txt" },
      { type: "text", text: "Now let me try something else." },
      { type: "tool_use", id: "tu_2", name: "bash", input: { command: "pwd" } },
      { type: "tool_result", tool_use_id: "tu_2", content: "/home" },
    ]);

    expect(output.textSegments).toEqual(["Now let me try something else."]);
    expect(output.contentOrder).toEqual(["tool:0", "text:0", "tool:1"]);
  });

  test("drops Anthropic placeholder sentinel text blocks from history", () => {
    // Sentinels are injected into outbound API requests for role alternation
    // and must never render to the UI. Guards against any leak path that
    // bypasses cleanAssistantContent (bug-prone stored rows, historical
    // data predating migration 222, future regressions).
    const output = renderHistoryContent([
      { type: "text", text: "Real response before." },
      { type: "text", text: "\x00__PLACEHOLDER__[empty assistant turn]" },
      { type: "text", text: "__PLACEHOLDER__[empty assistant turn]" },
      { type: "text", text: "\x00__PLACEHOLDER__[internal blocks omitted]" },
      { type: "text", text: "__PLACEHOLDER__[internal blocks omitted]" },
      { type: "text", text: "Real response after." },
    ]);

    expect(output.text).toBe("Real response before. Real response after.");
    expect(output.textSegments).toEqual([
      "Real response before. Real response after.",
    ]);
    expect(output.contentOrder).toEqual(["text:0"]);
  });

  test("yields empty output when content is only a placeholder sentinel", () => {
    const output = renderHistoryContent([
      { type: "text", text: "\x00__PLACEHOLDER__[empty assistant turn]" },
    ]);

    expect(output.text).toBe("");
    expect(output.textSegments).toEqual([]);
    expect(output.contentOrder).toEqual([]);
  });

  test("keeps a flagged surface-fallback text block in .text but out of blocks/segments", () => {
    // The approval-card builder emits [ui_surface, text(_surfaceFallback)]. The
    // surface renders the card for rich clients; the flagged fallback must stay
    // in the flat `.text` body (CLI/search) but NOT appear as a text segment or
    // content block, or the card would render twice.
    const output = renderHistoryContent([
      {
        type: "ui_surface",
        surfaceId: "tool-approval-1",
        surfaceType: "card",
        title: "Tool Approval",
        data: { title: "Bob" },
      },
      { type: "text", text: "Bob wants to use bash", _surfaceFallback: true },
    ]);

    expect(output.text).toBe("Bob wants to use bash");
    expect(output.textSegments).toEqual([]);
    expect(output.surfaces).toHaveLength(1);
    expect(output.contentOrder).toEqual(["surface:0"]);
    expect(output.contentBlocks.map((b) => b.type)).toEqual(["surface"]);
  });

  test("renders an unflagged text block after a surface (legacy [ui_surface, text])", () => {
    // Pre-flag rows carry no `_surfaceFallback`, so the sibling text still
    // renders as its own block — legacy cards keep their duplicate text until
    // re-seeded. New rows carry the flag and de-dupe.
    const output = renderHistoryContent([
      { type: "ui_surface", surfaceId: "s1", surfaceType: "card", data: {} },
      { type: "text", text: "legacy fallback" },
    ]);

    expect(output.contentBlocks.map((b) => b.type)).toEqual([
      "surface",
      "text",
    ]);
    expect(output.text).toBe("legacy fallback");
  });
});

describe("renderHistoryContent contentBlocks", () => {
  test("builds an ordered block array while walking interleaved content", () => {
    // GIVEN a turn that interleaves text, reasoning, a tool call, a surface,
    // and trailing text in the raw model content
    const output = renderHistoryContent([
      { type: "text", text: "before tool" },
      { type: "thinking", thinking: "reasoning", signature: "sig" },
      { type: "tool_use", id: "t1", name: "run_command", input: { cmd: "ls" } },
      { type: "tool_result", tool_use_id: "t1", content: "file.txt" },
      {
        type: "ui_surface",
        surfaceId: "s1",
        surfaceType: "ui_card",
        data: {},
      },
      { type: "text", text: "after tool" },
    ]);

    // THEN contentBlocks mirrors the walk order
    expect(output.contentBlocks.map((b) => b.type)).toEqual([
      "text",
      "thinking",
      "tool_use",
      "surface",
      "text",
    ]);
    expect(output.contentBlocks[0]).toEqual({
      type: "text",
      text: "before tool",
    });
    expect(output.contentBlocks[1]).toEqual({
      type: "thinking",
      thinking: "reasoning",
    });
    expect(output.contentBlocks[4]).toEqual({
      type: "text",
      text: "after tool",
    });
    // AND the tool_use / surface blocks reuse the same objects the positional
    // arrays hold, so the tool result paired in later is reflected here too
    const toolBlock = output.contentBlocks[2];
    expect(toolBlock.type === "tool_use" && toolBlock.toolCall).toBe(
      output.toolCalls[0],
    );
    expect(output.toolCalls[0].result).toBe("file.txt");
    const surfaceBlock = output.contentBlocks[3];
    expect(surfaceBlock.type === "surface" && surfaceBlock.surface).toBe(
      output.surfaces[0],
    );
    // AND no attachment block appears (this turn has no file blocks)
    expect(output.contentBlocks.some((b) => b.type === "attachment")).toBe(
      false,
    );
  });

  test("surfaces persisted thinking timing onto the thinking block", () => {
    // GIVEN a thinking block the daemon stamped with internal `_startedAt` /
    // `_completedAt` timing at message_complete
    const output = renderHistoryContent([
      {
        type: "thinking",
        thinking: "reasoning",
        signature: "sig",
        _startedAt: 1000,
        _completedAt: 1500,
      },
    ]);

    // THEN the rendered block exposes them as the wire schema's
    // startedAt/completedAt so the client can show the duration + hover state
    expect(output.contentBlocks).toEqual([
      {
        type: "thinking",
        thinking: "reasoning",
        startedAt: 1000,
        completedAt: 1500,
      },
    ]);
  });

  test("omits thinking timing when the block carries none", () => {
    // GIVEN a thinking block with no persisted timing (older daemon / thinking
    // streaming disabled)
    const output = renderHistoryContent([
      { type: "thinking", thinking: "reasoning", signature: "sig" },
    ]);

    // THEN the rendered block has no startedAt/completedAt and the client hides
    // the duration, exactly as a tool call with no timing
    expect(output.contentBlocks).toEqual([
      { type: "thinking", thinking: "reasoning" },
    ]);
  });

  const pdfBlock = {
    type: "file",
    source: {
      type: "base64",
      media_type: "application/pdf",
      filename: "spec.pdf",
      data: Buffer.from("hi").toString("base64"),
    },
  } as const;
  const pdfAttachment = {
    id: "att-1",
    filename: "spec.pdf",
    mimeType: "application/pdf",
    sizeBytes: 2,
    kind: "file",
  } as const;

  test("inlines an attachment block when hydrated metadata is supplied", () => {
    // GIVEN a turn with text, a file attachment, then more text, and the
    // caller supplies the DB-hydrated metadata for that file block
    const output = renderHistoryContent(
      [
        { type: "text", text: "see file" },
        pdfBlock,
        { type: "text", text: "thanks" },
      ],
      [pdfAttachment],
    );

    // THEN the attachment block is placed inline between the two text blocks
    expect(output.contentBlocks).toEqual([
      { type: "text", text: "see file" },
      { type: "attachment", attachment: pdfAttachment },
      { type: "text", text: "thanks" },
    ]);
  });

  test("omits the file block from contentBlocks when no metadata is supplied", () => {
    // GIVEN the same turn but no hydrated metadata (the file still ships via
    // the positional attachments array, just not as an inline block)
    const output = renderHistoryContent([
      { type: "text", text: "see file" },
      pdfBlock,
      { type: "text", text: "thanks" },
    ]);

    expect(output.contentBlocks).toEqual([
      { type: "text", text: "see file" },
      { type: "text", text: "thanks" },
    ]);
    expect(output.attachments.length).toBe(1);
  });

  test("excludes the trailing attachment-description segment from blocks", () => {
    // GIVEN an attachment-only turn (the legacy text body carries a synthetic
    // attachment description segment for clients without attachment UI)
    const output = renderHistoryContent([pdfBlock], [pdfAttachment]);

    // THEN the only block is the inlined attachment — the synthetic text
    // segment stays in textSegments but never pollutes contentBlocks
    expect(output.contentBlocks).toEqual([
      { type: "attachment", attachment: pdfAttachment },
    ]);
    expect(output.textSegments.length).toBe(1);
  });

  test("emits a single text block for the non-array fallback", () => {
    expect(renderHistoryContent("raw string").contentBlocks).toEqual([
      { type: "text", text: "raw string" },
    ]);
    expect(renderHistoryContent(null).contentBlocks).toEqual([]);
  });
});

describe("getAttachmentsForMessage", () => {
  beforeEach(() => {
    const db = getDb();
    db.run("DELETE FROM message_attachments");
    db.run("DELETE FROM attachments");
    db.run("DELETE FROM messages");
    db.run("DELETE FROM conversations");
  });

  async function createMessage(
    role: "user" | "assistant" | "system",
    content: string,
  ): Promise<string> {
    const conv = createConversation("test");
    const msg = await addMessage(conv.id, role, content);
    return msg.id;
  }

  test("returns attachments linked to a message", async () => {
    const msgId = await createMessage("assistant", "Here is a chart");
    const stored = uploadAttachment("chart.png", "image/png", "iVBORw==");
    linkAttachmentToMessage(msgId, stored.id, 0);

    const result = getAttachmentsForMessage(msgId);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe(stored.id);
    expect(result[0].originalFilename).toBe("chart.png");
    expect(result[0].mimeType).toBe("image/png");
    expect(result[0].dataBase64).toBe("iVBORw==");
  });

  test("returns empty array when no attachments are linked", () => {
    expect(getAttachmentsForMessage("msg-nonexistent")).toEqual([]);
  });

  test("returns multiple attachments in position order", async () => {
    const msgId = await createMessage("assistant", "Two files");
    const a1 = uploadAttachment("first.txt", "text/plain", "AAAA");
    const a2 = uploadAttachment("second.txt", "text/plain", "BBBB");

    linkAttachmentToMessage(msgId, a2.id, 1);
    linkAttachmentToMessage(msgId, a1.id, 0);

    const result = getAttachmentsForMessage(msgId);
    expect(result).toHaveLength(2);
    expect(result[0].originalFilename).toBe("first.txt");
    expect(result[1].originalFilename).toBe("second.txt");
  });

  test("returns all attachments linked to a message", async () => {
    const msgId = await createMessage("assistant", "Mixed");
    const a1 = uploadAttachment("a.png", "image/png", "AAAA");
    const a2 = uploadAttachment("b.png", "image/png", "BBBB");

    linkAttachmentToMessage(msgId, a1.id, 0);
    linkAttachmentToMessage(msgId, a2.id, 1);

    const result = getAttachmentsForMessage(msgId);
    expect(result).toHaveLength(2);
  });
});
