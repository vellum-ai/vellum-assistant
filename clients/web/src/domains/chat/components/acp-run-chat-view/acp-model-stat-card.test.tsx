/**
 * Tests for the MODEL tile in the ACP run detail panel.
 *
 * The surface is resolved inside the design library from a media query, so
 * these drive the viewport axes rather than stubbing a hook: a stubbed hook
 * would pass while the real primitive read something else. The switch action
 * arrives as a prop, so nothing here pulls in the daemon client.
 *
 * Whether the tile renders at all is the panel's decision, so the gate's cases
 * live in `acp-run-chat-view.test.tsx` beside the grid they size.
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
import { ApiError } from "@/utils/api-errors";

import { AcpModelStatCard } from "./acp-model-stat-card";

const OPTIONS: AcpModelOption[] = [
  { value: "opus", label: "Opus", description: "Most capable" },
  { value: "sonnet", label: "Sonnet" },
];

const TRIGGER_NAME = "Model: Opus. Change model";
const PENDING_TRIGGER_NAME = "Model: Sonnet. Change model";

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
function seed(...entries: AcpRunEntry[]) {
  useAcpRunStore.setState({
    byId: Object.fromEntries(entries.map((e) => [e.acpSessionId, e])),
    orderedIds: entries.map((e) => e.acpSessionId),
    byToolUseId: new Map<string, string>(),
    highWaterMark: new Map<string, number>(),
  });
}

function storedModel(acpSessionId = "acp-1"): string | undefined {
  return useAcpRunStore.getState().byId[acpSessionId]?.model;
}

/** What the named trigger tells the assistive layer about taking a choice. */
function ariaDisabled(name: string): string | null {
  return screen.getByRole("button", { name }).getAttribute("aria-disabled");
}

/** A switch whose answer the test hands back when it chooses to. */
function deferredSwitch() {
  let settle!: (result: {
    model: string;
    availableModels: AcpModelOption[];
  }) => void;
  const pending = new Promise<{
    model: string;
    availableModels: AcpModelOption[];
  }>((resolve) => {
    settle = resolve;
  });
  return { onSwitchModel: mock(async () => pending), settle };
}

const noopSwitch = mock(async () => ({
  model: "opus",
  availableModels: OPTIONS,
}));

beforeEach(() => {
  viewport.set({ narrow: false, coarsePointer: false });
  noopSwitch.mockClear();
});

afterEach(() => {
  cleanup();
  viewport.restore();
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

  test("lists every option the adapter offers and names the active one", () => {
    const e = entry();
    seed(e);

    render(
      <AcpModelStatCard entry={e} onSwitchModel={noopSwitch} defaultOpen />,
    );

    // Radix labels the menu from its trigger, so the surface is found by role.
    expect(screen.getByRole("menu")).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: /Sonnet/ })).toBeTruthy();
    // The check is decorative, so the selected row says so in its name rather
    // than in a colour only a sighted user can read.
    expect(
      screen.getByRole("menuitem", { name: "Opus Selected" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("menuitem", { name: /Sonnet Selected/ }),
    ).toBeNull();
    expect(screen.getByText("Applies from the next turn.")).toBeTruthy();
  });

  // An adapter can offer a list and name no current value. The row says which
  // model that leaves the run on rather than rendering empty.
  test("names the agent's own default when the adapter reports no model", () => {
    const e = entry({ model: undefined });
    seed(e);

    render(<AcpModelStatCard entry={e} onSwitchModel={noopSwitch} />);

    const trigger = screen.getByRole("button", {
      name: "Model: agent default. Change model",
    });
    expect(trigger.textContent).toContain("Agent default");
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

  test("shows the choice as pending and writes the store from the response", async () => {
    const e = entry();
    seed(e);
    const { onSwitchModel, settle } = deferredSwitch();

    render(
      <AcpModelStatCard entry={e} onSwitchModel={onSwitchModel} defaultOpen />,
    );
    fireEvent.click(screen.getByRole("menuitem", { name: /Sonnet/ }));

    expect(onSwitchModel).toHaveBeenCalledWith("acp-1", "sonnet");
    // The tile reads the choice; the store still holds what the daemon last
    // confirmed, so a snapshot landing now cannot roll the tile back.
    expect(
      screen.getByRole("button", { name: PENDING_TRIGGER_NAME }).textContent,
    ).toContain("Sonnet");
    expect(storedModel()).toBe("opus");

    await act(async () => {
      settle({ model: "sonnet", availableModels: [OPTIONS[1]!] });
    });

    expect(storedModel()).toBe("sonnet");
    expect(
      useAcpRunStore.getState().byId["acp-1"]!.availableModels,
    ).toHaveLength(1);
  });

  test("takes the tile out of play while a switch is in flight", async () => {
    const e = entry();
    seed(e);
    const { onSwitchModel, settle } = deferredSwitch();

    render(
      <AcpModelStatCard entry={e} onSwitchModel={onSwitchModel} defaultOpen />,
    );
    fireEvent.click(screen.getByRole("menuitem", { name: /Sonnet/ }));

    expect(ariaDisabled(PENDING_TRIGGER_NAME)).toBe("true");
    expect(
      screen
        .getByRole("button", { name: PENDING_TRIGGER_NAME })
        .getAttribute("data-pending"),
    ).toBe("");

    await act(async () => {
      settle({ model: "sonnet", availableModels: OPTIONS });
    });

    // The answer landed, so the tile is live again. It reads the run it was
    // given, which the panel re-renders from the store.
    expect(ariaDisabled(TRIGGER_NAME)).toBeNull();
    expect(onSwitchModel).toHaveBeenCalledTimes(1);
  });

  // The menu closes in the same commit the switch starts. A trigger that went
  // natively `disabled` there could not take Radix's focus return, so keyboard
  // focus would sit on the body until the daemon answered.
  test("keeps keyboard focus on the tile across a pending switch", async () => {
    const e = entry();
    seed(e);
    const { onSwitchModel, settle } = deferredSwitch();

    // Opened from the trigger rather than `defaultOpen`, since the focus the
    // menu returns is the focus it was opened from.
    render(<AcpModelStatCard entry={e} onSwitchModel={onSwitchModel} />);
    const trigger = screen.getByRole("button", { name: TRIGGER_NAME });
    trigger.focus();
    fireEvent.pointerDown(trigger, {
      button: 0,
      ctrlKey: false,
      pointerType: "mouse",
    });
    fireEvent.click(screen.getByRole("menuitem", { name: /Sonnet/ }));
    // Radix hands focus back from a timeout after the surface unmounts.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const pending = screen.getByRole("button", {
      name: PENDING_TRIGGER_NAME,
    }) as HTMLButtonElement;
    expect(pending.disabled).toBe(false);
    expect(document.activeElement).toBe(pending);

    await act(async () => {
      settle({ model: "sonnet", availableModels: OPTIONS });
    });

    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: TRIGGER_NAME }),
    );
  });

  test("ignores the answer to a switch the panel has already moved off", async () => {
    const first = entry();
    const second = entry({ acpSessionId: "acp-2", model: "opus" });
    seed(first, second);
    const { onSwitchModel, settle } = deferredSwitch();

    const { rerender } = render(
      <AcpModelStatCard
        entry={first}
        onSwitchModel={onSwitchModel}
        defaultOpen
      />,
    );
    fireEvent.click(screen.getByRole("menuitem", { name: /Sonnet/ }));

    rerender(<AcpModelStatCard entry={second} onSwitchModel={onSwitchModel} />);
    await act(async () => {
      settle({ model: "sonnet", availableModels: OPTIONS });
    });

    // The tile belongs to another run now: it is neither waiting nor writing
    // the answer to a question that run never asked.
    expect(storedModel("acp-1")).toBe("opus");
    expect(ariaDisabled(TRIGGER_NAME)).toBeNull();
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

  test("leaves the stored model alone and toasts when the switch fails", async () => {
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

    await act(async () => {});

    expect(storedModel()).toBe("opus");
    expect(useAcpRunStore.getState().byId["acp-1"]!.availableModels).toEqual(
      OPTIONS,
    );
    expect(errorToast).toHaveBeenCalledWith(
      "Could not switch the model. Please try again.",
    );
    expect(ariaDisabled(TRIGGER_NAME)).toBeNull();
    errorToast.mockRestore();
  });

  // 409 is the daemon's answer when the adapter dropped its model selector
  // mid-run. Retrying cannot fix that, so the user reads why.
  test("toasts the daemon's own words when it refuses the switch", async () => {
    const e = entry();
    seed(e);
    const onSwitchModel = mock(async () => {
      throw new ApiError(409, "This session no longer offers a model choice.");
    });
    const errorToast = spyOn(toast, "error");

    render(
      <AcpModelStatCard entry={e} onSwitchModel={onSwitchModel} defaultOpen />,
    );
    fireEvent.click(screen.getByRole("menuitem", { name: /Sonnet/ }));

    await act(async () => {});

    expect(errorToast).toHaveBeenCalledWith(
      "This session no longer offers a model choice.",
    );
    errorToast.mockRestore();
  });
});

describe("AcpModelStatCard on a touch surface", () => {
  beforeEach(() => {
    viewport.set({ narrow: true, coarsePointer: true });
  });

  test("offers the same options as a sheet, descriptions included", () => {
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
    // The sheet row has room for the supporting line, and the command still
    // names the row on its own.
    expect(screen.getByText("Most capable")).toBeTruthy();
    // The check lives in the anchored menu's trailing column, which the sheet
    // has none of, so the selected state rides the row's name in both.
    expect(screen.getByRole("button", { name: /Opus Selected/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Sonnet" }));

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

  // History carries the raw value the adapter reported and no option list, so
  // the tile shows the id rather than a label it has no way to resolve.
  test("shows the raw model id when there is no list to name it", () => {
    const e = entry({
      status: "completed",
      completedAt: 1,
      model: "claude-opus-4-1-20250805",
      availableModels: undefined,
    });
    seed(e);

    render(<AcpModelStatCard entry={e} onSwitchModel={noopSwitch} />);

    expect(screen.getByText("claude-opus-4-1-20250805")).toBeTruthy();
  });
});
