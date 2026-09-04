/**
 * The completion step's one rule: a task is reported when it turns done, and
 * a baseline belongs to the assistant it was taken for.
 *
 * The controller stays mounted across an assistant switch and every assistant
 * works the same catalog, so the two failure modes a shared baseline produces
 * are the cases below: the next assistant's finished tasks reported as fresh
 * completions, and a completion swallowed because the last assistant already
 * reported a task with that id.
 *
 * Only the progress read is mocked, at its hook seam. The emitter runs for
 * real, caught at the ingest transport, so the payload is asserted end to end.
 */

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";

import {
  ACTIVATION_PROGRESS_EMPTY,
  doneTaskProgress,
  FIXTURE_STARTER_IDS,
} from "@/domains/activation/activation-test-fixtures";
import {
  mockActivationProgress,
  recordActivationFunnelEvents,
  resetActivationFlagStore,
  seedActivationIdentity,
  setActivationArm,
} from "@/domains/activation/activation-test-helpers";
import type { ActivationProgress } from "@/domains/activation/hooks/use-activation-progress";

const progressMock = await mockActivationProgress();
const funnel = await recordActivationFunnelEvents();

afterAll(() => {
  // Unmount first: the hook subscribes to the flag store, so resetting it
  // below would re-render a component whose progress hook the restore has
  // just swapped back to the real one.
  cleanup();
  progressMock.restore();
  funnel.restore();
  resetActivationFlagStore();
});

const { useActivationCompletionTelemetry } =
  await import("@/domains/activation/hooks/use-activation-completion-telemetry");
// Imported after the progress mock is installed, for the same reason as the
// hook under test: a static import would bind the real progress hook and want
// a query client.
const { readEffectiveActivationListId, useEffectiveActivationListId } =
  await import("@/hooks/use-activation-enabled");

const [FIRST_TASK, SECOND_TASK] = FIXTURE_STARTER_IDS;

/** A snapshot in which every named task is finished. */
function progressWithDone(...taskIds: string[]): ActivationProgress {
  return {
    ...ACTIVATION_PROGRESS_EMPTY,
    tasks: Object.fromEntries(
      taskIds.map((taskId) => [taskId, doneTaskProgress()]),
    ),
  };
}

/** The task ids reported as completed, in order. */
function completions(): string[] {
  return funnel
    .matching("activation_task_completed")
    .map((event) => (event.screen ?? "").split("/").at(-1) ?? "");
}

beforeEach(() => {
  cleanup();
  funnel.clear();
  setActivationArm("smb");
  seedActivationIdentity("asst-1");
  progressMock.set(ACTIVATION_PROGRESS_EMPTY);
});

/**
 * The mocked progress hook does not re-render on its own, and in the app both
 * the snapshot and the active assistant change in one render, because the read
 * is keyed by that assistant. Setting the snapshot inside the same `act` as the
 * store write reproduces that.
 */
function advance(
  rerender: () => void,
  progress: ActivationProgress,
  assistantId?: string,
): void {
  act(() => {
    progressMock.set(progress);
    if (assistantId) {
      seedActivationIdentity(assistantId);
    }
  });
  rerender();
}

describe("useActivationCompletionTelemetry", () => {
  test("reports a task the moment its record turns done", () => {
    const { rerender } = renderHook(() => useActivationCompletionTelemetry());
    expect(completions()).toEqual([]);

    advance(rerender, progressWithDone(FIRST_TASK!));

    expect(completions()).toEqual([FIRST_TASK!]);
  });

  // A reload after finishing a task must not re-report it.
  test("reports nothing for a task already done in the first snapshot", () => {
    progressMock.set(progressWithDone(FIRST_TASK!));
    renderHook(() => useActivationCompletionTelemetry());

    expect(completions()).toEqual([]);
  });

  test("takes a switched-to assistant's first snapshot as its own baseline", () => {
    const { rerender } = renderHook(() => useActivationCompletionTelemetry());
    advance(rerender, progressWithDone(FIRST_TASK!));
    funnel.clear();

    advance(rerender, progressWithDone(SECOND_TASK!), "asst-2");

    expect(completions()).toEqual([]);
  });

  // The emitter falls back to a module global that an effect elsewhere
  // publishes, so a hook that leaves the list to it is only right while some
  // sibling happens to render ahead of it.
  test("files a completion under the list this render resolved", () => {
    const stale = renderHook(() => useEffectiveActivationListId());
    expect(readEffectiveActivationListId()).toBe("smb");
    stale.unmount();
    setActivationArm("parent");

    const { rerender } = renderHook(() => useActivationCompletionTelemetry());
    advance(rerender, progressWithDone(FIRST_TASK!));

    expect(funnel.matching("activation_task_completed")[0]?.screen).toBe(
      `parent/${FIRST_TASK}`,
    );
  });

  // Task ids are the catalog's, so they are shared across assistants: a
  // baseline carried over would swallow the second assistant's completion.
  test("reports a task under a second assistant after the first reported it", () => {
    const { rerender } = renderHook(() => useActivationCompletionTelemetry());
    advance(rerender, progressWithDone(FIRST_TASK!));
    expect(completions()).toEqual([FIRST_TASK!]);
    funnel.clear();

    advance(rerender, ACTIVATION_PROGRESS_EMPTY, "asst-2");
    advance(rerender, progressWithDone(FIRST_TASK!));

    expect(completions()).toEqual([FIRST_TASK!]);
  });
});
