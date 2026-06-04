import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

mock.module("@/domains/chat/components/chat-markdown-message", () => ({
  ChatMarkdownMessage: ({ content }: { content: string }) => (
    <div>{content}</div>
  ),
}));

import { ChoiceSurface } from "@/domains/chat/components/surfaces/choice-surface";
import { CopyBlockSurface } from "@/domains/chat/components/surfaces/copy-block-surface";
import { SurfaceRouter } from "@/domains/chat/components/surfaces/surface-router";
import type { Surface } from "@/domains/chat/types/types";

afterAll(() => {
  mock.restore();
});

afterEach(() => {
  cleanup();
});

function makeSurface(overrides: Partial<Surface>): Surface {
  return {
    surfaceId: "surface-1",
    surfaceType: "choice",
    data: {},
    ...overrides,
  };
}

describe("ChoiceSurface", () => {
  test("highlights recommended options and commits single-select choices on click", () => {
    const onAction = mock(() => {});
    const { getByRole, getByText } = render(
      <ChoiceSurface
        surface={makeSurface({
          title: "Pick an outcome",
          data: {
            description: "Choose the best next move.",
            options: [
              {
                id: "inbox",
                title: "Clean up my inbox",
                description: "Archive noise and surface the important threads.",
                recommended: true,
                data: { outcome: "inbox_cleanup" },
              },
              { id: "calendar", title: "Plan my week" },
            ],
          },
        })}
        onAction={onAction}
      />,
    );

    expect(getByText("Recommended")).toBeTruthy();

    fireEvent.click(getByRole("button", { name: /clean up my inbox/i }));

    expect(onAction).toHaveBeenCalledWith("surface-1", "inbox", {
      choiceId: "inbox",
      choiceTitle: "Clean up my inbox",
      selectedIds: ["inbox"],
      selectedTitles: ["Clean up my inbox"],
      choiceDescription: "Archive noise and surface the important threads.",
      recommended: true,
      outcome: "inbox_cleanup",
    });
  });

  test("multi-select choices require an explicit submit action", () => {
    const onAction = mock(() => {});
    const { getByRole } = render(
      <ChoiceSurface
        surface={makeSurface({
          data: {
            selectionMode: "multiple",
            submitLabel: "Run these",
            options: [
              { id: "inbox", title: "Clean up my inbox" },
              { id: "calendar", title: "Plan my week" },
            ],
          },
        })}
        onAction={onAction}
      />,
    );

    const submit = getByRole("button", { name: /run these/i });
    expect((submit as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(getByRole("button", { name: /clean up my inbox/i }));
    fireEvent.click(getByRole("button", { name: /plan my week/i }));
    expect((submit as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(submit);

    expect(onAction).toHaveBeenCalledWith("surface-1", "submit", {
      selectedIds: ["inbox", "calendar"],
      selectedTitles: ["Clean up my inbox", "Plan my week"],
      choices: [
        { id: "inbox", title: "Clean up my inbox" },
        { id: "calendar", title: "Plan my week" },
      ],
    });
  });

  test("recommended multi-select options are auto-selected but can be deselected", () => {
    const onAction = mock(() => {});
    const { getByRole } = render(
      <ChoiceSurface
        surface={makeSurface({
          data: {
            selectionMode: "multiple",
            submitLabel: "Run these",
            options: [
              { id: "inbox", title: "Clean up my inbox", recommended: true },
              { id: "calendar", title: "Plan my week" },
            ],
          },
        })}
        onAction={onAction}
      />,
    );

    const recommended = getByRole("button", { name: /clean up my inbox/i });
    const submit = getByRole("button", { name: /run these/i });

    expect(recommended.getAttribute("aria-pressed")).toBe("true");
    expect(recommended.querySelector("svg")).not.toBeNull();
    expect((submit as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(recommended);
    expect(recommended.getAttribute("aria-pressed")).toBe("false");
    expect(recommended.querySelector("svg")).toBeNull();
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    expect(onAction).not.toHaveBeenCalled();
  });
});

describe("CopyBlockSurface", () => {
  test("renders a visible copy affordance for the block text", async () => {
    const writeText = mock(() => Promise.resolve());
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    const { getByRole, getByText } = render(
      <CopyBlockSurface
        surface={makeSurface({
          surfaceType: "copy_block",
          data: {
            label: "Port prompt",
            text: "Paste this into another assistant.",
          },
        })}
        onAction={() => {}}
      />,
    );

    expect(getByText("Paste this into another assistant.")).toBeTruthy();

    fireEvent.click(getByRole("button", { name: "Copy" }));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith(
        "Paste this into another assistant.",
      );
    });
    expect(getByRole("button", { name: "Copied" })).toBeTruthy();
  });
});

describe("SurfaceRouter", () => {
  test("collapses completed choice surfaces into a completion chip", () => {
    const { queryByText, getByText } = render(
      <SurfaceRouter
        surface={makeSurface({
          completed: true,
          completionSummary: 'User chose: "Clean up my inbox"',
          data: {
            options: [{ id: "inbox", title: "Clean up my inbox" }],
          },
        })}
        onAction={() => {}}
      />,
    );

    expect(queryByText("Clean up my inbox")).toBeNull();
    expect(getByText('User chose: "Clean up my inbox"')).toBeTruthy();
  });
});
