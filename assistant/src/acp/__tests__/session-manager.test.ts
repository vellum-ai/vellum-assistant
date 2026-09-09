/**
 * Regression tests for AcpSessionManager state population — specifically
 * that `parentConversationId` is set on every session state at spawn time
 * and is therefore visible through `getStatus()` from t=0, plus the model a
 * spawn resolves, applies through the adapter, and publishes.
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
const { AcpSessionManager } = await import("../session-manager.js");
await initializeDb();

beforeEach(() => {
  scriptedConfigOptions = [];
  setConfigOptionCalls.length = 0;
  setConfigOptionResult = [];
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
  }): Promise<{ state: AcpSessionState; sent: AssistantEvent[] }> {
    const manager = new AcpSessionManager(5);
    const sent: AssistantEvent[] = [];
    const { acpSessionId } = await manager.spawn(
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
