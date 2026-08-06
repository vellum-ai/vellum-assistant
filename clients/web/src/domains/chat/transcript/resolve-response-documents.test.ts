import { describe, expect, test } from "bun:test";

import type { ChatMessageToolCall } from "@/domains/chat/api/event-types";
import type { ConversationContentBlock } from "@vellumai/assistant-api";
import type { TranscriptItem } from "@/domains/chat/transcript/types";

import { resolveResponseDocumentIds } from "@/domains/chat/transcript/resolve-response-documents";

/** A settled `document_update` whose result carries the surface it wrote. */
function updateCall(id: string, surfaceId: string): ChatMessageToolCall {
  return {
    id,
    name: "document_update",
    input: { surface_id: surfaceId, content: "notes" },
    result: JSON.stringify({ success: true, surface_id: surfaceId }),
    completedAt: 1,
  };
}

/** A settled `document_create` whose result names the document it opened. */
function createCall(id: string, surfaceId: string): ChatMessageToolCall {
  return {
    id,
    name: "document_create",
    input: { title: "Notes" },
    result: JSON.stringify({ surface_id: surfaceId, opened: true }),
    completedAt: 1,
  };
}

/**
 * The inline `document_preview` surface `document_create` emits alongside its
 * result. The card carries its own `preview-` surface id; the document it
 * opens rides in `data.surfaceId`.
 */
function previewBlock(surfaceId: string): ConversationContentBlock {
  return {
    type: "surface",
    surface: {
      surfaceId: `preview-${surfaceId}`,
      surfaceType: "document_preview",
      data: { title: "Notes", surfaceId },
    },
  } as ConversationContentBlock;
}

function assistant(
  key: string,
  toolCalls: ChatMessageToolCall[] = [],
  extraBlocks: ConversationContentBlock[] = [],
): TranscriptItem {
  return {
    kind: "message",
    key,
    message: {
      id: key,
      role: "assistant",
      toolCalls,
      contentBlocks: [
        ...toolCalls.map(
          (toolCall) =>
            ({ type: "tool_use", toolCall }) as ConversationContentBlock,
        ),
        ...extraBlocks,
      ],
    },
  };
}

function user(key: string): TranscriptItem {
  return {
    kind: "message",
    key,
    message: {
      id: key,
      role: "user",
      contentBlocks: [{ type: "text", text: "do it" }],
    },
  };
}

describe("resolveResponseDocumentIds", () => {
  test("collapses one document changed by several messages into one entry", () => {
    const items = [
      user("u1"),
      assistant("a1", [updateCall("tc-1", "surf-notes")]),
      assistant("a2", [updateCall("tc-2", "surf-notes")]),
      assistant("a3", [updateCall("tc-3", "surf-notes")]),
    ];

    const byKey = resolveResponseDocumentIds(items);

    expect([...byKey]).toEqual([["a3", ["surf-notes"]]]);
  });

  test("keeps one entry per distinct document of a response", () => {
    const items = [
      user("u1"),
      assistant("a1", [updateCall("tc-1", "surf-notes")]),
      assistant("a2", [updateCall("tc-2", "surf-plan")]),
    ];

    const byKey = resolveResponseDocumentIds(items);

    expect(byKey.get("a2")).toEqual(["surf-notes", "surf-plan"]);
    expect(byKey.has("a1")).toBe(false);
  });

  test("anchors each response on its own final message", () => {
    const items = [
      user("u1"),
      assistant("a1", [updateCall("tc-1", "surf-notes")]),
      assistant("a2"),
      user("u2"),
      assistant("a3", [updateCall("tc-2", "surf-plan")]),
      assistant("a4"),
    ];

    const byKey = resolveResponseDocumentIds(items);

    expect(byKey.get("a2")).toEqual(["surf-notes"]);
    expect(byKey.get("a4")).toEqual(["surf-plan"]);
    expect(byKey.size).toBe(2);
  });

  test("withholds the in-flight response while the turn is active", () => {
    const items = [
      user("u1"),
      assistant("a1", [updateCall("tc-1", "surf-notes")]),
      user("u2"),
      assistant("a2", [updateCall("tc-2", "surf-plan")]),
    ];

    const byKey = resolveResponseDocumentIds(items, { turnActive: true });

    expect(byKey.get("a1")).toEqual(["surf-notes"]);
    expect(byKey.has("a2")).toBe(false);
  });

  test("keeps an earlier response's entry when the newest turn has no message yet", () => {
    const items = [
      user("u1"),
      assistant("a1", [updateCall("tc-1", "surf-notes")]),
      user("u2"),
    ];

    const byKey = resolveResponseDocumentIds(items, { turnActive: true });

    expect(byKey.get("a1")).toEqual(["surf-notes"]);
  });

  test("skips a document a preview card in the same response already opens", () => {
    const items = [
      user("u1"),
      assistant(
        "a1",
        [createCall("tc-1", "surf-notes")],
        [previewBlock("surf-notes")],
      ),
      assistant("a2"),
    ];

    expect(resolveResponseDocumentIds(items).size).toBe(0);
  });

  test("keeps a previewed document a later message of the response edits", () => {
    const items = [
      user("u1"),
      assistant(
        "a1",
        [createCall("tc-1", "surf-notes")],
        [previewBlock("surf-notes")],
      ),
      assistant("a2", [updateCall("tc-2", "surf-notes")]),
    ];

    expect(resolveResponseDocumentIds(items).get("a2")).toEqual(["surf-notes"]);
  });

  test("keeps a document previewed by a later response", () => {
    const items = [
      user("u1"),
      assistant("a1", [createCall("tc-1", "surf-notes")]),
      user("u2"),
      assistant("a2", [], [previewBlock("surf-notes")]),
    ];

    expect(resolveResponseDocumentIds(items).get("a1")).toEqual(["surf-notes"]);
  });

  test("keeps a document a non-preview surface names", () => {
    const card = {
      type: "surface",
      surface: {
        surfaceId: "card-1",
        surfaceType: "card",
        data: { surfaceId: "surf-notes" },
      },
    } as ConversationContentBlock;
    const items = [
      user("u1"),
      assistant("a1", [updateCall("tc-1", "surf-notes")], [card]),
    ];

    expect(resolveResponseDocumentIds(items).get("a1")).toEqual(["surf-notes"]);
  });

  test("ignores a tool call that is not a document mutation", () => {
    const items = [
      user("u1"),
      assistant("a1", [
        {
          id: "tc-read",
          name: "file_read",
          input: { path: "/tmp/notes.md" },
          result: JSON.stringify({ surface_id: "surf-notes" }),
          completedAt: 1,
        },
      ]),
    ];

    expect(resolveResponseDocumentIds(items).size).toBe(0);
  });

  test("skips a failed document call", () => {
    const items = [
      user("u1"),
      assistant("a1", [{ ...updateCall("tc-1", "surf-notes"), isError: true }]),
    ];

    expect(resolveResponseDocumentIds(items).size).toBe(0);
  });

  test("anchors on the last ordinary message when a system card ends the response", () => {
    const card: TranscriptItem = {
      kind: "message",
      key: "a2",
      message: {
        id: "a2",
        role: "assistant",
        isSystemCard: true,
        contentBlocks: [{ type: "text", text: "Context compacted." }],
      },
    };
    const items = [
      user("u1"),
      assistant("a1", [updateCall("tc-1", "surf-notes")]),
      card,
    ];

    const byKey = resolveResponseDocumentIds(items);

    expect(byKey.get("a1")).toEqual(["surf-notes"]);
    expect(byKey.has("a2")).toBe(false);
  });

  test("reuses the previous array when a response resolves the same ids", () => {
    const items = [user("u1"), assistant("a1", [updateCall("tc-1", "surf-a")])];

    const first = resolveResponseDocumentIds(items).get("a1");
    const second = resolveResponseDocumentIds(items).get("a1");

    expect(second).toBe(first!);
  });
});
