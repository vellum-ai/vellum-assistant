/**
 * Tests for `ActivityStepsPanel` — the two-level activity-steps side drawer.
 *
 *  - Level 1 renders the phase-grouped timeline (phase headers + step pills)
 *    from the payload snapshot when no live group resolves.
 *  - Clicking a tool step drills into the level-2 detail (technical details +
 *    output) with an "All steps" back button; back returns to the timeline.
 *  - Clicking a thinking step drills into the reasoning text.
 *  - The header shows the run summary + step count, and the close button
 *    fires `onClose`.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";

import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import type { ChatMessageToolCall } from "@/domains/chat/api/event-types";
import type { DisplayMessage } from "@/domains/chat/types/types";
import type {
  ToolCallCardItem,
  ToolCallCardStep,
} from "@/domains/chat/utils/tool-call-card-utils";
import { toolCallStatusWireFields } from "@/domains/chat/utils/message-test-helpers";

// The viewer store and chat-session-store (pulled in transitively) import the
// generated daemon SDK, which isn't built in CI/worktree checkouts. Stub all
// endpoints so the module loads; the panel never invokes them.
const sdkStub = async () => ({ data: undefined });
const realSdkPath = new URL(
  "../../../generated/daemon/sdk.gen.ts",
  import.meta.url,
).pathname;
const sdkSource = await Bun.file(realSdkPath).text();
const exportNames = [...sdkSource.matchAll(/^export const (\w+)/gm)].map(
  (m) => m[1]!,
);
const sdkMock = Object.fromEntries(exportNames.map((n) => [n, sdkStub]));
mock.module("@/generated/daemon/sdk.gen", () => sdkMock);

const { ActivityStepsPanel, buildActivityScreenshotGallery } =
  await import("@/domains/chat/components/activity-steps-panel");
const { useChatSessionStore } =
  await import("@/domains/chat/chat-session-store");
const { useTurnStore } = await import("@/domains/chat/turn-store");

const { useAssistantFeatureFlagStore } =
  await import("@/stores/assistant-feature-flag-store");

afterEach(() => {
  cleanup();
  useAssistantFeatureFlagStore.setState({ sessionGroups: false });
  useTurnStore.setState({ phase: "idle" });
  useChatSessionStore.setState({ snapshot: null, optimisticSends: [] });
});

function makeToolCall(
  overrides: Partial<ChatMessageToolCall> & {
    id: string;
    name: string;
    status?: "running" | "completed" | "error";
  },
): ChatMessageToolCall {
  const { status = "completed", ...rest } = overrides;
  return {
    input: {},
    ...toolCallStatusWireFields(status),
    ...rest,
  };
}

const BASH = makeToolCall({
  id: "tc-1",
  name: "bash",
  status: "completed",
  input: { command: "git status", activity: "Checking git status" },
  result: "On branch main",
  startedAt: 0,
  completedAt: 2_000,
});

const THINKING_TEXT =
  "I should check the repository state before doing anything else.";

const ITEMS: ToolCallCardItem[] = [
  { kind: "thinking", text: THINKING_TEXT, startedAt: 0, completedAt: 500 },
  { kind: "toolCall", toolCall: BASH },
];

function renderPanel(onClose: () => void = () => {}) {
  return render(
    <ActivityStepsPanel
      payload={{ items: ITEMS, toolCalls: [BASH] }}
      onClose={onClose}
    />,
  );
}

function renderScreenshotPanel(
  toolCalls: ChatMessageToolCall[],
  items: ToolCallCardItem[] = toolCalls.map((toolCall) => ({
    kind: "toolCall" as const,
    toolCall,
  })),
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ActivityStepsPanel
        payload={{ items, toolCalls }}
        onClose={() => {}}
        assistantId="asst-1"
      />
    </QueryClientProvider>,
  );
}

function computerUseCall(
  id: string,
  options: {
    imageAttachmentIds?: string[];
    imageDataList?: string[];
    activity?: string | null;
  } = {},
): ChatMessageToolCall {
  return makeToolCall({
    id,
    name: "computer_use_screenshot",
    input:
      options.activity === null
        ? {}
        : { activity: options.activity ?? `Inspecting ${id}` },
    imageAttachmentIds: options.imageAttachmentIds,
    imageDataList: options.imageDataList,
    startedAt: 1_000,
    completedAt: 2_000,
  });
}

function seedTranscript(messages: DisplayMessage[]): void {
  act(() => {
    useChatSessionStore.setState({
      snapshot: {
        messages,
        seq: null,
        hasMore: false,
        oldestTimestamp: null,
        oldestMessageId: null,
      },
    });
  });
}

describe("ActivityStepsPanel — level 1 timeline", () => {
  test("renders phase headers and step pills for the snapshot items", () => {
    const { getAllByTestId, getByLabelText } = renderPanel();
    // Two phases: "Thinking" and "Working" (bash).
    const phases = getAllByTestId("phase-header");
    expect(phases.length).toBe(2);
    // The thinking step renders as a clickable pill.
    expect(getByLabelText("View thinking")).toBeTruthy();
    // The tool step renders its pill with the activity label.
    expect(
      getByLabelText("View details: Checking git status").textContent,
    ).toContain("Checking git status");
  });

  test("header shows the run summary and step count", () => {
    const { getByText } = renderPanel();
    // Timing data present → duration summary.
    expect(getByText(/Worked for/)).toBeTruthy();
    expect(getByText("2 steps")).toBeTruthy();
  });

  test("active trailing thinking settles while awaiting user input", () => {
    const items: ToolCallCardItem[] = [
      { kind: "toolCall", toolCall: BASH },
      { kind: "thinking", text: "Preparing the next step" },
    ];
    useTurnStore.setState({ phase: "thinking" });
    const { getAllByText, queryByText, getByText } = render(
      <ActivityStepsPanel
        payload={{ items, toolCalls: [BASH], active: true }}
        onClose={() => {}}
      />,
    );

    expect(getAllByText("Thinking").length).toBeGreaterThan(0);
    expect(queryByText(/Worked for/)).toBeNull();

    act(() => useTurnStore.setState({ phase: "awaiting_user_input" }));
    expect(getByText(/Worked for/)).toBeTruthy();
  });

  test("an open thinking detail follows appended steps and a blank-to-prose boundary", () => {
    const nextTool = makeToolCall({
      id: "tc-2",
      name: "bash",
      status: "completed",
      input: { command: "git diff", activity: "Checking the diff" },
      startedAt: 2_000,
      completedAt: 3_000,
    });
    const message = (
      thinking: string,
      includeNextTool: boolean,
      trailingText: string,
    ): DisplayMessage => ({
      id: "m-live",
      role: "assistant",
      contentBlocks: [
        { type: "tool_use", toolCall: BASH },
        { type: "text", text: "\n" },
        { type: "thinking", thinking },
        ...(includeNextTool
          ? ([
              { type: "text", text: "  " },
              { type: "tool_use", toolCall: nextTool },
            ] as const)
          : []),
        { type: "text", text: trailingText },
      ],
    });

    useTurnStore.setState({ phase: "thinking" });
    seedTranscript([message("partial reasoning", false, "\n")]);
    const { getByLabelText, getByRole, getByText } = render(
      <ActivityStepsPanel
        payload={{
          messageId: "m-live",
          groupIndex: 0,
          items: ITEMS,
          toolCalls: [BASH],
          active: true,
        }}
        onClose={() => {}}
      />,
    );

    fireEvent.click(getByLabelText("View thinking"));
    expect(getByText("partial reasoning")).toBeTruthy();

    seedTranscript([message("partial reasoning and more", true, "\n")]);
    expect(getByText("partial reasoning and more")).toBeTruthy();

    seedTranscript([
      message("partial reasoning and more", true, "Visible response."),
    ]);
    fireEvent.click(getByRole("button", { name: /back to all steps/i }));
    expect(getByText("3 steps")).toBeTruthy();
    expect(getByText(/Worked for/)).toBeTruthy();
  });

  test("close button fires onClose", () => {
    let closed = false;
    const { getByLabelText } = renderPanel(() => {
      closed = true;
    });
    fireEvent.click(getByLabelText("Close steps"));
    expect(closed).toBe(true);
  });
});

describe("ActivityStepsPanel — level 2 drill-in", () => {
  test("clicking a tool step shows its detail with a back button", () => {
    const {
      getAllByText,
      getByLabelText,
      getByText,
      getByRole,
      queryByTestId,
      queryByText,
    } = renderPanel();
    fireEvent.click(getByLabelText("View details: Checking git status"));
    // Level 2: the tool detail, headed by the tool and showing its output.
    expect(getByText("Run Command")).toBeTruthy();
    expect(getByText("On branch main")).toBeTruthy();
    // The timeline is replaced, and the header swaps to the step's title with
    // the back chevron on its left (the run summary is gone). The header owns
    // the activity sentence, so it renders once and the body does not echo it.
    expect(queryByTestId("phase-header")).toBeNull();
    expect(queryByText(/Worked for/)).toBeNull();
    expect(getAllByText("Checking git status")).toHaveLength(1);
    expect(getByRole("button", { name: /back to all steps/i })).toBeTruthy();
  });

  test("the back button returns to the timeline", () => {
    const { getByLabelText, getByRole, getAllByTestId, queryByText } =
      renderPanel();
    fireEvent.click(getByLabelText("View details: Checking git status"));
    fireEvent.click(getByRole("button", { name: /back to all steps/i }));
    expect(getAllByTestId("phase-header").length).toBe(2);
    // The detail body (title-cased tool name) is gone again.
    expect(queryByText("Bash")).toBeNull();
  });

  test("clicking a thinking step shows the full reasoning text", () => {
    const { getByLabelText, getByText, getByRole } = renderPanel();
    fireEvent.click(getByLabelText("View thinking"));
    // The full (untruncated) reasoning renders in the detail level.
    expect(getByText(THINKING_TEXT)).toBeTruthy();
    expect(getByRole("button", { name: /back to all steps/i })).toBeTruthy();
  });

  test("resets drill-in when a replacement group occupies the same index", () => {
    const replacement = makeToolCall({
      id: "tc-replacement",
      name: "bash",
      input: { command: "git diff", activity: "Checking the replacement" },
      result: "replacement output",
    });
    const { getByLabelText, getByText, queryByText, rerender } = render(
      <ActivityStepsPanel
        payload={{
          messageId: "m-shared",
          groupIndex: 0,
          groupToolCallIds: [BASH.id],
          items: ITEMS,
          toolCalls: [BASH],
        }}
        onClose={() => {}}
      />,
    );

    fireEvent.click(getByLabelText("View details: Checking git status"));
    expect(getByText("On branch main")).toBeTruthy();

    rerender(
      <ActivityStepsPanel
        payload={{
          messageId: "m-shared",
          groupIndex: 0,
          groupToolCallIds: [replacement.id],
          items: [{ kind: "toolCall", toolCall: replacement }],
          toolCalls: [replacement],
        }}
        onClose={() => {}}
      />,
    );

    expect(queryByText("On branch main")).toBeNull();
    expect(
      getByLabelText("View details: Checking the replacement"),
    ).toBeTruthy();
  });

  test("keeps drill-in through pagination relocation and donor prepend", () => {
    const olderGroup = makeToolCall({
      id: "tc-older-group",
      name: "bash",
      input: { command: "pwd", activity: "Checking the older group" },
      result: "/workspace",
    });
    const donor = makeToolCall({
      id: "tc-donor",
      name: "bash",
      input: { command: "ls", activity: "Checking donor context" },
      result: "README.md",
    });
    seedTranscript([
      {
        id: "m-relocated",
        role: "assistant",
        contentBlocks: [{ type: "tool_use", toolCall: BASH }],
      },
    ]);
    const { getByLabelText, getByText } = render(
      <ActivityStepsPanel
        payload={{
          messageId: "m-relocated",
          groupIndex: 0,
          groupToolCallIds: [BASH.id],
          items: [{ kind: "toolCall", toolCall: BASH }],
          toolCalls: [BASH],
        }}
        onClose={() => {}}
      />,
    );

    fireEvent.click(getByLabelText("View details: Checking git status"));
    expect(getByText("On branch main")).toBeTruthy();

    seedTranscript([
      {
        id: "m-relocated",
        role: "assistant",
        contentBlocks: [
          { type: "tool_use", toolCall: olderGroup },
          { type: "text", text: "Earlier response." },
          { type: "tool_use", toolCall: BASH },
        ],
      },
    ]);
    expect(getByText("On branch main")).toBeTruthy();

    seedTranscript([
      {
        id: "m-relocated",
        role: "assistant",
        contentBlocks: [
          { type: "tool_use", toolCall: olderGroup },
          { type: "text", text: "Earlier response." },
          { type: "tool_use", toolCall: donor },
          { type: "text", text: "\n" },
          { type: "tool_use", toolCall: BASH },
        ],
      },
    ]);
    expect(getByText("On branch main")).toBeTruthy();
  });
});

describe("ActivityStepsPanel - computer screenshot gallery", () => {
  test("keeps action wording inside Working without displacing its screenshot", () => {
    const screenshot = computerUseCall("tc-shot", {
      imageDataList: ["AAAA"],
      activity: null,
    });
    const click = makeToolCall({
      id: "tc-click",
      name: "host_bash",
      input: { command: "assistant browser click #submit" },
      startedAt: 2_000,
      completedAt: 3_000,
    });
    const { getAllByTestId, getByText, getByRole } = renderScreenshotPanel([
      screenshot,
      click,
    ]);

    expect(getAllByTestId("phase-header")).toHaveLength(1);
    expect(getByText("assistant browser click #submit")).toBeTruthy();
    act(() => useAssistantFeatureFlagStore.setState({ sessionGroups: true }));
    expect(getByText("Clicking")).toBeTruthy();
    expect(getAllByTestId("activity-screenshot-tile")).toHaveLength(1);
    const tile = getByRole("button", {
      name: "Preview computer screenshot",
    });
    expect(tile.querySelector("img")?.getAttribute("src")).toContain("AAAA");
  });

  test("keeps the final image from each multi-image computer-use call", () => {
    const referenced = computerUseCall("tc-referenced", {
      imageAttachmentIds: ["att-stale", "att-final"],
    });
    const inline = computerUseCall("tc-inline", {
      imageDataList: ["AAAA", "BBBB"],
    });
    const toolStep = (toolCallId: string): ToolCallCardStep => ({
      kind: "tool",
      title: "Working",
      info: toolCallId,
      activity: "Checking the page",
      iconName: "monitor",
      durationLabel: "1s",
      toolCallId,
      status: "completed",
    });

    const gallery = buildActivityScreenshotGallery(
      [referenced, inline],
      [toolStep(referenced.id), toolStep(inline.id)],
    );

    expect(gallery.map((entry) => entry.image.id)).toEqual([
      "att-final",
      "tool-image:tc-inline:2",
    ]);
    expect(gallery[1]?.image.previewUrl).toBe("data:image/png;base64,BBBB");
  });

  test("uses rendered tool order and keeps shared attachment ids as two occurrences", () => {
    const first = computerUseCall("tc-first", {
      imageAttachmentIds: ["att-shared"],
    });
    const second = computerUseCall("tc-second", {
      imageAttachmentIds: ["att-shared"],
    });
    const gallery = buildActivityScreenshotGallery(
      [second, first],
      [
        {
          kind: "tool",
          title: "Working",
          info: "first",
          activity: "First",
          iconName: "monitor",
          durationLabel: "1s",
          toolCallId: first.id,
          status: "completed",
        },
        {
          kind: "tool",
          title: "Working",
          info: "second",
          activity: "Second",
          iconName: "monitor",
          durationLabel: "1s",
          toolCallId: second.id,
          status: "completed",
        },
      ],
    );

    expect(gallery.map((entry) => entry.occurrenceKey)).toEqual([
      "tc-first",
      "tc-second",
    ]);
    expect(gallery.map((entry) => entry.image.id)).toEqual([
      "att-shared",
      "att-shared",
    ]);
  });

  test("renders one representative for two calls in a Working phase and opens both gallery entries", () => {
    const first = computerUseCall("tc-first", {
      imageDataList: ["AAAA"],
      activity: "Opening the page",
    });
    const second = computerUseCall("tc-second", {
      imageDataList: ["BBBB"],
      activity: "Checking the result",
    });
    const { getAllByTestId, getByRole, getByText } = renderScreenshotPanel([
      first,
      second,
    ]);

    expect(getAllByTestId("activity-screenshot-tile")).toHaveLength(1);
    const tile = getByRole("button", {
      name: "Preview screenshot from Checking the result",
    });
    expect(tile.querySelector("img")?.getAttribute("src")).toContain("BBBB");
    fireEvent.click(tile);
    expect(getByText("2 / 2")).toBeTruthy();
  });

  test("a later non-image Working step does not displace the screenshot", () => {
    const screenshot = computerUseCall("tc-shot", {
      imageDataList: ["AAAA"],
      activity: "Checking the page",
    });
    const later = makeToolCall({
      id: "tc-bash-later",
      name: "bash",
      input: { command: "pwd", activity: "Checking the folder" },
      startedAt: 2_000,
      completedAt: 3_000,
    });
    const { getAllByTestId, getByRole } = renderScreenshotPanel([
      screenshot,
      later,
    ]);

    expect(getAllByTestId("activity-screenshot-tile")).toHaveLength(1);
    expect(
      getByRole("button", {
        name: "Preview screenshot from Checking the page",
      }),
    ).toBeTruthy();
  });

  test("separate Working sections get separate representatives and share one block gallery", () => {
    const first = computerUseCall("tc-first", { imageDataList: ["AAAA"] });
    const skill = makeToolCall({
      id: "tc-skill",
      name: "skill_execute",
      input: { skill: "example" },
      startedAt: 2_000,
      completedAt: 3_000,
    });
    const second = computerUseCall("tc-second", { imageDataList: ["BBBB"] });
    const { getAllByTestId, getAllByRole, getByText } = renderScreenshotPanel([
      first,
      skill,
      second,
    ]);

    expect(getAllByTestId("activity-screenshot-tile")).toHaveLength(2);
    fireEvent.click(
      getAllByRole("button", { name: /Preview screenshot from/ })[0]!,
    );
    expect(getByText("1 / 2")).toBeTruthy();
  });

  test("ordinary generated, browser, and screenshot-free calls render no screenshot tile", () => {
    const ordinary = makeToolCall({
      id: "tc-generated",
      name: "media_generate_image",
      input: {},
      imageDataList: ["AAAA"],
    });
    const browser = makeToolCall({
      id: "tc-browser",
      name: "browser_screenshot",
      input: {},
      imageDataList: ["BBBB"],
    });
    const screenshotFree = computerUseCall("tc-empty");
    const { queryByTestId } = renderScreenshotPanel([
      ordinary,
      browser,
      screenshotFree,
    ]);
    expect(queryByTestId("activity-screenshot-tile")).toBeNull();
  });

  test("uses localized fallback labels when the call has no activity", () => {
    const screenshot = computerUseCall("tc-shot", {
      imageDataList: ["AAAA"],
      activity: null,
    });
    const { getByRole } = renderScreenshotPanel([screenshot]);

    expect(
      getByRole("button", { name: "Preview computer screenshot" }).getAttribute(
        "title",
      ),
    ).toBe("Computer screenshot");
  });

  test("keeps the open call selected when older history extends the live group", () => {
    const older = computerUseCall("tc-older", {
      imageDataList: ["AAAA"],
      activity: "Reviewing earlier state",
    });
    const existing = computerUseCall("tc-existing", {
      imageDataList: ["BBBB"],
      activity: "Reviewing current state",
    });
    seedTranscript([
      {
        id: "m-live-gallery",
        role: "assistant",
        contentBlocks: [
          { type: "tool_use", toolCall: older },
          { type: "text", text: "\n" },
          { type: "tool_use", toolCall: existing },
        ],
        toolCalls: [older, existing],
      },
    ]);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const { getByRole, getByText } = render(
      <QueryClientProvider client={client}>
        <ActivityStepsPanel
          payload={{
            messageId: "m-live-gallery",
            groupIndex: 0,
            groupToolCallIds: [existing.id],
            items: [{ kind: "toolCall", toolCall: existing }],
            toolCalls: [existing],
          }}
          onClose={() => {}}
          assistantId="asst-1"
        />
      </QueryClientProvider>,
    );

    fireEvent.click(
      getByRole("button", {
        name: "Preview screenshot from Reviewing current state",
      }),
    );
    expect(getByText("2 / 2")).toBeTruthy();
  });
});
