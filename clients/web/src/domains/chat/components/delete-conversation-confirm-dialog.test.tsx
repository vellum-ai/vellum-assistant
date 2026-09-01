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

function getConfirmButton(): HTMLButtonElement {
  const button = document.querySelector<HTMLButtonElement>(
    "[data-confirm-dialog-confirm]",
  );
  expect(button).not.toBeNull();
  return button!;
}

function getAcknowledgmentCheckbox(): HTMLElement {
  const checkbox = document.querySelector<HTMLElement>(
    '[role="checkbox"]',
  );
  expect(checkbox).not.toBeNull();
  return checkbox!;
}

function acknowledge() {
  act(() => {
    getAcknowledgmentCheckbox().click();
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
      expect(document.body.textContent).toContain(
        "Related assets and memories may still persist",
      );
      expect(document.body.textContent).toContain(
        "I understand that related assets and memories may still persist",
      );
      expect(getConfirmButton().disabled).toBe(true);
      expect(getAcknowledgmentCheckbox().getAttribute("aria-checked")).toBe(
        "false",
      );
    } finally {
      cleanup();
    }
  });

  test("confirm without acknowledgment deletes nothing", async () => {
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
        getConfirmButton().click();
      });
      expect(calls).toHaveLength(0);
      expect(getConfirmButton().disabled).toBe(true);
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
      acknowledge();
      expect(getConfirmButton().disabled).toBe(false);
      act(() => {
        getConfirmButton().click();
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

  test("reopening the dialog clears the acknowledgment", async () => {
    render(
      createElement(Harness, {
        assistantId: "asst-1",
        deleteConversation: () => {},
      }),
    );
    try {
      clickByText("request");
      await waitForDialog();
      acknowledge();
      expect(getConfirmButton().disabled).toBe(false);
      clickByText("Cancel");
      await waitFor(() => {
        expect(
          document.querySelector("[data-confirm-dialog-confirm]"),
        ).toBeNull();
      });
      clickByText("request");
      await waitForDialog();
      expect(getConfirmButton().disabled).toBe(true);
      expect(getAcknowledgmentCheckbox().getAttribute("aria-checked")).toBe(
        "false",
      );
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
