/**
 * Tests for the "Archive All" confirmation gate (LUM-3036). The invariant:
 * requesting an archive must never run it; only the dialog's explicit
 * confirm does, and it archives exactly the requested set.
 */

import { describe, expect, test } from "bun:test";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { createElement } from "react";

import {
  ArchiveAllConfirmDialog,
  useArchiveAllConfirmation,
} from "@/domains/chat/components/archive-all-confirm-dialog";
import type { Conversation } from "@/types/conversation-types";

const CONVERSATIONS = [
  { conversationId: "conv-1", title: "One" },
  { conversationId: "conv-2", title: "Two" },
] as Conversation[];

function Harness({
  assistantId,
  archiveAllInGroup,
  requestConversations = CONVERSATIONS,
}: {
  assistantId: string | null;
  archiveAllInGroup: (
    groupName: string,
    conversations: Conversation[],
  ) => void;
  requestConversations?: Conversation[];
}) {
  const { pending, requestArchiveAll, confirmArchiveAll, cancelArchiveAll } =
    useArchiveAllConfirmation({ assistantId, archiveAllInGroup });
  return (
    <>
      <button
        type="button"
        onClick={() => requestArchiveAll("Work", requestConversations)}
      >
        request
      </button>
      <ArchiveAllConfirmDialog
        pending={pending}
        onConfirm={confirmArchiveAll}
        onCancel={cancelArchiveAll}
      />
    </>
  );
}

function clickByText(text: string) {
  const button = Array.from(
    document.querySelectorAll<HTMLElement>("button"),
  ).find((el) => el.textContent?.trim() === text);
  expect(button).toBeDefined();
  act(() => {
    button?.click();
  });
}

async function waitForDialog() {
  await waitFor(() => {
    expect(
      document.querySelector("[data-confirm-dialog-confirm]"),
    ).not.toBeNull();
  });
}

describe("useArchiveAllConfirmation + ArchiveAllConfirmDialog", () => {
  test("requesting shows the dialog and archives nothing", async () => {
    const calls: Array<[string, Conversation[]]> = [];
    render(
      createElement(Harness, {
        assistantId: "asst-1",
        archiveAllInGroup: (name, convs) => calls.push([name, convs]),
      }),
    );
    try {
      clickByText("request");
      await waitForDialog();
      expect(calls).toHaveLength(0);
      expect(document.body.textContent).toContain(
        "all 2 conversations in “Work”",
      );
    } finally {
      cleanup();
    }
  });

  test("confirm archives exactly the requested set, once", async () => {
    const calls: Array<[string, Conversation[]]> = [];
    render(
      createElement(Harness, {
        assistantId: "asst-1",
        archiveAllInGroup: (name, convs) => calls.push([name, convs]),
      }),
    );
    try {
      clickByText("request");
      await waitForDialog();
      act(() => {
        document
          .querySelector<HTMLElement>("[data-confirm-dialog-confirm]")!
          .click();
      });
      expect(calls).toHaveLength(1);
      expect(calls[0]![0]).toBe("Work");
      expect(calls[0]![1].map((c) => c.conversationId)).toEqual([
        "conv-1",
        "conv-2",
      ]);
      await waitFor(() => {
        expect(
          document.querySelector("[data-confirm-dialog-confirm]"),
        ).toBeNull();
      });
    } finally {
      cleanup();
    }
  });

  test("cancel archives nothing and closes the dialog", async () => {
    const calls: Array<[string, Conversation[]]> = [];
    render(
      createElement(Harness, {
        assistantId: "asst-1",
        archiveAllInGroup: (name, convs) => calls.push([name, convs]),
      }),
    );
    try {
      clickByText("request");
      await waitForDialog();
      clickByText("Cancel");
      await waitFor(() => {
        expect(
          document.querySelector("[data-confirm-dialog-confirm]"),
        ).toBeNull();
      });
      expect(calls).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  test("a single conversation gets singular copy", async () => {
    render(
      createElement(Harness, {
        assistantId: "asst-1",
        archiveAllInGroup: () => {},
        requestConversations: CONVERSATIONS.slice(0, 1),
      }),
    );
    try {
      clickByText("request");
      await waitForDialog();
      expect(document.body.textContent).toContain(
        "the conversation in “Work”",
      );
    } finally {
      cleanup();
    }
  });

  test("switching assistants drops the pending request", async () => {
    const calls: Array<[string, Conversation[]]> = [];
    const { rerender } = render(
      createElement(Harness, {
        assistantId: "asst-1",
        archiveAllInGroup: (name, convs) => calls.push([name, convs]),
      }),
    );
    try {
      clickByText("request");
      await waitForDialog();
      rerender(
        createElement(Harness, {
          assistantId: "asst-2",
          archiveAllInGroup: (name, convs) => calls.push([name, convs]),
        }),
      );
      await waitFor(() => {
        expect(
          document.querySelector("[data-confirm-dialog-confirm]"),
        ).toBeNull();
      });
      expect(calls).toHaveLength(0);
    } finally {
      cleanup();
    }
  });
});
