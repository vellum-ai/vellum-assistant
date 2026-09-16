import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useEffect } from "react";
import { createMemoryRouter, RouterProvider } from "react-router";

import { liveViewportAxesStub } from "@/hooks/viewport-axes.test-helper";
import { MOBILE_MEDIA_QUERY } from "@/hooks/use-is-mobile";

import { ChatLayoutFrame } from "./chat-layout-frame";

const viewport = liveViewportAxesStub();
const mobileMaxWidth = Number(MOBILE_MEDIA_QUERY.match(/\d+/)?.[0]);
let mountCount = 0;

function StatefulChat() {
  useEffect(() => {
    mountCount += 1;
  }, []);

  return <textarea aria-label="Message" defaultValue="draft" />;
}

function setViewportWidth(width: number) {
  viewport.set({
    narrow: width <= mobileMaxWidth,
    coarsePointer: false,
  });
}

function renderFrame({ isPopout = false }: { isPopout?: boolean } = {}) {
  const router = createMemoryRouter(
    [
      {
        element: (
          <ChatLayoutFrame
            isPopout={isPopout}
            mainRoomClass=""
            routeContentInert={false}
            desktopNavigation={<nav>Desktop navigation</nav>}
            desktopPreview={<aside>Desktop session</aside>}
            sleepStage={<div>Sleep stage</div>}
            popoutVoiceSession={<div>Popout voice session</div>}
            desktopVoiceRoom={<div>Desktop voice room</div>}
            mobileDrawer={<div>Mobile drawer</div>}
          />
        ),
        children: [{ path: "/assistant", element: <StatefulChat /> }],
      },
    ],
    { initialEntries: ["/assistant"] },
  );

  render(<RouterProvider router={router} />);
}

describe("ChatLayoutFrame", () => {
  beforeEach(() => {
    mountCount = 0;
    setViewportWidth(767);
  });

  afterEach(() => {
    cleanup();
    viewport.restore();
  });

  test("preserves the routed chat across narrow and wide resizes", () => {
    renderFrame();
    const textarea = screen.getByRole("textbox") as HTMLTextAreaElement;
    const desktopPreview = screen.getByText("Desktop session");
    fireEvent.change(textarea, { target: { value: "draft with attachment" } });

    expect(mountCount).toBe(1);
    expect(screen.getByText("Mobile drawer")).toBeTruthy();

    act(() => setViewportWidth(700));
    expect(screen.getByRole("textbox")).toBe(textarea);
    expect(mountCount).toBe(1);

    act(() => setViewportWidth(768));
    expect(screen.getByText("Desktop navigation")).toBeTruthy();
    expect(screen.getByText("Desktop voice room")).toBeTruthy();
    expect(screen.getByRole("textbox")).toBe(textarea);
    expect(textarea.value).toBe("draft with attachment");
    expect(screen.getByText("Desktop session")).toBe(desktopPreview);
    expect(mountCount).toBe(1);

    act(() => setViewportWidth(767));
    expect(screen.getByText("Mobile drawer")).toBeTruthy();
    expect(screen.getByRole("textbox")).toBe(textarea);
    expect(mountCount).toBe(1);
  });

  test("preserves the routed chat when a popout crosses the breakpoint", () => {
    renderFrame({ isPopout: true });
    const textarea = screen.getByRole("textbox");

    expect(screen.getByText("Popout voice session")).toBeTruthy();
    expect(mountCount).toBe(1);

    act(() => setViewportWidth(768));
    expect(screen.getByText("Popout voice session")).toBeTruthy();
    expect(screen.queryByText("Desktop navigation")).toBeNull();
    expect(screen.queryByText("Desktop voice room")).toBeNull();
    expect(screen.getByRole("textbox")).toBe(textarea);
    expect(mountCount).toBe(1);
  });
});
