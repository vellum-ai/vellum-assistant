/**
 * Tests for `AssistantSwitcher`: the chevron's visibility matrix (gate,
 * entry count, collapsed rail), the expanded card's contents, and what a
 * row selection does on success and on failure. The switchable list and the
 * switch call are mocked; the identity pill renders for real around them.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { act, cleanup, fireEvent, render } from "@testing-library/react";
import * as reactRouter from "react-router";

import { useConversationStore } from "@/stores/conversation-store";
import type { ResolvedAssistant } from "@/stores/resolved-assistants-store";
import { routes } from "@/utils/routes";

const CURRENT: ResolvedAssistant = {
  id: "a1",
  name: "Alice",
  isLocal: false,
  isPlatformHosted: true,
  isPaired: false,
};
const OTHER: ResolvedAssistant = {
  id: "a2",
  name: "Bob",
  isLocal: false,
  isPlatformHosted: true,
  isPaired: false,
  runtimeVersion: "0.9.0",
};

const navigateMock = mock((_to: string, _opts?: { replace?: boolean }) => {});
const LOCATION = {
  pathname: "/assistant/conversations/conv-old",
  search: "",
  hash: "",
};
mock.module("react-router", () => ({
  ...reactRouter,
  useNavigate: () => navigateMock,
  useLocation: () => LOCATION,
}));

let switchable: { assistants: ResolvedAssistant[]; canSwitch: boolean } = {
  assistants: [],
  canSwitch: false,
};
mock.module("@/assistant/use-switchable-assistants", () => ({
  useSwitchableAssistants: () => switchable,
}));

const switchMock = mock(async (_assistant: ResolvedAssistant) => {});
mock.module("@/assistant/switch-service", () => ({
  switchToResolvedAssistant: switchMock,
}));

const captureErrorMock = mock(
  (_error: unknown, _context?: Record<string, unknown>) => {},
);
mock.module("@/lib/sentry/capture-error", () => ({
  captureError: captureErrorMock,
}));

let selfHostedIngressUrl: string | null = null;
mock.module("@/lib/self-hosted/connection", () => ({
  getSelfHostedIngressUrl: () => selfHostedIngressUrl,
}));

const avatarCalls: Array<
  [
    string | null,
    { supportsManifest?: boolean; enabled?: boolean } | undefined,
  ]
> = [];
mock.module("@/hooks/use-assistant-avatar", () => ({
  useAssistantAvatar: (
    id: string | null,
    options?: { supportsManifest?: boolean; enabled?: boolean },
  ) => {
    avatarCalls.push([id, options]);
    return {
      components: null,
      traits: null,
      customImageUrl: null,
      isLoading: false,
      invalidate: () => {},
    };
  },
}));

const { AssistantSwitcher } = await import(
  "@/domains/chat/components/assistant-switcher"
);

function renderSwitcher(
  props: Partial<Parameters<typeof AssistantSwitcher>[0]> = {},
) {
  return render(
    <AssistantSwitcher
      assistantId="a1"
      label="Alice"
      active={false}
      onSelect={() => {}}
      {...props}
    />,
  );
}

beforeEach(() => {
  switchable = { assistants: [CURRENT, OTHER], canSwitch: true };
  switchMock.mockClear();
  switchMock.mockImplementation(async () => {});
  captureErrorMock.mockClear();
  navigateMock.mockClear();
  avatarCalls.length = 0;
  selfHostedIngressUrl = null;
  useConversationStore.setState({ activeConversationId: null });
});

afterEach(() => {
  cleanup();
});

/* Flush the switch handler's post-await continuation and the React commits
   it queues. Deterministic where a polling waitFor is not: under CI load
   the poll raced bun's per-test timeout and bled assertions into the next
   test. */
async function flushSwitch(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("AssistantSwitcher chevron visibility", () => {
  test("no chevron when the gate is closed or the list is short", () => {
    switchable = { assistants: [CURRENT], canSwitch: false };
    const { queryByLabelText, getByText } = renderSwitcher();

    expect(queryByLabelText("Switch assistant")).toBeNull();
    expect(getByText("Alice")).toBeTruthy();
  });

  test("no chevron on the collapsed rail", () => {
    const { queryByLabelText } = renderSwitcher({ collapsed: true });

    expect(queryByLabelText("Switch assistant")).toBeNull();
  });

  test("two switchable assistants put the chevron on the pill", () => {
    const { getByLabelText } = renderSwitcher();

    const chevron = getByLabelText("Switch assistant");
    expect(chevron.getAttribute("aria-expanded")).toBe("false");
  });
});

describe("AssistantSwitcher expanded card", () => {
  test("the chevron expands the card with the current entry checked and the rest listed", () => {
    const { getByLabelText, getByText } = renderSwitcher();

    fireEvent.click(getByLabelText("Switch assistant"));

    expect(getByLabelText("Alice, current assistant")).toBeTruthy();
    expect(getByText("Bob")).toBeTruthy();
    const collapse = getByLabelText("Hide assistants");
    expect(collapse.getAttribute("aria-expanded")).toBe("true");
  });

  test("the collapse control folds the card back to the pill", () => {
    const { getByLabelText, queryByText } = renderSwitcher();

    fireEvent.click(getByLabelText("Switch assistant"));
    fireEvent.click(getByLabelText("Hide assistants"));

    expect(queryByText("Bob")).toBeNull();
  });

  test("toggling re-anchors keyboard focus on the counterpart chevron", async () => {
    const { getByLabelText } = renderSwitcher();

    fireEvent.click(getByLabelText("Switch assistant"));
    await flushSwitch();
    expect(document.activeElement).toBe(getByLabelText("Hide assistants"));

    fireEvent.click(getByLabelText("Hide assistants"));
    await flushSwitch();
    expect(document.activeElement).toBe(getByLabelText("Switch assistant"));
  });

  test("a successful switch reports completion; a failed one does not", async () => {
    const onSwitched = mock(() => {});
    const { getByLabelText } = renderSwitcher({ onSwitched });

    fireEvent.click(getByLabelText("Switch assistant"));
    fireEvent.click(getByLabelText("Switch to Bob"));
    await flushSwitch();
    expect(onSwitched).toHaveBeenCalledTimes(1);

    switchMock.mockImplementation(async () => {
      throw new Error("boom");
    });
    fireEvent.click(getByLabelText("Switch assistant"));
    fireEvent.click(getByLabelText("Switch to Bob"));
    await flushSwitch();
    expect(captureErrorMock).toHaveBeenCalledTimes(1);
    expect(onSwitched).toHaveBeenCalledTimes(1);
  });

  test("selecting a row resets the conversation before the connect, then collapses", async () => {
    useConversationStore.setState({ activeConversationId: "conv-old" });
    /* The reset must precede the connect: the selection publishes before
       the connect promise resolves, and the loader would apply, and
       persist, a still-mounted old conversation against the new
       assistant. */
    let storeIdAtSwitch: string | null = "unset";
    switchMock.mockImplementation(async () => {
      storeIdAtSwitch = useConversationStore.getState().activeConversationId;
    });
    const { getByLabelText, queryByText } = renderSwitcher();

    fireEvent.click(getByLabelText("Switch assistant"));
    fireEvent.click(getByLabelText("Switch to Bob"));

    /* The synchronous half: store and route reset land before any await,
       and the connect does not start until the navigation settles. */
    expect(useConversationStore.getState().activeConversationId).toBeNull();
    expect(navigateMock.mock.calls[0]).toEqual([
      routes.assistant,
      { replace: true },
    ]);
    expect(switchMock).not.toHaveBeenCalled();

    await flushSwitch();
    expect(switchMock).toHaveBeenCalledTimes(1);
    expect(switchMock.mock.calls[0]?.[0]).toEqual(OTHER);
    expect(storeIdAtSwitch).toBeNull();
    expect(queryByText("Bob")).toBeNull();
    expect(useConversationStore.getState().activeConversationId).toBeNull();
  });

  test("a failed switch reports, stays expanded, and restores the conversation", async () => {
    switchMock.mockImplementation(async () => {
      throw new Error("boom");
    });
    useConversationStore.setState({ activeConversationId: "conv-old" });
    const { getByLabelText, getByText } = renderSwitcher();

    fireEvent.click(getByLabelText("Switch assistant"));
    fireEvent.click(getByLabelText("Switch to Bob"));

    await flushSwitch();
    expect(captureErrorMock).toHaveBeenCalledTimes(1);
    expect(getByText("Bob")).toBeTruthy();
    expect(useConversationStore.getState().activeConversationId).toBe(
      "conv-old",
    );
    /* The route the switch was attempted from comes back, not a
       conversation URL invented from the store id. */
    expect(navigateMock.mock.calls.at(-1)).toEqual([
      LOCATION.pathname,
      { replace: true },
    ]);
  });

  test("sibling avatars gate by the sibling's own runtime version", () => {
    const OLD_SIBLING: ResolvedAssistant = {
      id: "a3",
      name: "Carol",
      isLocal: false,
      isPlatformHosted: true,
      isPaired: false,
      runtimeVersion: "0.5.0",
    };
    switchable = {
      assistants: [CURRENT, OTHER, OLD_SIBLING],
      canSwitch: true,
    };
    const { getByLabelText } = renderSwitcher();

    fireEvent.click(getByLabelText("Switch assistant"));

    /* Bob's 0.9.0 runtime serves the manifest; Carol's 0.5.0 predates it.
       The current row carries no override, deferring to the active gate. */
    expect(
      avatarCalls.some(([id, o]) => id === "a2" && o?.supportsManifest === true),
    ).toBe(true);
    expect(
      avatarCalls.some(
        ([id, o]) => id === "a3" && o?.supportsManifest === false,
      ),
    ).toBe(true);
    expect(
      avatarCalls.some(
        ([id, o]) =>
          id === "a1" && o !== undefined && o.supportsManifest === undefined,
      ),
    ).toBe(true);
  });

  test("sibling avatars fetch only through an addressable transport", () => {
    const PAIRED: ResolvedAssistant = {
      id: "a4",
      name: "Dana",
      isLocal: false,
      isPlatformHosted: false,
      isPaired: true,
    };
    switchable = { assistants: [CURRENT, OTHER, PAIRED], canSwitch: true };
    const first = renderSwitcher();

    fireEvent.click(first.getByLabelText("Switch assistant"));

    /* A platform sibling routes by the id in the path; a paired sibling
       has no per-id platform route and keeps the fallback avatar. */
    expect(
      avatarCalls.some(([id, o]) => id === "a2" && o?.enabled === true),
    ).toBe(true);
    expect(
      avatarCalls.some(([id, o]) => id === "a4" && o?.enabled === false),
    ).toBe(true);
    first.unmount();

    /* With a self-hosted ingress active, every daemon request is rewritten
       to that one gateway: no sibling is addressable. */
    selfHostedIngressUrl = "https://gateway.example.com/ingress";
    avatarCalls.length = 0;
    const second = renderSwitcher();
    fireEvent.click(second.getByLabelText("Switch assistant"));
    expect(
      avatarCalls.some(([id, o]) => id === "a2" && o?.enabled === false),
    ).toBe(true);
  });

  test("a mid-switch assistant publication still hands focus to the chevron", async () => {
    let resolveSwitch: () => void = () => {};
    switchMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveSwitch = resolve;
        }),
    );
    const { getByLabelText, queryByLabelText, rerender } = renderSwitcher();

    fireEvent.click(getByLabelText("Switch assistant"));
    fireEvent.click(getByLabelText("Switch to Bob"));

    /* The selection publishes before the connect resolves: the new active
       assistant re-renders the switcher and auto-collapses the card. */
    rerender(
      <AssistantSwitcher
        assistantId="a2"
        label="Bob"
        active={false}
        onSelect={() => {}}
      />,
    );

    await flushSwitch();
    expect(queryByLabelText("Hide assistants")).toBeNull();
    expect(document.activeElement).toBe(getByLabelText("Switch assistant"));

    resolveSwitch();
    await flushSwitch();
  });
});
