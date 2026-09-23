/**
 * Tests for the `recall` body: the query and scope, the answer and evidence
 * from the structured result, the text shown for history without one, and the
 * states in which there is no result to show.
 */

import { afterEach, describe, expect, test } from "bun:test";
import {
  act,
  cleanup,
  fireEvent,
  render as rtlRender,
} from "@testing-library/react";
import type { RecallMetadata } from "@vellumai/assistant-api";
import { MemoryRouter } from "react-router";

import { isWorkspaceFileOpen } from "@/components/local-file/open-local-file";
import { RecallDetail } from "@/domains/chat/components/tool-activity/recall-detail";
import { routes } from "@/utils/routes";
import type { ToolDetailPayload } from "@/stores/viewer-store";
import { useViewerStore } from "@/stores/viewer-store";

afterEach(() => {
  cleanup();
  act(() => useViewerStore.getState().closeDocument());
});

const recall: RecallMetadata = {
  query: "release checklist",
  depth: "deep",
  sources: ["memory", "workspace"],
  answer: "Let staging bake, then dispatch production.",
  evidence: [
    {
      source: "workspace",
      title: "docs/releasing.md",
      locator: "docs/releasing.md:14",
      excerpt: "14: Wait for the staging bake.",
      path: "docs/releasing.md",
    },
  ],
  searchedSources: [
    { source: "memory", status: "searched", evidenceCount: 0 },
    { source: "workspace", status: "searched", evidenceCount: 1 },
  ],
};

const detail: ToolDetailPayload = {
  toolCallId: "tc-recall",
  toolName: "recall",
  title: "Recalling",
  activity: "Looking up the release checklist",
  input: { query: "release checklist" },
  status: "completed",
};

type Props = Parameters<typeof RecallDetail>[0];

function renderRecall(overrides: Partial<Props> = {}) {
  return rtlRender(
    <RecallDetail
      detail={detail}
      result="Let staging bake, then dispatch production."
      activityMetadata={{ recall }}
      streamedOutput={undefined}
      answeredQuestion={undefined}
      isRunning={false}
      isError={false}
      isDenied={false}
      assistantId="assistant-1"
      {...overrides}
    />,
    { wrapper: MemoryRouter },
  );
}

describe("RecallDetail", () => {
  test("shows the query, how hard and where it searched, the answer and the evidence", () => {
    const { getByText } = renderRecall();

    expect(getByText("release checklist")).toBeDefined();
    expect(getByText("Deep search · Memory and Workspace files")).toBeDefined();
    expect(getByText("Answer")).toBeDefined();
    expect(
      getByText("Let staging bake, then dispatch production."),
    ).toBeDefined();
    expect(getByText("1 result")).toBeDefined();
    expect(getByText("docs/releasing.md")).toBeDefined();
    expect(getByText("Workspace files")).toBeDefined();
    expect(getByText("14: Wait for the staging bake.")).toBeDefined();
  });

  test("opens a file the evidence came from in the drawer", () => {
    const { getByRole } = renderRecall();

    fireEvent.click(getByRole("button", { name: /docs\/releasing\.md/ }));

    const state = useViewerStore.getState();
    expect(
      isWorkspaceFileOpen(
        state.mainView,
        state.openedDocumentState,
        "docs/releasing.md",
      ),
    ).toBe(true);
  });

  test("links a conversation hit to its message, never showing the ids", () => {
    const { getByRole, queryByText } = renderRecall({
      activityMetadata: {
        recall: {
          ...recall,
          evidence: [
            {
              source: "conversations",
              title: "Planning the release",
              locator: "conv-1#msg-9",
              excerpt: "The bake is 30 minutes.",
              conversationId: "conv-1",
              messageId: "msg-9",
            },
          ],
        },
      },
    });

    expect(
      getByRole("link", { name: /Planning the release/ }).getAttribute("href"),
    ).toBe(routes.conversationAtMessage("conv-1", "msg-9"));
    expect(queryByText(/conv-1/)).toBeNull();
  });

  test("shows an item with nowhere to open as a readout", () => {
    const { getByText, queryByRole } = renderRecall({
      activityMetadata: {
        recall: {
          ...recall,
          evidence: [
            {
              source: "memory",
              title: "Preference",
              locator: "node-42",
              excerpt: "Prefers window seats.",
            },
          ],
        },
      },
    });

    expect(getByText("Preference")).toBeDefined();
    expect(queryByRole("button", { name: /Preference/ })).toBeNull();
    expect(queryByRole("link", { name: /Preference/ })).toBeNull();
  });

  test("lists what turned up without an answer when recall wrote none", () => {
    const { getByText, queryByText } = renderRecall({
      activityMetadata: { recall: { ...recall, answer: undefined } },
    });

    expect(queryByText("Answer")).toBeNull();
    expect(getByText("docs/releasing.md")).toBeDefined();
  });

  test("says nothing turned up, and names the place it could not search", () => {
    const { getByText } = renderRecall({
      activityMetadata: {
        recall: {
          ...recall,
          answer: undefined,
          evidence: [],
          searchedSources: [
            { source: "memory", status: "searched", evidenceCount: 0 },
            {
              source: "workspace",
              status: "degraded",
              evidenceCount: 0,
              error: "index is still building",
            },
          ],
        },
      },
    });

    expect(getByText("Nothing relevant turned up.")).toBeDefined();
    expect(getByText("Some places couldn't be fully searched")).toBeDefined();
    expect(getByText("Workspace files: index is still building")).toBeDefined();
  });

  test("shows the text as written for history recorded without a structured result", () => {
    const text = [
      "Found evidence:",
      "1. [memory] Release checklist (memory/release.md): Cut the branch.",
      "Searched sources: memory.",
    ].join("\n");
    const { getByText, queryByText } = renderRecall({
      activityMetadata: undefined,
      result: text,
    });

    expect(getByText("release checklist")).toBeDefined();
    // One block, line breaks kept: the footer never folds into the last item.
    expect(getByText(/^Found evidence:/).textContent).toBe(text);
    expect(queryByText("Answer")).toBeNull();
  });

  test("says it is running until the result lands", () => {
    const { getByText, getByTestId } = renderRecall({
      activityMetadata: undefined,
      result: undefined,
      isRunning: true,
    });

    expect(getByText("release checklist")).toBeDefined();
    expect(getByTestId("tool-output-notice").textContent).toBe("Running…");
  });

  test("says a refused recall did not run, never its note to the model", () => {
    const { getByTestId, queryByText } = renderRecall({
      activityMetadata: undefined,
      result: "Recall is only available to the guardian.",
      isError: true,
      isDenied: true,
    });

    expect(getByTestId("tool-output-notice").textContent).toBe(
      "This tool call was not approved, so it did not run.",
    );
    expect(queryByText(/only available to the guardian/)).toBeNull();
  });
});
