/**
 * What the row does with a click, and which of its bodies each status earns.
 *
 * The launch paths are the load-bearing part: the chip sends the catalog
 * prompt and the Custom field sends what was typed, and the row must not be
 * able to confuse the two.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";

import { getActivationList } from "@/domains/activation/catalog";
import {
  doneTaskProgress,
  doneWithArtifactProgress,
  startedTaskProgress,
} from "@/domains/activation/activation-test-fixtures";
import { ActivationTaskRow } from "@/domains/activation/components/activation-task-row";

// Captured by value before anything mocks the module: a module namespace's
// bindings are live, so reading it back afterwards would hand out the mock.
const { isElectron: realIsElectron } = await import("@/runtime/is-electron");

const { starters, items } = getActivationList("smb");
const TASK = starters[0]!;
const LINKED_TASK = items.find((task) => task.id === "try-computer-use")!;

afterEach(() => {
  cleanup();
});

describe("ActivationTaskRow", () => {
  test("a todo row opens and closes rather than navigating", () => {
    let toggles = 0;
    const { getByRole } = render(
      <ActivationTaskRow
        task={TASK}
        expanded={false}
        onToggle={() => {
          toggles += 1;
        }}
      />,
    );
    fireEvent.click(getByRole("button"));
    expect(toggles).toBe(1);
  });

  test("the chip launches the task with the catalog prompt", () => {
    const launched: (string | undefined)[] = [];
    const { getByText } = render(
      <ActivationTaskRow
        task={TASK}
        expanded
        onLaunch={(override) => launched.push(override)}
      />,
    );
    fireEvent.click(getByText(TASK.chip));
    expect(launched).toEqual([undefined]);
  });

  test("the Custom field launches with what was typed", () => {
    const launched: (string | undefined)[] = [];
    const { getByRole, getByLabelText } = render(
      <ActivationTaskRow
        task={TASK}
        expanded
        onLaunch={(override) => launched.push(override)}
      />,
    );
    const field = getByLabelText("Custom:") as HTMLInputElement;
    fireEvent.change(field, { target: { value: "  quote for Acme  " } });
    fireEvent.click(getByRole("button", { name: "Send" }));
    expect(launched).toEqual(["quote for Acme"]);
  });

  test("Enter in the Custom field submits it", () => {
    const launched: (string | undefined)[] = [];
    const { getByLabelText } = render(
      <ActivationTaskRow
        task={TASK}
        expanded
        onLaunch={(override) => launched.push(override)}
      />,
    );
    const field = getByLabelText("Custom:");
    fireEvent.change(field, { target: { value: "quote for Acme" } });
    fireEvent.keyDown(field, { key: "Enter" });
    expect(launched).toEqual(["quote for Acme"]);
  });

  test("the send button stays disabled until something is typed", () => {
    const { getByRole, getByLabelText } = render(
      <ActivationTaskRow task={TASK} expanded />,
    );
    const send = getByRole("button", { name: "Send" }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.change(getByLabelText("Custom:"), { target: { value: "x" } });
    expect(send.disabled).toBe(false);
  });

  test("whitespace alone does not enable the send button", () => {
    const { getByRole, getByLabelText } = render(
      <ActivationTaskRow task={TASK} expanded />,
    );
    fireEvent.change(getByLabelText("Custom:"), { target: { value: "   " } });
    expect(
      (getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  test("a working row shows its step count and cannot be opened", () => {
    let toggles = 0;
    const { getByText, queryByLabelText, getByRole } = render(
      <ActivationTaskRow
        task={TASK}
        expanded
        progress={startedTaskProgress()}
        onToggle={() => {
          toggles += 1;
        }}
        onOpenConversation={() => {}}
      />,
    );
    expect(getByText("Working")).not.toBeNull();
    expect(getByText("6 steps")).not.toBeNull();
    expect(queryByLabelText("Custom:")).toBeNull();
    fireEvent.click(getByRole("button", { name: `Open ${TASK.title}` }));
    expect(toggles).toBe(0);
  });

  test("clicking a launched row opens its conversation", () => {
    const opened: string[] = [];
    const { getByRole } = render(
      <ActivationTaskRow
        task={TASK}
        progress={doneTaskProgress()}
        onOpenConversation={(conversationId) => opened.push(conversationId)}
      />,
    );
    fireEvent.click(getByRole("button", { name: `Open ${TASK.title}` }));
    expect(opened).toEqual(["conv-done-2"]);
  });

  test("a finished task with a file hands the file back instead of a pill", () => {
    const { getByText, queryByText } = render(
      <ActivationTaskRow
        task={TASK}
        progress={doneWithArtifactProgress()}
        assistantId="asst-1"
      />,
    );
    expect(getByText("proposal-aug2026.pdf")).not.toBeNull();
    expect(queryByText("Done")).toBeNull();
  });

  test("a finished task with nothing to show says how it went", () => {
    const { getByText } = render(
      <ActivationTaskRow task={TASK} progress={doneTaskProgress()} />,
    );
    expect(getByText("Done")).not.toBeNull();
    expect(getByText("4 steps")).not.toBeNull();
  });

  // A turn that called no tools has no count worth reporting, and "0 steps"
  // reads as if nothing happened.
  test("a task that used no tools says only how it ended", () => {
    const { getByText, queryByText } = render(
      <ActivationTaskRow
        task={TASK}
        progress={doneTaskProgress({ stepCount: 0 })}
      />,
    );
    expect(getByText("Done")).not.toBeNull();
    expect(queryByText("0 steps")).toBeNull();
  });

  test("a working row with no tool calls yet shows no count", () => {
    const { getByText, queryByText } = render(
      <ActivationTaskRow
        task={TASK}
        progress={startedTaskProgress({ stepCount: 0 })}
        onOpenConversation={() => {}}
      />,
    );
    expect(getByText("Working")).not.toBeNull();
    expect(queryByText("0 steps")).toBeNull();
  });

  test("an expanded task with a link renders its call to action", () => {
    const { getByText } = render(
      <ActivationTaskRow task={LINKED_TASK} expanded />,
    );
    const anchor = getByText(LINKED_TASK.link!.label).closest("a");
    expect(anchor?.getAttribute("href")).toBe(LINKED_TASK.link!.url);
    expect(anchor?.getAttribute("target")).toBe("_blank");
  });

  test("a task without a link renders no call to action", () => {
    const { container } = render(<ActivationTaskRow task={TASK} expanded />);
    expect(container.querySelector("a")).toBeNull();
  });

  test("a pending row locks its own controls", () => {
    const { getByRole } = render(
      <ActivationTaskRow task={TASK} expanded pending onLaunch={() => {}} />,
    );
    expect(
      (getByRole("button", { name: TASK.chip }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  test("the desktop app drops the call to action: it already is the download", async () => {
    // `mock.module` replaces the module for every test file sharing this
    // process and `mock.restore` does not undo it, so the real one is put back
    // by hand rather than left to leak into whatever runs next.
    mock.module("@/runtime/is-electron", () => ({ isElectron: () => true }));
    try {
      const { ActivationTaskRow: DesktopRow } =
        await import("@/domains/activation/components/activation-task-row");
      const { container } = render(<DesktopRow task={LINKED_TASK} expanded />);
      expect(container.querySelector("a")).toBeNull();
    } finally {
      mock.module("@/runtime/is-electron", () => ({
        isElectron: realIsElectron,
      }));
    }
  });
});

/**
 * The Inspiration List draws the same row without an accordion: a click is the
 * launch, the call to action shows on a row nobody has opened, and a launch
 * still out reads as Working because there is no open body to lock instead.
 */
describe("ActivationTaskRow on the list surface", () => {
  test("clicking an untouched row launches it", () => {
    const launched: (string | undefined)[] = [];
    let toggles = 0;
    const { getByRole } = render(
      <ActivationTaskRow
        task={TASK}
        surface="list"
        onLaunch={(override) => launched.push(override)}
        onToggle={() => {
          toggles += 1;
        }}
      />,
    );
    fireEvent.click(getByRole("button"));
    expect(launched).toEqual([undefined]);
    expect(toggles).toBe(0);
  });

  test("an unopened row still offers the task's call to action", () => {
    const { getByText } = render(
      <ActivationTaskRow task={LINKED_TASK} surface="list" />,
    );
    expect(
      getByText(LINKED_TASK.link!.label).closest("a")?.getAttribute("href"),
    ).toBe(LINKED_TASK.link!.url);
  });

  test("a launch in flight reads as working and cannot be fired again", () => {
    const launched: (string | undefined)[] = [];
    const { getByRole, getByText } = render(
      <ActivationTaskRow
        task={TASK}
        surface="list"
        pending
        onLaunch={(override) => launched.push(override)}
      />,
    );
    expect(getByText("Working")).not.toBeNull();
    fireEvent.click(getByRole("button"));
    expect(launched).toEqual([]);
  });

  test("neither the chip nor the Custom field belongs here", () => {
    const { queryByLabelText, queryByText } = render(
      <ActivationTaskRow task={TASK} surface="list" expanded />,
    );
    expect(queryByLabelText("Custom:")).toBeNull();
    expect(queryByText(TASK.chip)).toBeNull();
  });
});
