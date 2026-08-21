import { describe, expect, test } from "bun:test";

import type { ChatMessageToolCall } from "@/domains/chat/api/event-types";
import type { ConversationContentBlock } from "@vellumai/assistant-api";
import type { TranscriptItem } from "@/domains/chat/transcript/types";

import { resolveResponseArtifacts } from "@/domains/chat/transcript/resolve-response-artifacts";
import type { ResponseArtifact } from "@/domains/chat/transcript/response-artifacts";

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

/** A settled `app_create` whose result spreads the app record (`id`). */
function appCreateCall(id: string, appId: string): ChatMessageToolCall {
  return {
    id,
    name: "app_create",
    input: { name: "Tracker" },
    result: JSON.stringify({ id: appId, name: "Tracker", auto_opened: true }),
    completedAt: 1,
  };
}

/** A settled `app_update`, which reports the app under `appId` instead. */
function appUpdateCall(id: string, appId: string): ChatMessageToolCall {
  return {
    id,
    name: "app_update",
    input: { app_id: appId },
    result: JSON.stringify({ updated: true, appId, name: "Tracker" }),
    completedAt: 1,
  };
}

/**
 * The `dynamic_page` preview `app_create` auto-opens with. `data.preview` is
 * what makes it a pointer: the surface renders an `AppCard` rather than the
 * expanded app.
 */
function appPreviewBlock(appId: string): ConversationContentBlock {
  return {
    type: "surface",
    surface: {
      surfaceId: `page-${appId}`,
      surfaceType: "dynamic_page",
      data: { appId, preview: { title: "Tracker" }, html: "" },
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

/** The document artifact the resolver reports for `surfaceId`. */
function doc(surfaceId: string): ResponseArtifact {
  return { kind: "document", id: surfaceId };
}

describe("resolveResponseArtifacts", () => {
  test("collapses one document changed by several messages into one entry", () => {
    const items = [
      user("u1"),
      assistant("a1", [updateCall("tc-1", "surf-notes")]),
      assistant("a2", [updateCall("tc-2", "surf-notes")]),
      assistant("a3", [updateCall("tc-3", "surf-notes")]),
    ];

    const byKey = resolveResponseArtifacts(items);

    expect([...byKey]).toEqual([["a3", [doc("surf-notes")]]]);
  });

  test("keeps one entry per distinct document of a response", () => {
    const items = [
      user("u1"),
      assistant("a1", [updateCall("tc-1", "surf-notes")]),
      assistant("a2", [updateCall("tc-2", "surf-plan")]),
    ];

    const byKey = resolveResponseArtifacts(items);

    expect(byKey.get("a2")).toEqual([doc("surf-notes"), doc("surf-plan")]);
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

    const byKey = resolveResponseArtifacts(items);

    expect(byKey.get("a2")).toEqual([doc("surf-notes")]);
    expect(byKey.get("a4")).toEqual([doc("surf-plan")]);
    expect(byKey.size).toBe(2);
  });

  test("withholds the in-flight response while the turn is active", () => {
    const items = [
      user("u1"),
      assistant("a1", [updateCall("tc-1", "surf-notes")]),
      user("u2"),
      assistant("a2", [updateCall("tc-2", "surf-plan")]),
    ];

    const byKey = resolveResponseArtifacts(items, { turnActive: true });

    expect(byKey.get("a1")).toEqual([doc("surf-notes")]);
    expect(byKey.has("a2")).toBe(false);
  });

  test("keeps an earlier response's entry when the newest turn has no message yet", () => {
    const items = [
      user("u1"),
      assistant("a1", [updateCall("tc-1", "surf-notes")]),
      user("u2"),
    ];

    const byKey = resolveResponseArtifacts(items, { turnActive: true });

    expect(byKey.get("a1")).toEqual([doc("surf-notes")]);
  });

  test("keeps a created document to one entry despite its preview card", () => {
    // The preview card is not drawn where its tool ran, so it does not stand
    // in for the end-of-response card. It names the same document the create
    // does, and the response owes exactly one entry for it.
    const items = [
      user("u1"),
      assistant(
        "a1",
        [createCall("tc-1", "surf-notes")],
        [previewBlock("surf-notes")],
      ),
      assistant("a2"),
    ];

    expect(resolveResponseArtifacts(items).get("a2")).toEqual([
      doc("surf-notes"),
    ]);
  });

  test("keeps one entry for a document created then edited", () => {
    // A create and an edit both name one document, and the union collapses
    // them onto a single entry.
    const items = [
      user("u1"),
      assistant(
        "a1",
        [createCall("tc-1", "surf-notes")],
        [previewBlock("surf-notes")],
      ),
      assistant("a2", [updateCall("tc-2", "surf-notes")]),
    ];

    expect(resolveResponseArtifacts(items).get("a2")).toEqual([
      doc("surf-notes"),
    ]);
  });

  test("keeps a document a response only opened", () => {
    // `document_open` mutates nothing, so the preview surface it emits is the
    // response's only trace of the document, and it anchors the entry alone.
    const items = [
      user("u1"),
      assistant("a1", [], [previewBlock("surf-notes")]),
    ];

    expect(resolveResponseArtifacts(items).get("a1")).toEqual([
      doc("surf-notes"),
    ]);
  });

  test("leaves a later response that only previews the same document empty", () => {
    // The document is in the conversation's assets from the create onwards, so
    // reopening it is not news the transcript repeats.
    const items = [
      user("u1"),
      assistant("a1", [createCall("tc-1", "surf-notes")]),
      user("u2"),
      assistant("a2", [], [previewBlock("surf-notes")]),
    ];

    const byKey = resolveResponseArtifacts(items);

    expect(byKey.get("a1")).toEqual([doc("surf-notes")]);
    expect(byKey.has("a2")).toBe(false);
  });

  test("leaves a later response that edits the same document empty", () => {
    const items = [
      user("u1"),
      assistant("a1", [createCall("tc-1", "surf-notes")]),
      user("u2"),
      assistant("a2", [updateCall("tc-2", "surf-notes")]),
      user("u3"),
      assistant("a3", [updateCall("tc-3", "surf-notes")]),
    ];

    const byKey = resolveResponseArtifacts(items);

    expect([...byKey]).toEqual([["a1", [doc("surf-notes")]]]);
  });

  test("leaves a later response that updates the same app empty", () => {
    const items = [
      user("u1"),
      assistant(
        "a1",
        [appCreateCall("tc-1", "app-7")],
        [appPreviewBlock("app-7")],
      ),
      user("u2"),
      assistant("a2", [appUpdateCall("tc-2", "app-7")]),
    ];

    const byKey = resolveResponseArtifacts(items);

    expect([...byKey]).toEqual([["a1", [{ kind: "app", id: "app-7" }]]]);
  });

  test("keeps the card on the response that first reached the asset", () => {
    // Nothing in this thread created the document; it was reached from an
    // older conversation, so the response that first touches it here is the
    // one that owes the card.
    const items = [
      user("u1"),
      assistant("a1", [], [previewBlock("surf-notes")]),
      user("u2"),
      assistant("a2", [updateCall("tc-1", "surf-notes")]),
    ];

    const byKey = resolveResponseArtifacts(items);

    expect([...byKey]).toEqual([["a1", [doc("surf-notes")]]]);
  });

  test("gives each asset its own first response", () => {
    const items = [
      user("u1"),
      assistant("a1", [createCall("tc-1", "surf-notes")]),
      user("u2"),
      assistant("a2", [
        updateCall("tc-2", "surf-notes"),
        createCall("tc-3", "surf-plan"),
      ]),
    ];

    const byKey = resolveResponseArtifacts(items);

    expect(byKey.get("a1")).toEqual([doc("surf-notes")]);
    expect(byKey.get("a2")).toEqual([doc("surf-plan")]);
  });

  test("does not let the in-flight response claim an asset it repeats", () => {
    // The in-flight response is withheld, and a response that draws nothing
    // must not consume the entry either. The create keeps it throughout.
    const items = [
      user("u1"),
      assistant("a1", [createCall("tc-1", "surf-notes")]),
      user("u2"),
      assistant("a2", [updateCall("tc-2", "surf-notes")]),
    ];

    expect([...resolveResponseArtifacts(items, { turnActive: true })]).toEqual([
      ["a1", [doc("surf-notes")]],
    ]);
    expect([...resolveResponseArtifacts(items)]).toEqual([
      ["a1", [doc("surf-notes")]],
    ]);
  });

  test("collects apps alongside documents, in first-touched order", () => {
    // Both kinds run through one registry, so a response that builds an app
    // and writes a doc closes with one card each, ordered by when it happened.
    const items = [
      user("u1"),
      assistant(
        "a1",
        [appCreateCall("tc-app", "app-7")],
        [appPreviewBlock("app-7")],
      ),
      assistant("a2", [updateCall("tc-doc", "surf-notes")]),
    ];

    expect(resolveResponseArtifacts(items).get("a2")).toEqual([
      { kind: "app", id: "app-7" },
      doc("surf-notes"),
    ]);
  });

  test("keeps a created-then-updated app to one entry", () => {
    // The app twin of the document case: `app_create` emits a preview naming
    // the app, and a later `app_update` names it again.
    const items = [
      user("u1"),
      assistant(
        "a1",
        [appCreateCall("tc-1", "app-7")],
        [appPreviewBlock("app-7")],
      ),
      assistant("a2", [appUpdateCall("tc-2", "app-7")]),
    ];

    expect(resolveResponseArtifacts(items).get("a2")).toEqual([
      { kind: "app", id: "app-7" },
    ]);
  });

  test("ignores an expanded dynamic_page, which is the app itself", () => {
    // Without `preview` the surface renders the live app inline: content, not
    // a pointer, so it anchors nothing and keeps rendering where it landed.
    const expanded = {
      type: "surface",
      surface: {
        surfaceId: "page-1",
        surfaceType: "dynamic_page",
        data: { appId: "app-7", html: "<main/>" },
      },
    } as ConversationContentBlock;
    const items = [user("u1"), assistant("a1", [], [expanded])];

    expect(resolveResponseArtifacts(items).size).toBe(0);
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

    expect(resolveResponseArtifacts(items).get("a1")).toEqual([
      doc("surf-notes"),
    ]);
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

    expect(resolveResponseArtifacts(items).size).toBe(0);
  });

  test("skips a failed document call", () => {
    const items = [
      user("u1"),
      assistant("a1", [{ ...updateCall("tc-1", "surf-notes"), isError: true }]),
    ];

    expect(resolveResponseArtifacts(items).size).toBe(0);
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

    const byKey = resolveResponseArtifacts(items);

    expect(byKey.get("a1")).toEqual([doc("surf-notes")]);
    expect(byKey.has("a2")).toBe(false);
  });

  test("does not let a system-card-only response claim an asset", () => {
    // A response with no ordinary message has no card slot, so it cannot draw
    // the asset it touched. Claiming it there would lose the card entirely.
    const card = (key: string, toolCalls: ChatMessageToolCall[]) =>
      ({
        kind: "message",
        key,
        message: {
          id: key,
          role: "assistant",
          isSystemCard: true,
          toolCalls,
          contentBlocks: toolCalls.map(
            (toolCall) =>
              ({ type: "tool_use", toolCall }) as ConversationContentBlock,
          ),
        },
      }) as TranscriptItem;
    const items = [
      user("u1"),
      card("a1", [createCall("tc-1", "surf-notes")]),
      user("u2"),
      assistant("a2", [updateCall("tc-2", "surf-notes")]),
    ];

    expect([...resolveResponseArtifacts(items)]).toEqual([
      ["a2", [doc("surf-notes")]],
    ]);
  });

  test("keeps a drawn card where it is when older history arrives", () => {
    // The transcript loads its newest page first and prepends older ones, so
    // an earlier touch can surface after the card is already drawn. Retracting
    // it would remove height below the viewport, which the prepend's
    // scrollHeight-delta correction reads as prepended content.
    const conversationId = "conv-prepend";
    const newestPage = [user("u2"), assistant("a2", [updateCall("tc-2", "s")])];
    const withOlderPage = [
      user("u1"),
      assistant("a1", [createCall("tc-1", "s")]),
      ...newestPage,
    ];

    expect([
      ...resolveResponseArtifacts(newestPage, { conversationId }),
    ]).toEqual([["a2", [doc("s")]]]);
    expect([
      ...resolveResponseArtifacts(withOlderPage, { conversationId }),
    ]).toEqual([["a2", [doc("s")]]]);
  });

  test("awards the oldest touch when the held response has left the window", () => {
    // A fork or a cleared history retires the anchor an award names, and an
    // anchor nothing can draw must not keep the card from the responses that
    // remain.
    const conversationId = "conv-forked";
    const before = [user("u1"), assistant("a1", [createCall("tc-1", "s")])];
    const after = [user("u2"), assistant("a2", [updateCall("tc-2", "s")])];

    resolveResponseArtifacts(before, { conversationId });

    expect([...resolveResponseArtifacts(after, { conversationId })]).toEqual([
      ["a2", [doc("s")]],
    ]);
  });

  test("starts fresh awards for another conversation", () => {
    const first = [user("u1"), assistant("a1", [createCall("tc-1", "s")])];
    const second = [
      user("u1"),
      assistant("a1", [createCall("tc-1", "s")]),
      user("u2"),
      assistant("a2", [updateCall("tc-2", "s")]),
    ];

    resolveResponseArtifacts(first, { conversationId: "conv-a" });

    expect([
      ...resolveResponseArtifacts(second, { conversationId: "conv-b" }),
    ]).toEqual([["a1", [doc("s")]]]);
  });

  test("reuses the previous array when a response resolves the same ids", () => {
    const items = [user("u1"), assistant("a1", [updateCall("tc-1", "surf-a")])];

    const first = resolveResponseArtifacts(items).get("a1");
    const second = resolveResponseArtifacts(items).get("a1");

    expect(second).toBe(first!);
  });
});
