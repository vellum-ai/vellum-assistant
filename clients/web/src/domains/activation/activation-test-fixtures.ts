/**
 * Production-shaped activation progress for stories and tests.
 *
 * Every fixture is the exact wire shape `GET /v1/activation/progress` returns,
 * so a story cannot render a row the daemon could never produce. The task ids
 * are real `smb` starters, which is what the surfaces render against.
 */

import type {
  ActivationProgress,
  ActivationTaskProgress,
} from "./hooks/use-activation-progress";

/** The three `smb` starters, in list order. */
export const FIXTURE_STARTER_IDS = [
  "pdf-proposal",
  "weekly-report",
  "social-posts",
] as const;

const STARTED_AT = "2026-09-02T09:00:00.000Z";
const COMPLETED_AT = "2026-09-02T09:04:00.000Z";

/** A task the assistant is still working, with a live step count. */
export function startedTaskProgress(
  overrides: Partial<ActivationTaskProgress> = {},
): ActivationTaskProgress {
  return {
    status: "started",
    conversationId: "conv-started-1",
    startedAt: STARTED_AT,
    completedAt: null,
    stepCount: 6,
    artifacts: [],
    ...overrides,
  };
}

/** A finished task whose turn attached a file, rendered as a file card. */
export function doneWithArtifactProgress(
  overrides: Partial<ActivationTaskProgress> = {},
): ActivationTaskProgress {
  return {
    status: "done",
    conversationId: "conv-done-1",
    startedAt: STARTED_AT,
    completedAt: COMPLETED_AT,
    stepCount: 4,
    artifacts: [
      {
        workspacePath: "documents/proposal-aug2026.pdf",
        displayName: "proposal-aug2026.pdf",
      },
    ],
    ...overrides,
  };
}

/** A finished task with no file, rendered as the "Done · N steps" pill. */
export function doneTaskProgress(
  overrides: Partial<ActivationTaskProgress> = {},
): ActivationTaskProgress {
  return {
    status: "done",
    conversationId: "conv-done-2",
    startedAt: STARTED_AT,
    completedAt: COMPLETED_AT,
    stepCount: 4,
    artifacts: [],
    ...overrides,
  };
}

function progress(
  tasks: ActivationProgress["tasks"],
  overrides: Partial<ActivationProgress> = {},
): ActivationProgress {
  return {
    version: 1,
    listId: "smb",
    modalDismissedAt: null,
    allDoneShownAt: null,
    tasks,
    ...overrides,
  };
}

/** Nothing launched yet: the first-visit modal state. */
export const ACTIVATION_PROGRESS_EMPTY: ActivationProgress = progress(
  {},
  { listId: null },
);

/** One starter working, the rest untouched. */
export const ACTIVATION_PROGRESS_ONE_WORKING: ActivationProgress = progress({
  [FIXTURE_STARTER_IDS[0]]: startedTaskProgress(),
});

/** One starter finished with a file, one still working, one untouched. */
export const ACTIVATION_PROGRESS_MIXED: ActivationProgress = progress({
  [FIXTURE_STARTER_IDS[0]]: doneWithArtifactProgress(),
  [FIXTURE_STARTER_IDS[1]]: startedTaskProgress({
    conversationId: "conv-started-2",
    stepCount: 2,
  }),
});

/** All three starters finished: the celebration state, not yet shown. */
export const ACTIVATION_PROGRESS_ALL_DONE: ActivationProgress = progress({
  [FIXTURE_STARTER_IDS[0]]: doneWithArtifactProgress(),
  [FIXTURE_STARTER_IDS[1]]: doneTaskProgress(),
  [FIXTURE_STARTER_IDS[2]]: doneTaskProgress({
    conversationId: "conv-done-3",
    stepCount: 7,
  }),
});

/**
 * The Inspiration List showing every row treatment at once: a finished task
 * with its file, one still working, one finished with nothing to show for it,
 * and the untouched rest of the catalog.
 */
export const ACTIVATION_PROGRESS_LIST_MIXED: ActivationProgress = progress({
  [FIXTURE_STARTER_IDS[0]]: doneWithArtifactProgress(),
  [FIXTURE_STARTER_IDS[1]]: startedTaskProgress({
    conversationId: "conv-started-2",
    stepCount: 2,
  }),
  [FIXTURE_STARTER_IDS[2]]: doneTaskProgress({
    conversationId: "conv-done-3",
  }),
});

/** The modal dismissed with less than three starters done: the pill state. */
export const ACTIVATION_PROGRESS_DISMISSED: ActivationProgress = progress(
  {
    [FIXTURE_STARTER_IDS[0]]: doneTaskProgress(),
  },
  { modalDismissedAt: "2026-09-02T09:10:00.000Z" },
);
