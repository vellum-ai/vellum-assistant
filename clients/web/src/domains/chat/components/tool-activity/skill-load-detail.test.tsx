/**
 * Tests for the `skill_load` activity panel: the "Used Skill" card, its View
 * action, and the Output section's Clean/Raw switch and Show more clamp
 * (Figma node 7778-163402).
 *
 * Runs under happy-dom (see clients/web/test-setup.ts) so clicks drive real
 * state.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  act,
  cleanup,
  fireEvent,
  render as rtlRender,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

// The panel resolves the skill's glyph through the generated daemon SDK. Stub
// every endpoint so the module loads offline, then import dynamically so the
// mock is registered first (mirrors `tool-detail-panel.test.tsx`).
const sdkStub = async () => ({ data: undefined });
const realSdkPath = new URL(
  "../../../../generated/daemon/sdk.gen.ts",
  import.meta.url,
).pathname;
const sdkSource = await Bun.file(realSdkPath).text();
const exportNames = [...sdkSource.matchAll(/^export const (\w+)/gm)].map(
  (m) => m[1]!,
);
const sdkMock = Object.fromEntries(exportNames.map((n) => [n, sdkStub]));
mock.module("@/generated/daemon/sdk.gen", () => sdkMock);

const { SkillLoadDetail } =
  await import("@/domains/chat/components/tool-activity/skill-load-detail");
const { useViewerStore } = await import("@/stores/viewer-store");
import type { ToolDetailPayload } from "@/stores/viewer-store";
import { stubOverflow } from "@/hooks/overflow.test-helper";

const LONG_PARAGRAPH = "Detailed guidance about the skill. ".repeat(40);

/** A load body shaped like the daemon's real output. */
const loadResult = [
  "Skill: App Builder",
  "ID: app-builder",
  "Description: Build persistent apps in the user's Library.",
  "Path: /skills/app-builder/SKILL.md",
  "",
  "# App Builder",
  "",
  LONG_PARAGRAPH,
  "",
  "## Available Tools",
  "",
  "### app_create",
  "Create a new app in the user's Library.",
].join("\n");

let queryClient: QueryClient;

function wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

const render = (ui: Parameters<typeof rtlRender>[0]) =>
  rtlRender(ui, { wrapper });

function makeDetail(): ToolDetailPayload {
  return {
    toolCallId: "tc-skill-load",
    toolName: "skill_load",
    title: "Using a skill",
    activity: "Loading the app-builder skill",
    input: { skill: "app-builder" },
    result: loadResult,
    status: "completed",
    riskLevel: "low",
  };
}

type DetailProps = Parameters<typeof SkillLoadDetail>[0];

function renderDetail(overrides: Partial<DetailProps> = {}) {
  return render(
    <SkillLoadDetail
      detail={makeDetail()}
      result={loadResult}
      streamedOutput={undefined}
      isRunning={false}
      isError={false}
      isDenied={false}
      assistantId="assistant-1"
      {...overrides}
    />,
  );
}

beforeEach(() => {
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
});

afterEach(() => {
  cleanup();
  queryClient.clear();
});

describe("SkillLoadDetail", () => {
  test("leads with the skill's name and description", () => {
    const { getAllByText, getByText } = renderDetail();

    expect(getByText("Used Skill")).toBeDefined();
    // Also the body's own `# App Builder` heading, hence `getAllByText`.
    expect(getAllByText("App Builder").length).toBeGreaterThan(0);
    expect(
      getByText("Build persistent apps in the user's Library."),
    ).toBeDefined();
  });

  test("View opens the skill's own detail panel", () => {
    const { getByText } = renderDetail();

    act(() => {
      fireEvent.click(getByText("View"));
    });

    const state = useViewerStore.getState();
    expect(state.mainView).toBe("skill-detail");
    expect(state.activeSkillDetailId).toBe("app-builder");
  });

  test("shows the instructions, with the verbatim body under Raw output", () => {
    const { container, getByText, queryByRole } = renderDetail();

    expect(getByText("Output")).toBeDefined();
    // The readable view strips the daemon's header lines and tool manifest.
    expect(container.textContent).not.toContain("Path: /skills/app-builder");
    // Raw data is the one disclosure every tool uses, not a view switch.
    expect(queryByRole("radiogroup")).toBeNull();

    act(() => {
      fireEvent.click(getByText("Raw output"));
    });

    expect(container.textContent).toContain("Path: /skills/app-builder");
    expect(container.textContent).toContain("## Available Tools");
    // Both views at once: the instructions stay above the raw body.
    expect(container.textContent).toContain(
      "Detailed guidance about the skill.",
    );
  });

  test("shows a body of only its header and tools verbatim, as the output", () => {
    const manifestOnly = [
      "Skill: App Builder",
      "ID: app-builder",
      "Path: /skills/app-builder/SKILL.md",
      "",
      "## Available Tools",
      "",
      "### app_create",
      "Create a new app in the user's Library.",
    ].join("\n");
    const { container, queryByText } = renderDetail({ result: manifestOnly });

    expect(container.textContent).toContain("Path: /skills/app-builder");
    expect(queryByText("Raw output")).toBeNull();
  });

  test("folds a body taller than the fold behind Show more", () => {
    // The skill body is the only folded content in this detail.
    const restore = stubOverflow(() => true);
    const { getByText, queryByText } = renderDetail();
    restore();

    expect(getByText("Show more")).toBeDefined();

    act(() => {
      fireEvent.click(getByText("Show more"));
    });

    expect(getByText("Show less")).toBeDefined();
    expect(queryByText("Show more")).toBeNull();
  });

  test("reports a failed load once, with no Output section", () => {
    const error =
      "Error: skill 'meet-join' is currently unavailable in this workspace.";
    const { getByText, queryByText, container } = renderDetail({
      result: error,
      isError: true,
    });

    expect(getByText(error)).toBeDefined();
    expect(queryByText("Output")).toBeNull();
    // The error text appears in the notice only, not repeated as output.
    expect(container.textContent?.split("meet-join").length).toBe(2);
  });

  test("reads a refused load as not approved, not as still loading", () => {
    // Refused before any result: the call has no terminal signal yet, so it
    // also counts as running. The refusal decides what the card says.
    const { getByText, queryByText, queryByRole } = renderDetail({
      result: undefined,
      isRunning: true,
      isDenied: true,
    });

    expect(getByText("Not approved")).toBeDefined();
    expect(
      getByText("This tool call was not approved, so it did not run."),
    ).toBeDefined();
    expect(queryByText("Loading skill…")).toBeNull();
    expect(queryByRole("status")).toBeNull();
  });

  test("does not show the daemon's refusal note as a failed load", () => {
    const { getByText, queryByText, container } = renderDetail({
      result:
        'Permission denied. The "skill_load" tool was not allowed. Do NOT retry this tool call immediately.',
      isError: true,
      isDenied: true,
    });

    expect(getByText("Not approved")).toBeDefined();
    expect(
      getByText("This tool call was not approved, so it did not run."),
    ).toBeDefined();
    expect(queryByText("Failed to load")).toBeNull();
    expect(container.textContent).not.toContain("Do NOT retry");
  });

  test("names the skill from its id while the load is still running", () => {
    const { getByText, queryByText } = renderDetail({
      result: undefined,
      isRunning: true,
    });

    expect(getByText("app-builder")).toBeDefined();
    expect(getByText("Loading skill…")).toBeDefined();
    expect(queryByText("Output")).toBeNull();
  });
});
