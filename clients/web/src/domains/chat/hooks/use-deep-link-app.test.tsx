import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, renderHook, screen } from "@testing-library/react";
import { type ReactElement, type ReactNode } from "react";
import { MemoryRouter, useLocation } from "react-router";

import { useConversationStore } from "@/stores/conversation-store";
import { routes } from "@/utils/routes";

import { useDeepLinkApp } from "./use-deep-link-app";

// Core stores are driven through `setState` rather than `mock.module`, which
// is process-global in Bun and would leak into every other test file.
let conversationSnapshot: ReturnType<typeof useConversationStore.getState>;

const CONV_ID = "c1";
const APP_ID = "a1";

function LocationProbe(): ReactElement {
  const { pathname, search } = useLocation();
  return <span data-testid="location">{`${pathname}${search}`}</span>;
}
function currentLocation(): string | null {
  return screen.getByTestId("location").textContent;
}
function wrapperAt(initialPath: string) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <MemoryRouter initialEntries={[initialPath]}>
        {children}
        <LocationProbe />
      </MemoryRouter>
    );
  };
}

interface HookProps {
  urlConversationId: string | null;
  searchParams: URLSearchParams;
}

function renderRedirect(initialPath: string, props: HookProps) {
  return renderHook(
    ({ urlConversationId, searchParams }: HookProps) =>
      useDeepLinkApp(urlConversationId, searchParams),
    { wrapper: wrapperAt(initialPath), initialProps: props },
  );
}

beforeEach(() => {
  conversationSnapshot = useConversationStore.getState();
  useConversationStore.setState({ activeConversationId: null });
});

afterEach(() => {
  cleanup();
  useConversationStore.setState(conversationSnapshot, true);
});

describe("useDeepLinkApp", () => {
  test("redirects a legacy ?app= link onto the app route, keeping other params", () => {
    // GIVEN a bookmarked `/assistant/conversations/c1?app=a1&foo=1`
    renderRedirect(`${routes.conversation(CONV_ID)}?app=${APP_ID}&foo=1`, {
      urlConversationId: CONV_ID,
      searchParams: new URLSearchParams(`app=${APP_ID}&foo=1`),
    });

    // THEN the app moves into the path and the rest of the query survives
    expect(currentLocation()).toBe(
      `${routes.conversation(CONV_ID, APP_ID)}?foo=1`,
    );
  });

  test("leaves the URL alone when there is no app param", () => {
    const path = `${routes.conversation(CONV_ID)}?foo=1`;
    renderRedirect(path, {
      urlConversationId: CONV_ID,
      searchParams: new URLSearchParams("foo=1"),
    });

    expect(currentLocation()).toBe(path);
  });

  test("waits for the conversation id, then redirects exactly once", () => {
    // GIVEN an index landing (`/assistant?app=a1`) with no conversation yet
    const searchParams = new URLSearchParams(`app=${APP_ID}`);
    const { rerender } = renderRedirect(`/assistant?app=${APP_ID}`, {
      urlConversationId: null,
      searchParams,
    });
    expect(currentLocation()).toBe(`/assistant?app=${APP_ID}`);

    // WHEN the loader settles on a conversation
    act(() => {
      useConversationStore.setState({ activeConversationId: CONV_ID });
    });

    // THEN the landing is rewritten onto that conversation's app route
    expect(currentLocation()).toBe(routes.conversation(CONV_ID, APP_ID));

    // AND a later conversation change does not re-consume the param
    act(() => {
      useConversationStore.setState({ activeConversationId: "c2" });
    });
    rerender({ urlConversationId: null, searchParams });
    expect(currentLocation()).toBe(routes.conversation(CONV_ID, APP_ID));
  });
});
