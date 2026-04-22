/**
 * Tests for the `titleGenerate` pipeline (PR 28).
 *
 * The title-generation side effect used to be a direct call to
 * `queueGenerateConversationTitle` inside `conversation-agent-loop.ts`.
 * After PR 28 the assistant routes that call through the plugin pipeline
 * runner, giving plugins an opportunity to observe/replace the default
 * implementation.
 *
 * Covers:
 * - The default plugin's terminal delegates to
 *   `queueGenerateConversationTitle` with the same arguments the agent
 *   loop constructs.
 * - A custom plugin can install a short-circuit middleware that replaces
 *   the terminal with a deterministic generator. The default terminal is
 *   NOT invoked in that case.
 *
 * Mocks `memory/conversation-title-service.js` so the tests don't touch
 * the real provider stack, and resets the plugin registry between cases.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

// Stub the title-generation service before importing anything that binds
// to it, so both the default plugin and the agent loop capture the
// stubbed binding.
const queueGenerateConversationTitleMock = mock(
  (_params: {
    conversationId: string;
    provider?: unknown;
    userMessage?: string;
    onTitleUpdated?: (title: string) => void;
  }): void => undefined,
);
mock.module("../memory/conversation-title-service.js", () => ({
  queueGenerateConversationTitle: queueGenerateConversationTitleMock,
}));

import { defaultTitleGenerateTerminal } from "../plugins/defaults/title-generate.js";
import { DEFAULT_TIMEOUTS, runPipeline } from "../plugins/pipeline.js";
import {
  getMiddlewaresFor,
  registerPlugin,
  resetPluginRegistryForTests,
} from "../plugins/registry.js";
import type {
  Middleware,
  Plugin,
  TitleArgs,
  TitleResult,
  TurnContext,
} from "../plugins/types.js";

function makeCtx(overrides: Partial<TurnContext> = {}): TurnContext {
  return {
    requestId: "req-1",
    conversationId: "conv-1",
    turnIndex: 0,
    trust: { sourceChannel: "vellum", trustClass: "unknown" },
    ...overrides,
  };
}

function makeArgs(overrides: Partial<TitleArgs> = {}): TitleArgs {
  return {
    conversationId: "conv-1",
    userMessage: "hello world",
    ...overrides,
  };
}

describe("titleGenerate pipeline", () => {
  beforeEach(() => {
    resetPluginRegistryForTests();
    queueGenerateConversationTitleMock.mockReset();
    queueGenerateConversationTitleMock.mockImplementation(() => undefined);
    // Re-register the default plugin after the registry reset so tests see
    // the same shape the daemon sees at runtime.
    registerPlugin({
      manifest: {
        name: "default-title-generate",
        version: "1.0.0",
        provides: { titleGenerate: "v1" },
        requires: {
          pluginRuntime: "v1",
          titleGenerateApi: "v1",
        },
      },
    });
  });

  test("default: pipeline terminal queues a title-generation job", async () => {
    const ctx = makeCtx();
    const onTitleUpdated = mock((_title: string) => undefined);
    const args = makeArgs({
      conversationId: "conv-1",
      userMessage: "first message",
      onTitleUpdated,
    });

    await runPipeline(
      "titleGenerate",
      getMiddlewaresFor("titleGenerate"),
      defaultTitleGenerateTerminal,
      args,
      ctx,
      DEFAULT_TIMEOUTS.titleGenerate,
    );

    // The default terminal must have delegated to queueGenerateConversationTitle
    // with every argument the caller supplied, including the callback.
    expect(queueGenerateConversationTitleMock).toHaveBeenCalledTimes(1);
    const call = queueGenerateConversationTitleMock.mock.calls[0]?.[0];
    expect(call?.conversationId).toBe("conv-1");
    expect(call?.userMessage).toBe("first message");
    expect(call?.onTitleUpdated).toBe(onTitleUpdated);
  });

  test("default: pipeline result is the empty object from the terminal", async () => {
    const ctx = makeCtx();
    const result = await runPipeline(
      "titleGenerate",
      getMiddlewaresFor("titleGenerate"),
      defaultTitleGenerateTerminal,
      makeArgs(),
      ctx,
      DEFAULT_TIMEOUTS.titleGenerate,
    );
    expect(result).toEqual({});
  });

  test("custom plugin: short-circuit middleware replaces the default with a deterministic generator", async () => {
    // A custom plugin installs middleware that fabricates a title
    // deterministically and never calls `next`, so the default terminal
    // (which would delegate to queueGenerateConversationTitle) is
    // skipped entirely.
    const observedTitles: string[] = [];

    const deterministicMw: Middleware<TitleArgs, TitleResult> = async (
      args,
    ) => {
      const fabricated = `[deterministic] ${args.userMessage}`;
      args.onTitleUpdated?.(fabricated);
      observedTitles.push(fabricated);
      return {};
    };

    const customPlugin: Plugin = {
      manifest: {
        name: "custom-deterministic-title",
        version: "0.0.1",
        requires: {
          pluginRuntime: "v1",
          titleGenerateApi: "v1",
        },
      },
      middleware: { titleGenerate: deterministicMw },
    };
    registerPlugin(customPlugin);

    const receivedTitle: string[] = [];
    const args = makeArgs({
      userMessage: "what is the weather",
      onTitleUpdated: (title) => {
        receivedTitle.push(title);
      },
    });

    await runPipeline(
      "titleGenerate",
      getMiddlewaresFor("titleGenerate"),
      defaultTitleGenerateTerminal,
      args,
      makeCtx(),
      DEFAULT_TIMEOUTS.titleGenerate,
    );

    // Deterministic middleware produced the expected title and invoked
    // the caller's callback.
    expect(observedTitles).toEqual(["[deterministic] what is the weather"]);
    expect(receivedTitle).toEqual(["[deterministic] what is the weather"]);
    // The default terminal must NOT have been reached — it would have
    // called the real title-service stub.
    expect(queueGenerateConversationTitleMock).not.toHaveBeenCalled();
  });

  test("custom plugin: passthrough middleware leaves the default in charge", async () => {
    // A plugin that always calls `next` just observes — the default
    // terminal still runs and queues the title-generation job.
    let middlewareSawArgs = false;

    const passthroughMw: Middleware<TitleArgs, TitleResult> = async (
      args,
      next,
    ) => {
      middlewareSawArgs = true;
      return next(args);
    };

    registerPlugin({
      manifest: {
        name: "observer",
        version: "0.0.1",
        requires: {
          pluginRuntime: "v1",
          titleGenerateApi: "v1",
        },
      },
      middleware: { titleGenerate: passthroughMw },
    });

    await runPipeline(
      "titleGenerate",
      getMiddlewaresFor("titleGenerate"),
      defaultTitleGenerateTerminal,
      makeArgs(),
      makeCtx(),
      DEFAULT_TIMEOUTS.titleGenerate,
    );

    expect(middlewareSawArgs).toBe(true);
    expect(queueGenerateConversationTitleMock).toHaveBeenCalledTimes(1);
  });
});
