/**
 * Tests for the bulk "use my current default model for every schedule" flow.
 *
 * The invariants: the action never fires without an explicit confirm, the
 * confirm reaches the daemon as one reassign call with no `from` (so the move
 * covers schedules pinned to any profile, including rows the list hides), and
 * the user is told what actually moved.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";

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

let reassignBodies: unknown[] = [];
let reassignedCount = 2;
let reassignFails = false;
let successToasts: string[] = [];
let errorToasts: string[] = [];

mock.module("@/generated/daemon/sdk.gen", () => ({
  ...daemonSdk,
  configGet: mock(async () => ({ data: CONFIG })),
  configLlmCallsitesGet: mock(async () => ({ data: CATALOG })),
  schedulesReassignprofilePost: mock(async (options?: { body?: unknown }) => {
    reassignBodies.push(options?.body);
    return reassignFails
      ? { response: { ok: false, status: 500 }, error: undefined }
      : {
          response: { ok: true, status: 200 },
          data: { reassigned: reassignedCount },
        };
  }),
}));

mock.module("@vellumai/design-library/components/toast", () => ({
  toast: {
    success: (message: string) => successToasts.push(message),
    error: (message: string) => errorToasts.push(message),
  },
}));

const { ScheduleProfileRebaseDialog, useScheduleProfileRebase } =
  await import("./schedule-profile-rebase");

type RebaseSchedule = Parameters<typeof useScheduleProfileRebase>[1][number];

function schedule(
  id: string,
  inferenceProfile: string | null,
  status: string = "active",
) {
  return {
    id,
    name: id,
    inferenceProfile,
    status,
  } as unknown as RebaseSchedule;
}

const SCHEDULES = [
  schedule("sched-1", "thrifty"),
  schedule("sched-2", "quality"),
  schedule("sched-3", null),
];

let rebasedCalls = 0;

function Harness({ schedules = SCHEDULES }: { schedules?: RebaseSchedule[] }) {
  const rebase = useScheduleProfileRebase("asst-1", schedules, () => {
    rebasedCalls += 1;
  });
  return (
    <>
      <button type="button" onClick={rebase.requestRebase}>
        request
      </button>
      <span data-testid="off-default">{rebase.offDefaultCount}</span>
      <span data-testid="can-rebase">{String(rebase.canRebase)}</span>
      <span data-testid="label">{rebase.defaultProfileLabel ?? ""}</span>
      <ScheduleProfileRebaseDialog {...rebase.dialogProps} />
    </>
  );
}

function Wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 0 } },
  });
  return createElement(QueryClientProvider, { client }, children);
}

function clickByText(text: string) {
  const button = Array.from(
    document.querySelectorAll<HTMLElement>("button"),
  ).find((el) => el.textContent?.trim() === text);
  expect(button).toBeDefined();
  act(() => {
    button?.click();
  });
}

function confirmButton(): HTMLElement | null {
  return document.querySelector("[data-confirm-dialog-confirm]");
}

function renderedText(): string {
  return document.body.textContent ?? "";
}

beforeEach(() => {
  reassignBodies = [];
  reassignedCount = 2;
  reassignFails = false;
  successToasts = [];
  errorToasts = [];
  rebasedCalls = 0;
});

afterEach(() => {
  cleanup();
});

describe("useScheduleProfileRebase", () => {
  test("counts the schedules not already on the resolved default", async () => {
    render(
      <Wrapper>
        <Harness />
      </Wrapper>,
    );
    await waitFor(() => {
      expect(document.querySelector('[data-testid="label"]')?.textContent).toBe(
        "Quality",
      );
    });
    // sched-1 (thrifty) and sched-3 (no pin) differ from the default.
    expect(
      document.querySelector('[data-testid="off-default"]')?.textContent,
    ).toBe("2");
    expect(
      document.querySelector('[data-testid="can-rebase"]')?.textContent,
    ).toBe("true");
  });

  test("schedules that already fired or were cancelled are not counted", async () => {
    render(
      <Wrapper>
        <Harness
          schedules={[
            schedule("fired-one", "thrifty", "fired"),
            schedule("cancelled-one", "thrifty", "cancelled"),
            schedule("live-one", "thrifty"),
          ]}
        />
      </Wrapper>,
    );
    await waitFor(() => {
      expect(document.querySelector('[data-testid="label"]')?.textContent).toBe(
        "Quality",
      );
    });
    // Their profile is history; the daemon leaves them alone, so offering them
    // would promise a bigger move than the one that comes back.
    expect(
      document.querySelector('[data-testid="off-default"]')?.textContent,
    ).toBe("1");
  });

  test("the action is withheld when every schedule is already dead", async () => {
    render(
      <Wrapper>
        <Harness
          schedules={[
            schedule("fired-one", "thrifty", "fired"),
            schedule("cancelled-one", "thrifty", "cancelled"),
          ]}
        />
      </Wrapper>,
    );
    await waitFor(() => {
      expect(document.querySelector('[data-testid="label"]')?.textContent).toBe(
        "Quality",
      );
    });
    expect(
      document.querySelector('[data-testid="can-rebase"]')?.textContent,
    ).toBe("false");
  });

  test("requesting the rebase confirms first and moves nothing", async () => {
    render(
      <Wrapper>
        <Harness />
      </Wrapper>,
    );
    await waitFor(() => {
      expect(document.querySelector('[data-testid="label"]')?.textContent).toBe(
        "Quality",
      );
    });

    clickByText("request");
    await waitFor(() => {
      expect(confirmButton()).not.toBeNull();
    });
    expect(renderedText()).toContain("Use Quality for every schedule?");
    expect(renderedText()).toContain("2 of the schedules below run");
    expect(reassignBodies).toHaveLength(0);
  });

  test("cancelling closes the dialog without moving anything", async () => {
    render(
      <Wrapper>
        <Harness />
      </Wrapper>,
    );
    await waitFor(() => {
      expect(document.querySelector('[data-testid="label"]')?.textContent).toBe(
        "Quality",
      );
    });

    clickByText("request");
    await waitFor(() => {
      expect(confirmButton()).not.toBeNull();
    });
    clickByText("Cancel");
    await waitFor(() => {
      expect(confirmButton()).toBeNull();
    });
    expect(reassignBodies).toHaveLength(0);
  });

  test("confirming moves every schedule and reports the result", async () => {
    render(
      <Wrapper>
        <Harness />
      </Wrapper>,
    );
    await waitFor(() => {
      expect(document.querySelector('[data-testid="label"]')?.textContent).toBe(
        "Quality",
      );
    });

    clickByText("request");
    await waitFor(() => {
      expect(confirmButton()).not.toBeNull();
    });
    clickByText("Move schedules");

    await waitFor(() => {
      expect(reassignBodies).toHaveLength(1);
    });
    // No `from`: the move must cover schedules pinned to any profile, not just
    // one source.
    expect(reassignBodies[0]).toEqual({ to: "quality" });
    await waitFor(() => {
      expect(successToasts).toEqual(["Moved 2 schedules to Quality."]);
    });
    expect(rebasedCalls).toBe(1);
    expect(confirmButton()).toBeNull();
  });

  test("reports a no-op run honestly", async () => {
    reassignedCount = 0;
    render(
      <Wrapper>
        <Harness />
      </Wrapper>,
    );
    await waitFor(() => {
      expect(document.querySelector('[data-testid="label"]')?.textContent).toBe(
        "Quality",
      );
    });

    clickByText("request");
    await waitFor(() => {
      expect(confirmButton()).not.toBeNull();
    });
    clickByText("Move schedules");

    await waitFor(() => {
      expect(successToasts).toEqual([
        "Every schedule already runs on Quality.",
      ]);
    });
  });

  test("a failed move is surfaced and leaves the dialog open", async () => {
    reassignFails = true;
    render(
      <Wrapper>
        <Harness />
      </Wrapper>,
    );
    await waitFor(() => {
      expect(document.querySelector('[data-testid="label"]')?.textContent).toBe(
        "Quality",
      );
    });

    clickByText("request");
    await waitFor(() => {
      expect(confirmButton()).not.toBeNull();
    });
    clickByText("Move schedules");

    await waitFor(() => {
      expect(errorToasts).toEqual(["Failed to move the schedules."]);
    });
    expect(successToasts).toEqual([]);
    expect(confirmButton()).not.toBeNull();
  });
});
