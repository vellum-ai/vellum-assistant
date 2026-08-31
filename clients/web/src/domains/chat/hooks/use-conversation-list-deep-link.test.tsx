import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, render } from "@testing-library/react";
import { useCallback, useState } from "react";
import { MemoryRouter, useNavigate } from "react-router";

import { routes } from "@/utils/routes";

const { PENDING_CONVERSATION_LIST_TTL_MS, useConversationListDeepLink } =
  await import("@/domains/chat/hooks/use-conversation-list-deep-link");
const { __resetPendingDeepLinkForTesting, usePendingDeepLinkStore } =
  await import("@/stores/pending-deep-link-store");

const openDrawer = mock(() => {});
const expandSidebar = mock(() => {});

/**
 * The layout's shape around the drain: the close-on-navigation effect that
 * runs before it, and the navigate the landing's own redirect stands in for.
 */
function Host({ isMobile }: { isMobile: boolean }) {
  const navigate = useNavigate();
  const [, setDrawerOpen] = useState(false);
  const stableOpen = useCallback(() => {
    setDrawerOpen(true);
    openDrawer();
  }, []);
  const stableExpand = useCallback(() => {
    expandSidebar();
  }, []);
  useConversationListDeepLink({
    isMobile,
    openDrawer: stableOpen,
    expandSidebar: stableExpand,
  });
  return (
    <>
      <button
        type="button"
        data-testid="settle"
        onClick={() => {
          navigate(routes.conversation("conv-1"), { replace: true });
        }}
      />
      <button
        type="button"
        data-testid="wander"
        onClick={() => {
          navigate(`${routes.assistant}/library`);
        }}
      />
    </>
  );
}

const renderHost = (options?: { isMobile?: boolean; at?: string }) =>
  render(
    <MemoryRouter initialEntries={[options?.at ?? routes.assistant]}>
      <Host isMobile={options?.isMobile ?? true} />
    </MemoryRouter>,
  );

const park = () =>
  usePendingDeepLinkStore.getState().setPendingConversationList();

const parkedAt = () =>
  usePendingDeepLinkStore.getState().pendingConversationListAt;

beforeEach(() => {
  openDrawer.mockClear();
  expandSidebar.mockClear();
  __resetPendingDeepLinkForTesting();
});

afterEach(() => {
  cleanup();
  __resetPendingDeepLinkForTesting();
});

describe("useConversationListDeepLink", () => {
  test("opens nothing until a request is parked", () => {
    renderHost();

    expect(openDrawer).not.toHaveBeenCalled();
    expect(expandSidebar).not.toHaveBeenCalled();
  });

  test("drains a park made before the layout mounted, the cold-launch case", () => {
    park();

    renderHost({ at: routes.conversation("conv-1") });

    expect(openDrawer).toHaveBeenCalledTimes(1);
    expect(parkedAt()).toBeNull();
  });

  test("drains a park that arrives while already mounted, the warm case", () => {
    renderHost({ at: routes.conversation("conv-1") });
    expect(openDrawer).not.toHaveBeenCalled();

    act(() => {
      park();
    });

    expect(openDrawer).toHaveBeenCalledTimes(1);
    expect(parkedAt()).toBeNull();
  });

  test("waits out an unsettled landing, then opens once the route names a conversation", () => {
    park();
    const { getByTestId } = renderHost({ at: routes.assistant });

    // Nothing opens on the index: the landing's own replace-navigation would
    // shut it a beat later.
    expect(openDrawer).not.toHaveBeenCalled();
    expect(parkedAt()).toEqual(expect.any(Number));

    act(() => {
      getByTestId("settle").click();
    });

    expect(openDrawer).toHaveBeenCalledTimes(1);
    expect(parkedAt()).toBeNull();
  });

  test("opens once and does not come back on the next navigation", () => {
    park();
    const { getByTestId } = renderHost({ at: routes.conversation("conv-1") });
    expect(openDrawer).toHaveBeenCalledTimes(1);

    // Whatever the user does next, including picking another conversation from
    // the drawer, must not be covered by the list again.
    act(() => {
      getByTestId("wander").click();
    });
    act(() => {
      getByTestId("settle").click();
    });

    expect(openDrawer).toHaveBeenCalledTimes(1);
  });

  test("a landing that never settles drops the request rather than opening late", () => {
    park();
    const { getByTestId } = renderHost({ at: routes.assistant });

    act(() => {
      getByTestId("wander").click();
    });

    expect(openDrawer).not.toHaveBeenCalled();
    expect(parkedAt()).toEqual(expect.any(Number));

    // Only the TTL spends it, and it opens nothing on the way out.
    usePendingDeepLinkStore.setState({
      pendingConversationListAt:
        Date.now() - PENDING_CONVERSATION_LIST_TTL_MS - 1,
    });
    act(() => {
      getByTestId("wander").click();
    });

    expect(openDrawer).not.toHaveBeenCalled();
    expect(parkedAt()).toBeNull();
  });

  test("a wide window uncollapses the sidebar instead, and spends the park at once", () => {
    park();

    renderHost({ isMobile: false, at: routes.assistant });

    expect(expandSidebar).toHaveBeenCalledTimes(1);
    expect(openDrawer).not.toHaveBeenCalled();
    expect(parkedAt()).toBeNull();
  });

  test("an aged-out park is spent without opening anything", () => {
    usePendingDeepLinkStore.setState({
      pendingConversationListAt:
        Date.now() - PENDING_CONVERSATION_LIST_TTL_MS - 1,
    });

    renderHost({ at: routes.conversation("conv-1") });

    expect(openDrawer).not.toHaveBeenCalled();
    expect(expandSidebar).not.toHaveBeenCalled();
    expect(parkedAt()).toBeNull();
  });
});
