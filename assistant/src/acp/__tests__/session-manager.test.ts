/**
 * Regression tests for AcpSessionManager state population — specifically
 * that `parentConversationId` is set on every session state at spawn time
 * and is therefore visible through `getStatus()` from t=0, plus the model a
 * spawn resolves, applies through the adapter, and publishes, the live switch
 * that changes it mid-session, and the unsolicited updates an adapter sends
 * when the user changes the model from the transcript.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { SessionConfigOption } from "@agentclientprotocol/sdk";

import type { AssistantEvent } from "../../api/index.js";
import {
  getAcpConversationModelPreference,
  upsertAcpConversationModelPreference,
} from "../../persistence/acp-model-preference.js";
import { getSqlite } from "../../persistence/db-connection.js";
import { initializeDb } from "../../persistence/db-init.js";
import type { VellumAcpClientHandler } from "../client-handler.js";
import type { AcpSessionState } from "../types.js";
import { installAcpConfigStub } from "./helpers/acp-config-stub.js";
import {
  MODEL_OPTION_MODELS,
  modelOption,
} from "./helpers/acp-model-option.js";

// Records every `cancel(protocolSessionId)` the manager dispatches to a fake
// process, so tests can assert which sessions were cancelled.
const cancelCalls: string[] = [];

/** Config options each `createSession` reports, one entry per call. */
let scriptedConfigOptions: SessionConfigOption[][] = [];
/** Every `setConfigOption` the manager dispatched to a fake process. */
const setConfigOptionCalls: Array<{
  sessionId: string;
  configId: string;
  value: string | boolean;
}> = [];
/** What `setConfigOption` answers with; an Error is thrown instead. */
let setConfigOptionResult: SessionConfigOption[] | Error = [];
/** Answers per call when set, so one round trip can be slower than the next. */
let setConfigOptionResponder:
  | ((value: string | boolean) => Promise<SessionConfigOption[]>)
  | null = null;

// Stub the agent-process module so spawn() does not actually launch a child
// process. Each fake instance records the cwd it was spawned in and resolves
// every protocol method synchronously. The mock is process-global (Bun's
// `mock.module` semantics) — that's fine because this file only exercises
// AcpSessionManager.
mock.module("../agent-process.js", () => ({
  AcpAgentProcess: class FakeAcpAgentProcess {
    constructor(
      public readonly agentId: string,
      _config: unknown,
      _factory: unknown,
    ) {}
    spawn(_cwd: string): void {}
    async initialize(): Promise<void> {}
    async createSession(
      _cwd: string,
    ): Promise<{ sessionId: string; configOptions: SessionConfigOption[] }> {
      return {
        sessionId: `proto-${this.agentId}`,
        configOptions: scriptedConfigOptions.shift() ?? [],
      };
    }
    async setConfigOption(
      sessionId: string,
      configId: string,
      value: string | boolean,
    ): Promise<SessionConfigOption[]> {
      setConfigOptionCalls.push({ sessionId, configId, value });
      if (setConfigOptionResponder) {
        return setConfigOptionResponder(value);
      }
      if (setConfigOptionResult instanceof Error) {
        throw setConfigOptionResult;
      }
      return setConfigOptionResult;
    }
    async prompt(): Promise<{ stopReason: string }> {
      // Never resolves — keeps the session alive in `running` state for
      // the duration of the test so cleanup logic doesn't tear it down.
      return new Promise(() => {});
    }
    async cancel(sessionId: string): Promise<void> {
      cancelCalls.push(sessionId);
    }
    readonly appliedConfigOptions: SessionConfigOption[][] = [];
    applyConfigOptionsUpdate(configOptions: SessionConfigOption[]): void {
      this.appliedConfigOptions.push(configOptions);
    }
    markStderr(): number {
      return 0;
    }
    stderrSince(): string {
      return "";
    }
    kill(): void {}
  },
}));

// Installed before the manager is imported so its `getConfig` call resolves
// through the stub, which is what drives the global-default rung.
const config = await installAcpConfigStub();
const {
  AcpModelSelectionUnsupportedError,
  AcpSessionManager,
  AcpSessionNotFoundError,
} = await import("../session-manager.js");
await initializeDb();

type Manager = InstanceType<typeof AcpSessionManager>;

beforeEach(() => {
  scriptedConfigOptions = [];
  setConfigOptionCalls.length = 0;
  setConfigOptionResult = [];
  setConfigOptionResponder = null;
  config.setConfig({});
  getSqlite().run("DELETE FROM acp_conversation_model_preference");
});

describe("AcpSessionManager — parentConversationId population", () => {
  const noopSend = () => {};

  test("getStatus(id) returns parentConversationId matching the spawn argument", async () => {
    const manager = new AcpSessionManager(5);

    const { acpSessionId } = await manager.spawn(
      "agent-1",
      { command: "echo", args: ["hi"] },
      "do something",
      "/tmp",
      "conv-parent-abc",
      noopSend,
    );

    const state = manager.getStatus(acpSessionId) as AcpSessionState;
    expect(state.parentConversationId).toBe("conv-parent-abc");
  });

  test("getStatus() returns an array where every entry has parentConversationId populated", async () => {
    const manager = new AcpSessionManager(5);

    await manager.spawn(
      "agent-1",
      { command: "echo", args: ["hi"] },
      "task 1",
      "/tmp",
      "conv-parent-1",
      noopSend,
    );
    await manager.spawn(
      "agent-2",
      { command: "echo", args: ["hi"] },
      "task 2",
      "/tmp",
      "conv-parent-2",
      noopSend,
    );

    const states = manager.getStatus() as AcpSessionState[];
    const parents = states.map((s) => s.parentConversationId).sort();
    expect(parents).toEqual(["conv-parent-1", "conv-parent-2"]);
  });
});

describe("AcpSessionManager — cancelForParent", () => {
  const noopSend = () => {};

  test("cancels only the sessions spawned by the given parent", async () => {
    cancelCalls.length = 0;
    const manager = new AcpSessionManager(5);

    const a1 = await manager.spawn(
      "agent-a1",
      { command: "echo", args: ["hi"] },
      "task",
      "/tmp",
      "parent-A",
      noopSend,
    );
    const a2 = await manager.spawn(
      "agent-a2",
      { command: "echo", args: ["hi"] },
      "task",
      "/tmp",
      "parent-A",
      noopSend,
    );
    const b1 = await manager.spawn(
      "agent-b1",
      { command: "echo", args: ["hi"] },
      "task",
      "/tmp",
      "parent-B",
      noopSend,
    );

    // WHEN parent-A is cancelled
    const count = manager.cancelForParent("parent-A");

    // THEN it reports the two parent-A sessions and leaves parent-B alone
    expect(count).toBe(2);

    // Let the detached per-session cancels settle (each awaits a protocol
    // notification before flipping status).
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect((manager.getStatus(a1.acpSessionId) as AcpSessionState).status).toBe(
      "cancelled",
    );
    expect((manager.getStatus(a2.acpSessionId) as AcpSessionState).status).toBe(
      "cancelled",
    );
    expect((manager.getStatus(b1.acpSessionId) as AcpSessionState).status).toBe(
      "running",
    );

    // AND the cancel reached each parent-A agent process exactly once.
    expect(cancelCalls.sort()).toEqual(["proto-agent-a1", "proto-agent-a2"]);
  });

  test("returns 0 and dispatches nothing when the parent has no sessions", () => {
    cancelCalls.length = 0;
    const manager = new AcpSessionManager(5);

    expect(manager.cancelForParent("parent-with-nothing")).toBe(0);
    expect(cancelCalls).toEqual([]);
  });
});

describe("AcpSessionManager config option updates", () => {
  const noopSend = () => {};

  const MODEL_OPTION = modelOption("opus");

  test("a config_option_update notification refreshes the process cache", async () => {
    const manager = new AcpSessionManager(5);

    const { acpSessionId } = await manager.spawn(
      "agent-1",
      { command: "echo", args: ["hi"] },
      "task",
      "/tmp",
      "parent-A",
      noopSend,
    );

    const entry = (
      manager as unknown as {
        sessions: Map<
          string,
          {
            process: { appliedConfigOptions: SessionConfigOption[][] };
            clientHandler: VellumAcpClientHandler;
          }
        >;
      }
    ).sessions.get(acpSessionId);

    await entry?.clientHandler.sessionUpdate({
      sessionId: "proto-agent-1",
      update: {
        sessionUpdate: "config_option_update",
        configOptions: [MODEL_OPTION],
      },
    });

    expect(entry?.process.appliedConfigOptions).toEqual([[MODEL_OPTION]]);
  });
});

describe("AcpSessionManager: model selection at spawn", () => {
  /**
   * Spawns one session with the ladder rungs the case cares about set, and
   * returns the events it emitted alongside the resulting state.
   */
  async function spawnWithModel(opts: {
    conversationId: string;
    agentId?: string;
    agentModel?: string;
    requestedModel?: string;
  }): Promise<{
    state: AcpSessionState;
    sent: AssistantEvent[];
    modelWarning?: string;
  }> {
    const manager = new AcpSessionManager(5);
    const sent: AssistantEvent[] = [];
    const { acpSessionId, modelWarning } = await manager.spawn(
      opts.agentId ?? "agent-model",
      { command: "echo", args: ["hi"], model: opts.agentModel },
      "task",
      "/tmp",
      opts.conversationId,
      (msg) => sent.push(msg),
      opts.requestedModel ? { model: opts.requestedModel } : {},
    );
    return {
      state: manager.getStatus(acpSessionId) as AcpSessionState,
      sent,
      modelWarning,
    };
  }

  /** The model value the adapter was asked to select, if it was asked. */
  function selectedValue(): string | boolean | undefined {
    return setConfigOptionCalls[0]?.value;
  }

  test("state carries the model and options the adapter reported", async () => {
    scriptedConfigOptions = [[modelOption("opus")]];

    const { state } = await spawnWithModel({ conversationId: "conv-report" });

    expect(state.model).toBe("opus");
    expect(state.availableModels).toEqual(MODEL_OPTION_MODELS);
    // Nothing was requested and the adapter is already on a model, so it was
    // never asked to change.
    expect(setConfigOptionCalls).toEqual([]);
  });

  test("the model event follows the spawned event", async () => {
    scriptedConfigOptions = [[modelOption("opus")]];

    const { sent } = await spawnWithModel({ conversationId: "conv-event" });

    expect(sent.map((e) => e.type)).toEqual([
      "acp_session_spawned",
      "acp_session_model_update",
    ]);
    expect(sent[1]).toMatchObject({
      model: "opus",
      availableModels: MODEL_OPTION_MODELS,
    });
  });

  test("an adapter with no model selector publishes nothing and stays unset", async () => {
    const { state, sent } = await spawnWithModel({
      conversationId: "conv-no-selector",
      requestedModel: "opus",
    });

    expect(state.model).toBeUndefined();
    expect(state.availableModels).toBeUndefined();
    expect(setConfigOptionCalls).toEqual([]);
    expect(sent.map((e) => e.type)).toEqual(["acp_session_spawned"]);
    // A model that cannot be applied is not a failed spawn.
    expect(state.status).toBe("running");
  });

  test("a caller who asked for a model is told the agent cannot select one", async () => {
    const { modelWarning } = await spawnWithModel({
      conversationId: "conv-no-selector-warned",
      requestedModel: "opus",
    });

    expect(modelWarning).toBe(
      'Agent "agent-model" does not support model selection, so the ' +
        "session is running on the agent's own model.",
    );
  });

  test("an inherited model on an agent with no selector warns nobody", async () => {
    config.setConfig({ defaultModel: "opus" });

    const { modelWarning } = await spawnWithModel({
      conversationId: "conv-no-selector-inherited",
    });

    expect(modelWarning).toBeUndefined();
  });

  test("an explicit request outranks every other rung", async () => {
    config.setConfig({ defaultModel: "haiku" });
    upsertAcpConversationModelPreference({
      parentConversationId: "conv-ladder",
      agentId: "agent-model",
      model: "sonnet",
    });
    scriptedConfigOptions = [[modelOption("default")]];

    await spawnWithModel({
      conversationId: "conv-ladder",
      agentModel: "fable",
      requestedModel: "opus",
    });

    expect(setConfigOptionCalls).toEqual([
      { sessionId: "proto-agent-model", configId: "model", value: "opus" },
    ]);
  });

  test("the conversation preference outranks the agent and global defaults", async () => {
    config.setConfig({ defaultModel: "haiku" });
    upsertAcpConversationModelPreference({
      parentConversationId: "conv-ladder",
      agentId: "agent-model",
      model: "sonnet",
    });
    scriptedConfigOptions = [[modelOption("default")]];

    await spawnWithModel({
      conversationId: "conv-ladder",
      agentModel: "fable",
    });

    expect(selectedValue()).toBe("sonnet");
  });

  test("the agent's own model outranks the global default", async () => {
    config.setConfig({ defaultModel: "haiku" });
    scriptedConfigOptions = [[modelOption("default")]];

    await spawnWithModel({
      conversationId: "conv-ladder",
      agentModel: "fable",
    });

    expect(selectedValue()).toBe("fable");
  });

  test("the global default applies when nothing more specific is set", async () => {
    config.setConfig({ defaultModel: "haiku" });
    scriptedConfigOptions = [[modelOption("default")]];

    await spawnWithModel({ conversationId: "conv-ladder" });

    expect(selectedValue()).toBe("haiku");
  });

  test("a spawn with no rung set leaves the adapter on its own model", async () => {
    scriptedConfigOptions = [[modelOption("default")]];

    const { state } = await spawnWithModel({ conversationId: "conv-ladder" });

    expect(setConfigOptionCalls).toEqual([]);
    expect(state.model).toBe("default");
    expect(
      getAcpConversationModelPreference("conv-ladder", "agent-model"),
    ).toBeUndefined();
  });

  test("an explicit request is remembered as the value the adapter confirmed", async () => {
    scriptedConfigOptions = [[modelOption("default")]];
    // The adapter resolves the alias it was handed to a full model id.
    setConfigOptionResult = [modelOption("claude-opus-4-5")];

    const { state } = await spawnWithModel({
      conversationId: "conv-remember",
      requestedModel: "opus",
    });

    expect(state.model).toBe("claude-opus-4-5");
    expect(
      getAcpConversationModelPreference("conv-remember", "agent-model"),
    ).toBe("claude-opus-4-5");
  });

  test("an inherited model is applied but never becomes the conversation's choice", async () => {
    config.setConfig({ defaultModel: "sonnet" });
    scriptedConfigOptions = [[modelOption("default")]];
    setConfigOptionResult = [modelOption("sonnet")];

    const { state } = await spawnWithModel({ conversationId: "conv-inherit" });

    expect(state.model).toBe("sonnet");
    expect(
      getAcpConversationModelPreference("conv-inherit", "agent-model"),
    ).toBeUndefined();
  });

  test("a refused model warns, runs unpinned, and records no preference", async () => {
    scriptedConfigOptions = [[modelOption("opus")]];
    setConfigOptionResult = new Error(
      "Invalid value for config option model: nope",
    );

    const manager = new AcpSessionManager(5);
    const sent: AssistantEvent[] = [];
    const result = await manager.spawn(
      "agent-model",
      { command: "echo", args: ["hi"] },
      "task",
      "/tmp",
      "conv-refused",
      (msg) => sent.push(msg),
      { model: "nope" },
    );

    expect(result.modelWarning).toBe(
      "Invalid value for config option model: nope",
    );
    const state = manager.getStatus(result.acpSessionId) as AcpSessionState;
    // The run is live on whatever the adapter chose for itself.
    expect(state.status).toBe("running");
    expect(state.model).toBe("opus");
    expect(
      getAcpConversationModelPreference("conv-refused", "agent-model"),
    ).toBeUndefined();
    expect(sent.map((e) => e.type)).toEqual([
      "acp_session_spawned",
      "acp_session_model_update",
    ]);
  });
});

/** The client handler the manager wired for a session, to drive updates. */
function clientHandlerFor(
  manager: Manager,
  acpSessionId: string,
): VellumAcpClientHandler {
  const entry = (
    manager as unknown as {
      sessions: Map<string, { clientHandler: VellumAcpClientHandler }>;
    }
  ).sessions.get(acpSessionId);
  if (!entry) {
    throw new Error(`No ACP session registered for "${acpSessionId}"`);
  }
  return entry.clientHandler;
}

/**
 * A running session whose adapter advertises the model selector and sits on
 * `sonnet`, with the spawn events already drained so a test asserts only what
 * its own action emitted.
 */
async function spawnSwitchable(conversationId: string): Promise<{
  manager: Manager;
  acpSessionId: string;
  sent: AssistantEvent[];
}> {
  scriptedConfigOptions = [[modelOption("sonnet")]];
  const manager = new AcpSessionManager(5);
  const sent: AssistantEvent[] = [];
  const { acpSessionId } = await manager.spawn(
    "agent-model",
    { command: "echo", args: ["hi"] },
    "task",
    "/tmp",
    conversationId,
    (msg) => sent.push(msg),
  );
  sent.length = 0;
  return { manager, acpSessionId, sent };
}

/** Resolves once the manager has dispatched `count` `setConfigOption` calls. */
async function waitForConfigOptionCalls(count: number): Promise<void> {
  while (setConfigOptionCalls.length < count) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

describe("AcpSessionManager: live model switching", () => {
  test("applies the model, publishes it, and remembers what the adapter confirmed", async () => {
    const { manager, acpSessionId, sent } = await spawnSwitchable("conv-set");
    // The adapter resolves the alias it was handed to a full model id.
    setConfigOptionResult = [modelOption("claude-opus-4-5")];

    const state = await manager.setModel(acpSessionId, "opus");

    expect(setConfigOptionCalls).toEqual([
      { sessionId: "proto-agent-model", configId: "model", value: "opus" },
    ]);
    expect(state.model).toBe("claude-opus-4-5");
    expect(state.availableModels).toEqual(MODEL_OPTION_MODELS);
    expect(getAcpConversationModelPreference("conv-set", "agent-model")).toBe(
      "claude-opus-4-5",
    );
    expect(sent).toEqual([
      {
        type: "acp_session_model_update",
        acpSessionId,
        model: "claude-opus-4-5",
        availableModels: MODEL_OPTION_MODELS,
      },
    ]);
  });

  test("the prompt in flight keeps running", async () => {
    cancelCalls.length = 0;
    const { manager, acpSessionId } = await spawnSwitchable("conv-in-flight");
    setConfigOptionResult = [modelOption("opus")];

    await manager.setModel(acpSessionId, "opus");

    expect(cancelCalls).toEqual([]);
    expect((manager.getStatus(acpSessionId) as AcpSessionState).status).toBe(
      "running",
    );
  });

  test("an unknown session id is a not-found error", async () => {
    const manager = new AcpSessionManager(5);

    await expect(
      manager.setModel("no-such-session", "opus"),
    ).rejects.toBeInstanceOf(AcpSessionNotFoundError);
    expect(setConfigOptionCalls).toEqual([]);
  });

  test("an adapter with no model selector cannot be switched", async () => {
    const manager = new AcpSessionManager(5);
    const { acpSessionId } = await manager.spawn(
      "agent-model",
      { command: "echo", args: ["hi"] },
      "task",
      "/tmp",
      "conv-unsupported",
      () => {},
    );

    await expect(manager.setModel(acpSessionId, "opus")).rejects.toBeInstanceOf(
      AcpModelSelectionUnsupportedError,
    );
    expect(setConfigOptionCalls).toEqual([]);
  });

  test("a value the adapter never offered is rejected without a round trip", async () => {
    const { manager, acpSessionId, sent } =
      await spawnSwitchable("conv-unknown-value");

    await expect(manager.setModel(acpSessionId, "gpt-5")).rejects.toThrow(
      'does not offer model "gpt-5"',
    );
    expect(setConfigOptionCalls).toEqual([]);
    expect(sent).toEqual([]);
    expect(
      getAcpConversationModelPreference("conv-unknown-value", "agent-model"),
    ).toBeUndefined();
  });

  test("overlapping switches run in order and the later choice wins", async () => {
    const { manager, acpSessionId, sent } = await spawnSwitchable("conv-race");
    const confirmed: string[] = [];
    setConfigOptionResponder = async (value) => {
      // The first switch answers last if the calls are allowed to overlap.
      if (value === "opus") {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      confirmed.push(String(value));
      return [modelOption(String(value))];
    };

    const first = manager.setModel(acpSessionId, "opus");
    const second = manager.setModel(acpSessionId, "sonnet");
    await Promise.all([first, second]);

    expect(confirmed).toEqual(["opus", "sonnet"]);
    expect(setConfigOptionCalls.map((call) => call.value)).toEqual([
      "opus",
      "sonnet",
    ]);
    expect((manager.getStatus(acpSessionId) as AcpSessionState).model).toBe(
      "sonnet",
    );
    expect(getAcpConversationModelPreference("conv-race", "agent-model")).toBe(
      "sonnet",
    );
    expect(sent).toHaveLength(2);
    expect(sent[sent.length - 1]).toMatchObject({
      type: "acp_session_model_update",
      model: "sonnet",
    });
  });

  test("a refused switch leaves the next one free to run", async () => {
    const { manager, acpSessionId } = await spawnSwitchable("conv-chain");
    setConfigOptionResponder = async (value) => {
      if (value === "opus") {
        throw new Error("Invalid value for config option model: opus");
      }
      return [modelOption(String(value))];
    };

    const refused = manager.setModel(acpSessionId, "opus");
    const next = manager.setModel(acpSessionId, "sonnet");

    await expect(refused).rejects.toThrow(
      "Invalid value for config option model: opus",
    );
    await expect(next).resolves.toMatchObject({ model: "sonnet" });
  });

  test("a response that drops the selector clears the model and empties the picker", async () => {
    const { manager, acpSessionId, sent } = await spawnSwitchable(
      "conv-switch-dropped",
    );
    setConfigOptionResult = [
      {
        type: "select",
        id: "mode",
        name: "Mode",
        currentValue: "default",
        options: [{ value: "default", name: "Default" }],
      },
    ];

    const state = await manager.setModel(acpSessionId, "opus");

    expect(state.model).toBeUndefined();
    expect(state.availableModels).toEqual([]);
    expect(sent).toEqual([
      {
        type: "acp_session_model_update",
        acpSessionId,
        availableModels: [],
      },
    ]);
    expect(
      getAcpConversationModelPreference("conv-switch-dropped", "agent-model"),
    ).toBeUndefined();
    await expect(manager.setModel(acpSessionId, "opus")).rejects.toBeInstanceOf(
      AcpModelSelectionUnsupportedError,
    );
  });

  test("a response landing after the session closed changes nothing", async () => {
    const { manager, acpSessionId, sent } = await spawnSwitchable("conv-late");
    const state = manager.getStatus(acpSessionId) as AcpSessionState;
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    setConfigOptionResponder = async (value) => {
      await held;
      return [modelOption(String(value))];
    };

    const switched = manager.setModel(acpSessionId, "opus");
    await waitForConfigOptionCalls(1);
    manager.close(acpSessionId);
    release();

    await expect(switched).rejects.toBeInstanceOf(AcpSessionNotFoundError);
    expect(state.model).toBe("sonnet");
    expect(sent).toEqual([]);
    expect(
      getAcpConversationModelPreference("conv-late", "agent-model"),
    ).toBeUndefined();
  });

  test("a switch queued behind a slow one never reaches a closed session", async () => {
    const { manager, acpSessionId } = await spawnSwitchable("conv-late-queued");
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    setConfigOptionResponder = async (value) => {
      await held;
      return [modelOption(String(value))];
    };

    // Settled up front: the queued switch rejects while the first one is
    // still being awaited, and an unhandled rejection would fail the test.
    const settled = Promise.allSettled([
      manager.setModel(acpSessionId, "opus"),
      manager.setModel(acpSessionId, "sonnet"),
    ]);
    await waitForConfigOptionCalls(1);
    manager.close(acpSessionId);
    release();

    const outcomes = await settled;
    for (const outcome of outcomes) {
      expect(outcome.status).toBe("rejected");
      expect((outcome as PromiseRejectedResult).reason).toBeInstanceOf(
        AcpSessionNotFoundError,
      );
    }
    // The queued switch never reached the adapter.
    expect(setConfigOptionCalls.map((call) => call.value)).toEqual(["opus"]);
  });

  test("an adapter refusal surfaces verbatim and leaves the session as it was", async () => {
    const { manager, acpSessionId, sent } =
      await spawnSwitchable("conv-refuse");
    setConfigOptionResult = new Error(
      "Invalid value for config option model: opus",
    );

    await expect(manager.setModel(acpSessionId, "opus")).rejects.toThrow(
      "Invalid value for config option model: opus",
    );
    const state = manager.getStatus(acpSessionId) as AcpSessionState;
    expect(state.status).toBe("running");
    expect(state.model).toBe("sonnet");
    expect(sent).toEqual([]);
    expect(
      getAcpConversationModelPreference("conv-refuse", "agent-model"),
    ).toBeUndefined();
  });
});

describe("AcpSessionManager: unsolicited model updates", () => {
  test("a model changed from the transcript updates state, publishes, and is remembered", async () => {
    const { manager, acpSessionId, sent } = await spawnSwitchable("conv-typed");

    await clientHandlerFor(manager, acpSessionId).sessionUpdate({
      sessionId: "proto-agent-model",
      update: {
        sessionUpdate: "config_option_update",
        configOptions: [modelOption("opus")],
      },
    });

    expect((manager.getStatus(acpSessionId) as AcpSessionState).model).toBe(
      "opus",
    );
    expect(sent).toEqual([
      {
        type: "acp_session_model_update",
        acpSessionId,
        model: "opus",
        availableModels: MODEL_OPTION_MODELS,
      },
    ]);
    expect(getAcpConversationModelPreference("conv-typed", "agent-model")).toBe(
      "opus",
    );
    // Reporting is not choosing: the adapter is never asked to set it back.
    expect(setConfigOptionCalls).toEqual([]);
  });

  test("a selector that disappears clears the model, the options, and the picker", async () => {
    const { manager, acpSessionId, sent } =
      await spawnSwitchable("conv-dropped");

    await clientHandlerFor(manager, acpSessionId).sessionUpdate({
      sessionId: "proto-agent-model",
      update: {
        sessionUpdate: "config_option_update",
        configOptions: [
          {
            type: "select",
            id: "mode",
            name: "Mode",
            currentValue: "default",
            options: [{ value: "default", name: "Default" }],
          },
        ],
      },
    });

    const state = manager.getStatus(acpSessionId) as AcpSessionState;
    expect(state.model).toBeUndefined();
    expect(state.availableModels).toEqual([]);
    expect(sent).toEqual([
      {
        type: "acp_session_model_update",
        acpSessionId,
        availableModels: [],
      },
    ]);
    await expect(manager.setModel(acpSessionId, "opus")).rejects.toBeInstanceOf(
      AcpModelSelectionUnsupportedError,
    );
    expect(setConfigOptionCalls).toEqual([]);
  });

  test("an update repeating the current model publishes but records no preference", async () => {
    const { manager, acpSessionId, sent } =
      await spawnSwitchable("conv-unchanged");

    await clientHandlerFor(manager, acpSessionId).sessionUpdate({
      sessionId: "proto-agent-model",
      update: {
        sessionUpdate: "config_option_update",
        configOptions: [modelOption("sonnet")],
      },
    });

    expect(sent.map((e) => e.type)).toEqual(["acp_session_model_update"]);
    expect(
      getAcpConversationModelPreference("conv-unchanged", "agent-model"),
    ).toBeUndefined();
  });

  test("an update landing while the spawn pin is in flight records no preference", async () => {
    config.setConfig({ defaultModel: "sonnet" });
    scriptedConfigOptions = [[modelOption("default")]];
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    setConfigOptionResponder = async (value) => {
      await held;
      return [modelOption(String(value))];
    };
    const manager = new AcpSessionManager(5);
    const sent: AssistantEvent[] = [];
    const spawning = manager.spawn(
      "agent-model",
      { command: "echo", args: ["hi"] },
      "task",
      "/tmp",
      "conv-pin-race",
      (msg: AssistantEvent) => sent.push(msg),
    );
    await waitForConfigOptionCalls(1);
    const acpSessionId = (manager.getStatus() as AcpSessionState[])[0].id;

    // The adapter reports the pin it is still answering.
    await clientHandlerFor(manager, acpSessionId).sessionUpdate({
      sessionId: "proto-agent-model",
      update: {
        sessionUpdate: "config_option_update",
        configOptions: [modelOption("sonnet")],
      },
    });
    release();
    await spawning;

    expect((manager.getStatus(acpSessionId) as AcpSessionState).model).toBe(
      "sonnet",
    );
    expect(sent.map((e) => e.type)).toEqual([
      "acp_session_model_update",
      "acp_session_spawned",
      "acp_session_model_update",
    ]);
    expect(
      getAcpConversationModelPreference("conv-pin-race", "agent-model"),
    ).toBeUndefined();
  });

  test("an update echoing the spawn pin after it resolved records no preference", async () => {
    // The adapter answers the pin with the snapshot it had, then reports the
    // value it moved to through a notification of its own.
    setConfigOptionResponder = async () => [modelOption("default")];
    const { manager, acpSessionId, sent } =
      await spawnPinnedToDefault("conv-pin-echo");

    await clientHandlerFor(manager, acpSessionId).sessionUpdate({
      sessionId: "proto-agent-model",
      update: {
        sessionUpdate: "config_option_update",
        configOptions: [modelOption("sonnet")],
      },
    });

    expect((manager.getStatus(acpSessionId) as AcpSessionState).model).toBe(
      "sonnet",
    );
    expect(sent.map((e) => e.type)).toEqual(["acp_session_model_update"]);
    expect(
      getAcpConversationModelPreference("conv-pin-echo", "agent-model"),
    ).toBeUndefined();
  });

  test("a different model after the spawn pin is still remembered", async () => {
    setConfigOptionResult = [modelOption("sonnet")];
    const { manager, acpSessionId, sent } = await spawnPinnedToDefault(
      "conv-pin-then-typed",
    );

    await clientHandlerFor(manager, acpSessionId).sessionUpdate({
      sessionId: "proto-agent-model",
      update: {
        sessionUpdate: "config_option_update",
        configOptions: [modelOption("opus")],
      },
    });

    expect((manager.getStatus(acpSessionId) as AcpSessionState).model).toBe(
      "opus",
    );
    expect(sent.map((e) => e.type)).toEqual(["acp_session_model_update"]);
    expect(
      getAcpConversationModelPreference("conv-pin-then-typed", "agent-model"),
    ).toBe("opus");
  });
});

/**
 * A running session the manager pinned to the global default on its own, with
 * the spawn events drained. Nothing about the model was an explicit request,
 * so the spawn wrote no preference. Callers set the adapter's answer to the
 * pin before calling.
 */
async function spawnPinnedToDefault(conversationId: string): Promise<{
  manager: Manager;
  acpSessionId: string;
  sent: AssistantEvent[];
}> {
  config.setConfig({ defaultModel: "sonnet" });
  scriptedConfigOptions = [[modelOption("default")]];
  const manager = new AcpSessionManager(5);
  const sent: AssistantEvent[] = [];
  const { acpSessionId } = await manager.spawn(
    "agent-model",
    { command: "echo", args: ["hi"] },
    "task",
    "/tmp",
    conversationId,
    (msg) => sent.push(msg),
  );
  sent.length = 0;
  return { manager, acpSessionId, sent };
}
