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

  test("holds the park on an unsettled landing and re-opens once the route names a conversation", () => {
    park();
    const { getByTestId } = renderHost({ at: routes.assistant });

    // The `/assistant` landing opens the drawer but keeps the request: the
    // replace-navigation below is what would otherwise close it.
    expect(openDrawer).toHaveBeenCalledTimes(1);
    expect(parkedAt()).toEqual(expect.any(Number));

    act(() => {
      getByTestId("settle").click();
    });

    expect(openDrawer).toHaveBeenCalledTimes(2);
    expect(parkedAt()).toBeNull();
  });

  test("a landing that never settles buys one re-open, not a drawer that keeps coming back", () => {
    park();
    const { getByTestId } = renderHost({ at: routes.assistant });

    expect(openDrawer).toHaveBeenCalledTimes(1);
    expect(parkedAt()).toEqual(expect.any(Number));

    // Still not a conversation: the park is spent on this second open, so the
    // navigation after it leaves the drawer alone.
    act(() => {
      getByTestId("wander").click();
    });

    expect(openDrawer).toHaveBeenCalledTimes(2);
    expect(parkedAt()).toBeNull();

    act(() => {
      getByTestId("settle").click();
    });

    expect(openDrawer).toHaveBeenCalledTimes(2);
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
