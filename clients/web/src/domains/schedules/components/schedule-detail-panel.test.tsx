/**
 * Tests for the schedule detail panel's model-profile field.
 *
 * The invariants this PR adds:
 *  - a schedule shows the profile it is pinned to, by display label;
 *  - changing it PATCHes that one schedule with the chosen profile key;
 *  - the picker offers no "Default" option, because writing null re-snapshots
 *    the current default rather than unpinning;
 *  - a workflow-mode schedule presents no governing pin, since a workflow's
 *    own steps resolve their models independently of the schedule's.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { MemoryRouter } from "react-router";

import * as daemonSdk from "@/generated/daemon/sdk.gen";

const CONFIG = {
  llm: {
    profiles: {
      quality: {
        label: "Quality",
        provider: "anthropic",
        model: "claude-opus-5",
      },
      thrifty: {
        label: "Thrifty",
        provider: "anthropic",
        model: "claude-haiku-5",
      },
    },
    profileOrder: ["quality", "thrifty"],
    activeProfile: "quality",
    callSites: {},
  },
};

const CATALOG = {
  domains: [{ id: "agentLoop", displayName: "Agent Loop" }],
  callSites: [
    {
      id: "mainAgent",
      displayName: "Main Agent",
      description: "The primary chat agent.",
      domain: "agentLoop",
      defaultProfile: "quality",
    },
  ],
};

let patchCalls: Array<{ id: string; body: unknown }> = [];
let patchFails = false;

mock.module("@/generated/daemon/sdk.gen", () => ({
  ...daemonSdk,
  configGet: mock(async () => ({ data: CONFIG })),
  configLlmCallsitesGet: mock(async () => ({ data: CATALOG })),
  schedulesByIdRunsGet: mock(async () => ({
    data: { runs: [], nextCursor: null },
    response: { ok: true, status: 200 },
  })),
  schedulesByIdPatch: mock(
    async (options?: { path?: { id?: string }; body?: unknown }) => {
      patchCalls.push({ id: options?.path?.id ?? "", body: options?.body });
      return patchFails
        ? { response: { ok: false, status: 500 }, error: undefined }
        : { response: { ok: true, status: 200 }, data: {} };
    },
  ),
}));

const { ScheduleDetailPanel } = await import("./schedule-detail-panel");

type PanelSchedule = Parameters<typeof ScheduleDetailPanel>[0]["schedule"];

const BASE_SCHEDULE = {
  id: "sched-1",
  name: "Morning digest",
  description: "Morning digest",
  enabled: true,
  syntax: "cron",
  expression: "0 9 * * *",
  cronExpression: "0 9 * * *",
  cadenceDescription: "Every day at 9:00",
  timezone: null,
  message: "digest",
  script: null,
  mode: "execute",
  nextRunAt: 1_700_000_000_000,
  lastRunAt: null,
  lastStatus: null,
  isOneShot: false,
  inferenceProfile: "thrifty",
} as unknown as PanelSchedule;

function Wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0 } },
  });
  return createElement(
    QueryClientProvider,
    { client },
    createElement(MemoryRouter, null, children),
  );
}

function renderPanel(schedule: PanelSchedule, isPast = false) {
  return render(
    <Wrapper>
      <ScheduleDetailPanel
        schedule={schedule}
        assistantId="asst-1"
        usage={{ status: "loading" }}
        isPast={isPast}
        onClose={() => {}}
        onDeleted={() => {}}
      />
    </Wrapper>,
  );
}

function profileTrigger(): HTMLElement | undefined {
  return Array.from(
    document.querySelectorAll<HTMLElement>('button[role="combobox"]'),
  ).find((trigger) => trigger.getAttribute("aria-label") === "Model profile");
}

function renderedText(): string {
  return document.body.textContent ?? "";
}

beforeEach(() => {
  patchCalls = [];
  patchFails = false;
});

afterEach(() => {
  cleanup();
});

describe("ScheduleDetailPanel model profile", () => {
  test("shows the profile the schedule is pinned to", async () => {
    renderPanel(BASE_SCHEDULE);
    await waitFor(() => {
      expect(profileTrigger()?.textContent).toContain("Thrifty");
    });
    expect(renderedText()).toContain("Model profile");
  });

  test("offers no Default option, because null re-snapshots the default", async () => {
    renderPanel(BASE_SCHEDULE);
    await waitFor(() => {
      expect(profileTrigger()).toBeDefined();
    });

    fireEvent.click(profileTrigger()!);
    const optionLabels = Array.from(
      document.querySelectorAll<HTMLElement>('[role="option"]'),
    ).map((option) => option.textContent?.trim());
    expect(optionLabels).toEqual(["Quality", "Thrifty"]);
  });

  test("picking a profile patches that schedule with the chosen key", async () => {
    renderPanel(BASE_SCHEDULE);
    await waitFor(() => {
      expect(profileTrigger()).toBeDefined();
    });

    fireEvent.click(profileTrigger()!);
    const quality = Array.from(
      document.querySelectorAll<HTMLElement>('[role="option"]'),
    ).find((option) => option.textContent?.trim() === "Quality");
    expect(quality).toBeDefined();
    fireEvent.click(quality!);

    await waitFor(() => {
      expect(patchCalls).toHaveLength(1);
    });
    expect(patchCalls[0]).toEqual({
      id: "sched-1",
      body: { inferenceProfile: "quality" },
    });
  });

  test("re-picking the profile already in force patches nothing", async () => {
    renderPanel(BASE_SCHEDULE);
    await waitFor(() => {
      expect(profileTrigger()).toBeDefined();
    });

    fireEvent.click(profileTrigger()!);
    const thrifty = Array.from(
      document.querySelectorAll<HTMLElement>('[role="option"]'),
    ).find((option) => option.textContent?.trim() === "Thrifty");
    fireEvent.click(thrifty!);

    await waitFor(() => {
      expect(profileTrigger()?.textContent).toContain("Thrifty");
    });
    expect(patchCalls).toHaveLength(0);
  });

  test("a workflow schedule presents no pin it does not govern", async () => {
    renderPanel({ ...BASE_SCHEDULE, mode: "workflow" } as PanelSchedule);
    await waitFor(() => {
      expect(renderedText()).toContain("Not used for workflow runs");
    });
    expect(profileTrigger()).toBeUndefined();
    expect(renderedText()).toContain("Each step of a workflow picks its own");
    // The pinned profile is never named, so nothing implies it governs the run.
    expect(renderedText()).not.toContain("Thrifty");
  });

  test("a pin naming a deleted profile asks for a choice", async () => {
    renderPanel({
      ...BASE_SCHEDULE,
      inferenceProfile: "deleted-profile",
    } as PanelSchedule);
    await waitFor(() => {
      expect(profileTrigger()?.textContent).toContain("Choose a model");
    });
  });

  test("a one-shot that already fired shows its profile read-only", async () => {
    renderPanel(
      { ...BASE_SCHEDULE, isOneShot: true } as PanelSchedule,
      /* isPast */ true,
    );
    await waitFor(() => {
      expect(renderedText()).toContain("Thrifty");
    });
    expect(profileTrigger()).toBeUndefined();
  });
});
