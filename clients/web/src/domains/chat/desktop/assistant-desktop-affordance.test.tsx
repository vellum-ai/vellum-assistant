import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { useEffect, useState } from "react";

import { publish } from "@/lib/event-bus";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";

let desktopEnabled: boolean | undefined = true;
let assistantId = "asst-1";
let touch = false;
let platformHosted = true;
let attended = true;
let attentionSupported = true;

mock.module("@/runtime/window-attention", () => ({
  isWindowAttended: () => attended,
  supportsWindowAttention: () => attentionSupported,
}));

let automationActive: boolean | undefined = false;
mock.module("./use-desktop-setup", () => ({
  useDesktopSetupStatus: () => ({ query: { data: { automationActive } } }),
}));

mock.module("@/hooks/use-platform-gate", () => ({
  useActiveAssistantIsPlatformHosted: () => platformHosted,
}));

mock.module("@/utils/pointer", () => ({
  usePointerCoarse: () => touch,
  isPointerCoarse: () => touch,
}));

mock.module("@/stores/assistant-feature-flag-store", () => ({
  useAssistantFeatureFlagStore: {
    use: { assistantDesktop: () => desktopEnabled },
  },
}));

mock.module("@/stores/resolved-assistants-store", () => ({
  useResolvedAssistantsStore: {
    use: {
      activeAssistantId: () => assistantId,
      assistants: () => [
        { id: "asst-1", name: "Alice" },
        { id: "asst-2", name: "Bob" },
      ],
    },
  },
}));

let panelUnmounts = 0;

mock.module("./desktop-panel", () => ({
  DesktopPanel: ({ viewOnly }: { viewOnly: boolean }) => {
    useEffect(() => {
      return () => {
        panelUnmounts += 1;
      };
    }, []);
    return <div data-testid="desktop-panel" data-view-only={viewOnly}></div>;
  },
}));

const { AssistantDesktopAffordance } =
  await import("./assistant-desktop-affordance");

const { AssistantDesktopPreview } = await import("./assistant-desktop-preview");
const { useDesktopPreviewStore } = await import("./desktop-preview-store");

function DesktopHarness() {
  return (
    <>
      <AssistantDesktopAffordance />
      <AssistantDesktopPreview />
    </>
  );
}

const openDesktop = async () => {
  render(<DesktopHarness />);
  fireEvent.click(
    screen.getByRole("button", { name: "Open Alice's virtual desktop" }),
  );
  await waitFor(() =>
    expect(screen.getByTestId("desktop-panel")).not.toBeNull(),
  );
};

beforeEach(() => {
  useAssistantIdentityStore.getState().clearIdentity();
  touch = false;
  attended = true;
  attentionSupported = true;
  platformHosted = true;
  automationActive = false;
  useDesktopPreviewStore.setState({
    position: null,
    width: 320,
    submittedHelpRequests: {},
  });
  panelUnmounts = 0;
  desktopEnabled = true;
  assistantId = "asst-1";
  useDesktopPreviewStore.getState().close();
});

afterEach(() => {
  cleanup();
  useAssistantIdentityStore.getState().clearIdentity();
});

describe("AssistantDesktopAffordance", () => {
  test("updates the name after a rename and ignores another assistant's identity", () => {
    const { rerender } = render(<DesktopHarness />);
    act(() => {
      useAssistantIdentityStore
        .getState()
        .setIdentity("Example Assistant", null, "asst-1");
    });
    expect(
      screen.getByRole("button", {
        name: "Open Example Assistant's virtual desktop",
      }),
    ).not.toBeNull();
    assistantId = "asst-2";
    rerender(<DesktopHarness />);
    expect(
      screen.getByRole("button", { name: "Open Bob's virtual desktop" }),
    ).not.toBeNull();
  });

  test("opening from navigation dismisses the menu and keeps fullscreen open", async () => {
    touch = true;
    function MenuHarness() {
      const [menuOpen, setMenuOpen] = useState(true);
      return (
        <>
          {menuOpen && (
            <nav aria-label="Navigation">
              <AssistantDesktopAffordance onToggle={() => setMenuOpen(false)} />
            </nav>
          )}
          <AssistantDesktopPreview />
        </>
      );
    }
    render(<MenuHarness />);
    fireEvent.click(
      screen.getByRole("button", { name: "Open Alice's virtual desktop" }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("desktop-panel")).toBeTruthy(),
    );
    expect(screen.queryByRole("navigation") === null).toBe(true);
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close preview" }));
    await waitFor(() =>
      expect(screen.queryByTestId("desktop-panel") === null).toBe(true),
    );
  });

  test("touch opens directly in fullscreen and closing dismisses the desktop", async () => {
    touch = true;
    await openDesktop();
    expect(screen.getByRole("dialog")).not.toBeNull();
    expect(screen.getByTestId("desktop-panel").dataset.viewOnly).toBe("false");
    expect(
      screen.queryByRole("button", { name: "Expand virtual desktop" }),
    ).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Close preview" }));
    await waitFor(() =>
      expect(screen.queryByTestId("desktop-panel") === null).toBe(true),
    );
    expect(
      screen.getByRole("button", { name: "Open Alice's virtual desktop" }),
    ).not.toBeNull();
  });
  for (const flag of [false, undefined]) {
    test(`hides the desktop control and panel when the flag is ${flag}`, () => {
      desktopEnabled = flag;
      render(<DesktopHarness />);
      expect(
        screen.queryByRole("button", { name: "Open Alice's virtual desktop" }),
      ).toBeNull();
      expect(screen.queryByTestId("desktop-panel") === null).toBe(true);
    });
  }

  test("unmounts an open desktop when the flag is disabled", async () => {
    const { rerender } = render(<DesktopHarness />);
    fireEvent.click(
      screen.getByRole("button", { name: "Open Alice's virtual desktop" }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("desktop-panel")).not.toBeNull(),
    );
    desktopEnabled = false;
    rerender(<DesktopHarness />);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByTestId("desktop-panel") === null).toBe(true);
    expect(panelUnmounts).toBe(1);
  });

  test("Escape leaves the modal open and the panel mounted", async () => {
    await openDesktop();
    fireEvent.click(
      screen.getByRole("button", { name: "Expand virtual desktop" }),
    );

    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "Escape",
    });

    expect(screen.getByRole("dialog")).not.toBeNull();
    expect(screen.getByTestId("desktop-panel")).not.toBeNull();
    expect(panelUnmounts).toBe(0);
  });

  test("clicks inside the expanded desktop keep it open", async () => {
    await openDesktop();
    fireEvent.click(
      screen.getByRole("button", { name: "Expand virtual desktop" }),
    );
    fireEvent.pointerDown(screen.getByTestId("desktop-panel"));
    fireEvent.click(screen.getByTestId("desktop-panel"));
    expect(screen.getByRole("dialog")).not.toBeNull();
    expect(panelUnmounts).toBe(0);
  });

  test("closing fullscreen restores the same preview session", async () => {
    await openDesktop();
    expect(screen.queryByRole("button", { name: "Take control" })).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "Expand virtual desktop" }),
    );
    expect(screen.getByTestId("desktop-panel").dataset.viewOnly).toBe("false");
    expect(screen.queryByRole("button", { name: "Take control" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Close preview" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(panelUnmounts).toBe(0);
    expect(screen.getByTestId("desktop-panel").dataset.viewOnly).toBe("true");
    expect(screen.queryByRole("button", { name: "Take control" })).toBeNull();
  });

  test("toggles the floating preview without opening fullscreen", async () => {
    await openDesktop();
    expect(screen.queryByRole("dialog")).toBeNull();
    const collapse = screen.getByRole("button", {
      name: "Hide virtual desktop",
    });
    expect(collapse.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(collapse);
    expect(panelUnmounts).toBe(0);
    await waitFor(() =>
      expect(screen.queryByTestId("desktop-panel") === null).toBe(true),
    );
    expect(panelUnmounts).toBe(1);
    expect(
      screen.getByRole("button", { name: "Open Alice's virtual desktop" }),
    ).not.toBeNull();
  });

  test("the preview X closes it without opening fullscreen", async () => {
    await openDesktop();
    fireEvent.click(
      screen.getByRole("button", { name: "Close virtual desktop preview" }),
    );
    await waitFor(() =>
      expect(screen.queryByTestId("desktop-panel") === null).toBe(true),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Open Alice's virtual desktop" }),
    ).not.toBeNull();
  });

  function mockPreviewGeometry(width = 800, height = 600) {
    const frame = document.getElementById("assistant-desktop-preview")!;
    const renderedWidth = () =>
      Math.min(
        useDesktopPreviewStore.getState().width,
        width,
        ((height - 40) * 16) / 9,
      );
    Object.defineProperties(frame, {
      offsetWidth: {
        configurable: true,
        get: renderedWidth,
      },
      offsetHeight: {
        configurable: true,
        get: () => (renderedWidth() * 9) / 16 + 40,
      },
      offsetLeft: {
        configurable: true,
        get: () => Number.parseFloat(frame.style.left || "480"),
      },
      offsetTop: {
        configurable: true,
        get: () => Number.parseFloat(frame.style.top || "380"),
      },
      setPointerCapture: { configurable: true, value: () => {} },
    });
    Object.defineProperties(frame.parentElement!, {
      clientWidth: { configurable: true, value: width },
      clientHeight: { configurable: true, value: height },
    });
    return frame;
  }

  test("dragging moves the preview without expanding and the X still closes it", async () => {
    await openDesktop();
    const frame = mockPreviewGeometry();
    const expand = screen.getByRole("button", {
      name: "Expand virtual desktop",
    });
    const pointer = { pointerId: 1, button: 0, buttons: 1, isPrimary: true };
    fireEvent.pointerDown(expand, { ...pointer, clientX: 500, clientY: 400 });
    fireEvent.pointerMove(frame, { ...pointer, clientX: 300, clientY: 200 });
    fireEvent.pointerUp(frame, pointer);
    fireEvent.click(expand, { detail: 1 });
    expect(useDesktopPreviewStore.getState().position).toEqual({
      x: 280,
      y: 180,
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(panelUnmounts).toBe(0);

    const close = screen.getByRole("button", {
      name: "Close virtual desktop preview",
    });
    fireEvent.pointerDown(close, pointer);
    fireEvent.click(close, { detail: 1 });
    expect(useDesktopPreviewStore.getState().session).toBeNull();
  });

  test("corner resizing preserves the desktop ratio and clamps to 1000px", async () => {
    await openDesktop();
    const frame = mockPreviewGeometry(1400, 1000);
    const capture = mock(() => {});
    Object.defineProperty(frame, "setPointerCapture", { value: capture });
    const handle = screen.getByRole("button", {
      name: "Resize virtual desktop preview (arrow keys)",
    });
    const pointer = { pointerId: 1, button: 0, buttons: 1, isPrimary: true };
    fireEvent.pointerDown(handle, { ...pointer, clientX: 480, clientY: 380 });
    expect(capture).toHaveBeenCalledWith(pointer.pointerId);
    fireEvent.pointerMove(frame, { ...pointer, clientX: 160, clientY: 200 });
    expect(useDesktopPreviewStore.getState().width).toBe(640);
    expect(useDesktopPreviewStore.getState().position).toEqual({
      x: 160,
      y: 200,
    });
    fireEvent.pointerMove(frame, {
      ...pointer,
      clientX: -1000,
      clientY: -1000,
    });
    expect(useDesktopPreviewStore.getState().width).toBe(1000);
    expect(useDesktopPreviewStore.getState().position).toEqual({ x: 0, y: 0 });
    fireEvent.pointerUp(frame, pointer);
    fireEvent.click(handle, { detail: 1 });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(panelUnmounts).toBe(0);

    fireEvent.pointerDown(handle, { ...pointer, clientX: 0, clientY: 0 });
    fireEvent.pointerMove(frame, { ...pointer, clientX: 1000, clientY: 1000 });
    fireEvent.pointerUp(frame, pointer);
    expect(useDesktopPreviewStore.getState().width).toBe(320);
  });

  test("resizing fits short viewports and supports the keyboard", async () => {
    await openDesktop();
    const frame = mockPreviewGeometry(800, 400);
    const handle = screen.getByRole("button", {
      name: "Resize virtual desktop preview (arrow keys)",
    });
    fireEvent.keyDown(handle, { key: "ArrowLeft", shiftKey: true });
    expect(useDesktopPreviewStore.getState().width).toBe(360);
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    expect(useDesktopPreviewStore.getState().width).toBe(344);
    const pointer = { pointerId: 1, button: 0, buttons: 1, isPrimary: true };
    fireEvent.pointerDown(handle, { ...pointer, clientX: 400, clientY: 200 });
    fireEvent.pointerMove(frame, {
      ...pointer,
      clientX: -1000,
      clientY: -1000,
    });
    fireEvent.pointerUp(frame, pointer);
    expect(frame.offsetWidth).toBe(640);
    expect(frame.offsetHeight).toBe(400);
    expect(useDesktopPreviewStore.getState().position).toEqual({
      x: 160,
      y: 0,
    });
    expect(panelUnmounts).toBe(0);
  });

  test("enlarging a constrained preview preserves its preferred width", async () => {
    await openDesktop();
    act(() => useDesktopPreviewStore.getState().resize(1000, { x: 0, y: 0 }));
    const frame = mockPreviewGeometry(800, 400);
    const handle = screen.getByRole("button", {
      name: "Resize virtual desktop preview (arrow keys)",
    });
    expect(frame.offsetWidth).toBe(640);
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(useDesktopPreviewStore.getState().width).toBe(1000);
    expect(frame.offsetWidth).toBe(640);
    mockPreviewGeometry(1400, 1000);
    expect(frame.offsetWidth).toBe(1000);
  });

  test("keyboard resizing accumulates while the viewport constrains the frame", async () => {
    await openDesktop();
    act(() => useDesktopPreviewStore.getState().resize(600, { x: 0, y: 0 }));
    const frame = mockPreviewGeometry(400, 400);
    const handle = screen.getByRole("button", {
      name: "Resize virtual desktop preview (arrow keys)",
    });
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    fireEvent.keyDown(handle, { key: "ArrowLeft" });
    expect(frame.offsetWidth).toBe(400);
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    mockPreviewGeometry();
    expect(frame.offsetWidth).toBe(616);
  });

  test("a narrow viewport does not lower the preferred minimum size", async () => {
    await openDesktop();
    const frame = mockPreviewGeometry(240, 400);
    fireEvent.keyDown(
      screen.getByRole("button", {
        name: "Resize virtual desktop preview (arrow keys)",
      }),
      { key: "ArrowRight" },
    );
    expect(frame.offsetWidth).toBe(240);
    expect(useDesktopPreviewStore.getState().width).toBe(320);
    mockPreviewGeometry();
    expect(frame.offsetWidth).toBe(320);
  });

  test("keyboard movement keeps the preview inside the available area", async () => {
    await openDesktop();
    const frame = mockPreviewGeometry();
    const move = screen.getByRole("button", {
      name: "Move virtual desktop preview (arrow keys)",
    });
    fireEvent.keyDown(move, { key: "ArrowLeft" });
    expect(frame.style.left).toBe("464px");
    fireEvent.keyDown(move, { key: "ArrowRight", shiftKey: true });
    fireEvent.keyDown(move, { key: "ArrowDown" });
    expect(useDesktopPreviewStore.getState().position).toEqual({
      x: 480,
      y: 380,
    });
    expect(panelUnmounts).toBe(0);
  });

  test("switching assistants closes the previous session", async () => {
    const { rerender } = render(<DesktopHarness />);
    fireEvent.click(
      screen.getByRole("button", { name: "Open Alice's virtual desktop" }),
    );
    await waitFor(() =>
      expect(screen.getByTestId("desktop-panel")).not.toBeNull(),
    );
    assistantId = "asst-2";
    rerender(<DesktopHarness />);
    expect(screen.queryByTestId("desktop-panel") === null).toBe(true);
    expect(panelUnmounts).toBe(1);
    assistantId = "asst-1";
    rerender(<DesktopHarness />);
    expect(screen.queryByTestId("desktop-panel") === null).toBe(true);
  });
});

test("self-hosted assistants cannot open the virtual desktop even with its flag enabled", () => {
  platformHosted = false;
  render(<DesktopHarness />);
  expect(
    screen.queryByRole("button", { name: "Open Alice's virtual desktop" }),
  ).toBeNull();
  expect(screen.queryByTestId("desktop-panel")).toBeNull();
});

test("switching to a self-hosted assistant closes the virtual desktop preview", async () => {
  const { rerender } = render(<DesktopHarness />);
  fireEvent.click(
    screen.getByRole("button", { name: "Open Alice's virtual desktop" }),
  );
  await waitFor(() => expect(screen.getByTestId("desktop-panel")).toBeTruthy());
  platformHosted = false;
  rerender(<DesktopHarness />);
  await waitFor(() => expect(screen.queryByTestId("desktop-panel")).toBeNull());
  expect(useDesktopPreviewStore.getState().session).toBeNull();
});

const { DesktopHelpCard } = await import("./desktop-help-card");
const { normalizeQuestionRequest } =
  await import("@/domains/chat/api/event-types");

const helpEntry = normalizeQuestionRequest({
  type: "question_request",
  requestId: "req-help",
  question: "Please complete the CAPTCHA.",
  options: [],
  questions: [
    {
      id: "q1",
      question: "Please complete the CAPTCHA.",
      presentation: "virtual_desktop",
      options: [
        { id: "done", label: "Done" },
        { id: "skip", label: "Skip" },
      ],
    },
  ],
})[0]!;

test.each([false, true])(
  "desktop help keeps one viewer through Step In and returns to the card (touch=%s)",
  async (isTouch) => {
    touch = isTouch;
    const submit = mock(() => {});
    render(
      <>
        <DesktopHelpCard
          entry={helpEntry}
          isSubmitting={false}
          onSubmit={submit}
        />
        <AssistantDesktopPreview />
      </>,
    );
    expect(screen.queryByTestId("desktop-panel")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show live preview" }));
    const panel = await screen.findByTestId("desktop-panel");
    expect(panel.getAttribute("data-view-only")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Step In" }));
    await waitFor(() =>
      expect(panel.getAttribute("data-view-only")).toBe("false"),
    );
    expect(screen.getAllByTestId("desktop-panel")).toHaveLength(1);
    expect(panelUnmounts).toBe(0);
    expect(submit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Close preview" }));
    await waitFor(() =>
      expect(panel.getAttribute("data-view-only")).toBe("true"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(submit).toHaveBeenCalledWith([
      { questionId: "q1", kind: "option", optionId: "done" },
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Skip" }));
    expect(submit).toHaveBeenLastCalledWith([
      { questionId: "q1", kind: "skip" },
    ]);
  },
);

test("desktop help disables all actions while its response is submitting", () => {
  render(
    <DesktopHelpCard entry={helpEntry} isSubmitting onSubmit={() => {}} />,
  );
  for (const name of ["Show live preview", "Step In", "Done", "Skip"]) {
    expect(
      (screen.getByRole("button", { name }) as HTMLButtonElement).disabled,
    ).toBe(true);
  }
});

test("moving an open desktop into a help card preserves the live connection", async () => {
  function Harness({ help }: { help: boolean }) {
    return (
      <>
        {help && (
          <DesktopHelpCard
            entry={helpEntry}
            isSubmitting={false}
            onSubmit={() => {}}
          />
        )}
        <DesktopHarness />
      </>
    );
  }
  const { rerender } = render(<Harness help={false} />);
  fireEvent.click(
    screen.getByRole("button", { name: "Open Alice's virtual desktop" }),
  );
  const panel = await screen.findByTestId("desktop-panel");
  rerender(<Harness help />);
  expect(screen.getByTestId("desktop-panel")).toBe(panel);
  expect(panelUnmounts).toBe(0);
  fireEvent.click(screen.getByRole("button", { name: "Step In" }));
  rerender(<Harness help={false} />);
  expect(screen.getByTestId("desktop-panel")).toBe(panel);
  expect(panelUnmounts).toBe(0);
  expect(panel.getAttribute("data-view-only")).toBe("true");
  expect(screen.queryByRole("dialog")).toBeNull();
});

test("desktop help releases its viewer when another app window takes focus", async () => {
  attended = false;
  render(
    <>
      <DesktopHelpCard
        entry={helpEntry}
        isSubmitting={false}
        onSubmit={() => {}}
      />
      <AssistantDesktopPreview />
    </>,
  );
  expect(screen.queryByTestId("desktop-panel")).toBeNull();
  act(() => publish("app.attention", { attended: true }));
  fireEvent.click(screen.getByRole("button", { name: "Show live preview" }));
  await screen.findByTestId("desktop-panel");
  act(() => publish("app.attention", { attended: false }));
  expect(screen.queryByTestId("desktop-panel")).toBeNull();
  expect(panelUnmounts).toBe(1);
  act(() => publish("app.attention", { attended: true }));
  await screen.findByTestId("desktop-panel");
  fireEvent.click(screen.getByRole("button", { name: "Step In" }));
  expect(screen.getByRole("dialog")).toBeTruthy();
});

test("windows without attention reporting release the viewer on browser focus changes", async () => {
  attended = false;
  attentionSupported = false;
  let focused = false;
  const originalHasFocus = document.hasFocus;
  document.hasFocus = () => focused;
  try {
    render(
      <>
        <DesktopHelpCard
          entry={helpEntry}
          isSubmitting={false}
          onSubmit={() => {}}
        />
        <AssistantDesktopPreview />
      </>,
    );
    expect(screen.queryByTestId("desktop-panel")).toBeNull();
    focused = true;
    fireEvent(window, new Event("focus"));
    fireEvent.click(screen.getByRole("button", { name: "Show live preview" }));
    await screen.findByTestId("desktop-panel");
    fireEvent.click(screen.getByRole("button", { name: "Step In" }));
    expect(screen.getByRole("dialog")).toBeTruthy();
    focused = false;
    fireEvent(window, new Event("blur"));
    expect(screen.queryByTestId("desktop-panel")).toBeNull();
    expect(panelUnmounts).toBe(1);
    focused = true;
    fireEvent(window, new Event("focus"));
    await screen.findByTestId("desktop-panel");
    expect(screen.getByRole("dialog")).toBeTruthy();
  } finally {
    document.hasFocus = originalHasFocus;
  }
});

const submitQuestion = mock(() => {});
mock.module("@/domains/chat/question-actions", () => ({
  handleQuestionResponse: submitQuestion,
  handleDismissPendingQuestion: mock(() => {}),
}));
const { useInteractionStore } =
  await import("@/domains/chat/interaction-store");
const { PendingDesktopHelpRow } =
  await import("@/domains/chat/transcript/pending-desktop-help-row");
const { QuestionPromptSlot } =
  await import("@/domains/chat/components/question-prompt-slot");

test("desktop help renders in the transcript only and submits through the question lifecycle", async () => {
  useInteractionStore.setState({
    pendingQuestion: { requestId: "req-help", entries: [helpEntry] },
  });
  try {
    render(
      <>
        <section aria-label="Messages">
          <PendingDesktopHelpRow requestId="req-help" />
        </section>
        <footer data-testid="composer">
          <QuestionPromptSlot />
        </footer>
        <AssistantDesktopPreview />
      </>,
    );
    expect(screen.queryByTestId("desktop-panel")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Show live preview" }));
    await screen.findByTestId("desktop-panel");
    const messages = within(screen.getByRole("region", { name: "Messages" }));
    expect(messages.getByRole("button", { name: "Step In" })).toBeTruthy();
    expect(
      within(screen.getByTestId("composer")).queryByRole("button"),
    ).toBeNull();
    fireEvent.click(messages.getByRole("button", { name: "Done" }));
    expect(submitQuestion).toHaveBeenCalledWith([
      { questionId: "q1", kind: "option", optionId: "done" },
    ]);
    act(() => useInteractionStore.setState({ pendingQuestion: null }));
    expect(messages.queryByRole("button", { name: "Step In" })).toBeNull();
  } finally {
    act(() => useInteractionStore.setState({ pendingQuestion: null }));
  }
});

test("an older transcript row cannot show a newer help request", () => {
  useInteractionStore.setState({
    pendingQuestion: { requestId: "req-new", entries: [helpEntry] },
  });
  try {
    render(<PendingDesktopHelpRow requestId="req-old" />);
    expect(screen.queryByRole("button", { name: "Step In" })).toBeNull();
  } finally {
    act(() => useInteractionStore.setState({ pendingQuestion: null }));
  }
});

test("desktop icon pulses during automation and clears when it ends", () => {
  const { rerender } = render(<DesktopHarness />);
  const icon = () =>
    screen
      .getByRole("button", { name: "Open Alice's virtual desktop" })
      .querySelector("svg")!;
  expect(icon().classList.contains("motion-safe:animate-pulse")).toBe(false);
  automationActive = true;
  rerender(<DesktopHarness />);
  expect(icon().classList.contains("motion-safe:animate-pulse")).toBe(true);
  expect(icon().getAttribute("stroke")).toBe(
    "var(--avatar-accent, var(--content-emphasised))",
  );
  automationActive = undefined;
  rerender(<DesktopHarness />);
  expect(icon().getAttribute("stroke")).toBe("currentColor");
  expect(icon().classList.contains("motion-safe:animate-pulse")).toBe(false);
});

test("a help request does not claim a viewer until this client selects Step In", async () => {
  render(
    <>
      <DesktopHelpCard
        entry={helpEntry}
        isSubmitting={false}
        onSubmit={() => {}}
      />
      <AssistantDesktopPreview />
    </>,
  );
  expect(screen.queryByTestId("desktop-panel")).toBeNull();
  expect(useDesktopPreviewStore.getState().session).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Step In" }));
  const panel = await screen.findByTestId("desktop-panel");
  expect(screen.getByRole("dialog")).toBeTruthy();
  expect(panel.getAttribute("data-view-only")).toBe("false");
  fireEvent.click(screen.getByRole("button", { name: "Close preview" }));
  expect(screen.getByTestId("desktop-panel")).toBe(panel);
  expect(panelUnmounts).toBe(0);
});

test.each([false, true])(
  "resolving help remotely closes its interactive viewer (touch=%s)",
  async (isTouch) => {
    touch = isTouch;
    useInteractionStore.setState({
      pendingQuestion: { requestId: "req-help", entries: [helpEntry] },
    });
    try {
      render(
        <>
          <PendingDesktopHelpRow requestId="req-help" />
          <AssistantDesktopPreview />
        </>,
      );
      fireEvent.click(screen.getByRole("button", { name: "Step In" }));
      const panel = await screen.findByTestId("desktop-panel");
      expect(panel.getAttribute("data-view-only")).toBe("false");
      act(() => useInteractionStore.setState({ pendingQuestion: null }));
      expect(panel.getAttribute("data-view-only")).toBe("true");
      await waitFor(() =>
        expect(screen.queryByTestId("desktop-panel") === null).toBe(true),
      );
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(useDesktopPreviewStore.getState().session).toBeNull();
    } finally {
      act(() => useInteractionStore.setState({ pendingQuestion: null }));
    }
  },
);

test.each(["preview", "fullscreen"] as const)(
  "mobile help resolution does not reactivate a preexisting %s session",
  async (view) => {
    touch = true;
    render(
      <>
        <PendingDesktopHelpRow requestId="req-help" />
        <DesktopHarness />
      </>,
    );
    act(() =>
      useDesktopPreviewStore.setState({
        session: { assistantId: "asst-1", view },
      }),
    );
    const panel = await screen.findByTestId("desktop-panel");
    act(() =>
      useInteractionStore
        .getState()
        .showQuestion({ requestId: "req-help", entries: [helpEntry] }),
    );
    if (view === "preview") {
      fireEvent.click(screen.getByRole("button", { name: "Step In" }));
    }
    expect(panel.getAttribute("data-view-only")).toBe("false");
    act(() => useInteractionStore.setState({ pendingQuestion: null }));
    expect(panel.getAttribute("data-view-only")).toBe("true");
    if (view === "fullscreen") {
      await waitFor(() =>
        expect(screen.queryByTestId("desktop-panel") === null).toBe(true),
      );
      expect(useDesktopPreviewStore.getState().session).toBeNull();
    } else {
      expect(screen.getByTestId("desktop-panel")).toBe(panel);
      expect(useDesktopPreviewStore.getState().session?.view).toBe("preview");
    }
  },
);

test("submitted help stays read-only after a failed response and reopening", async () => {
  useInteractionStore.setState({
    pendingQuestion: { requestId: "req-help", entries: [helpEntry] },
  });
  try {
    render(
      <>
        <PendingDesktopHelpRow requestId="req-help" />
        <AssistantDesktopPreview />
      </>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Step In" }));
    const panel = await screen.findByTestId("desktop-panel");
    expect(panel.getAttribute("data-view-only")).toBe("false");
    act(() => {
      useInteractionStore.getState().claimSubmission("question", "req-help");
      useDesktopPreviewStore
        .getState()
        .markHelpSubmitted("asst-1", "req-help", "conv-help");
    });
    expect(panel.getAttribute("data-view-only")).toBe("true");
    expect(useInteractionStore.getState().pendingQuestion?.requestId).toBe(
      "req-help",
    );
    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(panelUnmounts).toBe(0);
    act(() => {
      useInteractionStore.getState().releaseSubmission("question", "req-help");
    });
    expect(panel.getAttribute("data-view-only")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Close preview" }));
    fireEvent.click(screen.getByRole("button", { name: "Step In" }));
    expect(panel.getAttribute("data-view-only")).toBe("true");
    act(() => useDesktopPreviewStore.getState().close());
    await waitFor(() =>
      expect(screen.queryByTestId("desktop-panel") === null).toBe(true),
    );
    fireEvent.click(screen.getByRole("button", { name: "Step In" }));
    expect(
      (await screen.findByTestId("desktop-panel")).getAttribute(
        "data-view-only",
      ),
    ).toBe("true");
    act(() => useInteractionStore.getState().resetAll());
    await waitFor(() =>
      expect(screen.queryByTestId("desktop-panel") === null).toBe(true),
    );
    act(() => useDesktopPreviewStore.getState().openFullscreen("asst-1"));
    const reopened = await screen.findByTestId("desktop-panel");
    expect(reopened.getAttribute("data-view-only")).toBe("true");
    act(() =>
      useDesktopPreviewStore.getState().resolveHelpSubmission("unrelated"),
    );
    expect(reopened.getAttribute("data-view-only")).toBe("true");
    act(() =>
      useDesktopPreviewStore.getState().resolveHelpSubmission("req-help"),
    );
    expect(reopened.getAttribute("data-view-only")).toBe("true");
    expect(screen.queryByRole("dialog")).toBeNull();
    act(() => useDesktopPreviewStore.getState().openFullscreen("asst-1"));
    expect(reopened.getAttribute("data-view-only")).toBe("false");
  } finally {
    act(() => {
      useInteractionStore.getState().releaseSubmission("question", "req-help");
      useInteractionStore.setState({ pendingQuestion: null });
    });
  }
});
