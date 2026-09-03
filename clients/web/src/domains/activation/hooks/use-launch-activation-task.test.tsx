/**
 * The launch contract: create the conversation, link it, then send, and never
 * reject whatever the transport does.
 *
 * Mocked at the transport (`fetch`), not at the seams under test. The bug this
 * file exists to hold shut lives in the wire field `postChatMessage` picks: a
 * conversation id the daemon has never seen is looked up strictly on every
 * assistant new enough to serve the activation routes, so a launch that sends
 * against an unmaterialized id 404s every time. Only a test that reaches the
 * request body can see that, which is why the SDK and `sendBackgroundPrompt`
 * are both real here.
 */

import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
} from "@testing-library/react";

import {
  ACTIVATION_PROGRESS_EMPTY,
  doneTaskProgress,
  startedTaskProgress,
} from "@/domains/activation/activation-test-fixtures";
import { getActivationList } from "@/domains/activation/catalog";
import { ActivationListPage } from "@/domains/activation/components/activation-list-page";
import type { ActivationProgress } from "@/domains/activation/hooks/use-activation-progress";
import { activationProgressGetQueryKey } from "@/generated/daemon/@tanstack/react-query.gen";
import { MIN_VERSION } from "@/lib/backwards-compat/use-supports-activation-progress";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";

interface CapturedRequest {
  url: string;
  method: string;
  body: Record<string, unknown>;
}

const requests: CapturedRequest[] = [];

/** Which leg of the launch a request belongs to. */
type Leg = "create" | "start" | "send" | "discard";

function legOf(url: string, method: string): Leg | null {
  if (url.includes("/activation/tasks/")) {
    return "start";
  }
  if (url.includes("/messages")) {
    return "send";
  }
  if (url.includes("/conversations")) {
    return method === "DELETE" ? "discard" : "create";
  }
  return null;
}

const calls: Leg[] = [];

let createStatus = 200;
/** The `detail` the create leg answers with; `null` for a body carrying none. */
let createDetail: string | null = "no conversation for you";
let startStatus = 200;
/**
 * What the start leg answers with. The daemon returns the whole progress
 * document; the default here is the older shape, which is the fallback path.
 */
let startBody: unknown = { taskId: "t", status: "started" };
let sendStatus = 200;
let sendThrows = false;
let startThrows = false;
let mintCounter = 0;
/** While true, the create leg parks until `releaseCreates()` lets it answer. */
let holdCreates = false;
let parkedCreates: Array<() => void> = [];

function releaseCreates(): void {
  holdCreates = false;
  const parked = parkedCreates;
  parkedCreates = [];
  for (const resume of parked) {
    resume();
  }
}

const emitMock = mock(() => {});

// Every `mock.module` spreads the real module: it replaces the module for
// every test file sharing this process, so returning only the mocked exports
// would erase the rest for anything that loads it later.
const telemetry = await import("@/utils/activation-telemetry");
mock.module("@/utils/activation-telemetry", () => ({
  ...telemetry,
  emitActivationEvent: emitMock,
}));

const { useLaunchActivationTask } =
  await import("@/domains/activation/hooks/use-launch-activation-task");
type LaunchActivationTaskResult = Awaited<
  ReturnType<ReturnType<typeof useLaunchActivationTask>["launch"]>
>;

const originalFetch = globalThis.fetch;

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function installFetch(): void {
  globalThis.fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = input instanceof Request ? input.url : String(input);
    const method = (
      input instanceof Request ? input.method : (init?.method ?? "GET")
    ).toUpperCase();
    let bodyText: string | undefined;
    if (input instanceof Request) {
      bodyText = await input.clone().text();
    } else if (typeof init?.body === "string") {
      bodyText = init.body;
    }
    const leg = legOf(url, method);
    if (leg === null) {
      return json(200, {});
    }
    calls.push(leg);
    requests.push({
      url,
      method,
      body: bodyText ? (JSON.parse(bodyText) as Record<string, unknown>) : {},
    });
    switch (leg) {
      case "create":
        if (holdCreates) {
          await new Promise<void>((resolve) => parkedCreates.push(resolve));
        }
        if (createStatus !== 200) {
          return json(
            createStatus,
            createDetail === null ? {} : { detail: createDetail },
          );
        }
        return json(200, {
          id: `conv-${++mintCounter}`,
          conversationKey: "",
          conversationType: "standard",
          created: true,
        });
      case "start":
        if (startThrows) {
          throw new TypeError("network down");
        }
        if (startStatus !== 200) {
          return json(startStatus, { detail: "task id rejected" });
        }
        return json(200, startBody);
      case "send":
        if (sendThrows) {
          throw new TypeError("network down");
        }
        if (sendStatus !== 200) {
          return json(sendStatus, { detail: "daemon said no" });
        }
        return json(200, {
          accepted: true,
          messageId: "m1",
          conversationId: `conv-${mintCounter}`,
        });
      case "discard":
        return json(200, { success: true });
    }
  }) as typeof fetch;
}

let queryClient = new QueryClient();

function newQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

function wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

const PROGRESS_KEY = activationProgressGetQueryKey({
  path: { assistant_id: "asst-1" },
});

/** What `useActivationProgress` would read right now, without refetching. */
function cachedProgress(): ActivationProgress | undefined {
  return queryClient.getQueryData<ActivationProgress>(PROGRESS_KEY);
}

function launcher() {
  const { result } = renderHook(() => useLaunchActivationTask("smb"), {
    wrapper,
  });
  return result;
}

/** Every request belonging to one leg of the launch. */
function requestsFor(leg: Leg): CapturedRequest[] {
  return requests.filter(
    (request) => legOf(request.url, request.method) === leg,
  );
}

/** The single request for one leg of the launch. */
function requestFor(leg: Leg): CapturedRequest {
  const matches = requestsFor(leg);
  expect(matches).toHaveLength(1);
  return matches[0]!;
}

beforeEach(() => {
  calls.length = 0;
  requests.length = 0;
  mintCounter = 0;
  createStatus = 200;
  createDetail = "no conversation for you";
  startStatus = 200;
  startBody = { taskId: "t", status: "started" };
  sendStatus = 200;
  sendThrows = false;
  startThrows = false;
  holdCreates = false;
  parkedCreates = [];
  queryClient = newQueryClient();
  emitMock.mockClear();
  installFetch();
  useResolvedAssistantsStore.setState({ activeAssistantId: "asst-1" });
  useAssistantIdentityStore
    .getState()
    .setIdentity("Vel", MIN_VERSION, "asst-1");
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  useAssistantIdentityStore.getState().clearIdentity();
});

describe("useLaunchActivationTask", () => {
  test("creates the conversation, links it, then sends", async () => {
    const result = launcher();
    await act(async () => {
      await result.current.launch("pdf-proposal");
    });

    expect(calls).toEqual(["create", "start", "send"]);
    expect(requestFor("start").body).toMatchObject({
      conversationId: "conv-1",
      listId: "smb",
    });
    expect(requestFor("start").url).toContain(
      "/activation/tasks/pdf-proposal/start",
    );
  });

  // The regression: the daemon looks a `conversationId` up strictly, so the id
  // on the wire has to be one it minted, carried in that field.
  test("sends against the daemon-created conversation, in the strict wire field", async () => {
    const result = launcher();
    await act(async () => {
      await result.current.launch("pdf-proposal");
    });

    const send = requestFor("send");
    expect(send.body.conversationId).toBe("conv-1");
    expect(send.body).not.toHaveProperty("conversationKey");
  });

  test("sends the catalog prompt for the task", async () => {
    const result = launcher();
    await act(async () => {
      await result.current.launch("pdf-proposal");
    });

    expect(requestFor("send").body.content).toContain("PDF proposal");
  });

  // The catalog prompt is generated, not typed, so activation analytics has to
  // be able to exclude the turn. An omitted marker reads as unknown, not false.
  test("marks the catalog turn as scripted on the wire", async () => {
    const result = launcher();
    await act(async () => {
      await result.current.launch("pdf-proposal");
    });

    expect(requestFor("send").body.scripted).toBe(true);
  });

  test("sends a custom prompt in place of the catalog one", async () => {
    const result = launcher();
    await act(async () => {
      await result.current.launch("pdf-proposal", "  quote for Bob  ");
    });

    expect(requestFor("send").body.content).toBe("quote for Bob");
  });

  // The user wrote these words into the row's Custom field, so the turn is
  // real engagement; marking it scripted would delete it from the experiment.
  test("marks a custom prompt as typed on the wire", async () => {
    const result = launcher();
    await act(async () => {
      await result.current.launch("pdf-proposal", "  quote for Bob  ");
    });

    expect(requestFor("send").body.scripted).toBe(false);
  });

  // A blank Custom field is not a custom prompt: the catalog one is sent, so
  // the turn is scripted like any other catalog launch.
  test("marks a blank override as scripted, sending the catalog prompt", async () => {
    const result = launcher();
    await act(async () => {
      await result.current.launch("pdf-proposal", "   ");
    });

    const send = requestFor("send");
    expect(send.body.content).toContain("PDF proposal");
    expect(send.body.scripted).toBe(true);
  });

  test("never links or sends when the conversation cannot be created", async () => {
    createStatus = 500;
    const result = launcher();
    let outcome;
    await act(async () => {
      outcome = await result.current.launch("pdf-proposal");
    });

    expect(calls).toEqual(["create"]);
    expect(outcome).toMatchObject({
      ok: false,
      error: "no conversation for you",
    });
  });

  // The create leg's own fallback is the translated launch copy, not the
  // generic English string the shared error helper defaults to.
  test("reports a create failure that carries no message in the launch copy", async () => {
    createStatus = 500;
    createDetail = null;
    const result = launcher();
    let outcome;
    await act(async () => {
      outcome = await result.current.launch("pdf-proposal");
    });

    expect(outcome).toMatchObject({
      ok: false,
      error: "Could not start the task. Please try again.",
    });
  });

  // An unlinked prompt would run a task the checklist can never observe, and a
  // conversation the daemon answered and refused to link has no owner, so it
  // is given back.
  test("never sends when the daemon refuses the link, and discards the conversation", async () => {
    startStatus = 400;
    const result = launcher();
    let outcome;
    await act(async () => {
      outcome = await result.current.launch("pdf-proposal");
    });

    expect(calls.slice(0, 2)).toEqual(["create", "start"]);
    expect(calls).not.toContain("send");
    expect(outcome).toMatchObject({ ok: false, error: "task id rejected" });
    expect(outcome).not.toHaveProperty("conversationId");
    expect(requestFor("discard").url).toContain("/conversations/conv-1");
  });

  // A 5xx can land after the daemon persisted the link, so deleting the
  // conversation would strand a `started` task pointing at a row that is gone.
  test("keeps the conversation when the link fails with a server error", async () => {
    startStatus = 500;
    const result = launcher();
    let outcome;
    await act(async () => {
      outcome = await result.current.launch("pdf-proposal");
    });

    expect(calls).toEqual(["create", "start"]);
    expect(requestsFor("discard")).toHaveLength(0);
    expect(outcome).toMatchObject({
      ok: false,
      conversationId: "conv-1",
      error: "task id rejected",
    });
  });

  // A transport that never answers says nothing about whether the write
  // landed, so the conversation is kept for the row to recover with.
  test("keeps the conversation when the link throws instead of answering", async () => {
    startThrows = true;
    const result = launcher();
    let outcome: LaunchActivationTaskResult | undefined;
    await act(async () => {
      outcome = await result.current.launch("pdf-proposal");
    });

    expect(calls).toEqual(["create", "start"]);
    expect(requestsFor("discard")).toHaveLength(0);
    expect(outcome).toMatchObject({ ok: false, conversationId: "conv-1" });
    expect(outcome?.error).toBeTruthy();
    expect(result.current.isPending("pdf-proposal")).toBe(false);
  });

  test("reports a failed send against the conversation it linked", async () => {
    sendStatus = 500;
    const result = launcher();
    let outcome;
    await act(async () => {
      outcome = await result.current.launch("pdf-proposal");
    });

    expect(outcome).toMatchObject({
      ok: false,
      conversationId: "conv-1",
      error: "daemon said no",
    });
    expect(emitMock).not.toHaveBeenCalled();
  });

  // A transport that throws rather than answers must not escape as a rejected
  // promise: the row would sit pending forever with nothing to show.
  test("returns a result when the send throws instead of answering", async () => {
    sendThrows = true;
    const result = launcher();
    let outcome: LaunchActivationTaskResult | undefined;
    await act(async () => {
      outcome = await result.current.launch("pdf-proposal");
    });

    expect(outcome).toMatchObject({ ok: false, conversationId: "conv-1" });
    expect(outcome?.error).toBeTruthy();
    expect(emitMock).not.toHaveBeenCalled();
    expect(result.current.isPending("pdf-proposal")).toBe(false);
  });

  test("creates a fresh conversation for every launch", async () => {
    const result = launcher();
    await act(async () => {
      await result.current.launch("pdf-proposal");
      await result.current.launch("weekly-report");
    });

    expect(
      requestsFor("send").map((request) => request.body.conversationId),
    ).toEqual(["conv-1", "conv-2"]);
  });

  test("rejects a task the catalog does not carry, without creating or sending", async () => {
    const result = launcher();
    let outcome;
    await act(async () => {
      outcome = await result.current.launch("not-a-task");
    });

    expect(outcome).toMatchObject({
      ok: false,
      error: "That task is no longer available.",
    });
    expect(calls).toEqual([]);
  });

  test("does nothing without an active assistant", async () => {
    useResolvedAssistantsStore.setState({ activeAssistantId: null });
    const result = launcher();
    let outcome;
    await act(async () => {
      outcome = await result.current.launch("pdf-proposal");
    });

    expect(outcome).toMatchObject({
      ok: false,
      error: "No assistant is connected right now.",
    });
    expect(calls).toEqual([]);
  });

  test("emits the started event with the list and task", async () => {
    const result = launcher();
    await act(async () => {
      await result.current.launch("pdf-proposal");
    });

    expect(emitMock).toHaveBeenCalledWith("activation_task_started", {
      arm: expect.any(String) as never,
      listId: "smb",
      taskId: "pdf-proposal",
    });
  });
});

/**
 * The list lets the user start a second task while the first is still going,
 * so pending state is per task. A single pending id would clear on whichever
 * launch settled first and hand every other row back mid-launch.
 */
describe("useLaunchActivationTask concurrency", () => {
  test("a second launch leaves the first task pending", async () => {
    holdCreates = true;
    const result = launcher();

    let first: Promise<LaunchActivationTaskResult> | undefined;
    let second: Promise<LaunchActivationTaskResult> | undefined;
    await act(async () => {
      first = result.current.launch("pdf-proposal");
      second = result.current.launch("weekly-report");
    });

    expect(result.current.isPending("pdf-proposal")).toBe(true);
    expect(result.current.isPending("weekly-report")).toBe(true);
    expect([...result.current.pendingTaskIds].sort()).toEqual([
      "pdf-proposal",
      "weekly-report",
    ]);

    await act(async () => {
      releaseCreates();
      await first;
      await second;
    });

    expect(result.current.pendingTaskIds.size).toBe(0);
  });

  // Two conversations for one task would leave the daemon two rows to mark
  // done and run the prompt twice.
  test("a task already in flight cannot be launched again", async () => {
    holdCreates = true;
    const result = launcher();

    let first: Promise<LaunchActivationTaskResult> | undefined;
    let second: Promise<LaunchActivationTaskResult> | undefined;
    await act(async () => {
      first = result.current.launch("pdf-proposal");
      second = result.current.launch("weekly-report");
    });

    let duplicate: LaunchActivationTaskResult | undefined;
    await act(async () => {
      duplicate = await result.current.launch("pdf-proposal");
    });

    expect(duplicate).toEqual({ ok: false });
    // The refusal has nothing to tell the user: the row is already working.
    expect(duplicate?.error).toBeUndefined();
    expect(calls.filter((leg) => leg === "create")).toHaveLength(2);
    expect(result.current.isPending("pdf-proposal")).toBe(true);

    await act(async () => {
      releaseCreates();
      await first;
      await second;
    });
  });

  test("a settled launch can be started again", async () => {
    const result = launcher();
    await act(async () => {
      await result.current.launch("pdf-proposal");
    });

    expect(result.current.isPending("pdf-proposal")).toBe(false);

    let again: LaunchActivationTaskResult | undefined;
    await act(async () => {
      again = await result.current.launch("pdf-proposal");
    });

    expect(again?.ok).toBe(true);
  });
});

/**
 * The row is guarded by two things in sequence: the pending set while the
 * launch runs, then the daemon's `started` record. The write below is what
 * closes the gap between them, and without it the row falls back to Todo and
 * takes a second click that relinks the task to a second conversation.
 */
describe("useLaunchActivationTask progress cache", () => {
  const startedProgress: ActivationProgress = {
    ...ACTIVATION_PROGRESS_EMPTY,
    listId: "smb",
    tasks: {
      "pdf-proposal": startedTaskProgress({
        conversationId: "conv-1",
        stepCount: null,
      }),
    },
  };

  // Two rows launched together answer with snapshots from different points;
  // the older answer must keep the task the newer one already seeded.
  test("keeps tasks seeded by a concurrent start when an older snapshot answers", async () => {
    queryClient.setQueryData(PROGRESS_KEY, {
      ...startedProgress,
      tasks: {
        ...startedProgress.tasks,
        "weekly-report": startedTaskProgress({
          conversationId: "conv-2",
          stepCount: null,
        }),
      },
    });
    startBody = startedProgress;
    const result = launcher();
    await act(async () => {
      await result.current.launch("pdf-proposal");
    });

    expect(Object.keys(cachedProgress()?.tasks ?? {}).sort()).toEqual([
      "pdf-proposal",
      "weekly-report",
    ]);
  });

  // The snapshot a start answers with was taken while the daemon handled it,
  // so a task another launch has since finished can come back as `started`.
  // Taking that wholesale would un-finish the row and offer the task again.
  test("keeps a finished task finished when an older snapshot calls it started", async () => {
    queryClient.setQueryData(PROGRESS_KEY, {
      ...startedProgress,
      tasks: {
        "pdf-proposal": doneTaskProgress({ conversationId: "conv-1" }),
      },
    });
    startBody = {
      ...startedProgress,
      tasks: {
        "pdf-proposal": startedTaskProgress({
          conversationId: "conv-1",
          stepCount: null,
        }),
        "weekly-report": startedTaskProgress({
          conversationId: "conv-2",
          stepCount: null,
        }),
      },
    };
    const result = launcher();
    await act(async () => {
      await result.current.launch("weekly-report");
    });

    const tasks = cachedProgress()?.tasks ?? {};
    expect(tasks["pdf-proposal"]?.status).toBe("done");
    expect(tasks["weekly-report"]?.status).toBe("started");
  });

  test("writes the progress the daemon answered the start with", async () => {
    startBody = startedProgress;
    const result = launcher();
    await act(async () => {
      await result.current.launch("pdf-proposal");
    });

    expect(cachedProgress()).toEqual(startedProgress);
  });

  // An older daemon answers the start with something else, so the started task
  // is inserted into what is cached rather than taken from the answer.
  test("inserts the started task when the start answers with something else", async () => {
    queryClient.setQueryData(PROGRESS_KEY, ACTIVATION_PROGRESS_EMPTY);
    const result = launcher();
    await act(async () => {
      await result.current.launch("pdf-proposal");
    });

    expect(cachedProgress()?.tasks["pdf-proposal"]).toMatchObject({
      status: "started",
      conversationId: "conv-1",
    });
  });

  // Every surface is hidden while the progress read has not landed, so a
  // document invented here would turn them on against a daemon that never
  // answered one.
  test("invents no progress when none is cached and none is answered", async () => {
    const result = launcher();
    await act(async () => {
      await result.current.launch("pdf-proposal");
    });

    expect(cachedProgress()).toBeUndefined();
  });

  // A send that fails leaves the link standing, so the task is started and the
  // row must stay guarded whatever the prompt did.
  test("guards the row even when the prompt fails to send", async () => {
    startBody = startedProgress;
    sendStatus = 500;
    const result = launcher();
    await act(async () => {
      await result.current.launch("pdf-proposal");
    });

    expect(cachedProgress()?.tasks["pdf-proposal"]?.status).toBe("started");
  });

  test("leaves the cache alone when the daemon refuses the link", async () => {
    queryClient.setQueryData(PROGRESS_KEY, ACTIVATION_PROGRESS_EMPTY);
    startStatus = 400;
    const result = launcher();
    await act(async () => {
      await result.current.launch("pdf-proposal");
    });

    expect(cachedProgress()?.tasks).toEqual({});
  });

  // The list as the user sees it mid-launch: the rows read the cache and
  // nothing refetches, so the write above is the only thing guarding the row.
  test("the launched row is no longer launchable once the launch settles", async () => {
    startBody = startedProgress;
    const { starters, items } = getActivationList("smb");
    const tasks = [...starters, ...items];
    const launchedFromRow: string[] = [];
    const openedFromRow: string[] = [];
    let launch: ((taskId: string) => Promise<unknown>) | undefined;

    function GuardedList() {
      const launcherState = useLaunchActivationTask("smb");
      launch = launcherState.launch;
      // Read the cache directly: the hook's pending-state change re-renders
      // this component after the launch settles, and a sibling test file mocks
      // useQuery process-wide, which would hide the seeded write here.
      const data = queryClient.getQueryData<ActivationProgress>(PROGRESS_KEY);
      return (
        <ActivationListPage
          tasks={tasks}
          progress={data?.tasks ?? {}}
          pendingTaskIds={launcherState.pendingTaskIds}
          onLaunch={(taskId) => launchedFromRow.push(taskId)}
          onOpenConversation={(conversationId) =>
            openedFromRow.push(conversationId)
          }
        />
      );
    }

    render(<GuardedList />, { wrapper });
    const title = starters[0]?.title ?? "";
    await act(async () => {
      await launch?.("pdf-proposal");
    });

    fireEvent.click(screen.getByText(title).closest("button")!);

    expect(launchedFromRow).toEqual([]);
    expect(openedFromRow).toEqual(["conv-1"]);
  });
});
