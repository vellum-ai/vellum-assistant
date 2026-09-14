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
import { ASSISTANT_SECTION_LABEL } from "@/domains/chat/utils/sidebar-section-icon";
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
  return {
    type: "assistant",
    key: "assistant",
    label: ASSISTANT_SECTION_LABEL,
    all: [],
  };
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

function renderSection(section: SidebarSection, overlayCards = false) {
  /* The empty state's eyes read the avatar through a query, so the tree needs
     a client even though nothing here asserts on the avatar. */
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <ConversationListProvider
        value={{
          overlayCards,
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
  /* The section opens directly under the assistant's own pill, so a header
     that repeated her name said it twice; it speaks in her voice instead. */
  test("titles the header in the assistant's voice, named or not", () => {
    useAssistantIdentityStore.getState().setIdentity("Ada", "0.12.0", "asst-1");
    const named = renderSection(assistantSection());
    expect(screen.getByText("From me")).toBeTruthy();
    expect(screen.queryByText(/Ada/)).toBeNull();
    named.unmount();

    useAssistantIdentityStore.getState().clearIdentity();
    renderSection(assistantSection());
    expect(screen.getByText("From me")).toBeTruthy();
  });

  test("draws no glyph on its header", () => {
    const { container } = renderSection(assistantSection());
    expect(
      container.querySelector('[data-slot="collapsible-nav-section-icon"]'),
    ).toBeNull();
  });

  /* On the rail the header is its own accent pill, inset like the New Chat
     pill beside it. On the overlay every section is a card that already
     owns its inset and its header row, and this card is tinted edge to
     edge, so the pill has nothing to draw; all it did there was push this
     one header 8px right of every other section's and stand it taller. */
  test("on the rail, draws its header as an inset pill", () => {
    const { container } = renderSection(assistantSection());

    const header = container.querySelector(
      '[data-slot="collapsible-nav-section-header"]',
    );
    expect(header?.className).toContain("rounded-full");
    expect(header?.className).toContain("pl-2!");
  });

  test("on the overlay, sits its header flush like every other card's", () => {
    const { container } = renderSection(assistantSection(), true);

    const header = container.querySelector(
      '[data-slot="collapsible-nav-section-header"]',
    );
    expect(header?.className).not.toContain("rounded-full");
    expect(header?.className).not.toContain("pl-2!");
  });

  /* On a touch screen every row is backed by the card's surface for the
     swipe, and the assistant card is the one that tints itself: its tint has
     to be the surface the rows are backed with, or each row sits in a white
     cell on the wash. */
  test("on the overlay, backs its rows with its own tint", () => {
    const { container } = renderSection(assistantSection(), true);

    const card = container.querySelector<HTMLElement>(
      "[data-slot='sidebar-section-card'], [class*='--sidebar-card-surface:']",
    );
    expect(card).not.toBeNull();
    expect(card!.className).toContain(
      "[--sidebar-card-surface:color-mix(in_srgb,var(--avatar-accent,var(--surface-lift))_15%,var(--surface-lift))]",
    );
    expect(card!.className).toContain(
      "[--swipe-item-surface:var(--sidebar-card-surface,var(--surface-lift))]",
    );
    expect(card!.className).not.toContain(
      "[--swipe-item-surface:var(--surface-lift)]",
    );
  });

  /* Its rows hover and open in the accent's raised wash, the New Chat
     pill's own hover, rather than the neutral gray the other cards' rows use.
     The wash is derived from `--avatar-accent` without a fallback, so where no
     accent is published it is unset and each state's own neutral fallback
     stands: an open thread under a custom-image avatar keeps the visible
     `--surface-active` rather than dissolving into the card. */
  test("raises a hovered or open row to the New Chat pill's wash, with neutral fallbacks", () => {
    const { container } = renderSection(assistantSection());
    const card = container.querySelector<HTMLElement>(
      "[class*='--sidebar-card-surface:']",
    );
    expect(card!.className).toContain(
      "[--assistant-row-raised:color-mix(in_srgb,var(--avatar-accent)_24%,var(--surface-lift))]",
    );
    expect(card!.className).toContain(
      "[--panel-item-hover:var(--assistant-row-raised,var(--surface-hover))]",
    );
    expect(card!.className).toContain(
      "[--panel-item-active:var(--assistant-row-raised,var(--surface-active))]",
    );
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
