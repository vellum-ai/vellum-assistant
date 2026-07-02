/**
 * Tests for `useEffectiveChatPlugins`, the read-only hook that resolves a
 * chat's effective plugin selection by joining the installed list
 * (`pluginsGet`) against the conversation's explicit scope.
 *
 * The generated SDK is mocked so both reads resolve locally: module-level
 * holders let each test drive the installed payload and the conversation
 * response (or make the conversation read reject, standing in for a draft with
 * no server row). The conversation store is the real module — reset per test.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";

import type {
  ConversationsByIdGetResponse,
  PluginsGetResponse,
} from "@/generated/daemon/types.gen";
import { useConversationStore } from "@/stores/conversation-store";
import { ApiError } from "@/utils/api-errors";

const ASSISTANT_ID = "asst-1";
const CONVERSATION_ID = "conv-1";

type InstalledPlugin = PluginsGetResponse["plugins"][number];

interface InstalledResult {
  data?: PluginsGetResponse;
  response: { ok: boolean; status: number };
}

// Per-test holders the SDK mocks read.
let installedResult: InstalledResult;
let conversationImpl: () => Promise<{ data: ConversationsByIdGetResponse }>;

const sdkActual = await import("@/generated/daemon/sdk.gen");
const pluginsGetSpy = mock(async () => installedResult);
const conversationsByIdGetSpy = mock(() => conversationImpl());
mock.module("@/generated/daemon/sdk.gen", () => ({
  ...sdkActual,
  pluginsGet: pluginsGetSpy,
  conversationsByIdGet: conversationsByIdGetSpy,
}));

const { useEffectiveChatPlugins } = await import("./use-effective-chat-plugins");

function installed(name: string): InstalledPlugin {
  return { id: name, name, enabled: true, description: null, version: null };
}

function installedOk(plugins: InstalledPlugin[]): InstalledResult {
  return { data: { plugins }, response: { ok: true, status: 200 } };
}

/**
 * A loaded conversation row carrying an explicit `enabledPlugins` scope.
 * `enabledPlugins` isn't on the generated conversation type yet (the sibling
 * daemon PR adds it), so cast through the response shape.
 */
function conversationWith(
  enabledPlugins: string[] | null,
): { data: ConversationsByIdGetResponse } {
  return {
    data: {
      conversation: { id: CONVERSATION_ID, enabledPlugins },
    } as unknown as ConversationsByIdGetResponse,
  };
}

/** Default conversation read: reject with a 404, standing in for a draft with no server row. */
function noServerRow(): Promise<{ data: ConversationsByIdGetResponse }> {
  return Promise.reject(new ApiError(404, "no server row"));
}

function renderEffective(conversationId: string | undefined = CONVERSATION_ID) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  function wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client }, children);
  }

  return renderHook(() => useEffectiveChatPlugins(ASSISTANT_ID, conversationId), {
    wrapper,
  });
}

beforeEach(() => {
  // Installed list is deliberately unsorted so the hook's stable sort is exercised.
  installedResult = installedOk([
    installed("c"),
    installed("a"),
    installed("b"),
  ]);
  conversationImpl = noServerRow;
  pluginsGetSpy.mockClear();
  conversationsByIdGetSpy.mockClear();
  useConversationStore.getState().reset();
});

afterEach(() => {
  cleanup();
});

describe("useEffectiveChatPlugins", () => {
  test("draft with no stored entry → every plugin selected, isDefault true", async () => {
    const { result } = renderEffective();

    await waitFor(() => expect(result.current.total).toBe(3));

    expect(result.current.isDefault).toBe(true);
    expect(result.current.selectedCount).toBe(3);
    expect(result.current.plugins.every((p) => p.selected)).toBe(true);
    // Sorted alphabetically regardless of installed-list order.
    expect(result.current.plugins.map((p) => p.name)).toEqual(["a", "b", "c"]);
  });

  test("existing chat whose detail is still loading → isResolved false", async () => {
    // Never resolves: an existing conversation whose detail GET is still pending.
    conversationImpl = () =>
      new Promise<{ data: ConversationsByIdGetResponse }>(() => {});
    // A scoped draft stash exists, but a still-loading existing chat must NOT
    // fall back to it (that would show the wrong scope until the GET lands).
    useConversationStore
      .getState()
      .setPendingDraftPlugins(CONVERSATION_ID, new Set(["a"]));

    const { result } = renderEffective();

    // Installed list loads; the conversation detail stays pending.
    await waitFor(() => expect(result.current.total).toBe(3));

    expect(result.current.isResolved).toBe(false);
  });

  test("existing chat whose detail fails with a non-404 error → isResolved false", async () => {
    // A transient failure (500 / network / auth), not a confirmed missing row:
    // the scope stays unknown so a scoped chat isn't rendered as all-active.
    conversationImpl = () => Promise.reject(new ApiError(500, "server error"));
    useConversationStore
      .getState()
      .setPendingDraftPlugins(CONVERSATION_ID, new Set(["a"]));

    const { result } = renderEffective();

    await waitFor(() => expect(result.current.total).toBe(3));

    expect(result.current.isResolved).toBe(false);
  });

  test("sent conversation with enabledPlugins ['a'] → only 'a' selected", async () => {
    conversationImpl = () => Promise.resolve(conversationWith(["a"]));
    // A conflicting draft stash must lose to the loaded server row.
    useConversationStore
      .getState()
      .setPendingDraftPlugins(CONVERSATION_ID, new Set(["a", "b"]));

    const { result } = renderEffective();

    await waitFor(() => expect(result.current.selectedCount).toBe(1));

    expect(result.current.isDefault).toBe(false);
    expect(result.current.total).toBe(3);
    const byName = Object.fromEntries(
      result.current.plugins.map((p) => [p.name, p.selected]),
    );
    expect(byName).toEqual({ a: true, b: false, c: false });
  });

  test("sent conversation with enabledPlugins null → default, all selected", async () => {
    conversationImpl = () => Promise.resolve(conversationWith(null));
    // Draft stash would select only 'a'; the loaded null scope must override it
    // back to the all-selected default.
    useConversationStore
      .getState()
      .setPendingDraftPlugins(CONVERSATION_ID, new Set(["a"]));

    const { result } = renderEffective();

    await waitFor(() => expect(result.current.isDefault).toBe(true));

    expect(result.current.selectedCount).toBe(3);
    expect(result.current.plugins.every((p) => p.selected)).toBe(true);
  });

  test("selected joins installed metadata (name + label per plugin)", async () => {
    conversationImpl = () => Promise.resolve(conversationWith(["b"]));

    const { result } = renderEffective();

    await waitFor(() => expect(result.current.selectedCount).toBe(1));

    expect(result.current.plugins).toEqual([
      { name: "a", label: "a", selected: false },
      { name: "b", label: "b", selected: true },
      { name: "c", label: "c", selected: false },
    ]);
  });

  test("draft stash (no server row) drives selection when the row is absent", async () => {
    // Row read rejects (draft); the composer stash is the source of truth.
    useConversationStore
      .getState()
      .setPendingDraftPlugins(CONVERSATION_ID, new Set(["b", "c"]));

    const { result } = renderEffective();

    await waitFor(() => expect(result.current.selectedCount).toBe(2));

    expect(result.current.isDefault).toBe(false);
    const byName = Object.fromEntries(
      result.current.plugins.map((p) => [p.name, p.selected]),
    );
    expect(byName).toEqual({ a: false, b: true, c: true });
  });
});
