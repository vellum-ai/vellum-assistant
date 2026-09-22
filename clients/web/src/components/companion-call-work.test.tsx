import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, mock, test } from "bun:test";

import type {
  VoiceActivityState,
  VoiceActivityWork,
} from "@vellumai/ipc-contract";

import { CompanionSurface } from "@/components/companion-surface";

afterEach(() => {
  cleanup();
});

const CALL: VoiceActivityState = {
  phase: "thinking",
  label: "Working on that…",
  accentHex: "#5eead4",
  muted: false,
  outputMuted: false,
  detail: "Searching the web",
  approvalRequestId: "",
  assistantName: "Ziggy",
};

const TURN: VoiceActivityWork = {
  id: "turn",
  kind: "turn",
  title: "Ziggy",
  step: "Searching the web",
  state: "running",
  startedAt: 1_000,
};

const FLIGHTS: VoiceActivityWork = {
  id: "sub-1",
  kind: "subagent",
  title: "Flights to Lisbon",
  step: "Reading a page",
  state: "running",
  startedAt: 1_000,
};

const lineOf = (container: HTMLElement): string | null =>
  container.querySelector('[data-label="line"]')?.textContent ?? null;

const lineElementOf = (container: HTMLElement): HTMLElement | null =>
  container.querySelector<HTMLElement>('[data-label="line"]');

const chipOf = (container: HTMLElement): HTMLButtonElement | null =>
  container.querySelector<HTMLButtonElement>('button[data-control="work"]');

const shelfOf = (container: HTMLElement): HTMLElement | null =>
  container.querySelector<HTMLElement>("[data-companion-work-shelf]");

const renderCall = (call: VoiceActivityState, prompt?: React.ReactNode) =>
  render(
    <CompanionSurface
      phase="call"
      call={call}
      assistantName="Ziggy"
      accentHex="#5eead4"
      prompt={prompt}
    />,
  );

describe("the call's work on its bar", () => {
  test("a session without a work list keeps its step on the line", () => {
    const { container } = renderCall(CALL);
    expect(lineOf(container)).toBe("Searching the web");
    expect(chipOf(container)).toBeNull();
  });

  test("a session with a work list reads its phase, and counts the work", () => {
    const { container } = renderCall({ ...CALL, work: [TURN, FLIGHTS] });
    expect(lineOf(container)).toBe("Working on that…");
    const chip = chipOf(container);
    expect(chip?.textContent).toContain("2");
    expect(chip?.getAttribute("aria-label")).toBe("2 things running");
    expect(chip?.nextElementSibling?.getAttribute("data-label")).toBe("line");
  });

  test("takes the indicator's width out of the status line", () => {
    const { container: plain } = renderCall(CALL);
    const { container: working } = renderCall({
      ...CALL,
      work: [TURN, FLIGHTS],
    });
    const chipWidth = parseFloat(chipOf(working)?.style.width ?? "0");
    const plainLineWidth = parseFloat(lineElementOf(plain)?.style.width ?? "0");
    const workingLineWidth = parseFloat(
      lineElementOf(working)?.style.width ?? "0",
    );

    expect(chipWidth).toBeGreaterThan(0);
    expect(workingLineWidth + chipWidth).toBe(plainLineWidth);
  });

  test("an empty list draws no count", () => {
    const { container } = renderCall({ ...CALL, work: [] });
    expect(chipOf(container)).toBeNull();
  });

  test("counts only what is still running", () => {
    const { container } = renderCall({
      ...CALL,
      work: [{ ...FLIGHTS, state: "done" }, TURN],
    });
    expect(chipOf(container)?.getAttribute("aria-label")).toBe(
      "1 thing running",
    );
  });

  test("a press opens the list joined to the bar, and a second closes it", () => {
    const { container } = renderCall({ ...CALL, work: [TURN, FLIGHTS] });
    const chip = chipOf(container)!;
    expect(shelfOf(container)).toBeNull();
    expect(chip.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(chip);
    const shelf = shelfOf(container);
    expect(shelf?.textContent).toContain("Flights to Lisbon");
    expect(shelf?.textContent).toContain("Reading a page");
    expect(shelf?.textContent).toContain("Ziggy");
    expect(chip.getAttribute("aria-expanded")).toBe("true");
    expect(
      container.querySelector("[data-shelf-side] .companion-working-ring"),
    ).toBeNull();

    fireEvent.click(chip);
    expect(shelfOf(container)).toBeNull();
  });

  test("a finished piece of work reads as done on the list", () => {
    const { container } = renderCall({
      ...CALL,
      work: [TURN, { ...FLIGHTS, state: "done" }],
    });
    fireEvent.click(chipOf(container)!);
    expect(shelfOf(container)?.textContent).toContain("Done");
  });

  test("a prompt waiting on the user outranks the list", () => {
    const { container } = renderCall(
      { ...CALL, work: [TURN, FLIGHTS] },
      <div data-testid="approval">Approve?</div>,
    );
    fireEvent.click(chipOf(container)!);
    expect(shelfOf(container)).toBeNull();
    expect(container.querySelector('[data-testid="approval"]')).not.toBeNull();
    expect(chipOf(container)?.getAttribute("aria-expanded")).toBe("false");
  });

  test("the list closes when the work runs out, and stays closed after", () => {
    const { container, rerender } = renderCall({
      ...CALL,
      work: [FLIGHTS],
    });
    fireEvent.click(chipOf(container)!);
    expect(shelfOf(container)).not.toBeNull();

    const rerenderCall = (call: VoiceActivityState) => {
      rerender(
        <CompanionSurface
          phase="call"
          call={call}
          assistantName="Ziggy"
          accentHex="#5eead4"
        />,
      );
    };
    rerenderCall({ ...CALL, work: [] });
    expect(shelfOf(container)).toBeNull();
    rerenderCall({ ...CALL, work: [FLIGHTS] });
    expect(shelfOf(container)).toBeNull();
  });

  test("tells the host when the list opens and closes", () => {
    const onWorkShelfChange = mock((_shown: boolean) => undefined);
    const { container } = render(
      <CompanionSurface
        phase="call"
        call={{ ...CALL, work: [FLIGHTS] }}
        assistantName="Ziggy"
        accentHex="#5eead4"
        onWorkShelfChange={onWorkShelfChange}
      />,
    );
    expect(onWorkShelfChange.mock.calls.at(-1)?.[0]).toBe(false);
    fireEvent.click(chipOf(container)!);
    expect(onWorkShelfChange.mock.calls.at(-1)?.[0]).toBe(true);
    fireEvent.click(chipOf(container)!);
    expect(onWorkShelfChange.mock.calls.at(-1)?.[0]).toBe(false);
  });

  test("counts work waiting on the user apart, without a spinner", () => {
    const { container } = renderCall({
      ...CALL,
      work: [{ ...FLIGHTS, state: "waiting" }],
    });
    const chip = chipOf(container)!;
    expect(chip.getAttribute("aria-label")).toBe("1 waiting on you");
    expect(chip.querySelector(".companion-work-spin")).toBeNull();
    fireEvent.click(chip);
    expect(shelfOf(container)?.textContent).toContain("Waiting on you");
  });

  test("counts only the running work while some is also waiting", () => {
    const { container } = renderCall({
      ...CALL,
      work: [TURN, { ...FLIGHTS, state: "waiting" }],
    });
    expect(chipOf(container)?.getAttribute("aria-label")).toBe(
      "1 thing running",
    );
  });

  test("docked to a side, a press opens the list beside the column", () => {
    for (const [dock, side] of [
      ["right", "left"],
      ["left", "right"],
    ] as const) {
      const { container, unmount } = render(
        <CompanionSurface
          phase="call"
          call={{ ...CALL, work: [TURN, FLIGHTS] }}
          assistantName="Ziggy"
          accentHex="#5eead4"
          dock={dock}
        />,
      );
      fireEvent.click(chipOf(container)!);
      expect(shelfOf(container)).not.toBeNull();
      expect(
        container
          .querySelector("[data-shelf-side]")
          ?.getAttribute("data-shelf-side"),
      ).toBe(side);
      unmount();
    }
  });

  test("docked to a side, the host's prompt stays off the column", () => {
    const { container } = render(
      <CompanionSurface
        phase="call"
        call={{ ...CALL, work: [TURN] }}
        assistantName="Ziggy"
        accentHex="#5eead4"
        dock="left"
        prompt={<div data-testid="approval">Approve?</div>}
      />,
    );
    expect(container.querySelector('[data-testid="approval"]')).toBeNull();
    fireEvent.click(chipOf(container)!);
    expect(shelfOf(container)).not.toBeNull();
  });
});
