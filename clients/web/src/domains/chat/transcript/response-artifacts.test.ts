import { describe, expect, test } from "bun:test";

import type { ChatMessageToolCall } from "@/domains/chat/api/event-types";
import {
  artifactFromSurface,
  artifactsFromToolCalls,
  isArtifactPointerSurface,
  type ResponseArtifact,
} from "@/domains/chat/transcript/response-artifacts";

function call(partial: Partial<ChatMessageToolCall>): ChatMessageToolCall {
  return { id: "tc", name: "skill_execute", ...partial } as ChatMessageToolCall;
}

/** Just the ids, for the document cases that predate the app kind. */
function ids(artifacts: ResponseArtifact[]): string[] {
  return artifacts.map((artifact) => artifact.id);
}

/** A document tool call whose surface id is recoverable from its result. */
function docCall(
  id: string,
  tool: string,
  surfaceId: string,
  overrides: Partial<ChatMessageToolCall> = {},
): ChatMessageToolCall {
  return call({
    id,
    name: tool,
    input: { surface_id: surfaceId },
    result: JSON.stringify({ success: true, surface_id: surfaceId }),
    ...overrides,
  });
}

describe("artifactsFromToolCalls: documents", () => {
  test("resolves the surface id a single update wrote to", () => {
    const tc = docCall("tc-a", "document_update", "doc-1");
    expect(ids(artifactsFromToolCalls([tc], new Set()))).toEqual(["doc-1"]);
  });

  test("resolves a call delivered inside a skill_execute envelope", () => {
    const tc = call({
      id: "tc-a",
      name: "skill_execute",
      input: { tool: "document_update", surface_id: "doc-1" },
      result: JSON.stringify({ success: true, surface_id: "doc-1" }),
    });
    expect(ids(artifactsFromToolCalls([tc], new Set()))).toEqual(["doc-1"]);
  });

  test("collapses a create then an update of the same document to one entry", () => {
    const calls = [
      docCall("tc-a", "document_create", "doc-1"),
      docCall("tc-b", "document_update", "doc-1"),
    ];
    expect(ids(artifactsFromToolCalls(calls, new Set()))).toEqual(["doc-1"]);
  });

  test("returns two different documents in first-changed order", () => {
    const calls = [
      docCall("tc-a", "document_update", "doc-2"),
      docCall("tc-b", "document_replace_text", "doc-1"),
    ];
    expect(ids(artifactsFromToolCalls(calls, new Set()))).toEqual([
      "doc-2",
      "doc-1",
    ]);
  });

  test("a shared seen Set stops a second group anchoring the same document", () => {
    const claimed = new Set<string>();
    const first = docCall("tc-a", "document_update", "doc-1");
    const second = docCall("tc-b", "document_update", "doc-1");
    expect(ids(artifactsFromToolCalls([first], claimed))).toEqual(["doc-1"]);
    expect(ids(artifactsFromToolCalls([second], claimed))).toEqual([]);
  });

  test("ignores a malformed, non-JSON result without throwing", () => {
    const tc = docCall("tc-a", "document_update", "doc-1", {
      result: "Failed to update document: no document is open",
    });
    expect(ids(artifactsFromToolCalls([tc], new Set()))).toEqual([]);
  });

  test("ignores a result whose JSON carries no surface_id", () => {
    const tc = docCall("tc-a", "document_update", "doc-1", {
      result: JSON.stringify({ success: true }),
    });
    expect(ids(artifactsFromToolCalls([tc], new Set()))).toEqual([]);
  });

  test("ignores a call whose result has not landed yet", () => {
    const tc = docCall("tc-a", "document_update", "doc-1", {
      result: undefined,
    });
    expect(ids(artifactsFromToolCalls([tc], new Set()))).toEqual([]);
  });

  test("ignores non-document tool calls", () => {
    const calls = [
      call({ id: "tc-a", name: "document_read", result: "{}" }),
      call({
        id: "tc-b",
        name: "file_write",
        result: JSON.stringify({ surface_id: "doc-1" }),
      }),
    ];
    expect(ids(artifactsFromToolCalls(calls, new Set()))).toEqual([]);
  });

  test("ignores an errored call even when its result carries a surface id", () => {
    // A failed document_replace_text still echoes the surface id it targeted,
    // but nothing changed, so there is no document to reopen.
    const tc = docCall("tc-a", "document_replace_text", "doc-1", {
      isError: true,
      result: JSON.stringify({
        success: false,
        surface_id: "doc-1",
        error: "text not found",
      }),
    });
    expect(ids(artifactsFromToolCalls([tc], new Set()))).toEqual([]);
  });

  test("ignores a replace that succeeded without changing content", () => {
    // document_replace_text succeeds with content_changed: false when `find`
    // matched nothing, so the document is unchanged.
    const tc = docCall("tc-a", "document_replace_text", "doc-1", {
      result: JSON.stringify({
        success: true,
        surface_id: "doc-1",
        replacements_made: 0,
        content_changed: false,
      }),
    });
    expect(ids(artifactsFromToolCalls([tc], new Set()))).toEqual([]);
  });

  test("resolves a replace that reports content_changed", () => {
    const tc = docCall("tc-a", "document_replace_text", "doc-1", {
      result: JSON.stringify({
        success: true,
        surface_id: "doc-1",
        replacements_made: 2,
        content_changed: true,
      }),
    });
    expect(ids(artifactsFromToolCalls([tc], new Set()))).toEqual(["doc-1"]);
  });

  test("resolves create and update results, which omit content_changed", () => {
    const calls = [
      call({
        id: "tc-a",
        name: "document_create",
        input: { title: "Notes" },
        result: JSON.stringify({
          success: true,
          surface_id: "doc-1",
          message: "Document created",
        }),
      }),
      call({
        id: "tc-b",
        name: "document_update",
        input: { surface_id: "doc-2" },
        result: JSON.stringify({
          success: true,
          surface_id: "doc-2",
          mode: "append",
          message: "Document content updated",
        }),
      }),
    ];
    expect(ids(artifactsFromToolCalls(calls, new Set()))).toEqual([
      "doc-1",
      "doc-2",
    ]);
  });
});

describe("artifactsFromToolCalls: apps", () => {
  test("reads app_create's id and app_update's appId", () => {
    // The two executors spell the field differently: `app_create` spreads the
    // app record and `app_update` reports `appId`. Both persist as written.
    const calls = [
      call({
        id: "tc-a",
        name: "app_create",
        input: { name: "Tracker" },
        result: JSON.stringify({ id: "app-1", name: "Tracker" }),
      }),
      call({
        id: "tc-b",
        name: "app_update",
        input: { app_id: "app-2" },
        result: JSON.stringify({ updated: true, appId: "app-2" }),
      }),
    ];

    expect(artifactsFromToolCalls(calls, new Set())).toEqual([
      { kind: "app", id: "app-1" },
      { kind: "app", id: "app-2" },
    ]);
  });

  test("resolves an app call delivered inside a skill_execute envelope", () => {
    // App tools ship in the bundled `app-builder` skill, so the tool_use event
    // still carries `toolName: "skill_execute"`.
    const tc = call({
      id: "tc-a",
      input: { tool: "app_create", name: "Tracker" },
      result: JSON.stringify({ id: "app-1" }),
    });

    expect(artifactsFromToolCalls([tc], new Set())).toEqual([
      { kind: "app", id: "app-1" },
    ]);
  });

  test("omits a delete, which leaves nothing to open", () => {
    const tc = call({
      id: "tc-a",
      name: "app_delete",
      input: { app_id: "app-1" },
      result: JSON.stringify({ deleted: true, appId: "app-1" }),
    });

    expect(artifactsFromToolCalls([tc], new Set())).toEqual([]);
  });

  test("omits a failed create", () => {
    const tc = call({
      id: "tc-a",
      name: "app_create",
      input: { name: "Tracker" },
      result: JSON.stringify({ error: "compile failed" }),
      isError: true,
    });

    expect(artifactsFromToolCalls([tc], new Set())).toEqual([]);
  });

  test("keys dedupe by kind, so an app and a doc sharing an id both stand", () => {
    const calls = [
      docCall("tc-a", "document_update", "shared-id"),
      call({
        id: "tc-b",
        name: "app_create",
        input: {},
        result: JSON.stringify({ id: "shared-id" }),
      }),
    ];

    expect(artifactsFromToolCalls(calls, new Set())).toEqual([
      { kind: "document", id: "shared-id" },
      { kind: "app", id: "shared-id" },
    ]);
  });
});

describe("pointer surfaces", () => {
  test("a document_preview points at the document in data.surfaceId", () => {
    const surface = {
      surfaceType: "document_preview",
      data: { surfaceId: "doc-1", title: "Notes" },
    };

    expect(isArtifactPointerSurface(surface)).toBe(true);
    expect(artifactFromSurface(surface)).toEqual({
      kind: "document",
      id: "doc-1",
    });
  });

  test("a dynamic_page with preview points at its app", () => {
    const surface = {
      surfaceType: "dynamic_page",
      data: { appId: "app-1", preview: { title: "Tracker" }, html: "" },
    };

    expect(isArtifactPointerSurface(surface)).toBe(true);
    expect(artifactFromSurface(surface)).toEqual({ kind: "app", id: "app-1" });
  });

  test("a dynamic_page without preview is the app itself, not a pointer", () => {
    // This is the expanded, interactive surface. It is the content of the
    // response and has to keep rendering where it landed.
    const surface = {
      surfaceType: "dynamic_page",
      data: { appId: "app-1", html: "<main/>" },
    };

    expect(isArtifactPointerSurface(surface)).toBe(false);
    expect(artifactFromSurface(surface)).toBeNull();
  });

  test("reads the app_id spelling too", () => {
    const surface = {
      surfaceType: "dynamic_page",
      data: { app_id: "app-1", preview: {} },
    };

    expect(artifactFromSurface(surface)).toEqual({ kind: "app", id: "app-1" });
  });

  test("an unrelated surface is never a pointer", () => {
    expect(
      isArtifactPointerSurface({
        surfaceType: "card",
        data: { surfaceId: "doc-1" },
      }),
    ).toBe(false);
  });
});
