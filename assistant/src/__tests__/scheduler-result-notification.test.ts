/**
 * Wiring tests for the schedule-result notification: which schedule runs reach
 * the producer, and with what.
 *
 * The producer's own gates (already notified / nothing to say / flag off) are
 * covered in `notifications/__tests__/schedule-result-producer.test.ts`. What
 * is checked here is the scheduler's half of the contract, which the producer
 * cannot verify about itself: that a successful execute-mode run calls it at
 * all, that a quiet successful execute-mode run does not, that a failed run
 * does not, that the other modes are left alone, and that `runStartedAt` is
 * captured before the run rather than after. The start bound keeps a reused
 * conversation's earlier notifications from silencing later runs.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

// Stub the shared runner so the execute path is observable without an LLM.
let runBackgroundJobShouldFail = false;
/**
 * Set by a test to model a turn that delegated: called with the run's
 * conversation id just before the runner resolves, exactly where a real turn
 * would already have spawned its child.
 */
let delegateOnRun: ((conversationId: string) => void) | undefined;
mock.module("../runtime/background-job-runner.js", () => ({
  runBackgroundJob: async (opts: {
    prompt: string;
    groupId?: string;
    conversationType?: "background" | "scheduled";
    scheduleJobId?: string;
    onConversationCreated?: (id: string) => void;
  }) => {
    const { createConversation } =
      await import("../persistence/conversation-crud.js");
    const conv = createConversation({
      title: "(test stub)",
      conversationType: opts.conversationType ?? "background",
      source: "schedule",
      ...(opts.groupId ? { groupId: opts.groupId } : {}),
      ...(opts.scheduleJobId ? { scheduleJobId: opts.scheduleJobId } : {}),
    });
    opts.onConversationCreated?.(conv.id);
    if (runBackgroundJobShouldFail) {
      return {
        conversationId: conv.id,
        ok: false,
        error: new Error("Simulated failure"),
        errorKind: "exception" as const,
      };
    }
    delegateOnRun?.(conv.id);
    return { conversationId: conv.id, ok: true };
  },
}));

interface CapturedCall {
  scheduleId: string;
  scheduleName: string;
  conversationId: string;
  runId: string;
  runStartedAt: number;
}
const producerCalls: CapturedCall[] = [];
/**
 * The conversation's latest assistant text at the moment the producer ran. The
 * real producer reads exactly this row, so capturing it here is what makes
 * "did the scheduler wait for the delegated reply?" observable.
 */
const producerSawText: (string | undefined)[] = [];
mock.module("../notifications/schedule-result-producer.js", () => ({
  emitScheduleResultNotification: async (params: CapturedCall) => {
    producerCalls.push(params);
    producerSawText.push(latestAssistantText(params.conversationId));
  },
}));

// Notify-mode schedules emit through the pipeline; stub it so the mode-scoping
// test does not need a live notification stack.
mock.module("../notifications/emit-signal.js", () => ({
  emitNotificationSignal: async () => ({
    signalId: "sig-1",
    deduplicated: false,
    dispatched: true,
    reason: "ok",
    deliveryResults: [],
  }),
}));

import type { AssistantEvent } from "../api/index.js";
import { getConfig } from "../config/loader.js";
import type { Conversation } from "../daemon/conversation.js";
import {
  type AbortContext,
  abortScheduledRun,
} from "../daemon/conversation-lifecycle.js";
import {
  MessageQueue,
  type QueuedDispatch,
} from "../daemon/conversation-queue-manager.js";
import {
  clearConversations,
  setConversation,
  setSubagentConversation,
} from "../daemon/conversation-registry.js";
import { addMessage } from "../persistence/conversation-crud.js";
import { getDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import { wakeAgentForOpportunity } from "../runtime/agent-wake.js";
import { createSchedule, getScheduleRuns } from "../schedule/schedule-store.js";
import { runDueSchedulesOnce } from "../schedule/scheduler.js";
import { getSubagentManager } from "../subagent/index.js";
import type { SubagentState } from "../subagent/types.js";
import {
  _clearRegistryForTesting,
  cancelBackgroundTool,
  registerBackgroundTool,
  removeBackgroundTool,
} from "../tools/background-tool-registry.js";
import { setConfig } from "./helpers/set-config.js";

await initializeDb();

function getRawDb(): import("bun:sqlite").Database {
  return (getDb() as unknown as { $client: import("bun:sqlite").Database })
    .$client;
}

function latestAssistantText(conversationId: string): string | undefined {
  const rows = getRawDb()
    .query(
      `SELECT content FROM messages
         WHERE conversation_id = ? AND role = 'assistant'
         ORDER BY created_at DESC, rowid DESC LIMIT 1`,
    )
    .all(conversationId) as { content: string }[];
  return rows[0]?.content;
}

/**
 * Put a live child under `parentConversationId` so the scheduler sees that this
 * run delegated. Returns a handle that settles it, mirroring what a real
 * child's teardown does.
 */
function attachRunningChild(
  parentConversationId: string,
  cronRunId?: string,
): {
  settle: () => void;
} {
  const manager = getSubagentManager();
  const internals = manager as unknown as {
    subagents: Map<
      string,
      {
        conversation: unknown;
        state: SubagentState;
        parentSendToClient: (msg: AssistantEvent) => void;
        runInFlight?: boolean;
      }
    >;
    parentToChildren: Map<string, Set<string>>;
  };
  const subagentId = `sub-${parentConversationId}-${cronRunId ?? "default"}`;
  const entry = {
    conversation: null,
    state: {
      config: {
        id: subagentId,
        parentConversationId,
        cronRunId,
        label: "advisor",
        objective: "Advise on the briefing",
        role: "advisor",
      },
      status: "running" as const,
      conversationId: `conv-${subagentId}`,
      isFork: false,
      createdAt: Date.now(),
      usage: { inputTokens: 0, outputTokens: 0, estimatedCost: 0 },
    } as unknown as SubagentState,
    parentSendToClient: () => {},
    runInFlight: true,
  };
  internals.subagents.set(subagentId, entry);
  const children =
    internals.parentToChildren.get(parentConversationId) ?? new Set<string>();
  children.add(subagentId);
  internals.parentToChildren.set(parentConversationId, children);
  return {
    settle: () => {
      entry.state.status = "completed";
      entry.runInFlight = false;
    },
  };
}

function forceScheduleDue(scheduleId: string): void {
  getRawDb().run("UPDATE cron_jobs SET next_run_at = ? WHERE id = ?", [
    Date.now() - 1000,
    scheduleId,
  ]);
}

describe("schedule result notification wiring", () => {
  beforeEach(() => {
    const db = getDb();
    db.run("DELETE FROM cron_runs");
    db.run("DELETE FROM cron_jobs");
    db.run("DELETE FROM messages");
    db.run("DELETE FROM conversations");
    producerCalls.length = 0;
    producerSawText.length = 0;
    runBackgroundJobShouldFail = false;
    clearConversations();
    _clearRegistryForTesting();
    delegateOnRun = undefined;
  });

  test("a successful execute-mode run reaches the producer", async () => {
    const schedule = await createSchedule({
      name: "Morning briefing",
      cronExpression: "0 9 * * *",
      message: "Summarize my inbox",
      syntax: "cron",
      expression: "0 9 * * *",
    });
    forceScheduleDue(schedule.id);

    await runDueSchedulesOnce();

    expect(producerCalls).toHaveLength(1);
    expect(producerCalls[0].scheduleId).toBe(schedule.id);
    expect(producerCalls[0].scheduleName).toBe("Morning briefing");
    expect(producerCalls[0].conversationId).toBeTruthy();

    // The producer must be handed the run the scheduler actually recorded, so
    // its dedupe key names this firing and not some other.
    const runs = getScheduleRuns(schedule.id);
    expect(producerCalls[0].runId).toBe(runs[0].id);
    expect(runs[0].conversationId).toBe(producerCalls[0].conversationId);
  });

  test("a successful quiet execute-mode run does not reach the producer", async () => {
    // Quiet suppresses the automatic schedule-result fallback. The run still
    // completes; only the completion notification is skipped.
    const schedule = await createSchedule({
      name: "Morning briefing",
      cronExpression: "0 9 * * *",
      message: "Summarize my inbox",
      syntax: "cron",
      expression: "0 9 * * *",
      quiet: true,
    });
    forceScheduleDue(schedule.id);

    await runDueSchedulesOnce();

    expect(getScheduleRuns(schedule.id)[0].status).toBe("ok");
    expect(producerCalls).toHaveLength(0);
  });

  test("waits for a delegated advisor so the result is the informed reply", async () => {
    // A scheduled turn that consults an advisor resolves as soon as its own
    // reply is written. The advisor's guidance arrives later, through a
    // continuation turn, and the producer fires once and reads the latest row.
    // Without the wait the schedule ships the pre-consult reply and the
    // guidance never reaches the user at all.
    const schedule = await createSchedule({
      name: "Morning briefing",
      cronExpression: "0 9 * * *",
      message: "Summarize my inbox",
      syntax: "cron",
      expression: "0 9 * * *",
    });
    forceScheduleDue(schedule.id);

    delegateOnRun = (conversationId) => {
      // The turn's own reply, written before the guidance exists.
      addMessage(conversationId, "assistant", "Here is a first pass.");

      const cronRunId = getScheduleRuns(schedule.id)[0].id;
      const child = attachRunningChild(conversationId, cronRunId);
      let continuationRunning = false;
      setConversation(conversationId, {
        isProcessing: () => continuationRunning,
        currentTurnCronRunId: cronRunId,
        snapshotQueuedMessages: () => [],
      } as unknown as Conversation);

      // The advisor settles, then its notification starts the continuation
      // that writes the reply its guidance informed.
      setTimeout(() => {
        child.settle();
        continuationRunning = true;
        setTimeout(() => {
          addMessage(
            conversationId,
            "assistant",
            "Revised with the advisor's guidance.",
          );
          continuationRunning = false;
        }, 120);
      }, 120);
    };

    await runDueSchedulesOnce();

    expect(producerCalls).toHaveLength(1);
    // The row the real producer would have read.
    expect(producerSawText[0]).toContain("advisor's guidance");
  });

  test("a run that delegated nothing reaches the producer without waiting", async () => {
    // The wait must cost an ordinary schedule nothing: no children means
    // there is nothing to settle.
    const schedule = await createSchedule({
      name: "Morning briefing",
      cronExpression: "0 9 * * *",
      message: "Summarize my inbox",
      syntax: "cron",
      expression: "0 9 * * *",
    });
    forceScheduleDue(schedule.id);

    delegateOnRun = (conversationId) => {
      addMessage(conversationId, "assistant", "Done.");
    };

    const before = Date.now();
    await runDueSchedulesOnce();

    expect(producerCalls).toHaveLength(1);
    expect(producerSawText[0]).toContain("Done.");
    expect(Date.now() - before).toBeLessThan(200);
  });

  for (const quiet of [false, true]) {
    for (const status of ["completed", "failed", "cancelled"] as const) {
      test(`waits for a ${status} background command and its final wake (quiet=${quiet})`, async () => {
        const schedule = await createSchedule({
          name: "Background report",
          message: "Run the report in the background",
          syntax: "cron",
          expression: "0 9 * * *",
          quiet,
        });
        forceScheduleDue(schedule.id);
        const started = Promise.withResolvers<string>();
        const finishWake = Promise.withResolvers<void>();
        delegateOnRun = (conversationId) => {
          addMessage(conversationId, "assistant", "The command is running.");
          setConversation(conversationId, {
            isProcessing: () => false,
            snapshotQueuedMessages: () => [],
          } as unknown as Conversation);
          registerBackgroundTool({
            id: "bg-scheduled",
            cronRunId: getScheduleRuns(schedule.id)[0].id,
            conversationId,
            toolName: "bash",
            command: "generate-report",
            startedAt: Date.now(),
            cancel: () => {},
          });
          if (status === "cancelled") {
            cancelBackgroundTool("bg-scheduled");
          }
          started.resolve(conversationId);
        };

        let scheduleSettled = false;
        const scheduledRun = runDueSchedulesOnce().then(() => {
          scheduleSettled = true;
        });
        const conversationId = await started.promise;
        await new Promise((resolve) => setTimeout(resolve, 250));
        expect(scheduleSettled).toBe(false);
        expect(producerCalls).toHaveLength(0);

        clearConversations();
        removeBackgroundTool("bg-scheduled");
        const wake = wakeAgentForOpportunity(
          {
            conversationId,
            cronRunId: getScheduleRuns(schedule.id)[0].id,
            hint: `Background command ${status}`,
            source: "background-tool",
          },
          {
            resolveTarget: async () => {
              await finishWake.promise;
              addMessage(
                conversationId,
                "assistant",
                `Final result: ${status}.`,
              );
              return null;
            },
          },
        );
        await new Promise((resolve) => setTimeout(resolve, 250));
        expect(scheduleSettled).toBe(false);
        expect(producerCalls).toHaveLength(0);

        finishWake.resolve();
        await wake;
        await scheduledRun;
        expect(getScheduleRuns(schedule.id)[0].status).toBe("ok");
        expect(producerCalls).toHaveLength(quiet ? 0 : 1);
        if (!quiet) {
          expect(producerSawText).toEqual([`Final result: ${status}.`]);
        }
      });
    }
  }

  for (const quiet of [false, true]) {
    for (const kind of ["bash", "host_bash", "wake", "subagent"] as const) {
      test(`a timed-out ${kind} fails without a partial result (quiet=${quiet})`, async () => {
        const timeouts = getConfig().timeouts;
        setConfig("timeouts", { ...timeouts, scheduleTurnTimeoutSec: 1 });
        const schedule = await createSchedule({
          name: "Background report",
          message: "Prepare the report",
          syntax: "cron",
          expression: "0 9 * * *",
          maxRetries: 1,
          quiet,
        });
        forceScheduleDue(schedule.id);
        let cancelled = false;
        let parentAborted = false;
        let wake: ReturnType<typeof wakeAgentForOpportunity> | undefined;
        const finishLookup = Promise.withResolvers<void>();
        delegateOnRun = (conversationId) => {
          addMessage(
            conversationId,
            "assistant",
            "The report is still running.",
          );
          const cronRunId = getScheduleRuns(schedule.id)[0].id;
          setConversation(conversationId, {
            isProcessing: () => false,
            snapshotQueuedMessages: () => [],
            abortScheduledRun: (runId: string) => {
              expect(runId).toBe(cronRunId);
              parentAborted = true;
            },
          } as unknown as Conversation);
          if (kind === "wake") {
            wake = wakeAgentForOpportunity(
              {
                conversationId,
                cronRunId: getScheduleRuns(schedule.id)[0].id,
                source: "background-tool",
                hint: "The command finished",
              },
              {
                resolveTarget: async () => {
                  await finishLookup.promise;
                  return {
                    waitForIdle: async () => true,
                    isProcessing: () => false,
                  } as unknown as Conversation;
                },
              },
            );
          } else {
            let toolConversationId = conversationId;
            if (kind === "subagent") {
              attachRunningChild(conversationId, cronRunId);
              toolConversationId =
                getSubagentManager().getChildrenOf(conversationId)[0]
                  .conversationId;
            }
            registerBackgroundTool({
              id: "bg-timeout",
              cronRunId,
              conversationId: toolConversationId,
              toolName: kind,
              command: "generate-report",
              startedAt: Date.now(),
              cancel: () => {
                cancelled = true;
                removeBackgroundTool("bg-timeout");
              },
            });
          }
        };
        try {
          const result = await runDueSchedulesOnce();
          expect(getScheduleRuns(schedule.id)[0]).toMatchObject({
            status: "error",
            error: "Scheduled work did not finish before its time limit",
          });
          expect(producerCalls).toHaveLength(0);
          expect(parentAborted).toBe(true);
          if (kind !== "wake") {
            expect(cancelled).toBe(true);
          }
          finishLookup.resolve();
          if (wake) {
            expect(await wake).toMatchObject({
              invoked: false,
              reason: "timeout",
            });
          }
          expect(result.failed).toBe(1);
        } finally {
          finishLookup.resolve();
          await wake;
          removeBackgroundTool("bg-timeout");
          setConfig("timeouts", timeouts);
        }
      });
    }
  }

  for (const userTurnActive of [true, false]) {
    test(`timeout preserves unrelated work (user turn active=${userTurnActive})`, async () => {
      const timeouts = getConfig().timeouts;
      setConfig("timeouts", { ...timeouts, scheduleTurnTimeoutSec: 1 });
      const schedule = await createSchedule({
        name: "Report",
        message: "Prepare a report",
        syntax: "cron",
        expression: "0 9 * * *",
        maxRetries: 1,
      });
      forceScheduleDue(schedule.id);
      const controller = new AbortController();
      const queue = new MessageQueue();
      const userEvents: string[] = [];
      const cancelledTools: string[] = [];
      let conversationId = "";
      let runId = "";
      let settleUserChild: (() => void) | undefined;
      delegateOnRun = (id) => {
        conversationId = id;
        runId = getScheduleRuns(schedule.id)[0].id;
        const ctx = {
          conversationId: id,
          currentTurnCronRunId: userTurnActive ? undefined : runId,
          isProcessing: () => true,
          setProcessing: () => {},
          abortController: controller,
          queue,
          pendingInterruptRepair: false,
          prompter: { dispose: () => {} },
          secretPrompter: { dispose: () => {} },
          pendingSurfaceActions: new Map(),
          surfaceActionRequestIds: new Set(),
          surfaceState: new Map(),
          accumulatedSurfaceState: new Map(),
          kickDrainQueue: async () => {},
        } as unknown as AbortContext;
        setConversation(id, {
          ...ctx,
          snapshotQueuedMessages: () => queue.snapshot(),
          abortScheduledRun: (run: string) => abortScheduledRun(ctx, run),
        } as unknown as Conversation);
        for (const owner of [undefined, runId, "run-other"]) {
          queue.push({
            content: "Follow-up",
            attachments: [],
            requestId: `queued-${owner ?? "user"}`,
            sentAt: Date.now(),
            cronRunId: owner,
            onEvent: (event) => {
              if (owner !== runId) {
                userEvents.push(event.type);
              }
            },
          });
          const id = `tool-${owner ?? "user"}`;
          registerBackgroundTool({
            id,
            cronRunId: owner,
            conversationId,
            toolName: "bash",
            command: "example-command",
            startedAt: Date.now(),
            cancel: () => {
              cancelledTools.push(id);
              removeBackgroundTool(id);
            },
          });
        }
        attachRunningChild(id, runId);
        settleUserChild = attachRunningChild(id).settle;
      };
      try {
        await runDueSchedulesOnce();
        expect(controller.signal.aborted).toBe(!userTurnActive);
        expect(queue.snapshot().map((message) => message.requestId)).toEqual([
          "queued-user",
          "queued-run-other",
        ]);
        expect(userEvents).toEqual([]);
        expect(cancelledTools).toEqual([`tool-${runId}`]);
        const children = getSubagentManager().getChildrenOf(conversationId);
        expect(
          children.find((child) => child.config.cronRunId === runId)?.status,
        ).toBe("aborted");
        expect(
          children.find((child) => child.config.cronRunId === undefined)
            ?.status,
        ).toBe("running");
        expect(producerCalls).toHaveLength(0);
      } finally {
        settleUserChild?.();
        _clearRegistryForTesting();
        setConfig("timeouts", timeouts);
      }
    });
  }

  for (const kind of [
    "turn",
    "queue",
    "command",
    "child",
    "wake",
    "dispatch",
  ] as const) {
    test(`unrelated ${kind} does not keep a settled firing open`, async () => {
      const timeouts = getConfig().timeouts;
      setConfig("timeouts", { ...timeouts, scheduleTurnTimeoutSec: 1 });
      const schedule = await createSchedule({
        name: "Report",
        message: "Prepare a report",
        syntax: "cron",
        expression: "0 9 * * *",
      });
      forceScheduleDue(schedule.id);
      const delegated = Promise.withResolvers<void>();
      const releaseWake = Promise.withResolvers<void>();
      let wake: ReturnType<typeof wakeAgentForOpportunity> | undefined;
      let userChild: ReturnType<typeof attachRunningChild> | undefined;
      let conversationId = "";
      delegateOnRun = (id) => {
        conversationId = id;
        const runId = getScheduleRuns(schedule.id)[0].id;
        const queue = new MessageQueue();
        if (kind === "queue") {
          queue.push({
            content: "User follow-up",
            attachments: [],
            requestId: "queued-user",
            sentAt: Date.now(),
            onEvent: () => {},
          });
        }
        setConversation(id, {
          isProcessing: () => kind === "turn",
          currentTurnCronRunId: undefined,
          pendingQueuedDispatches:
            kind === "dispatch"
              ? new Map<string | null, Set<QueuedDispatch>>([
                  [
                    "run-other",
                    new Set([
                      { controller: new AbortController(), messages: [] },
                    ]),
                  ],
                  [
                    null,
                    new Set([
                      { controller: new AbortController(), messages: [] },
                    ]),
                  ],
                ])
              : new Map(),
          snapshotQueuedMessages: () => queue.snapshot(),
        } as unknown as Conversation);
        registerBackgroundTool({
          id: "owned-command",
          conversationId: id,
          cronRunId: runId,
          toolName: "bash",
          command: "report",
          startedAt: Date.now(),
          cancel: () => {},
        });
        if (kind === "command") {
          registerBackgroundTool({
            id: "user-command",
            conversationId: id,
            toolName: "bash",
            command: "user-work",
            startedAt: Date.now(),
            cancel: () => {},
          });
        }
        if (kind === "child") {
          userChild = attachRunningChild(id);
        }
        if (kind === "wake") {
          wake = wakeAgentForOpportunity(
            {
              conversationId: id,
              source: "background-tool",
              hint: "Unrelated result",
              cronRunId: "run-other",
            },
            {
              resolveTarget: async () => {
                await releaseWake.promise;
                return null;
              },
            },
          );
        }
        delegated.resolve();
      };
      try {
        const scheduledRun = runDueSchedulesOnce();
        await delegated.promise;
        await new Promise((resolve) => setTimeout(resolve, 150));
        expect(producerCalls).toHaveLength(0);
        addMessage(conversationId, "assistant", "Report finished.");
        removeBackgroundTool("owned-command");
        await scheduledRun;
        expect(getScheduleRuns(schedule.id)[0].status).toBe("ok");
        expect(producerSawText).toEqual(["Report finished."]);
      } finally {
        releaseWake.resolve();
        await wake;
        userChild?.settle();
        _clearRegistryForTesting();
        setConfig("timeouts", timeouts);
      }
    });
  }

  for (const location of [
    "parent",
    "completed-child",
    "reused-child",
  ] as const) {
    test(`waits for owned queued work in a ${location}`, async () => {
      const schedule = await createSchedule({
        name: "Report",
        message: "Prepare a report",
        syntax: "cron",
        expression: "0 9 * * *",
      });
      forceScheduleDue(schedule.id);
      const delegated = Promise.withResolvers<string>();
      const queue = new MessageQueue();
      delegateOnRun = (id) => {
        const runId = getScheduleRuns(schedule.id)[0].id;
        queue.push({
          content: "Continue report",
          attachments: [],
          requestId: "queued-schedule",
          sentAt: Date.now(),
          cronRunId: runId,
          onEvent: () => {},
        });
        const live = {
          isProcessing: () => false,
          snapshotQueuedMessages: () => queue.snapshot(),
        } as unknown as Conversation;
        if (location === "parent") {
          setConversation(id, live);
        } else {
          attachRunningChild(
            id,
            location === "reused-child" ? undefined : runId,
          ).settle();
          setSubagentConversation(
            getSubagentManager().getChildrenOf(id)[0].conversationId,
            live,
          );
        }
        delegated.resolve(id);
      };
      const scheduledRun = runDueSchedulesOnce();
      const id = await delegated.promise;
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(producerCalls).toHaveLength(0);
      addMessage(id, "assistant", "Final report.");
      queue.clear();
      await scheduledRun;
      expect(getScheduleRuns(schedule.id)[0].status).toBe("ok");
      expect(producerSawText).toEqual(["Final report."]);
    });
  }

  test("waits for a dequeued dispatch before its processing claim", async () => {
    const schedule = await createSchedule({
      name: "Report",
      message: "Prepare report",
      syntax: "cron",
      expression: "0 9 * * *",
    });
    forceScheduleDue(schedule.id);
    const entered = Promise.withResolvers<string>();
    const dispatches = new Map<string, Set<QueuedDispatch>>();
    delegateOnRun = (id) => {
      dispatches.set(
        getScheduleRuns(schedule.id)[0].id,
        new Set([{ controller: new AbortController(), messages: [] }]),
      );
      setConversation(id, {
        isProcessing: () => false,
        snapshotQueuedMessages: () => [],
        pendingQueuedDispatches: dispatches,
      } as unknown as Conversation);
      entered.resolve(id);
    };
    const scheduledRun = runDueSchedulesOnce();
    const id = await entered.promise;
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(producerCalls).toHaveLength(0);
    addMessage(id, "assistant", "Final report.");
    dispatches.clear();
    await scheduledRun;
    expect(getScheduleRuns(schedule.id)[0].status).toBe("ok");
    expect(producerSawText).toEqual(["Final report."]);
  });

  test("captures runStartedAt before the run, not after", async () => {
    const before = Date.now();
    const schedule = await createSchedule({
      name: "Morning briefing",
      cronExpression: "0 9 * * *",
      message: "Summarize my inbox",
      syntax: "cron",
      expression: "0 9 * * *",
    });
    forceScheduleDue(schedule.id);

    await runDueSchedulesOnce();

    // Stamped at or after the moment this test began and at or before the
    // run's own reply. A timestamp taken after the run would sit past any
    // notification the run emitted, so the probe would miss it and every
    // well-authored schedule would notify twice.
    const runs = getScheduleRuns(schedule.id);
    expect(producerCalls[0].runStartedAt).toBeGreaterThanOrEqual(before);
    expect(producerCalls[0].runStartedAt).toBeLessThanOrEqual(
      runs[0].startedAt,
    );
  });

  test("a failed run does not reach the producer", async () => {
    // A failure has its own alerting path (the retry policy's exhaustion
    // alert). Notifying here would pair every failure with a second message
    // carrying whatever half-finished text the run left behind.
    runBackgroundJobShouldFail = true;
    const schedule = await createSchedule({
      name: "Morning briefing",
      cronExpression: "0 9 * * *",
      message: "Summarize my inbox",
      syntax: "cron",
      expression: "0 9 * * *",
    });
    forceScheduleDue(schedule.id);

    await runDueSchedulesOnce();

    expect(getScheduleRuns(schedule.id)[0].status).toBe("error");
    expect(producerCalls).toHaveLength(0);
  });

  test("notify-mode schedules are left alone", async () => {
    // Notify mode already is a notification; the fallback would duplicate it.
    const schedule = await createSchedule({
      name: "Drink water",
      cronExpression: "0 9 * * *",
      message: "Time to drink water",
      syntax: "cron",
      expression: "0 9 * * *",
      mode: "notify",
    });
    forceScheduleDue(schedule.id);

    await runDueSchedulesOnce();

    expect(getScheduleRuns(schedule.id)[0].status).toBe("ok");
    expect(producerCalls).toHaveLength(0);
  });

  test("script-mode schedules are left alone", async () => {
    // No agent turn runs, so there is no reply to carry and nothing the
    // producer could say.
    const schedule = await createSchedule({
      name: "Rotate logs",
      cronExpression: "0 9 * * *",
      message: "unused",
      syntax: "cron",
      expression: "0 9 * * *",
      mode: "script",
      script: "true",
    });
    forceScheduleDue(schedule.id);

    await runDueSchedulesOnce();

    expect(producerCalls).toHaveLength(0);
  });
});
