/**
 * Tests for the per-conversation Delete confirmation gate. The invariant:
 * requesting a delete must never run it; only the dialog's explicit
 * confirm does, and cancel leaves the conversation untouched.
 */

import { describe, expect, test } from "bun:test";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { createElement } from "react";

import {
  DeleteConversationConfirmDialog,
  useDeleteConversationConfirmation,
} from "@/domains/chat/components/delete-conversation-confirm-dialog";
import type { Conversation } from "@/types/conversation-types";

const CONVERSATION = {
  conversationId: "conv-xyz",
  title: "Planning notes",
} as Conversation;

function Harness({
  assistantId,
  deleteConversation,
  requestConversation = CONVERSATION,
}: {
  assistantId: string | null;
  deleteConversation: (conversation: Conversation) => void;
  requestConversation?: Conversation;
}) {
  const { pending, requestDelete, confirmDelete, cancelDelete } =
    useDeleteConversationConfirmation({ assistantId, deleteConversation });
  return (
    <>
      <button
        type="button"
        onClick={() => requestDelete(requestConversation)}
      >
        request
      </button>
      <DeleteConversationConfirmDialog
        pending={pending}
        onConfirm={confirmDelete}
        onCancel={cancelDelete}
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

describe("useDeleteConversationConfirmation + DeleteConversationConfirmDialog", () => {
  test("requesting shows the dialog and deletes nothing", async () => {
    const calls: Conversation[] = [];
    render(
      createElement(Harness, {
        assistantId: "asst-1",
        deleteConversation: (conversation) => calls.push(conversation),
      }),
    );
    try {
      clickByText("request");
      await waitForDialog();
      expect(calls).toHaveLength(0);
      expect(document.body.textContent).toContain("Planning notes");
      expect(document.body.textContent).toContain("permanently removes");
    } finally {
      cleanup();
    }
  });

  test("confirm deletes exactly the requested conversation, once", async () => {
    const calls: Conversation[] = [];
    render(
      createElement(Harness, {
        assistantId: "asst-1",
        deleteConversation: (conversation) => calls.push(conversation),
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
      expect(calls[0]!.conversationId).toBe("conv-xyz");
      await waitFor(() => {
        expect(
          document.querySelector("[data-confirm-dialog-confirm]"),
        ).toBeNull();
      });
    } finally {
      cleanup();
    }
  });

  test("cancel deletes nothing and closes the dialog", async () => {
    const calls: Conversation[] = [];
    render(
      createElement(Harness, {
        assistantId: "asst-1",
        deleteConversation: (conversation) => calls.push(conversation),
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

  test("an untitled conversation uses the untitled fallback in the copy", async () => {
    render(
      createElement(Harness, {
        assistantId: "asst-1",
        deleteConversation: () => {},
        requestConversation: { conversationId: "conv-xyz" } as Conversation,
      }),
    );
    try {
      clickByText("request");
      await waitForDialog();
      expect(document.body.textContent).toContain("Untitled");
    } finally {
      cleanup();
    }
  });

  test("switching assistants drops the pending request", async () => {
    const calls: Conversation[] = [];
    const { rerender } = render(
      createElement(Harness, {
        assistantId: "asst-1",
        deleteConversation: (conversation) => calls.push(conversation),
      }),
    );
    try {
      clickByText("request");
      await waitForDialog();
      rerender(
        createElement(Harness, {
          assistantId: "asst-2",
          deleteConversation: (conversation) => calls.push(conversation),
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
