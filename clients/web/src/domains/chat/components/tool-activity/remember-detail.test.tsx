/**
 * Tests for the `remember` body: the facts, under a label that says whether
 * they were saved, and why not when they were not.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";

import { RememberDetail } from "@/domains/chat/components/tool-activity/remember-detail";
import type { ToolDetailPayload } from "@/stores/viewer-store";

afterEach(cleanup);

const detail: ToolDetailPayload = {
  toolCallId: "tc-remember",
  toolName: "remember",
  title: "Remembering",
  activity: "Saving travel preferences",
  input: { content: [" Prefers window seats. ", "", "Flies out of SFO."] },
  status: "completed",
};

type Props = Parameters<typeof RememberDetail>[0];

function renderRemember(overrides: Partial<Props> = {}) {
  return render(
    <RememberDetail
      detail={detail}
      result="Saved 2 facts to knowledge base."
      activityMetadata={{
        remember: { facts: ["Prefers window seats.", "Flies out of SFO."] },
      }}
      streamedOutput={undefined}
      isRunning={false}
      isError={false}
      isDenied={false}
      {...overrides}
    />,
  );
}

function facts(container: HTMLElement): string[] {
  return [...container.querySelectorAll("li")].map((li) => li.textContent!);
}

describe("RememberDetail", () => {
  test("lists the facts saved under Saved, without repeating the confirmation", () => {
    const { container, getByText, queryByText } = renderRemember();

    expect(getByText("Saved")).toBeDefined();
    expect(facts(container)).toEqual([
      "Prefers window seats.",
      "Flies out of SFO.",
    ]);
    expect(queryByText("Saved 2 facts to knowledge base.")).toBeNull();
  });

  test("shows the list as saved once the result reports it, over the input", () => {
    const { container } = renderRemember({
      activityMetadata: { remember: { facts: ["Prefers window seats."] } },
    });

    expect(facts(container)).toEqual(["Prefers window seats."]);
  });

  test("reads the facts from the input while saving, blanks dropped", () => {
    const { container, getByText } = renderRemember({
      activityMetadata: undefined,
      result: undefined,
      isRunning: true,
    });

    expect(getByText("Saving")).toBeDefined();
    expect(facts(container)).toEqual([
      "Prefers window seats.",
      "Flies out of SFO.",
    ]);
  });

  test("says why nothing was saved when the save failed", () => {
    const { getByText } = renderRemember({
      activityMetadata: undefined,
      result: "Memory is disabled.",
      isError: true,
    });

    expect(getByText("Not saved")).toBeDefined();
    expect(getByText("Memory is disabled.")).toBeDefined();
  });

  test("says a refused save did not run", () => {
    const { getByText, getByTestId } = renderRemember({
      activityMetadata: undefined,
      result: "Permission denied.",
      isDenied: true,
    });

    expect(getByText("Not saved")).toBeDefined();
    expect(getByTestId("tool-output-notice").textContent).toBe(
      "This tool call was not approved, so it did not run.",
    );
  });
});
