/**
 * The two things `SidebarSectionItem` does only for the assistant-initiated
 * section: name its header after the assistant, and put an empty state in
 * place of its row list.
 *
 * The empty state is the risky one, which is why it is covered here rather
 * than left to Storybook. `ConversationNavSection` resolves its body as
 * `children ?? <ConversationRowList/>`, so a `children` that is anything other
 * than `undefined` for the other sections would silently replace their rows
 * with nothing. The assertions below pin both directions of that.
 */

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import type * as SectionConversations from "@/domains/chat/use-section-conversations";
import type { SidebarSection } from "@/domains/chat/use-sidebar-state";
import type { Conversation } from "@/types/conversation-types";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";

/** What the section query answers with, per test. */
let sectionRows: Conversation[] = [];

mock.module(
  "@/domains/chat/use-section-conversations",
  (): Partial<typeof SectionConversations> => ({
    useSectionConversations: () => ({
      conversations: sectionRows,
      hasMore: false,
      loadMore: () => {},
      getAllRows: () => Promise.resolve(sectionRows),
      isPending: false,
    }),
  }),
);

const { SidebarSectionItem } =
  await import("@/domains/chat/components/sidebar-section-item");
const { ConversationListProvider } =
  await import("@/domains/chat/components/conversation-list-context");
const { CollapsibleNavSection } =
  await import("@/components/collapsible-nav-section");

function conv(conversationId: string, title: string): Conversation {
  return {
    conversationId,
    title,
    hasUnseenLatestAssistantMessage: false,
  };
}

function assistantSection(): SidebarSection {
  return { type: "assistant", key: "assistant", label: "On My Mind", all: [] };
}

function chatsSection(): SidebarSection {
  return {
    type: "recents",
    key: "recents",
    label: "Chats",
    all: [],
    holdsChannels: true,
  };
}

function renderSection(section: SidebarSection) {
  /* The empty state's eyes read the avatar through a query, so the tree needs
     a client even though nothing here asserts on the avatar. */
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ConversationListProvider
        value={{
          overlayCards: false,
          processingConversationIds: new Set<string>(),
          attentionConversationIds: new Set<string>(),
          onSelect: () => {},
        }}
      >
        <CollapsibleNavSection.Root
          type="multiple"
          defaultValue={[section.key]}
        >
          <SidebarSectionItem
            section={section}
            assistantId="asst-1"
            groupMenu={() => ({})}
          />
        </CollapsibleNavSection.Root>
      </ConversationListProvider>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  sectionRows = [];
  useAssistantIdentityStore.getState().clearIdentity();
});

describe("SidebarSectionItem — the assistant-initiated section", () => {
  test("names the header after the assistant once it has a name", () => {
    useAssistantIdentityStore.getState().setIdentity("Ada", "0.12.0", "asst-1");
    renderSection(assistantSection());

    expect(screen.getByText("From Ada")).toBeTruthy();
  });

  test("falls back to the neutral header while the assistant is unnamed", () => {
    // "From Your Assistant" reads as a settings row rather than a byline.
    renderSection(assistantSection());

    expect(screen.getByText("On My Mind")).toBeTruthy();
    expect(screen.queryByText(/^From /)).toBeNull();
  });

  test("shows the empty state in place of the rows when it has none", () => {
    renderSection(assistantSection());

    expect(screen.getByText("Nothing on my mind yet.")).toBeTruthy();
  });

  test("shows its rows, not the empty state, once it has any", () => {
    sectionRows = [conv("a1", "Your Tuesday reviews keep slipping")];
    renderSection(assistantSection());

    expect(
      screen.getAllByText("Your Tuesday reviews keep slipping").length,
    ).toBeGreaterThan(0);
    expect(screen.queryByText("Nothing on my mind yet.")).toBeNull();
  });
});

describe("SidebarSectionItem — every other section", () => {
  test("keeps its rows, so the empty-state branch cannot blank them", () => {
    // The regression this guards: `children` is resolved with `??`, so a
    // non-undefined value here would replace the row list for every section.
    sectionRows = [conv("c1", "Lease renewal")];
    renderSection(chatsSection());

    expect(screen.getAllByText("Lease renewal").length).toBeGreaterThan(0);
  });

  test("gets no empty state and no assistant header when it is empty", () => {
    renderSection(chatsSection());

    expect(screen.queryByText("Nothing on my mind yet.")).toBeNull();
    expect(screen.getByText("Chats")).toBeTruthy();
  });
});
