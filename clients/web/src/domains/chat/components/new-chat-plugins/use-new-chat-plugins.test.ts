/**
 * Tests for `useNewChatPlugins`, the data hook backing the new-chat plugin
 * pills. It reads the installed list (`pluginsGet`) and derives a per-draft
 * selection from the conversation store's `pendingDraftPlugins`.
 *
 * The generated SDK is mocked so the installed read resolves locally; a
 * module-level holder lets each test drive the payload. The conversation store
 * is the real module — reset per test and seeded with an active draft id.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";

import type { PluginsGetResponse } from "@/generated/daemon/types.gen";
import { useConversationStore } from "@/stores/conversation-store";

const ASSISTANT_ID = "asst-1";

type InstalledPlugin = PluginsGetResponse["plugins"][number];

interface InstalledResult {
  data?: PluginsGetResponse;
  response: { ok: boolean; status: number };
}

// Per-test holder the SDK mock reads.
let installedResult: InstalledResult;

const sdkActual = await import("@/generated/daemon/sdk.gen");
const pluginsGetSpy = mock(async () => installedResult);
mock.module("@/generated/daemon/sdk.gen", () => ({
  ...sdkActual,
  pluginsGet: pluginsGetSpy,
}));

const { useNewChatPlugins } = await import("./use-new-chat-plugins");

function installed(name: string): InstalledPlugin {
  return { id: name, name, enabled: true, description: null, version: null };
}

function installedOk(plugins: InstalledPlugin[]): InstalledResult {
  return { data: { plugins }, response: { ok: true, status: 200 } };
}

function renderNewChatPlugins() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  function wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client }, children);
  }

  return renderHook(() => useNewChatPlugins(ASSISTANT_ID), { wrapper });
}

beforeEach(() => {
  installedResult = installedOk([
    installed("a"),
    installed("b"),
    installed("c"),
  ]);
  pluginsGetSpy.mockClear();
  useConversationStore.getState().reset();
  useConversationStore.getState().setActiveConversationId("draft-1");
});

afterEach(() => {
  cleanup();
});

describe("useNewChatPlugins", () => {
  test("default (untouched): every installed plugin is selected", async () => {
    const { result } = renderNewChatPlugins();

    await waitFor(() => expect(result.current.plugins).toHaveLength(3));

    expect(result.current.isSelected("a")).toBe(true);
    expect(result.current.isSelected("b")).toBe(true);
    expect(result.current.isSelected("c")).toBe(true);
  });

  test("toggling one off persists an explicit set lacking only that plugin", async () => {
    const { result } = renderNewChatPlugins();

    await waitFor(() => expect(result.current.plugins).toHaveLength(3));

    act(() => result.current.toggle("b"));

    expect(result.current.isSelected("a")).toBe(true);
    expect(result.current.isSelected("b")).toBe(false);
    expect(result.current.isSelected("c")).toBe(true);

    const stored = useConversationStore
      .getState()
      .pendingDraftPlugins.get("draft-1");
    expect(stored && [...stored].sort()).toEqual(["a", "c"]);
  });

  test("re-toggling a disabled plugin re-selects it", async () => {
    const { result } = renderNewChatPlugins();

    await waitFor(() => expect(result.current.plugins).toHaveLength(3));

    act(() => result.current.toggle("b"));
    expect(result.current.isSelected("b")).toBe(false);

    act(() => result.current.toggle("b"));
    expect(result.current.isSelected("b")).toBe(true);
    // Re-enabling within the same draft keeps the explicit entry around.
    expect(
      useConversationStore.getState().pendingDraftPlugins.has("draft-1"),
    ).toBe(true);
  });

  test("selection is independent per conversation id", async () => {
    const { result } = renderNewChatPlugins();

    await waitFor(() => expect(result.current.plugins).toHaveLength(3));

    act(() => result.current.toggle("b"));
    expect(result.current.isSelected("b")).toBe(false);

    // Switching to a fresh draft has no stored entry → default all-selected.
    act(() =>
      useConversationStore.getState().setActiveConversationId("draft-2"),
    );
    await waitFor(() => expect(result.current.isSelected("b")).toBe(true));

    // The first draft's selection is untouched.
    const stored = useConversationStore
      .getState()
      .pendingDraftPlugins.get("draft-1");
    expect(stored?.has("b")).toBe(false);
  });
});
