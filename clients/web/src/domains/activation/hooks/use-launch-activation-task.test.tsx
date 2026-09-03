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
import { act, cleanup, renderHook } from "@testing-library/react";

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
let startStatus = 200;
let sendStatus = 200;
let sendThrows = false;
let mintCounter = 0;

const emitMock = mock(() => {});

// Every `mock.module` spreads the real module: it replaces the module for
// every test file sharing this process, so returning only the mocked exports
// would erase the rest for anything that loads it later.
const telemetry = await import("@/utils/activation-telemetry");
mock.module("@/utils/activation-telemetry", () => ({
  ...telemetry,
  emitActivationEvent: emitMock,
}));

const { useLaunchActivationTask } = await import(
  "@/domains/activation/hooks/use-launch-activation-task"
);
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
        if (createStatus !== 200) {
          return json(createStatus, { detail: "no conversation for you" });
        }
        return json(200, {
          id: `conv-${++mintCounter}`,
          conversationKey: "",
          conversationType: "standard",
          created: true,
        });
      case "start":
        if (startStatus !== 200) {
          return json(startStatus, { detail: "task id rejected" });
        }
        return json(200, { taskId: "t", status: "started" });
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

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
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
  startStatus = 200;
  sendStatus = 200;
  sendThrows = false;
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

  test("sends a custom prompt in place of the catalog one", async () => {
    const result = launcher();
    await act(async () => {
      await result.current.launch("pdf-proposal", "  quote for Bob  ");
    });

    expect(requestFor("send").body.content).toBe("quote for Bob");
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

  // An unlinked prompt would run a task the checklist can never observe, and
  // the conversation created for it has no owner, so it is given back.
  test("never sends when the link fails, and discards the conversation", async () => {
    startStatus = 500;
    const result = launcher();
    let outcome;
    await act(async () => {
      outcome = await result.current.launch("pdf-proposal");
    });

    expect(calls.slice(0, 2)).toEqual(["create", "start"]);
    expect(calls).not.toContain("send");
    expect(outcome).toMatchObject({ ok: false, error: "task id rejected" });
    expect(requestFor("discard").url).toContain("/conversations/conv-1");
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
    expect(result.current.pendingTaskId).toBeNull();
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
