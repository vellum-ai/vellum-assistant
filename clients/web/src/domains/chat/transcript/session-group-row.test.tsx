import { useState } from "react";
import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { changeLocale } from "@/i18n";

import {
  SessionGroupContinuation,
  SessionGroupRow,
  type SessionGroupRowProps,
} from "./session-group-row";

const STARTED_AT = Date.UTC(2026, 8, 15, 14, 0);
const ENDED_AT = STARTED_AT + 125_000;
const OUT_OF_RANGE_TIMESTAMP = 8_640_000_000_000_001;

const COMPLETED_SUMMARY: SessionGroupRowProps["summary"] = {
  state: "completed",
  startedAt: STARTED_AT,
  endedAt: ENDED_AT,
};

afterEach(async () => {
  cleanup();
  await changeLocale("en");
});

function ControlledRow({
  initiallyOpen = false,
  ...props
}: Omit<SessionGroupRowProps, "open" | "onOpenChange"> & {
  initiallyOpen?: boolean;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  return <SessionGroupRow {...props} open={open} onOpenChange={setOpen} />;
}

describe("SessionGroupRow", () => {
  test.each([
    ["computerUse", "Computer session"],
    ["browser", "Browser session"],
    ["liveVision", "Live vision session"],
    ["ambient", "Ambient session"],
  ] as const)("renders the %s mode title", (mode, title) => {
    const { getByRole } = render(
      <ControlledRow mode={mode} summary={COMPLETED_SUMMARY}>
        <div>Child</div>
      </ControlledRow>,
    );

    expect(getByRole("button").textContent).toContain(title);
    expect(getByRole("button").textContent).toContain("2 min");
    expect(getByRole("button").textContent).not.toMatch(/steps|messages/i);
  });

  test.each([
    ["working", "Working"],
    ["waiting", "Waiting"],
    ["finishing", "Finishing"],
    ["interrupted", "Interrupted"],
    ["unavailable", "Timing unavailable"],
  ] as const)("renders the %s presentation summary", (state, label) => {
    const { getByRole } = render(
      <ControlledRow
        mode="computerUse"
        summary={{
          state,
          startedAt: STARTED_AT,
          lastActivityAt: ENDED_AT,
          now: ENDED_AT,
        }}
      >
        <div>Child</div>
      </ControlledRow>,
    );

    expect(getByRole("button").textContent).toContain(label);
  });

  test("toggles through a real disclosure button", () => {
    const { getByRole, getByText, queryByText } = render(
      <ControlledRow mode="browser" summary={COMPLETED_SUMMARY}>
        <div>Current children</div>
      </ControlledRow>,
    );
    const trigger = getByRole("button", { name: /Browser session/ });

    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(queryByText("Current children")).toBeNull();
    fireEvent.click(trigger);
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(getByText("Current children")).toBeTruthy();
  });

  test("opens from the keyboard through the native disclosure trigger", async () => {
    const user = userEvent.setup();
    const { getByRole, getByText, queryByText } = render(
      <ControlledRow mode="browser" summary={COMPLETED_SUMMARY}>
        <div>Keyboard child</div>
      </ControlledRow>,
    );
    const trigger = getByRole("button", { name: /Browser session/ });

    expect(queryByText("Keyboard child")).toBeNull();
    trigger.focus();
    await user.keyboard("{Enter}");
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(getByText("Keyboard child")).toBeTruthy();
  });

  test("shows last confirmed activity when interruption end is unknown", () => {
    const { getByRole, queryByTestId } = render(
      <ControlledRow
        mode="ambient"
        summary={{
          state: "interrupted",
          startedAt: STARTED_AT,
          lastActivityAt: ENDED_AT,
          endedAt: null,
        }}
      >
        <div>Cached child</div>
      </ControlledRow>,
    );
    const summaryText = getByRole("button").textContent ?? "";

    expect(summaryText).toContain("Interrupted");
    expect(summaryText).toContain("Last active");
    expect(summaryText).not.toContain("Ended");
    expect(queryByTestId("session-group-live-indicator")).toBeNull();
  });

  test("shows cached activity without a pulse after the connection is lost", () => {
    const { getByRole, queryByTestId } = render(
      <ControlledRow
        mode="browser"
        summary={{
          state: "disconnected",
          startedAt: STARTED_AT,
          lastActivityAt: ENDED_AT,
          now: ENDED_AT + 60_000,
        }}
      >
        <div>Cached child</div>
      </ControlledRow>,
    );
    const summaryText = getByRole("button").textContent ?? "";

    expect(summaryText).toContain("Connection lost");
    expect(summaryText).toContain("Last active");
    expect(summaryText).not.toContain("Working");
    expect(queryByTestId("session-group-live-indicator")).toBeNull();
  });

  test.each([
    [
      "completed end",
      {
        state: "completed",
        startedAt: STARTED_AT,
        endedAt: OUT_OF_RANGE_TIMESTAMP,
      },
      "Timing unavailable",
    ],
    [
      "interrupted activity",
      {
        state: "interrupted",
        startedAt: STARTED_AT,
        lastActivityAt: OUT_OF_RANGE_TIMESTAMP,
      },
      "Interrupted",
    ],
  ] as const)(
    "degrades an out-of-range %s timestamp",
    (_name, summary, fallback) => {
      const { getByRole } = render(
        <ControlledRow mode="ambient" summary={summary}>
          <div>Cached child</div>
        </ControlledRow>,
      );

      expect(getByRole("button").textContent).toContain(fallback);
    },
  );

  test("mounts only the latest children after closed header updates", () => {
    const onRender = mock((_label: string) => {});
    function ExpensiveChild({ label }: { label: string }) {
      onRender(label);
      return <div>{label}</div>;
    }

    const { getByText, queryByText, rerender } = render(
      <SessionGroupRow
        mode="computerUse"
        summary={{ state: "waiting", startedAt: STARTED_AT, now: ENDED_AT }}
        open={false}
        onOpenChange={() => {}}
      >
        <ExpensiveChild label="Earlier child" />
      </SessionGroupRow>,
    );
    expect(onRender).not.toHaveBeenCalled();

    rerender(
      <SessionGroupRow
        mode="computerUse"
        summary={{ state: "finishing", startedAt: STARTED_AT, now: ENDED_AT }}
        open={false}
        onOpenChange={() => {}}
      >
        <ExpensiveChild label="Latest child" />
      </SessionGroupRow>,
    );
    expect(onRender).not.toHaveBeenCalled();

    rerender(
      <SessionGroupRow
        mode="computerUse"
        summary={{ state: "finishing", startedAt: STARTED_AT, now: ENDED_AT }}
        open
        onOpenChange={() => {}}
      >
        <ExpensiveChild label="Latest child" />
      </SessionGroupRow>,
    );
    expect(queryByText("Earlier child")).toBeNull();
    expect(getByText("Latest child")).toBeTruthy();
    expect(onRender).toHaveBeenCalledWith("Latest child");
  });

  test("unmounts children when the shared disclosure finishes closing", () => {
    const { getByRole, getByTestId, queryByText } = render(
      <ControlledRow
        mode="computerUse"
        summary={COMPLETED_SUMMARY}
        initiallyOpen
      >
        <div>Exiting child</div>
      </ControlledRow>,
    );
    const trigger = getByRole("button");
    const content = getByTestId("session-group-content");

    fireEvent.click(trigger);
    expect(content.getAttribute("data-state")).toBe("closed");
    expect(queryByText("Exiting child")).toBeNull();
  });

  test("keeps the child subtree mounted when the header reveals", () => {
    const onMount = mock(() => {});
    function Child() {
      useState(() => {
        onMount();
        return null;
      });
      return <input aria-label="Stable field" />;
    }

    const props = {
      mode: "computerUse" as const,
      summary: {
        state: "working" as const,
        startedAt: STARTED_AT,
        now: ENDED_AT,
      },
      open: true,
      onOpenChange: () => {},
    };
    const { getByLabelText, getByTestId, rerender } = render(
      <SessionGroupRow {...props} headerVisible={false}>
        <Child />
      </SessionGroupRow>,
    );
    const field = getByLabelText("Stable field");
    expect(getByTestId("session-group-trigger").hasAttribute("disabled")).toBe(
      true,
    );

    rerender(
      <SessionGroupRow {...props} headerVisible>
        <Child />
      </SessionGroupRow>,
    );
    expect(getByLabelText("Stable field")).toBe(field);
    expect(onMount).toHaveBeenCalledTimes(1);
  });

  test("retains the caller's open choice when a live session completes", () => {
    const { getByRole, getByText, rerender } = render(
      <SessionGroupRow
        mode="liveVision"
        summary={{ state: "working", startedAt: STARTED_AT, now: ENDED_AT }}
        open
        onOpenChange={() => {}}
      >
        <div>Live child</div>
      </SessionGroupRow>,
    );
    const child = getByText("Live child");

    rerender(
      <SessionGroupRow
        mode="liveVision"
        summary={COMPLETED_SUMMARY}
        open
        onOpenChange={() => {}}
      >
        <div>Live child</div>
      </SessionGroupRow>,
    );

    expect(getByRole("button").getAttribute("aria-expanded")).toBe("true");
    expect(getByText("Live child")).toBe(child);
  });

  test("moves focus to the trigger before an externally controlled collapse", () => {
    const onOpenChange = () => {};
    const { getByLabelText, getByRole, rerender } = render(
      <SessionGroupRow
        mode="ambient"
        summary={COMPLETED_SUMMARY}
        open
        onOpenChange={onOpenChange}
      >
        <input aria-label="Focused child" />
      </SessionGroupRow>,
    );
    const field = getByLabelText("Focused child");
    const trigger = getByRole("button");
    field.focus();
    expect(document.activeElement).toBe(field);

    rerender(
      <SessionGroupRow
        mode="ambient"
        summary={COMPLETED_SUMMARY}
        open={false}
        onOpenChange={onOpenChange}
      >
        <input aria-label="Focused child" />
      </SessionGroupRow>,
    );
    expect(document.activeElement).toBe(trigger);
  });

  test("one disclosure controls both separated regions and unmounts the tail", () => {
    function SplitRow() {
      const [open, setOpen] = useState(true);
      return (
        <>
          <SessionGroupRow
            mode="liveVision"
            summary={COMPLETED_SUMMARY}
            open={open}
            onOpenChange={setOpen}
            continuationId="live-tail"
          >
            <div>Earlier exchange</div>
          </SessionGroupRow>
          <SessionGroupContinuation
            id="live-tail"
            mode="liveVision"
            open={open}
          >
            <input aria-label="Current exchange" />
          </SessionGroupContinuation>
          <div>Unowned prompt</div>
        </>
      );
    }

    const {
      getByRole,
      getAllByRole,
      getByLabelText,
      getByText,
      queryByLabelText,
    } = render(<SplitRow />);
    const trigger = getByRole("button", { name: /Live vision session/ });
    const regions = getAllByRole("region", { name: /Live vision session/ });
    expect(regions.map((region) => region.id)).toEqual([
      "live-tail-prefix",
      "live-tail",
    ]);
    expect(trigger.getAttribute("aria-controls")).toBe(
      "live-tail-prefix live-tail",
    );
    expect(getAllByRole("button")).toHaveLength(1);

    getByLabelText("Current exchange").focus();
    fireEvent.click(trigger);
    expect(document.activeElement).toBe(trigger);
    expect(queryByLabelText("Current exchange")).toBeNull();
    expect(getByText("Unowned prompt")).toBeTruthy();
    fireEvent.click(trigger);
    expect(getByLabelText("Current exchange")).toBeTruthy();
  });

  test.each([true, false])(
    "external collapse returns tail focus only when it owns focus (%s)",
    (focusTail) => {
      function SplitRow({ open }: { open: boolean }) {
        return (
          <>
            <SessionGroupRow
              mode="liveVision"
              summary={COMPLETED_SUMMARY}
              open={open}
              onOpenChange={() => {}}
              continuationId="controlled-tail"
            >
              <div>Earlier exchange</div>
            </SessionGroupRow>
            <SessionGroupContinuation
              id="controlled-tail"
              mode="liveVision"
              open={open}
            >
              <input aria-label="Tail field" />
            </SessionGroupContinuation>
            <input aria-label="Outside field" />
          </>
        );
      }

      const { getByRole, getByLabelText, queryByLabelText, rerender } = render(
        <SplitRow open />,
      );
      const trigger = getByRole("button");
      getByLabelText("Tail field").focus();
      if (!focusTail) {
        getByLabelText("Outside field").focus();
      }

      rerender(<SplitRow open={false} />);
      expect(queryByLabelText("Tail field")).toBeNull();
      expect(document.activeElement).toBe(
        focusTail ? trigger : getByLabelText("Outside field"),
      );
    },
  );

  test("uses the shared exit motion and reduced-motion escape hatch", () => {
    const { getByTestId } = render(
      <SessionGroupRow
        mode="browser"
        summary={COMPLETED_SUMMARY}
        open
        onOpenChange={() => {}}
      >
        <div>Child</div>
      </SessionGroupRow>,
    );

    const content = getByTestId("session-group-content");
    expect(content.className).toContain("collapsible-content");
    expect(content.className).toContain("motion-reduce:animate-none");
    expect(content.style.animationDuration).toBe("var(--anim-standard)");
  });

  test("renders frames-only children only while open", () => {
    const { getByRole, queryByAltText } = render(
      <ControlledRow mode="liveVision" summary={COMPLETED_SUMMARY}>
        <img
          alt="Recorded frame"
          src="data:image/gif;base64,R0lGODlhAQABAAAAACw="
        />
      </ControlledRow>,
    );
    expect(queryByAltText("Recorded frame")).toBeNull();
    fireEvent.click(getByRole("button"));
    expect(queryByAltText("Recorded frame")).toBeTruthy();
  });

  test("reacts to locale changes for title and time-only summary", async () => {
    const { getByRole } = render(
      <ControlledRow mode="browser" summary={COMPLETED_SUMMARY}>
        <div>Child</div>
      </ControlledRow>,
    );
    expect(getByRole("button").textContent).toContain("Browser session");

    await act(async () => {
      await changeLocale("es");
    });
    await waitFor(() => {
      expect(getByRole("button").textContent).toContain("Sesión del navegador");
    });
    expect(getByRole("button").textContent).toContain("Finalizó");
  });
});
