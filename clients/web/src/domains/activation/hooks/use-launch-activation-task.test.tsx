/**
 * The launch contract: link before send, never send an unlinked prompt, and a
 * fresh conversation per task.
 *
 * The daemon route and the message POST are mocked; what is asserted is the
 * order and the arguments, which is where the race the daemon cannot recover
 * from lives.
 */

import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook } from "@testing-library/react";

import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";

const calls: string[] = [];

let startResult: () => Promise<unknown> = () => Promise.resolve({});
let sendOk = true;

const startMock = mock(async (options: unknown) => {
  calls.push("start");
  startArgs.push(options);
  return startResult();
});

const sendMock = mock(async (args: { conversationId: string }) => {
  calls.push("send");
  sendArgs.push(args);
  return sendOk
    ? { ok: true as const, assistantId: "asst-1", conversationId: args.conversationId, messageId: "m1" }
    : { ok: false as const, status: 500, error: { detail: "daemon said no" } };
});

const startArgs: unknown[] = [];
const sendArgs: { conversationId: string }[] = [];

let mintCounter = 0;

const emitMock = mock(() => {});

// Every `mock.module` spreads the real module: it replaces the module for
// every test file sharing this process, so returning only the mocked exports
// would erase the rest for anything that loads it later.
const queryGen = await import("@/generated/daemon/@tanstack/react-query.gen");
mock.module("@/generated/daemon/@tanstack/react-query.gen", () => ({
  ...queryGen,
  activationTasksByTaskIdStartPostMutation: () => ({ mutationFn: startMock }),
}));

const backgroundConversation = await import("@/utils/background-conversation");
mock.module("@/utils/background-conversation", () => ({
  ...backgroundConversation,
  mintBackgroundConversationId: () => `conv-${++mintCounter}`,
  sendBackgroundPrompt: sendMock,
}));

const telemetry = await import("@/utils/activation-telemetry");
mock.module("@/utils/activation-telemetry", () => ({
  ...telemetry,
  emitActivationEvent: emitMock,
}));

const { useLaunchActivationTask } = await import(
  "@/domains/activation/hooks/use-launch-activation-task"
);

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

beforeEach(() => {
  calls.length = 0;
  startArgs.length = 0;
  sendArgs.length = 0;
  mintCounter = 0;
  sendOk = true;
  startResult = () => Promise.resolve({});
  startMock.mockClear();
  sendMock.mockClear();
  emitMock.mockClear();
  useResolvedAssistantsStore.setState({ activeAssistantId: "asst-1" });
});

afterEach(() => {
  cleanup();
});

describe("useLaunchActivationTask", () => {
  test("records the link before sending the prompt", async () => {
    const result = launcher();
    await act(async () => {
      await result.current.launch("pdf-proposal");
    });

    expect(calls).toEqual(["start", "send"]);
    expect(startArgs[0]).toMatchObject({
      path: { assistant_id: "asst-1", taskId: "pdf-proposal" },
      body: { conversationId: "conv-1", listId: "smb" },
    });
    // The prompt goes to the conversation the link named, not a second one.
    expect(sendArgs[0]?.conversationId).toBe("conv-1");
  });

  test("sends the catalog prompt for the task", async () => {
    const result = launcher();
    await act(async () => {
      await result.current.launch("pdf-proposal");
    });

    expect(sendMock.mock.calls[0]?.[0]).toMatchObject({
      prompt: expect.stringContaining("PDF proposal") as never,
    });
  });

  test("sends a custom prompt in place of the catalog one", async () => {
    const result = launcher();
    await act(async () => {
      await result.current.launch("pdf-proposal", "  quote for Bob  ");
    });

    expect(sendMock.mock.calls[0]?.[0]).toMatchObject({
      prompt: "quote for Bob",
    });
  });

  test("never sends when the link fails", async () => {
    startResult = () => Promise.reject({ detail: "task id rejected" });
    const result = launcher();
    let outcome;
    await act(async () => {
      outcome = await result.current.launch("pdf-proposal");
    });

    expect(calls).toEqual(["start"]);
    expect(sendMock).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ ok: false, error: "task id rejected" });
  });

  test("reports a failed send against the conversation it linked", async () => {
    sendOk = false;
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

  test("mints a fresh conversation for every launch", async () => {
    const result = launcher();
    await act(async () => {
      await result.current.launch("pdf-proposal");
      await result.current.launch("weekly-report");
    });

    expect(sendArgs.map((args) => args.conversationId)).toEqual([
      "conv-1",
      "conv-2",
    ]);
  });

  test("rejects a task the catalog does not carry, without minting or sending", async () => {
    const result = launcher();
    let outcome;
    await act(async () => {
      outcome = await result.current.launch("not-a-task");
    });

    expect(outcome).toMatchObject({ ok: false, error: "Unknown task" });
    expect(calls).toEqual([]);
  });

  test("does nothing without an active assistant", async () => {
    useResolvedAssistantsStore.setState({ activeAssistantId: null });
    const result = launcher();
    let outcome;
    await act(async () => {
      outcome = await result.current.launch("pdf-proposal");
    });

    expect(outcome).toMatchObject({ ok: false });
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
