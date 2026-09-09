/**
 * Tests for the MODEL tile in the ACP run detail panel.
 *
 * The surface is resolved inside the design library from a media query, so
 * these drive the viewport axes rather than stubbing a hook: a stubbed hook
 * would pass while the real primitive read something else. The switch action
 * arrives as a prop, so nothing here pulls in the daemon client.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";

import { toast } from "@vellumai/design-library";

import {
  useAcpRunStore,
  type AcpModelOption,
  type AcpRunEntry,
} from "@/domains/chat/acp-run-store";
import { viewportAxesStub } from "@/hooks/viewport-axes.test-helper";
import { MIN_VERSION } from "@/lib/backwards-compat/acp-model-switching";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";

import { AcpModelStatCard } from "./acp-model-stat-card";

const OPTIONS: AcpModelOption[] = [
  { value: "opus", label: "Opus", description: "Most capable" },
  { value: "sonnet", label: "Sonnet" },
];

const TRIGGER_NAME = "Model: Opus. Change model";

const viewport = viewportAxesStub();

function entry(overrides: Partial<AcpRunEntry> = {}): AcpRunEntry {
  return {
    acpSessionId: "acp-1",
    agent: "claude",
    parentConversationId: "conv-1",
    status: "running",
    startedAt: 0,
    usedTokens: 0,
    contextSize: 0,
    events: [],
    model: "opus",
    availableModels: OPTIONS,
    ...overrides,
  };
}

/** Seed the run so the store's `setModel` has an entry to write. */
function seed(e: AcpRunEntry) {
  useAcpRunStore.setState({
    byId: { [e.acpSessionId]: e },
    orderedIds: [e.acpSessionId],
    byToolUseId: new Map<string, string>(),
    highWaterMark: new Map<string, number>(),
  });
}

function storedModel(): string | undefined {
  return useAcpRunStore.getState().byId["acp-1"]?.model;
}

const noopSwitch = mock(async () => ({
  model: "opus",
  availableModels: OPTIONS,
}));

beforeEach(() => {
  viewport.set({ narrow: false, coarsePointer: false });
  useAssistantIdentityStore.setState({ version: MIN_VERSION });
  noopSwitch.mockClear();
});

afterEach(() => {
  cleanup();
  viewport.restore();
  useAssistantIdentityStore.setState({ version: null });
  useAcpRunStore.getState().reset();
});

describe("AcpModelStatCard on a live run", () => {
  test("names the selected model in a monospace value row", () => {
    const e = entry();
    seed(e);

    render(<AcpModelStatCard entry={e} onSwitchModel={noopSwitch} />);

    const trigger = screen.getByRole("button", { name: TRIGGER_NAME });
    expect(trigger.textContent).toContain("Opus");
    expect(trigger.textContent).toContain("Model");
    expect(trigger.innerHTML).toContain("font-mono");
  });

  test("opens the menu from the tile itself", () => {
    const e = entry();
    seed(e);

    render(<AcpModelStatCard entry={e} onSwitchModel={noopSwitch} />);
    fireEvent.pointerDown(screen.getByRole("button", { name: TRIGGER_NAME }), {
      button: 0,
      ctrlKey: false,
      pointerType: "mouse",
    });

    expect(screen.getByRole("menuitem", { name: /Sonnet/ })).toBeTruthy();
  });

  test("lists every option the adapter offers and checks the active one", () => {
    const e = entry();
    seed(e);

    render(
      <AcpModelStatCard entry={e} onSwitchModel={noopSwitch} defaultOpen />,
    );

    // Radix labels the menu from its trigger, so the surface is found by role.
    expect(screen.getByRole("menu")).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: /Opus/ })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: /Sonnet/ })).toBeTruthy();
    // The description rides along with the label so both surfaces show it.
    expect(
      screen.getByRole("menuitem", { name: /Opus/ }).textContent,
    ).toContain("Most capable");
    expect(screen.getByText("Applies from the next turn.")).toBeTruthy();
    // Only the selected row carries the check.
    expect(screen.getByRole("menuitem", { name: /Opus/ }).innerHTML).toContain(
      "--system-positive-strong",
    );
    expect(
      screen.getByRole("menuitem", { name: /Sonnet/ }).innerHTML,
    ).not.toContain("--system-positive-strong");
  });

  test("groups options under the names the adapter gave them", () => {
    const e = entry({
      availableModels: [
        { value: "opus", label: "Opus", group: "Claude" },
        { value: "gpt", label: "GPT", group: "OpenAI" },
      ],
    });
    seed(e);

    render(
      <AcpModelStatCard entry={e} onSwitchModel={noopSwitch} defaultOpen />,
    );

    expect(screen.getByText("Claude")).toBeTruthy();
    expect(screen.getByText("OpenAI")).toBeTruthy();
  });

  test("selecting an option switches optimistically, then reconciles", async () => {
    const e = entry();
    seed(e);
    const onSwitchModel = mock(async () => ({
      model: "sonnet",
      availableModels: [OPTIONS[1]!],
    }));

    render(
      <AcpModelStatCard entry={e} onSwitchModel={onSwitchModel} defaultOpen />,
    );
    fireEvent.click(screen.getByRole("menuitem", { name: /Sonnet/ }));

    expect(onSwitchModel).toHaveBeenCalledWith("acp-1", "sonnet");
    // Written before the round trip resolves.
    expect(storedModel()).toBe("sonnet");

    await act(async () => {});

    expect(
      useAcpRunStore.getState().byId["acp-1"]!.availableModels,
    ).toHaveLength(1);
  });

  test("re-selecting the active model asks the daemon for nothing", () => {
    const e = entry();
    seed(e);

    render(
      <AcpModelStatCard entry={e} onSwitchModel={noopSwitch} defaultOpen />,
    );
    fireEvent.click(screen.getByRole("menuitem", { name: /Opus/ }));

    expect(noopSwitch).not.toHaveBeenCalled();
  });

  test("restores the previous selection and toasts when the switch fails", async () => {
    const e = entry();
    seed(e);
    const onSwitchModel = mock(async () => {
      throw new Error("adapter refused");
    });
    const errorToast = spyOn(toast, "error");

    render(
      <AcpModelStatCard entry={e} onSwitchModel={onSwitchModel} defaultOpen />,
    );
    fireEvent.click(screen.getByRole("menuitem", { name: /Sonnet/ }));
    expect(storedModel()).toBe("sonnet");

    await act(async () => {});

    expect(storedModel()).toBe("opus");
    expect(useAcpRunStore.getState().byId["acp-1"]!.availableModels).toEqual(
      OPTIONS,
    );
    expect(errorToast).toHaveBeenCalledWith(
      "Could not switch the model. Please try again.",
    );
    errorToast.mockRestore();
  });

  test("renders nothing when the adapter offers no models", () => {
    const e = entry({ availableModels: [] });
    seed(e);

    const { container } = render(
      <AcpModelStatCard entry={e} onSwitchModel={noopSwitch} />,
    );

    expect(container.innerHTML).toBe("");
  });
});

describe("AcpModelStatCard on a touch surface", () => {
  beforeEach(() => {
    viewport.set({ narrow: true, coarsePointer: true });
  });

  test("offers the same options as a sheet", () => {
    const e = entry();
    seed(e);
    const onSwitchModel = mock(async () => ({
      model: "sonnet",
      availableModels: OPTIONS,
    }));

    render(
      <AcpModelStatCard entry={e} onSwitchModel={onSwitchModel} defaultOpen />,
    );

    expect(screen.getByRole("dialog", { name: "Choose model" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Sonnet/ }));

    expect(onSwitchModel).toHaveBeenCalledWith("acp-1", "sonnet");
  });
});

describe("AcpModelStatCard on a terminal run", () => {
  test("renders the static tile with no menu", () => {
    const e = entry({ status: "completed", completedAt: 1 });
    seed(e);

    render(<AcpModelStatCard entry={e} onSwitchModel={noopSwitch} />);

    expect(screen.getByText("Opus")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });
});

describe("AcpModelStatCard behind the compat gate", () => {
  test("renders nothing when the assistant predates model switching", () => {
    useAssistantIdentityStore.setState({ version: "0.1.0" });
    const e = entry();
    seed(e);

    const { container } = render(
      <AcpModelStatCard entry={e} onSwitchModel={noopSwitch} />,
    );

    expect(container.innerHTML).toBe("");
  });
});
