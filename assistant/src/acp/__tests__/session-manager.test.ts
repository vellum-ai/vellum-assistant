/**
 * Regression tests for AcpSessionManager state population — specifically
 * that `parentConversationId` is set on every session state at spawn time
 * and is therefore visible through `getStatus()` from t=0, plus the model a
 * spawn resolves, applies through the adapter, and publishes, and the
 * unsolicited updates an adapter sends when the model changes from the
 * transcript.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import * as acp from "@agentclientprotocol/sdk";

import type { AssistantEvent } from "../../api/index.js";
import { initializeDb } from "../../persistence/db-init.js";
import { claudeCredentialRefused } from "../acp-auth-marker-store.js";
import { AcpAuthRequiredError, isAcpAuthRequired } from "../auth-required.js";
import type { VellumAcpClientHandler } from "../client-handler.js";
import type { AcpSessionState } from "../types.js";
import { AcpConfigOptionRefusedError } from "../types.js";
import { installAcpConfigStub } from "./helpers/acp-config-stub.js";
import {
  MODEL_OPTION_MODELS,
  modelOption,
  nonModelOption,
} from "./helpers/acp-model-option.js";

// Records every `cancel(protocolSessionId)` the manager dispatches to a fake
// process, so tests can assert which sessions were cancelled.
const cancelCalls: string[] = [];

/** Config options each `createSession` reports, one entry per call. */
let scriptedConfigOptions: SessionConfigOption[][] = [];
/**
 * When set, `createSession` stalls on this gate before it answers, so a test
 * can drive a notification into the still-open call.
 */
let createSessionGate: Promise<void> | null = null;
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
      if (createSessionGate) {
        await createSessionGate;
      }
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
    markStderr(): number {
      return 0;
    }
    stderrSince(): string {
      return "";
    }
    kill(): void {}
  },
}));

// Installed before the manager is imported so its own `getConfig` calls
// resolve through the stub rather than the real workspace config.
await installAcpConfigStub();
const { AcpSessionManager } = await import("../session-manager.js");
await initializeDb();

type Manager = InstanceType<typeof AcpSessionManager>;

beforeEach(() => {
  scriptedConfigOptions = [];
  createSessionGate = null;
  setConfigOptionCalls.length = 0;
  setConfigOptionResult = [];
  setConfigOptionResponder = null;
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
    const { modelWarning } = await spawnWithModel({
      conversationId: "conv-no-selector-inherited",
      agentModel: "opus",
    });

    expect(modelWarning).toBeUndefined();
  });

  test("an explicit request outranks the agent's own model", async () => {
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

  test("the agent's own model applies when the ask names none", async () => {
    scriptedConfigOptions = [[modelOption("default")]];

    await spawnWithModel({
      conversationId: "conv-ladder",
      agentModel: "fable",
    });

    expect(selectedValue()).toBe("fable");
  });

  test("a spawn with no rung set leaves the adapter on its own model", async () => {
    scriptedConfigOptions = [[modelOption("default")]];

    const { state } = await spawnWithModel({ conversationId: "conv-ladder" });

    expect(setConfigOptionCalls).toEqual([]);
    expect(state.model).toBe("default");
  });

  test("the pin records the value the adapter confirmed", async () => {
    scriptedConfigOptions = [[modelOption("default")]];
    // The adapter resolves the alias it was handed to a full model id.
    setConfigOptionResult = [modelOption("claude-opus-4-5")];

    const { state } = await spawnWithModel({
      conversationId: "conv-pin",
      requestedModel: "opus",
    });

    expect(state.model).toBe("claude-opus-4-5");
  });

  test("an inherited model the adapter refuses warns nobody", async () => {
    scriptedConfigOptions = [[modelOption("opus")]];
    setConfigOptionResult = new AcpConfigOptionRefusedError(
      "Invalid value for config option model: nope",
    );

    const { modelWarning, state } = await spawnWithModel({
      conversationId: "conv-refused-inherited",
      agentModel: "nope",
    });

    // Logged, not surfaced: nobody typed this model here.
    expect(modelWarning).toBeUndefined();
    expect(state.model).toBe("opus");
  });

  test("a refused model warns and runs unpinned", async () => {
    scriptedConfigOptions = [[modelOption("opus")]];
    setConfigOptionResult = new AcpConfigOptionRefusedError(
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
    expect(sent.map((e) => e.type)).toEqual([
      "acp_session_spawned",
      "acp_session_model_update",
    ]);
  });

  test("an authentication failure during the pin surfaces as auth required", async () => {
    scriptedConfigOptions = [[modelOption("default")]];
    setConfigOptionResult = new AcpAuthRequiredError(
      "agent-model",
      "Claude refused the configured credential",
    );

    const manager = new AcpSessionManager(5);
    const sent: AssistantEvent[] = [];
    const spawned = manager.spawn(
      "agent-model",
      { command: "echo", args: ["hi"] },
      "task",
      "/tmp",
      "conv-pin-auth",
      (msg) => sent.push(msg),
      { model: "opus" },
    );

    const failure = await spawned.then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(isAcpAuthRequired(failure)).toBe(true);
    expect(sent).toEqual([]);
    expect(manager.getStatus()).toEqual([]);
  });

  test("Claude's message-shaped 401 during the pin surfaces as auth required", async () => {
    scriptedConfigOptions = [[modelOption("default")]];
    // Not the structured auth_required answer: the CLI's own words, which the
    // adapter relays as a generic internal error carrying them in `data`, and
    // which the spawn boundary only recognises once the manager classifies.
    setConfigOptionResult = new acp.RequestError(-32603, "Internal error", {
      details: "Failed to authenticate. Please run /login",
    });

    const manager = new AcpSessionManager(5);
    const sent: AssistantEvent[] = [];
    const spawned = manager.spawn(
      "claude",
      {
        command: "claude-agent-acp",
        args: [],
        credentialDigest: "digest-pin-401",
      },
      "task",
      "/tmp",
      "conv-pin-auth-message",
      (msg) => sent.push(msg),
      { model: "opus" },
    );

    const failure = await spawned.then(
      () => undefined,
      (err: unknown) => err,
    );
    expect(failure).toBeInstanceOf(AcpAuthRequiredError);
    expect(isAcpAuthRequired(failure)).toBe(true);
    expect((failure as Error).message).toBe(
      "Failed to authenticate. Please run /login",
    );
    // The refused credential is written down, so no later spawn resolves it.
    expect(claudeCredentialRefused("digest-pin-401")).toBe(true);
    expect(sent).toEqual([]);
    expect(manager.getStatus()).toEqual([]);
  });

  test("a message-shaped 401 with no payload classifies off the message", async () => {
    scriptedConfigOptions = [[modelOption("default")]];
    setConfigOptionResult = new Error(
      "Failed to authenticate. Please run /login",
    );

    const failure = await new AcpSessionManager(5)
      .spawn(
        "claude",
        { command: "claude-agent-acp", args: [] },
        "task",
        "/tmp",
        "conv-pin-auth-plain",
        () => {},
        { model: "opus" },
      )
      .then(
        () => undefined,
        (err: unknown) => err,
      );

    expect(failure).toBeInstanceOf(AcpAuthRequiredError);
    expect((failure as Error).message).toBe(
      "Failed to authenticate. Please run /login",
    );
  });

  test("the message-shaped 401 is still recognised when the adapter runs by full path", async () => {
    scriptedConfigOptions = [[modelOption("default")]];
    setConfigOptionResult = new acp.RequestError(-32603, "Internal error", {
      details: "Not logged in",
    });

    const manager = new AcpSessionManager(5);
    const failure = await manager
      .spawn(
        "claude",
        { command: "/opt/bin/claude-agent-acp", args: [] },
        "task",
        "/tmp",
        "conv-pin-auth-path",
        () => {},
        { model: "opus" },
      )
      .then(
        () => undefined,
        (err: unknown) => err,
      );

    expect(isAcpAuthRequired(failure)).toBe(true);
    expect(manager.getStatus()).toEqual([]);
  });

  test("a pin the connection cannot carry tears the spawn down", async () => {
    scriptedConfigOptions = [[modelOption("default")]];
    // A plain Error is how the SDK rejects a request when the stream closes
    // or the process exits: not the adapter's answer, so not a refusal.
    setConfigOptionResult = new Error("ACP connection closed");

    const manager = new AcpSessionManager(5);
    const sent: AssistantEvent[] = [];
    await expect(
      manager.spawn(
        "agent-model",
        { command: "echo", args: ["hi"] },
        "task",
        "/tmp",
        "conv-pin-transport",
        (msg) => sent.push(msg),
        { model: "opus" },
      ),
    ).rejects.toThrow("ACP connection closed");

    // The pin was attempted, then nothing was announced or prompted, and
    // nothing is left registered.
    expect(setConfigOptionCalls).toHaveLength(1);
    expect(sent).toEqual([]);
    expect(manager.getStatus()).toEqual([]);
  });

  test("a pin answered without the selector warns and leaves no model", async () => {
    scriptedConfigOptions = [[modelOption("sonnet")]];
    // The adapter takes the call, then answers with a set that advertises no
    // model selection at all.
    setConfigOptionResult = [nonModelOption()];

    const manager = new AcpSessionManager(5);
    const sent: AssistantEvent[] = [];
    const result = await manager.spawn(
      "agent-model",
      { command: "echo", args: ["hi"] },
      "task",
      "/tmp",
      "conv-pin-dropped",
      (msg) => sent.push(msg),
      { model: "opus" },
    );

    expect(result.modelWarning).toBe(
      'Agent "agent-model" does not support model selection, so the ' +
        "session is running on the agent's own model.",
    );
    const state = manager.getStatus(result.acpSessionId) as AcpSessionState;
    expect(state.model).toBeUndefined();
    expect(state.availableModels).toEqual([]);
    // The withdrawal goes out before the session is announced, which no
    // client holds an entry for yet, and the spawn's own model event stays
    // silent for an adapter with nothing to select.
    expect(sent.map((e) => e.type)).toEqual([
      "acp_session_model_update",
      "acp_session_spawned",
    ]);
    expect(sent[0]).toEqual({
      type: "acp_session_model_update",
      acpSessionId: result.acpSessionId,
      modelRevisionEpoch: state.modelRevisionEpoch!,
      modelRevision: 1,
      availableModels: [],
    });
  });

  test("a selector announced while the pin was open is withdrawn from clients", async () => {
    scriptedConfigOptions = [[modelOption("sonnet")]];
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    setConfigOptionResponder = async () => {
      await held;
      return [nonModelOption()];
    };

    const manager = new AcpSessionManager(5);
    const sent: AssistantEvent[] = [];
    const spawned = manager.spawn(
      "agent-model",
      { command: "echo", args: ["hi"] },
      "task",
      "/tmp",
      "conv-pin-announced",
      (msg) => sent.push(msg),
      { model: "opus" },
    );
    await waitForConfigOptionCalls(1);
    const acpSessionId = manager.getActiveAndPendingIds()[0]!;
    // The adapter reports a selector of its own while the pin is still open,
    // which reaches clients right away.
    await emitConfigOptions(manager, acpSessionId, [modelOption("opus")]);
    release();
    await spawned;

    const state = manager.getStatus(acpSessionId) as AcpSessionState;
    expect(state.model).toBeUndefined();
    expect(state.availableModels).toEqual([]);
    expect(sent.filter((e) => e.type === "acp_session_model_update")).toEqual([
      {
        type: "acp_session_model_update",
        acpSessionId,
        modelRevisionEpoch: state.modelRevisionEpoch!,
        modelRevision: 1,
        model: "opus",
        availableModels: MODEL_OPTION_MODELS,
      },
      {
        type: "acp_session_model_update",
        acpSessionId,
        modelRevisionEpoch: state.modelRevisionEpoch!,
        modelRevision: 2,
        availableModels: [],
      },
    ]);
  });

  test("an inherited model whose pin loses the selector warns nobody", async () => {
    scriptedConfigOptions = [[modelOption("sonnet")]];
    setConfigOptionResult = [nonModelOption()];

    const { modelWarning, state } = await spawnWithModel({
      conversationId: "conv-pin-dropped-inherited",
      agentModel: "opus",
    });

    expect(modelWarning).toBeUndefined();
    expect(state.model).toBeUndefined();
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
 * Drives a `config_option_update` through a session's real client handler,
 * the way an adapter reports a model change it made on its own.
 */
async function emitConfigOptions(
  manager: Manager,
  acpSessionId: string,
  options: SessionConfigOption[],
  sessionId = "proto-agent-model",
): Promise<void> {
  await clientHandlerFor(manager, acpSessionId).sessionUpdate({
    sessionId,
    update: { sessionUpdate: "config_option_update", configOptions: options },
  });
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

describe("AcpSessionManager: unsolicited model updates", () => {
  test("a model changed from the transcript updates state and publishes", async () => {
    const { manager, acpSessionId, sent } = await spawnSwitchable("conv-typed");

    await emitConfigOptions(manager, acpSessionId, [modelOption("opus")]);

    const state = manager.getStatus(acpSessionId) as AcpSessionState;
    expect(state.model).toBe("opus");
    expect(state.modelRevision).toBe(2);
    expect(sent).toEqual([
      {
        type: "acp_session_model_update",
        acpSessionId,
        modelRevisionEpoch: state.modelRevisionEpoch!,
        modelRevision: 2,
        model: "opus",
        availableModels: MODEL_OPTION_MODELS,
      },
    ]);
    // Reporting is not choosing: the adapter is never asked to set it back.
    expect(setConfigOptionCalls).toEqual([]);
  });

  test("a selector that disappears clears the model, the options, and the picker", async () => {
    const { manager, acpSessionId, sent } =
      await spawnSwitchable("conv-dropped");

    await emitConfigOptions(manager, acpSessionId, [nonModelOption()]);

    const state = manager.getStatus(acpSessionId) as AcpSessionState;
    expect(state.model).toBeUndefined();
    expect(state.availableModels).toEqual([]);
    expect(sent).toEqual([
      {
        type: "acp_session_model_update",
        acpSessionId,
        modelRevisionEpoch: state.modelRevisionEpoch!,
        modelRevision: 2,
        availableModels: [],
      },
    ]);
    expect(setConfigOptionCalls).toEqual([]);
  });

  test("an update repeating the current model still publishes", async () => {
    const { manager, acpSessionId, sent } =
      await spawnSwitchable("conv-unchanged");

    await emitConfigOptions(manager, acpSessionId, [modelOption("sonnet")]);

    expect(sent.map((e) => e.type)).toEqual(["acp_session_model_update"]);
  });

  test("a notification after the session went terminal changes nothing", async () => {
    const { manager, acpSessionId, sent } =
      await spawnSwitchable("conv-terminal");
    const handler = clientHandlerFor(manager, acpSessionId);
    await manager.cancel(acpSessionId);
    sent.length = 0;

    await handler.sessionUpdate({
      sessionId: "proto-agent-model",
      update: {
        sessionUpdate: "config_option_update",
        configOptions: [modelOption("opus")],
      },
    });

    const state = manager.getStatus(acpSessionId) as AcpSessionState;
    expect(state.status).toBe("cancelled");
    expect(state.model).toBe("sonnet");
    expect(sent).toEqual([]);
  });

  test("a selector appearing mid-run publishes the picker", async () => {
    scriptedConfigOptions = [[nonModelOption()]];
    const manager = new AcpSessionManager(5);
    const sent: AssistantEvent[] = [];
    const { acpSessionId } = await manager.spawn(
      "agent-model",
      { command: "echo", args: ["hi"] },
      "task",
      "/tmp",
      "conv-selector-midrun",
      (msg) => sent.push(msg),
    );
    expect(sent.map((e) => e.type)).toEqual(["acp_session_spawned"]);
    sent.length = 0;

    await emitConfigOptions(manager, acpSessionId, [modelOption("opus")]);

    const state = manager.getStatus(acpSessionId) as AcpSessionState;
    expect(sent).toEqual([
      {
        type: "acp_session_model_update",
        acpSessionId,
        modelRevisionEpoch: state.modelRevisionEpoch!,
        modelRevision: 1,
        model: "opus",
        availableModels: MODEL_OPTION_MODELS,
      },
    ]);
  });

  test("a selector announced during session/new survives a response that omits it", async () => {
    // The adapter answers session/new with no config options at all.
    scriptedConfigOptions = [[]];
    setConfigOptionResult = [modelOption("opus")];
    let release = () => {};
    createSessionGate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const manager = new AcpSessionManager(5);
    const sent: AssistantEvent[] = [];
    const spawning = manager.spawn(
      "agent-model",
      { command: "echo", args: ["hi"], model: "opus" },
      "task",
      "/tmp",
      "conv-open-race",
      (msg: AssistantEvent) => sent.push(msg),
    );
    const acpSessionId = (manager.getStatus() as AcpSessionState[])[0].id;

    // The adapter announces its selector while session/new is still open.
    await emitConfigOptions(manager, acpSessionId, [modelOption("sonnet")]);
    release();
    await spawning;

    // The selector is still there for the agent's own model to be pinned
    // through, and the picker still reaches the client after the spawn.
    expect(setConfigOptionCalls).toEqual([
      { sessionId: "proto-agent-model", configId: "model", value: "opus" },
    ]);
    expect((manager.getStatus(acpSessionId) as AcpSessionState).model).toBe(
      "opus",
    );
    expect(sent.map((e) => e.type)).toEqual([
      "acp_session_model_update",
      "acp_session_spawned",
      "acp_session_model_update",
    ]);
    expect(sent[2]).toMatchObject({
      model: "opus",
      availableModels: MODEL_OPTION_MODELS,
    });
  });

  test("an opening response naming a selector outranks one announced mid-call", async () => {
    scriptedConfigOptions = [[modelOption("opus")]];
    let release = () => {};
    createSessionGate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const manager = new AcpSessionManager(5);
    const sent: AssistantEvent[] = [];
    const spawning = manager.spawn(
      "agent-model",
      { command: "echo", args: ["hi"] },
      "task",
      "/tmp",
      "conv-open-response",
      (msg: AssistantEvent) => sent.push(msg),
    );
    const acpSessionId = (manager.getStatus() as AcpSessionState[])[0].id;

    await emitConfigOptions(manager, acpSessionId, [modelOption("sonnet")]);
    release();
    await spawning;

    // Nothing was requested and the response says the session is on opus, so
    // the adapter is never asked to change.
    expect((manager.getStatus(acpSessionId) as AcpSessionState).model).toBe(
      "opus",
    );
    expect(setConfigOptionCalls).toEqual([]);
    expect(sent[sent.length - 1]).toMatchObject({
      type: "acp_session_model_update",
      model: "opus",
      availableModels: MODEL_OPTION_MODELS,
    });
  });
});

describe("AcpSessionManager: a resumed id and the process it replaced", () => {
  /**
   * A cancel frees the id, so a resume can register a fresh entry under it
   * while the stopped spawn's pin is still open. Everything the old process
   * says after that reaches the manager through the old entry's own closures,
   * and those closures own nothing the replacement holds: not its state, not
   * its ring buffer, not its clients.
   */
  test("late frames from the replaced process touch nothing the replacement owns", async () => {
    scriptedConfigOptions = [[modelOption("sonnet")]];
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    setConfigOptionResponder = async () => {
      await held;
      // The withdrawal a vanished selector publishes, which is the frame that
      // would otherwise go out over the replacement's id.
      return [];
    };

    const manager = new AcpSessionManager(5);
    const controller = new AbortController();
    const sent: AssistantEvent[] = [];
    const spawned = manager.spawn(
      "agent-model",
      { command: "echo", args: ["hi"] },
      "task",
      "/tmp",
      "conv-replaced",
      (msg) => sent.push(msg),
      { model: "opus" },
      { signal: controller.signal },
    );
    await waitForConfigOptionCalls(1);
    const acpSessionId = manager.getActiveAndPendingIds()[0]!;
    const oldHandler = clientHandlerFor(manager, acpSessionId);

    // The user stops the turn and a resume takes the id over, both while the
    // pin's round trip is still open.
    controller.abort();
    const internals = manager as unknown as {
      registerSession: (opts: Record<string, unknown>) => {
        state: AcpSessionState;
      };
      eventBuffers: Map<string, unknown[]>;
    };
    const replacement = internals.registerSession({
      acpSessionId,
      agentId: "agent-model",
      agentConfig: { command: "echo", args: ["hi"] },
      parentConversationId: "conv-resumed",
      cwd: "/tmp",
      startedAt: Date.now(),
      sendToVellum: () => {},
    });
    replacement.state.status = "running";
    sent.length = 0;

    release();
    await expect(spawned).rejects.toThrow();

    // The old adapter goes on talking: a model change typed into its
    // transcript, then a message chunk.
    await oldHandler.sessionUpdate({
      sessionId: "proto-agent-model",
      update: {
        sessionUpdate: "config_option_update",
        configOptions: [modelOption("haiku")],
      },
    });
    await oldHandler.sessionUpdate({
      sessionId: "proto-agent-model",
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "from the old process" },
      },
    });

    // The replacement is on nothing the old process said, and its buffer and
    // its clients heard none of it.
    const state = manager.getStatus(acpSessionId) as AcpSessionState;
    expect(state.parentConversationId).toBe("conv-resumed");
    expect(state.model).toBeUndefined();
    expect(state.availableModels).toBeUndefined();
    expect(internals.eventBuffers.get(acpSessionId)).toEqual([]);
    expect(sent).toEqual([]);
  });
});
