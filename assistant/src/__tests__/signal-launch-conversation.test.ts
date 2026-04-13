/**
 * Unit tests for the launch-conversation signal handler and the
 * launchConversation daemon helper.
 *
 * Covers the parse/validate/dispatch/write-result contract of
 * {@link handleLaunchConversationSignal} in isolation (the daemon-side
 * callback is exercised through a mock registered via
 * {@link registerLaunchConversationCallback}) plus a direct unit test of
 * {@link launchConversation}'s `originTrustContext` inheritance behavior.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// Stub out DB-hitting helpers used by the launchConversation implementation
// so the direct unit test below does not need a real database. These mocks
// apply only within this test file.
mock.module("../memory/conversation-key-store.js", () => ({
  getOrCreateConversation: (_key: string) => ({
    conversationId: "conv-mocked-id",
  }),
}));
mock.module("../memory/conversation-crud.js", () => ({
  updateConversationTitle: () => {},
}));

// Dynamic imports after mock.module calls so the stubs above take effect
// before the modules under test are loaded.
const { launchConversation, registerLaunchConversationDeps } = await import(
  "../daemon/conversation-launch.js"
);
const { handleLaunchConversationSignal, registerLaunchConversationCallback } =
  await import("../signals/launch-conversation.js");
const { getSignalsDir } = await import("../util/platform.js");
type TrustContext =
  import("../daemon/conversation-runtime-assembly.js").TrustContext;

function signalPath(filename: string): string {
  return join(getSignalsDir(), filename);
}

type RecordedCall = {
  title: string;
  seedPrompt: string;
  anchorMessageId?: string;
};

function cleanupSignalFiles(filename: string): void {
  const base = signalPath(filename);
  for (const path of [base, `${base}.result`]) {
    if (existsSync(path)) rmSync(path, { force: true });
  }
}

describe("handleLaunchConversationSignal", () => {
  beforeEach(() => {
    mkdirSync(getSignalsDir(), { recursive: true });
  });

  afterEach(() => {
    // Leave a benign no-op registered so the process isn't left holding
    // a reference to the previous test's callback.
    registerLaunchConversationCallback(async () => ({ accepted: false }));
  });

  test("callback not registered → writes 'Assistant not ready' error", async () => {
    // Intentionally FIRST: the callback registry is a module singleton that
    // starts out null. Once any prior test registers a callback, this case
    // can't be reproduced without a module re-import. Running first keeps
    // the assertion simple.
    const requestId = "req-not-ready";
    const filename = `launch-conversation.${requestId}`;
    cleanupSignalFiles(filename);

    writeFileSync(
      signalPath(filename),
      JSON.stringify({
        requestId,
        title: "Fresh",
        seedPrompt: "Still cold",
      }),
      "utf-8",
    );

    await handleLaunchConversationSignal(filename);

    const resultPath = signalPath(`${filename}.result`);
    expect(existsSync(resultPath)).toBe(true);
    const result = JSON.parse(readFileSync(resultPath, "utf-8")) as {
      ok: boolean;
      error: string;
      requestId: string;
    };
    expect(result).toEqual({
      ok: false,
      error: "Assistant not ready",
      requestId,
    });

    cleanupSignalFiles(filename);
  });

  test("happy path dispatches to registered callback and writes result", async () => {
    const requestId = "req-happy-1";
    const filename = `launch-conversation.${requestId}`;
    cleanupSignalFiles(filename);

    const calls: RecordedCall[] = [];
    registerLaunchConversationCallback(async (params) => {
      calls.push(params);
      return { accepted: true, conversationId: "conv-new-1" };
    });

    writeFileSync(
      signalPath(filename),
      JSON.stringify({
        requestId,
        title: "New thread",
        seedPrompt: "Let's talk about X",
        anchorMessageId: "msg-99",
      }),
      "utf-8",
    );

    await handleLaunchConversationSignal(filename);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      title: "New thread",
      seedPrompt: "Let's talk about X",
      anchorMessageId: "msg-99",
    });

    // Signal file was consumed.
    expect(existsSync(signalPath(filename))).toBe(false);

    // Result file was written with the callback outcome.
    const resultPath = signalPath(`${filename}.result`);
    expect(existsSync(resultPath)).toBe(true);
    const result = JSON.parse(readFileSync(resultPath, "utf-8")) as {
      ok: boolean;
      accepted: boolean;
      requestId: string;
      conversationId?: string;
    };
    expect(result).toEqual({
      ok: true,
      accepted: true,
      requestId,
      conversationId: "conv-new-1",
    });

    cleanupSignalFiles(filename);
  });

  test("happy path omits anchorMessageId when not supplied", async () => {
    const requestId = "req-happy-no-anchor";
    const filename = `launch-conversation.${requestId}`;
    cleanupSignalFiles(filename);

    const calls: RecordedCall[] = [];
    registerLaunchConversationCallback(async (params) => {
      calls.push(params);
      return { accepted: true, conversationId: "conv-new-2" };
    });

    writeFileSync(
      signalPath(filename),
      JSON.stringify({
        requestId,
        title: "Minimal thread",
        seedPrompt: "Hello",
      }),
      "utf-8",
    );

    await handleLaunchConversationSignal(filename);

    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      title: "Minimal thread",
      seedPrompt: "Hello",
    });

    cleanupSignalFiles(filename);
  });

  test("missing requestId → writes error result with requestId=null", async () => {
    const filename = "launch-conversation.no-id";
    cleanupSignalFiles(filename);

    let callbackFired = false;
    registerLaunchConversationCallback(async () => {
      callbackFired = true;
      return { accepted: true, conversationId: "should-not-fire" };
    });

    writeFileSync(
      signalPath(filename),
      JSON.stringify({
        title: "No id",
        seedPrompt: "Seed",
      }),
      "utf-8",
    );

    await handleLaunchConversationSignal(filename);

    expect(callbackFired).toBe(false);

    const resultPath = signalPath(`${filename}.result`);
    expect(existsSync(resultPath)).toBe(true);
    const result = JSON.parse(readFileSync(resultPath, "utf-8")) as {
      ok: boolean;
      error: string;
      requestId: string | null;
    };
    expect(result).toEqual({
      ok: false,
      error: "Missing requestId",
      requestId: null,
    });

    cleanupSignalFiles(filename);
  });

  test("missing title → writes error result", async () => {
    const requestId = "req-no-title";
    const filename = `launch-conversation.${requestId}`;
    cleanupSignalFiles(filename);

    let callbackFired = false;
    registerLaunchConversationCallback(async () => {
      callbackFired = true;
      return { accepted: true };
    });

    writeFileSync(
      signalPath(filename),
      JSON.stringify({
        requestId,
        seedPrompt: "Seed only",
      }),
      "utf-8",
    );

    await handleLaunchConversationSignal(filename);

    expect(callbackFired).toBe(false);

    const resultPath = signalPath(`${filename}.result`);
    const result = JSON.parse(readFileSync(resultPath, "utf-8")) as {
      ok: boolean;
      error: string;
      requestId: string;
    };
    expect(result).toEqual({
      ok: false,
      error: "Missing title",
      requestId,
    });

    cleanupSignalFiles(filename);
  });

  test("missing seedPrompt → writes error result", async () => {
    const requestId = "req-no-seed";
    const filename = `launch-conversation.${requestId}`;
    cleanupSignalFiles(filename);

    let callbackFired = false;
    registerLaunchConversationCallback(async () => {
      callbackFired = true;
      return { accepted: true };
    });

    writeFileSync(
      signalPath(filename),
      JSON.stringify({
        requestId,
        title: "Title only",
      }),
      "utf-8",
    );

    await handleLaunchConversationSignal(filename);

    expect(callbackFired).toBe(false);

    const resultPath = signalPath(`${filename}.result`);
    const result = JSON.parse(readFileSync(resultPath, "utf-8")) as {
      ok: boolean;
      error: string;
      requestId: string;
    };
    expect(result).toEqual({
      ok: false,
      error: "Missing seedPrompt",
      requestId,
    });

    cleanupSignalFiles(filename);
  });
});

describe("launchConversation", () => {
  test("launchConversation applies originTrustContext when provided", async () => {
    const setTrustContextSpy = mock((_ctx: TrustContext | null) => {});
    // Minimal Conversation-like stub — launchConversation only calls
    // setTrustContext on the returned object, so we only implement that.
    const fakeConversation = {
      setTrustContext: setTrustContextSpy,
    };

    const persistAndProcessMessageSpy = mock(async () => ({
      messageId: "msg-mocked",
    }));

    registerLaunchConversationDeps({
      // Cast through unknown because we only exercise the methods
      // launchConversation actually invokes on the Conversation instance.
      getOrCreateConversation: async () =>
        fakeConversation as unknown as Awaited<
          ReturnType<
            Parameters<typeof registerLaunchConversationDeps>[0]["getOrCreateConversation"]
          >
        >,
      persistAndProcessMessage: persistAndProcessMessageSpy,
      publishAssistantEvent: () => {},
      getAssistantId: () => "test-assistant-id",
    });

    const originTrustContext: TrustContext = {
      sourceChannel: "telegram",
      trustClass: "guardian",
      guardianChatId: "chat-guardian",
      guardianExternalUserId: "ext-user-guardian",
      guardianPrincipalId: "principal-guardian",
      requesterIdentifier: "@guardian",
      requesterDisplayName: "Guardian",
    };

    const result = await launchConversation({
      title: "Inherited",
      seedPrompt: "Continue the task",
      anchorMessageId: "msg-anchor-99",
      originTrustContext,
    });

    expect(result).toEqual({ conversationId: "conv-mocked-id" });
    expect(setTrustContextSpy).toHaveBeenCalledTimes(1);
    expect(setTrustContextSpy).toHaveBeenCalledWith(originTrustContext);
    // The trust context must be applied before the seed message is persisted
    // so the first agent turn runs under the inherited guardian scope.
    expect(persistAndProcessMessageSpy).toHaveBeenCalledTimes(1);
    expect(
      setTrustContextSpy.mock.invocationCallOrder[0],
    ).toBeLessThan(persistAndProcessMessageSpy.mock.invocationCallOrder[0]);
  });
});
