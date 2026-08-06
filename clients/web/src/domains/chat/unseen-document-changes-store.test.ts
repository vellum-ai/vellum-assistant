/**
 * Tests for the unseen-document-changes store.
 *
 * Every case asserts the pure predicate and the reactive hook together, since
 * the point of the pairing is that a badge and the clearing logic can never
 * disagree about what "unseen" means.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";

import {
  hasUnseenChanges,
  useHasUnseenDocumentChanges,
  useUnseenDocumentChangesStore,
} from "@/domains/chat/unseen-document-changes-store";

afterEach(() => {
  cleanup();
  useUnseenDocumentChangesStore.setState({ changedDocuments: {} });
});

/** Assert the predicate and the hook agree, and return what they both say. */
function unseen(conversationId: string | null): boolean {
  const fromPredicate = hasUnseenChanges(
    useUnseenDocumentChangesStore.getState(),
    conversationId,
  );
  const { result } = renderHook(() =>
    useHasUnseenDocumentChanges(conversationId),
  );
  expect(result.current).toBe(fromPredicate);
  return fromPredicate;
}

describe("unseen document changes", () => {
  test("starts with nothing unseen", () => {
    expect(unseen("conv-1")).toBe(false);
  });

  test("marking a document makes its conversation unseen", () => {
    act(() => {
      useUnseenDocumentChangesStore
        .getState()
        .markDocumentChanged("conv-1", "doc-a");
    });

    expect(unseen("conv-1")).toBe(true);
  });

  test("clearing the marked document clears the conversation", () => {
    act(() => {
      useUnseenDocumentChangesStore
        .getState()
        .markDocumentChanged("conv-1", "doc-a");
      useUnseenDocumentChangesStore.getState().clearDocument("conv-1", "doc-a");
    });

    expect(unseen("conv-1")).toBe(false);
    expect(
      useUnseenDocumentChangesStore.getState().changedDocuments["conv-1"],
    ).toBeUndefined();
  });

  test("clearing one document leaves the other unseen", () => {
    act(() => {
      const store = useUnseenDocumentChangesStore.getState();
      store.markDocumentChanged("conv-1", "doc-a");
      store.markDocumentChanged("conv-1", "doc-b");
      store.clearDocument("conv-1", "doc-a");
    });

    expect(unseen("conv-1")).toBe(true);
    expect(
      useUnseenDocumentChangesStore.getState().changedDocuments["conv-1"],
    ).toEqual(new Set(["doc-b"]));
  });

  test("clearing a document that was never marked is a no-op", () => {
    const before = useUnseenDocumentChangesStore.getState().changedDocuments;

    act(() => {
      useUnseenDocumentChangesStore.getState().clearDocument("conv-1", "doc-a");
    });

    expect(useUnseenDocumentChangesStore.getState().changedDocuments).toBe(
      before,
    );
    expect(unseen("conv-1")).toBe(false);
  });

  test("conversations are isolated from each other", () => {
    act(() => {
      useUnseenDocumentChangesStore
        .getState()
        .markDocumentChanged("conv-1", "doc-a");
    });

    expect(unseen("conv-1")).toBe(true);
    expect(unseen("conv-2")).toBe(false);
  });

  test("clearing one conversation leaves the other unseen", () => {
    act(() => {
      const store = useUnseenDocumentChangesStore.getState();
      store.markDocumentChanged("conv-1", "doc-a");
      store.markDocumentChanged("conv-2", "doc-b");
      store.clearConversation("conv-1");
    });

    expect(unseen("conv-1")).toBe(false);
    expect(unseen("conv-2")).toBe(true);
  });

  test("clearing a conversation clears all of its documents", () => {
    act(() => {
      const store = useUnseenDocumentChangesStore.getState();
      store.markDocumentChanged("conv-1", "doc-a");
      store.markDocumentChanged("conv-1", "doc-b");
      store.clearConversation("conv-1");
    });

    expect(unseen("conv-1")).toBe(false);
    expect(useUnseenDocumentChangesStore.getState().changedDocuments).toEqual(
      {},
    );
  });

  test("marking the same document twice is idempotent", () => {
    act(() => {
      useUnseenDocumentChangesStore
        .getState()
        .markDocumentChanged("conv-1", "doc-a");
    });
    const afterFirst =
      useUnseenDocumentChangesStore.getState().changedDocuments;

    act(() => {
      useUnseenDocumentChangesStore
        .getState()
        .markDocumentChanged("conv-1", "doc-a");
    });

    expect(useUnseenDocumentChangesStore.getState().changedDocuments).toBe(
      afterFirst,
    );
    expect(unseen("conv-1")).toBe(true);

    act(() => {
      useUnseenDocumentChangesStore.getState().clearDocument("conv-1", "doc-a");
    });

    expect(unseen("conv-1")).toBe(false);
  });

  test("clearing everywhere clears a conversation the reader never opened", () => {
    act(() => {
      useUnseenDocumentChangesStore
        .getState()
        .markDocumentChanged("conv-2", "doc-a");
      useUnseenDocumentChangesStore.getState().clearDocumentEverywhere("doc-a");
    });

    expect(unseen("conv-2")).toBe(false);
    expect(useUnseenDocumentChangesStore.getState().changedDocuments).toEqual(
      {},
    );
  });

  test("clearing everywhere clears the surface from every conversation", () => {
    act(() => {
      const store = useUnseenDocumentChangesStore.getState();
      store.markDocumentChanged("conv-1", "doc-a");
      store.markDocumentChanged("conv-2", "doc-a");
      store.markDocumentChanged("conv-3", "doc-b");
      store.clearDocumentEverywhere("doc-a");
    });

    expect(unseen("conv-1")).toBe(false);
    expect(unseen("conv-2")).toBe(false);
    expect(unseen("conv-3")).toBe(true);
  });

  test("clearing everywhere leaves the conversation's other documents unseen", () => {
    act(() => {
      const store = useUnseenDocumentChangesStore.getState();
      store.markDocumentChanged("conv-1", "doc-a");
      store.markDocumentChanged("conv-1", "doc-b");
      store.clearDocumentEverywhere("doc-a");
    });

    expect(unseen("conv-1")).toBe(true);
    expect(
      useUnseenDocumentChangesStore.getState().changedDocuments["conv-1"],
    ).toEqual(new Set(["doc-b"]));
  });

  test("clearing everywhere for an unmarked surface is a no-op", () => {
    act(() => {
      useUnseenDocumentChangesStore
        .getState()
        .markDocumentChanged("conv-1", "doc-a");
    });
    const before = useUnseenDocumentChangesStore.getState().changedDocuments;

    act(() => {
      useUnseenDocumentChangesStore.getState().clearDocumentEverywhere("doc-b");
    });

    expect(useUnseenDocumentChangesStore.getState().changedDocuments).toBe(
      before,
    );
    expect(unseen("conv-1")).toBe(true);
  });

  test("a null conversation id is never unseen", () => {
    act(() => {
      useUnseenDocumentChangesStore
        .getState()
        .markDocumentChanged("conv-1", "doc-a");
    });

    expect(unseen(null)).toBe(false);
  });

  test("the hook reacts to a mark and a clear while mounted", () => {
    const { result } = renderHook(() => useHasUnseenDocumentChanges("conv-1"));
    expect(result.current).toBe(false);

    act(() => {
      useUnseenDocumentChangesStore
        .getState()
        .markDocumentChanged("conv-1", "doc-a");
    });
    expect(result.current).toBe(true);

    act(() => {
      useUnseenDocumentChangesStore.getState().clearConversation("conv-1");
    });
    expect(result.current).toBe(false);
  });
});
