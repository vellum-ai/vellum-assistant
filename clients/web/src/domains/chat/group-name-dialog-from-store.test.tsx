/**
 * Tests for {@link GroupNameDialogFromStore}.
 *
 * One dialog serves three requests - create-and-file, create-empty, and
 * rename - so what matters is that each submit runs exactly the right
 * mutations. Creating an empty group in particular must not move anything.
 */

import { describe, expect, mock, test, afterEach } from "bun:test";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { createElement } from "react";

mock.module("@/lib/backwards-compat/use-supports-group-icons", () => ({
  useSupportsGroupIcons: () => false,
}));

import { GroupNameDialogFromStore } from "@/domains/chat/group-name-dialog-from-store";
import { useGroupNameRequestStore } from "@/domains/chat/group-name-request-store";
import type { Conversation } from "@/types/conversation-types";

const GROUP = { id: "grp-new", name: "Reviews" };

interface Harness {
  created: string[];
  moved: { conversationId: string; groupId: string }[];
  renamed: { groupId: string; name: string }[];
}

function renderDialog(harness: Harness) {
  return render(
    createElement(GroupNameDialogFromStore, {
      createGroup: async (name: string) => {
        harness.created.push(name);
        return GROUP as never;
      },
      moveToGroup: (conversation: Conversation, groupId: string) => {
        harness.moved.push({
          conversationId: conversation.conversationId,
          groupId,
        });
      },
      renameGroup: (groupId: string, name: string) => {
        harness.renamed.push({ groupId, name });
      },
    }),
  );
}

function makeHarness(): Harness {
  return { created: [], moved: [], renamed: [] };
}

async function submit(name: string) {
  const input = await waitFor(() => {
    const el = document.querySelector<HTMLInputElement>("input");
    if (!el) {
      throw new Error("no input");
    }
    return el;
  });
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )?.set;
    setter?.call(input, name);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const submitButton = Array.from(
    document.querySelectorAll<HTMLButtonElement>("button"),
  ).find((b) => /create|save/i.test(b.textContent ?? ""));
  act(() => submitButton?.click());
}

afterEach(() => {
  cleanup();
  useGroupNameRequestStore.getState().clearGroupNameRequest();
});

describe("GroupNameDialogFromStore", () => {
  test("creating from the sidebar makes an empty group and moves nothing", async () => {
    const harness = makeHarness();
    renderDialog(harness);

    act(() => {
      // No conversation - the sidebar's own "New group…".
      useGroupNameRequestStore.getState().requestCreateGroup();
    });
    await submit("Reviews");

    await waitFor(() => expect(harness.created).toEqual(["Reviews"]));
    expect(harness.moved).toEqual([]);
    expect(harness.renamed).toEqual([]);
  });

  test("creating from a conversation still files that conversation in", async () => {
    const harness = makeHarness();
    renderDialog(harness);

    act(() => {
      useGroupNameRequestStore
        .getState()
        .requestCreateGroup({ conversationId: "c1" } as Conversation);
    });
    await submit("Reviews");

    await waitFor(() => expect(harness.created).toEqual(["Reviews"]));
    expect(harness.moved).toEqual([
      { conversationId: "c1", groupId: "grp-new" },
    ]);
  });

  test("renaming touches neither create nor move", async () => {
    const harness = makeHarness();
    renderDialog(harness);

    act(() => {
      useGroupNameRequestStore
        .getState()
        .requestRenameGroup("grp-a", "Old", null);
    });
    await submit("New name");

    await waitFor(() =>
      expect(harness.renamed).toEqual([
        { groupId: "grp-a", name: "New name" },
      ]),
    );
    expect(harness.created).toEqual([]);
    expect(harness.moved).toEqual([]);
  });
});
