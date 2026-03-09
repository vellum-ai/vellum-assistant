import { describe, expect, mock, test } from "bun:test";

const actualEnv = await import("../config/env.js");
mock.module("../config/env.js", () => ({
  ...actualEnv,
  isHttpAuthDisabled: () => true,
  isMonitoringEnabled: () => false,
}));

mock.module("../runtime/local-actor-identity.js", () => ({
  resolveLocalIpcTrustContext: () => ({
    trustClass: "guardian",
    sourceChannel: "vellum",
    guardianPrincipalId: "local-principal",
  }),
  resolveLocalIpcAuthContext: () => ({
    scope: "ipc_v1",
    actorPrincipalId: "local-principal",
  }),
}));

mock.module("../config/loader.js", () => {
  const config = {
    daemon: { standaloneRecording: false },
    secretDetection: {
      enabled: true,
      blockIngress: true,
      customPatterns: [],
      entropyThreshold: 3.5,
    },
  };
  return {
    getConfig: () => config,
    loadConfig: () => config,
    loadRawConfig: () => ({}),
    saveConfig: () => {},
    saveRawConfig: () => {},
    invalidateConfigCache: () => {},
    applyNestedDefaults: (c: unknown) => c,
    getNestedValue: () => undefined,
    setNestedValue: () => {},
    syncConfigToLockfile: () => {},
    API_KEY_PROVIDERS: [],
  };
});

const noopLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  trace: () => {},
  fatal: () => {},
  child: () => noopLogger,
};

// eslint-disable-next-line @typescript-eslint/no-require-imports
const realLogger = require("../util/logger.js");
mock.module("../util/logger.js", () => ({
  ...realLogger,
  getLogger: () => noopLogger,
  getCliLogger: () => noopLogger,
  isDebug: () => false,
  truncateForLog: (v: string) => v,
  initLogger: () => {},
  pruneOldLogFiles: () => 0,
}));

const { handleUserMessage } =
  await import("../daemon/handlers/session-user-message.js");

describe("handleUserMessage secret redirect continuation", () => {
  test("resumes the request after secure save with redacted continuation text", async () => {
    const sentMessages: Array<Record<string, unknown>> = [];
    const enqueueCalls: Array<Record<string, unknown>> = [];
    const processCalls: Array<Record<string, unknown>> = [];

    const session = {
      hasEscalationHandler: () => true,
      redirectToSecurePrompt: (
        _detectedTypes: string[],
        options?: {
          onStored?: (record: {
            service: string;
            field: string;
            label: string;
            delivery: "store" | "transient_send";
          }) => void;
        },
      ) => {
        options?.onStored?.({
          service: "telegram",
          field: "bot_token",
          label: "Telegram Bot Token",
          delivery: "store",
        });
      },
      traceEmitter: { emit: () => {} },
      enqueueMessage: (
        content: string,
        _attachments: unknown[],
        _onEvent: unknown,
        requestId: string,
      ) => {
        enqueueCalls.push({ content, requestId });
        return { queued: false, requestId };
      },
      getQueueDepth: () => 0,
      setTurnChannelContext: () => {},
      setTurnInterfaceContext: () => {},
      setAssistantId: () => {},
      setChannelCapabilities: () => {},
      setTrustContext: () => {},
      setAuthContext: () => {},
      setCommandIntent: () => {},
      updateClient: () => {},
      emitActivityState: () => {},
      hasAnyPendingConfirmation: () => false,
      hasPendingConfirmation: () => false,
      processMessage: (
        content: string,
        _attachments: unknown[],
        _onEvent: unknown,
        requestId: string,
      ) => {
        processCalls.push({ content, requestId });
        return Promise.resolve();
      },
    };

    const ctx = {
      sessions: new Map(),
      cuSessions: new Map(),
      getOrCreateSession: async () => session,
      send: (message: Record<string, unknown>) => {
        sentMessages.push(message);
      },
    };

    await handleUserMessage(
      {
        type: "user_message",
        sessionId: "sess-1",
        content:
          "Set up Telegram with my bot token 123456789:ABCDefGHIJklmnopQRSTuvwxyz012345678",
        interface: "cli",
      },
      ctx as never,
    );

    expect(sentMessages[0]).toMatchObject({
      type: "error",
      category: "secret_blocked",
    });
    expect(
      sentMessages.some((msg) => msg.type === "assistant_text_delta"),
    ).toBe(true);
    expect(sentMessages.some((msg) => msg.type === "message_complete")).toBe(
      true,
    );

    expect(enqueueCalls).toHaveLength(1);
    expect(processCalls).toHaveLength(1);
    expect(enqueueCalls[0].content as string).toContain(
      '<redacted type="Telegram Bot Token" />',
    );
    expect(enqueueCalls[0].content as string).toContain(
      "credential telegram/bot_token",
    );
    expect(processCalls[0].content).toBe(enqueueCalls[0].content);
  });
});
