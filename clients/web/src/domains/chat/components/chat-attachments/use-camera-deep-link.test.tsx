import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, render, screen } from "@testing-library/react";
import { createElement, useEffect } from "react";
import {
  MemoryRouter,
  Outlet,
  Route,
  Routes,
  useNavigate,
  useParams,
} from "react-router";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { routes } from "@/utils/routes";

// The viewfinder itself is covered by `camera-capture-overlay.test.tsx`; this
// suite is about the park-and-drain that raises it, so the surface is stubbed
// to a marker that also hands its two callbacks back for the delivery tests.
let overlayProps: {
  onCapture: (files: File[]) => void;
  onClose: () => void;
} | null = null;
mock.module(
  "@/domains/chat/components/chat-attachments/camera-capture-overlay",
  () => ({
    CameraCaptureOverlay: (props: {
      onCapture: (files: File[]) => void;
      onClose: () => void;
    }) => {
      overlayProps = props;
      return createElement("div", { "data-testid": "camera-surface" });
    },
  }),
);

const { PENDING_CAMERA_TTL_MS, useCameraDeepLink } =
  await import("@/domains/chat/components/chat-attachments/use-camera-deep-link");
const { __resetPendingDeepLinkForTesting, usePendingDeepLinkStore } =
  await import("@/stores/pending-deep-link-store");
const { useLiveVoiceStore } =
  await import("@/domains/chat/voice/live-voice/live-voice-store");
const { useGlobalDeepLinkConsumer } =
  await import("@/hooks/use-global-deep-link-consumer");
const { __resetForTesting, publish } = await import("@/lib/event-bus");
const { useConversationStore } = await import("@/stores/conversation-store");

const onFiles = mock((_files: File[]) => {});

/** The conversation the host below is mounted on, and so the park's address. */
const HOST_CONVERSATION_ID = "conv-host";

function Host({ enabled }: { enabled: boolean }) {
  const { overlayNode, captureOpen } = useCameraDeepLink({ onFiles, enabled });
  return createElement(
    "div",
    { "data-testid": "host", "data-capture-open": String(captureOpen) },
    overlayNode,
  );
}

// The drain reads its conversation off the route, so the host lives on one.
const hostTree = (enabled: boolean) => (
  <MemoryRouter initialEntries={[routes.conversation(HOST_CONVERSATION_ID)]}>
    <Host enabled={enabled} />
  </MemoryRouter>
);

const renderCameraDeepLink = (enabled = true) => render(hostTree(enabled));

const parkForHost = () =>
  usePendingDeepLinkStore.getState().setPendingCamera(HOST_CONVERSATION_ID);

const surface = () => screen.queryByTestId("camera-surface");
const captureOpen = () =>
  screen.getByTestId("host").getAttribute("data-capture-open");

beforeEach(() => {
  onFiles.mockClear();
  overlayProps = null;
  __resetPendingDeepLinkForTesting();
  useLiveVoiceStore.setState({ state: "idle" });
});

afterEach(() => {
  cleanup();
  __resetPendingDeepLinkForTesting();
  useLiveVoiceStore.setState({ state: "idle" });
});

describe("useCameraDeepLink", () => {
  test("raises no camera until a request is parked", () => {
    renderCameraDeepLink();

    expect(surface()).toBeNull();
    expect(captureOpen()).toBe("false");
  });

  test("drains a park made before the composer mounted, the cold-launch case", () => {
    parkForHost();

    renderCameraDeepLink();

    expect(surface()).not.toBeNull();
    expect(captureOpen()).toBe("true");
    expect(usePendingDeepLinkStore.getState().pendingCamera).toBeNull();
  });

  test("drains a park that arrives while already mounted, the warm case", () => {
    renderCameraDeepLink();
    expect(surface()).toBeNull();

    act(() => {
      parkForHost();
    });

    expect(surface()).not.toBeNull();
  });

  test("hands the photo to the composer's attachment pipeline as files", () => {
    parkForHost();
    renderCameraDeepLink();

    const photo = new File([new Uint8Array([1, 2, 3])], "photo-1.jpg", {
      type: "image/jpeg",
    });
    act(() => {
      overlayProps?.onCapture([photo]);
      overlayProps?.onClose();
    });

    expect(onFiles).toHaveBeenCalledTimes(1);
    expect(onFiles.mock.calls[0]?.[0]).toEqual([photo]);
    expect(surface()).toBeNull();
  });

  test("closing without a photo takes the surface down and attaches nothing", () => {
    parkForHost();
    renderCameraDeepLink();

    act(() => {
      overlayProps?.onClose();
    });

    expect(onFiles).not.toHaveBeenCalled();
    expect(surface()).toBeNull();
    expect(captureOpen()).toBe("false");
  });

  test("delivers exactly once: a closed surface does not come back on re-render", () => {
    parkForHost();
    const { rerender } = renderCameraDeepLink();

    act(() => {
      overlayProps?.onClose();
    });
    rerender(hostTree(true));

    expect(surface()).toBeNull();
  });

  test("a park older than the TTL is spent, not acted on: no camera minutes later", () => {
    usePendingDeepLinkStore.setState({
      pendingCamera: {
        targetConversationId: HOST_CONVERSATION_ID,
        parkedAt: Date.now() - PENDING_CAMERA_TTL_MS - 1,
      },
    });

    renderCameraDeepLink();

    expect(surface()).toBeNull();
    expect(usePendingDeepLinkStore.getState().pendingCamera).toBeNull();
  });

  test("a park just inside the TTL still opens the camera", () => {
    usePendingDeepLinkStore.setState({
      pendingCamera: {
        targetConversationId: HOST_CONVERSATION_ID,
        parkedAt: Date.now() - PENDING_CAMERA_TTL_MS + 1_000,
      },
    });

    renderCameraDeepLink();

    expect(surface()).not.toBeNull();
  });

  test("a running call keeps the camera: no surface, and the request is spent", () => {
    // The room's viewfinder and this one are two hooks over one native preview
    // layer, so the drain gives way rather than fighting it for the camera.
    useLiveVoiceStore.setState({ state: "listening" });
    parkForHost();

    const { rerender } = renderCameraDeepLink();

    expect(surface()).toBeNull();
    expect(captureOpen()).toBe("false");
    // Spent rather than parked: a call outlives the TTL, so a held request
    // would raise a viewfinder long after the tap asked for one.
    expect(usePendingDeepLinkStore.getState().pendingCamera).toBeNull();

    useLiveVoiceStore.setState({ state: "idle" });
    rerender(hostTree(true));

    expect(surface()).toBeNull();
  });

  test("a disabled composer leaves the park alone for the one that answers it", () => {
    parkForHost();

    const { rerender } = renderCameraDeepLink(false);

    expect(surface()).toBeNull();
    expect(usePendingDeepLinkStore.getState().pendingCamera).not.toBeNull();

    rerender(hostTree(true));

    expect(surface()).not.toBeNull();
  });

  test("a park addressed to another conversation is left where it is", () => {
    usePendingDeepLinkStore.getState().setPendingCamera("some-other-conv");

    renderCameraDeepLink();

    expect(surface()).toBeNull();
    expect(captureOpen()).toBe("false");
    // Untouched, not spent: the composer it names still has to find it.
    expect(
      usePendingDeepLinkStore.getState().pendingCamera?.targetConversationId,
    ).toBe("some-other-conv");
  });

  test("a park addressed to another conversation still ages out", () => {
    // Expiry is not addressed: whichever composer notices a park past its TTL
    // clears it, so a landing that never happened cannot leave one behind.
    usePendingDeepLinkStore.setState({
      pendingCamera: {
        targetConversationId: "some-other-conv",
        parkedAt: Date.now() - PENDING_CAMERA_TTL_MS - 1,
      },
    });

    renderCameraDeepLink();

    expect(surface()).toBeNull();
    expect(usePendingDeepLinkStore.getState().pendingCamera).toBeNull();
  });
});

/**
 * The camera link end to end, over a route tree shaped like the real one.
 *
 * The bare `/assistant` index is the trap: `useConversationLoader` replace
 * navigates off it to a conversation key the moment it mounts, which swaps the
 * leaf element and remounts the composer. The overlay lives in composer-local
 * state, so a link that lands there raises a viewfinder and loses it a beat
 * later. `LoaderIndex` below is that redirect, so any landing that touches the
 * index fails these tests the way it fails on a phone.
 */
describe("the camera link across the app's landings", () => {
  function LoaderIndex() {
    const navigate = useNavigate();
    useEffect(() => {
      void navigate(routes.conversation("loaded-1"), { replace: true });
    }, [navigate]);
    return null;
  }

  function ComposerRoute() {
    const { conversationId } = useParams();
    const { overlayNode } = useCameraDeepLink({ onFiles, enabled: true });
    return (
      <div data-testid="composer" data-conversation-id={conversationId}>
        {overlayNode}
      </div>
    );
  }

  function Shell() {
    useGlobalDeepLinkConsumer();
    return <Outlet />;
  }

  const renderAt = (initialPath: string) =>
    render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <MemoryRouter initialEntries={[initialPath]}>
          <Routes>
            <Route path={routes.assistant} element={<Shell />}>
              <Route index element={<LoaderIndex />} />
              <Route
                path="conversations/:conversationId"
                element={<ComposerRoute />}
              />
              <Route path="settings" element={<div />} />
            </Route>
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

  const landedConversationId = () =>
    screen.getByTestId("composer").getAttribute("data-conversation-id");

  beforeEach(() => {
    __resetForTesting();
    useConversationStore.getState().reset();
  });

  afterEach(() => {
    __resetForTesting();
    useConversationStore.getState().reset();
  });

  test("a tap with the composer already up keeps the conversation and the viewfinder", async () => {
    renderAt(routes.conversation("A"));

    await act(async () => {
      publish("deeplink.openCamera", { provenance: "intent" });
    });

    expect(surface()).not.toBeNull();
    expect(landedConversationId()).toBe("A");
  });

  test("a tap from elsewhere opens the camera on a fresh conversation", async () => {
    renderAt(`${routes.assistant}/settings`);

    await act(async () => {
      publish("deeplink.openCamera", { provenance: "intent" });
    });

    expect(surface()).not.toBeNull();
    // The draft the link minted, not the key the index route redirects to.
    expect(landedConversationId()).not.toBe("loaded-1");
    expect(useConversationStore.getState().activeConversationId).toBe(
      landedConversationId(),
    );
  });

  test("the composer on the route being left alone lets the draft's have the park", async () => {
    // The navigating branch publishes the park while the outgoing route is
    // still mounted, so a composer sitting on it sees the park first. It must
    // not take it: the navigation would unmount the viewfinder it raised a beat
    // later, and the one-shot park would already be gone.
    renderAt(routes.conversation("A"));

    await act(async () => {
      usePendingDeepLinkStore.getState().setPendingCamera("draft-B");
    });

    expect(surface()).toBeNull();
    expect(landedConversationId()).toBe("A");
    expect(
      usePendingDeepLinkStore.getState().pendingCamera?.targetConversationId,
    ).toBe("draft-B");

    // The landing the deep link was navigating to.
    await act(async () => {
      publish("deeplink.openThread", { threadId: "draft-B" });
    });

    expect(landedConversationId()).toBe("draft-B");
    expect(surface()).not.toBeNull();
    expect(usePendingDeepLinkStore.getState().pendingCamera).toBeNull();
  });

  test("a second tap does not raise a second camera", async () => {
    renderAt(routes.conversation("A"));

    await act(async () => {
      publish("deeplink.openCamera", { provenance: "intent" });
      publish("deeplink.openCamera", { provenance: "intent" });
    });

    expect(screen.getAllByTestId("camera-surface")).toHaveLength(1);
    expect(landedConversationId()).toBe("A");
  });
});
