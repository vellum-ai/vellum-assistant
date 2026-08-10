/**
 * Tests for the `skill_load` activity panel — the "Used Skill" card, its View
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

const { SkillLoadDetail } = await import(
  "@/domains/chat/components/tool-activity/skill-load-detail"
);
const { useViewerStore } = await import("@/stores/viewer-store");
import type { ToolDetailPayload } from "@/stores/viewer-store";

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

  test("shows the instructions cleanly and the verbatim body under Raw", () => {
    const { container, getByText } = renderDetail();

    expect(getByText("Output")).toBeDefined();
    // Clean strips the daemon's header lines and the tool manifest.
    expect(container.textContent).not.toContain("Path: /skills/app-builder");

    act(() => {
      fireEvent.click(getByText("Raw"));
    });

    expect(container.textContent).toContain("Path: /skills/app-builder");
    expect(container.textContent).toContain("## Available Tools");
  });

  test("clamps a long body behind Show more", () => {
    const { getByText, queryByText } = renderDetail();

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
    // The error text appears in the notice only — not repeated as output.
    expect(container.textContent?.split("meet-join").length).toBe(2);
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
