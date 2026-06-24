import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { Message } from "../../../../providers/types.js";

// Stub the provider resolution; spread the real module so `extractAllText` /
// `userMessage` (which the consult also uses) keep working.
let sendMessageArgs: Record<string, unknown> | null = null;
let responseText = "Use a channel-based worker pool; drain on shutdown.";
let sendMessageError: Error | null = null;
let providerResolves = true;
let providerSupportsWeb = false;
let streamDeltas: string[] = [];
let streamEvents: Array<Record<string, unknown>> = [];
// Multi-turn scripting for the tool-loop tests: each queued entry is returned
// by one `sendMessage` call (e.g. a `tool_use` turn followed by a final turn).
// When empty, the provider returns the default single `responseText` turn.
let responseQueue: Array<{ content: unknown[]; stopReason: string }> = [];
// Snapshot of every call's messages, so tests can assert what was fed back.
let sendMessageCalls: Array<{ messages: unknown[]; options: unknown }> = [];

const fakeProvider = {
  name: "mock-advisor-provider",
  get supportsNativeWebSearch() {
    return providerSupportsWeb;
  },
  async sendMessage(messages: unknown, options: unknown) {
    sendMessageArgs = { messages, options } as Record<string, unknown>;
    sendMessageCalls.push({
      messages: Array.isArray(messages) ? [...messages] : [],
      options,
    });
    if (sendMessageError) throw sendMessageError;
    const onEvent = (
      options as { onEvent?: (e: Record<string, unknown>) => void }
    ).onEvent;
    if (onEvent) {
      // Activity (search/thinking) streams before the final advice text.
      for (const ev of streamEvents) onEvent(ev);
      for (const text of streamDeltas) onEvent({ type: "text_delta", text });
    }
    const scripted = responseQueue.shift();
    return {
      content: scripted?.content ?? [{ type: "text", text: responseText }],
      model: "mock-model",
      usage: { inputTokens: 1, outputTokens: 1 },
      stopReason: scripted?.stopReason ?? "end_turn",
    };
  },
};

// The advisor's `read_file` tool reads through these shared filesystem modules;
// stub them so the loop tests never touch disk. The returned content echoes the
// requested path, so tests can assert the file content was fed back.
mock.module("../../../../tools/shared/filesystem/path-policy.js", () => ({
  sandboxPolicy: (path: string, dir: string) => ({
    ok: true,
    resolved: `${dir}/${path}`,
  }),
}));
mock.module("../../../../tools/shared/filesystem/file-ops-service.js", () => ({
  FileSystemOps: class {
    constructor(_policy: unknown) {}
    readFileSafe({ path }: { path: string }) {
      if (path.includes("missing")) {
        return { ok: false, error: { code: "NOT_FOUND", message: "no such file" } };
      }
      return { ok: true, value: { content: `1\tCONTENTS OF ${path}` } };
    }
  },
}));

const realPsm = await import("../../../../providers/provider-send-message.js");
mock.module("../../../../providers/provider-send-message.js", () => ({
  ...realPsm,
  getConfiguredProvider: async () => (providerResolves ? fakeProvider : null),
}));

// Keep the tool tests focused on the consult wiring: stub the context pack so
// they don't reach into the registry / workspace / memory sources (those have
// their own coverage). The consult itself never imports this module.
mock.module("../context-pack.js", () => ({
  buildAdvisorContext: async () => null,
  deriveRecallQuery: () => null,
}));

const { consultAdvisor } = await import("../consult.js");
const advisorTool = (await import("../tools/advisor.js")).default;
const { recordSystemPrompt, recordMessages, resetAdvisorStateForTests } =
  await import("../advisor-state-store.js");

const userMsg = (t: string): Message => ({
  role: "user",
  content: [{ type: "text", text: t }],
});

function optionConfig(): Record<string, unknown> {
  const options = sendMessageArgs?.options as Record<string, unknown>;
  return options.config as Record<string, unknown>;
}

beforeEach(() => {
  sendMessageArgs = null;
  responseText = "Use a channel-based worker pool; drain on shutdown.";
  sendMessageError = null;
  providerResolves = true;
  providerSupportsWeb = false;
  streamDeltas = [];
  streamEvents = [];
  responseQueue = [];
  sendMessageCalls = [];
  resetAdvisorStateForTests();
});

describe("consultAdvisor", () => {
  test("routes through the advisor call site, tools off, returns advice", async () => {
    const messages: Message[] = [
      userMsg("build a worker pool"),
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "secret", signature: "s" },
          { type: "text", text: "let me consult the advisor" },
          { type: "tool_use", id: "t1", name: "advisor", input: {} },
        ],
      },
    ];

    const advice = await consultAdvisor({
      systemPrompt: "You are a coding agent.",
      messages,
    });

    expect(advice).toBe(responseText);

    const config = optionConfig();
    expect(config.callSite).toBe("advisor");
    // No `advisorProfile` is configured in the default test config, so the
    // consult passes no override and the `advisor` call site resolves to its
    // default profile (`quality-optimized`).
    expect(config.overrideProfile).toBeUndefined();
    expect(config.tool_choice).toEqual({ type: "none" });
    // No advisor-specific output cap — the resolver applies the profile budget.
    expect(config.max_tokens).toBeUndefined();

    const sent = sendMessageArgs?.messages as Message[];
    expect(sent[0]).toEqual(userMsg("build a worker pool"));
    expect(sent[1]).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "let me consult the advisor" }],
    });
    const lastText = (sent[sent.length - 1].content[0] as { text: string })
      .text;
    expect(lastText).toContain("focused strategic guidance");
    // The request carries no word limit.
    expect(lastText).not.toContain("words");

    const options = sendMessageArgs?.options as { systemPrompt: string };
    expect(options.systemPrompt).toContain("senior advisor");
    expect(options.systemPrompt).toContain("You are a coding agent.");
  });

  test("stays tool-less when the provider has no native web search", async () => {
    providerSupportsWeb = false;
    await consultAdvisor({ systemPrompt: null, messages: [userMsg("hi")] });
    const options = sendMessageArgs?.options as { tools?: unknown };
    expect(options.tools).toBeUndefined();
    expect(optionConfig().tool_choice).toEqual({ type: "none" });
  });

  test("enables native web search when the provider supports it", async () => {
    providerSupportsWeb = true;
    await consultAdvisor({ systemPrompt: null, messages: [userMsg("hi")] });

    const options = sendMessageArgs?.options as {
      tools?: Array<{ name: string }>;
    };
    expect(options.tools?.map((t) => t.name)).toEqual(["web_search"]);
    // tool_choice must not be `none`, or the provider suppresses its server tool.
    expect(optionConfig().tool_choice).toEqual({ type: "auto" });
  });

  test("attaches read_file only when a workingDir is provided", async () => {
    await consultAdvisor({
      systemPrompt: null,
      messages: [userMsg("hi")],
      workingDir: "/work",
    });
    let opts = sendMessageArgs?.options as { tools?: Array<{ name: string }> };
    expect(opts.tools?.map((t) => t.name)).toContain("read_file");

    await consultAdvisor({ systemPrompt: null, messages: [userMsg("hi")] });
    opts = sendMessageArgs?.options as { tools?: Array<{ name: string }> };
    expect(opts.tools?.some((t) => t.name === "read_file") ?? false).toBe(false);
  });

  test("reads a workspace file the advisor requests, then advises with it", async () => {
    // Turn 1: advisor asks to read a file. Turn 2: it gives advice.
    responseQueue = [
      {
        content: [
          { type: "tool_use", id: "r1", name: "read_file", input: { path: "src/app.ts" } },
        ],
        stopReason: "tool_use",
      },
      {
        content: [{ type: "text", text: "Given src/app.ts, drain the pool on shutdown." }],
        stopReason: "end_turn",
      },
    ];
    const chunks: string[] = [];

    const advice = await consultAdvisor({
      systemPrompt: null,
      messages: [userMsg("review my plan")],
      workingDir: "/work",
      onText: (c) => chunks.push(c),
    });

    // The final advice is returned...
    expect(advice).toContain("drain the pool on shutdown");
    // ...a read note streamed to the drawer...
    expect(chunks.join("")).toContain("Read src/app.ts");
    // ...and the file content was fed back to the model on the 2nd call.
    expect(JSON.stringify(sendMessageCalls[1]?.messages)).toContain(
      "CONTENTS OF src/app.ts",
    );
    expect(sendMessageCalls).toHaveLength(2);
  });

  test("feeds an error result back when a requested file can't be read", async () => {
    responseQueue = [
      {
        content: [
          { type: "tool_use", id: "r1", name: "read_file", input: { path: "missing.ts" } },
        ],
        stopReason: "tool_use",
      },
      {
        content: [{ type: "text", text: "Can't see that file; here's my best guidance." }],
        stopReason: "end_turn",
      },
    ];
    const chunks: string[] = [];

    const advice = await consultAdvisor({
      systemPrompt: null,
      messages: [userMsg("review my plan")],
      workingDir: "/work",
      onText: (c) => chunks.push(c),
    });

    expect(chunks.join("")).toContain("Couldn't read missing.ts");
    expect(JSON.stringify(sendMessageCalls[1]?.messages)).toContain("no such file");
    expect(advice).toContain("best guidance");
  });

  test("caps total file reads so a runaway consult terminates", async () => {
    // The model asks to read one file every turn, forever. The loop must stop.
    for (let i = 0; i < 30; i++) {
      responseQueue.push({
        content: [
          { type: "tool_use", id: `r${i}`, name: "read_file", input: { path: `f${i}.ts` } },
        ],
        stopReason: "tool_use",
      });
    }

    await consultAdvisor({
      systemPrompt: null,
      messages: [userMsg("review my plan")],
      workingDir: "/work",
    });

    // Bounded by ADVISOR_MAX_TOOL_ITERATIONS (12) + the initial call — never 31.
    expect(sendMessageCalls.length).toBeLessThanOrEqual(13);
  });

  test("does not attach read_file or loop when no workingDir is set", async () => {
    // Even if the model returns a tool_use, with no workingDir there is no
    // read_file tool, so the consult stays a one-shot and doesn't loop.
    responseText = "Just advice, no tools.";
    const advice = await consultAdvisor({
      systemPrompt: null,
      messages: [userMsg("hi")],
    });
    expect(advice).toBe("Just advice, no tools.");
    expect(sendMessageCalls).toHaveLength(1);
  });

  test("streams web-search activity to onText, not just the final advice", async () => {
    providerSupportsWeb = true;
    streamEvents = [
      { type: "server_tool_start", name: "web_search", toolUseId: "s1", input: {} },
      {
        type: "server_tool_complete",
        toolUseId: "s1",
        isError: false,
        resolvedInput: { query: "vellum streaming" },
      },
    ];
    streamDeltas = ["Here is ", "the advice."];
    const chunks: string[] = [];

    await consultAdvisor({
      systemPrompt: null,
      messages: [userMsg("hi")],
      onText: (c) => chunks.push(c),
    });

    const joined = chunks.join("");
    // The drawer isn't silent during the search prefix...
    expect(joined).toContain("Searching the web");
    expect(joined).toContain("Searched: vellum streaming");
    // ...and the advice text still streams.
    expect(joined).toContain("Here is the advice.");
  });

  test("surfaces a failure note (not 'Searched') when a web search errors", async () => {
    providerSupportsWeb = true;
    streamEvents = [
      { type: "server_tool_start", name: "web_search", toolUseId: "s1", input: {} },
      {
        type: "server_tool_complete",
        toolUseId: "s1",
        isError: true,
        errorCode: "query_too_long",
        resolvedInput: { query: "an overly long query" },
      },
    ];
    streamDeltas = ["Proceeding without search."];
    const chunks: string[] = [];

    await consultAdvisor({
      systemPrompt: null,
      messages: [userMsg("hi")],
      onText: (c) => chunks.push(c),
    });

    const joined = chunks.join("");
    expect(joined).toContain("Web search failed");
    expect(joined).not.toContain("🔎 Searched:");
    // The consult still continues and streams its guidance.
    expect(joined).toContain("Proceeding without search.");
  });

  test("streams the model's reasoning summary to onText", async () => {
    streamEvents = [{ type: "thinking_delta", thinking: "weighing tradeoffs" }];
    const chunks: string[] = [];
    await consultAdvisor({
      systemPrompt: null,
      messages: [userMsg("hi")],
      onText: (c) => chunks.push(c),
    });
    expect(chunks.join("")).toContain("weighing tradeoffs");
  });

  test("embeds the runtime context in the advisor system prompt", async () => {
    await consultAdvisor({
      systemPrompt: "You are a coding agent.",
      messages: [userMsg("hi")],
      runtimeContext: "## Available tools\n- bash — run commands",
    });
    const options = sendMessageArgs?.options as { systemPrompt: string };
    expect(options.systemPrompt).toContain("<agent_runtime_context>");
    expect(options.systemPrompt).toContain("- bash — run commands");
  });

  test("soft-fails when no provider is configured", async () => {
    providerResolves = false;
    const advice = await consultAdvisor({
      systemPrompt: null,
      messages: [userMsg("hi")],
    });
    expect(advice).toContain("no inference provider");
  });

  test("returns a notice when there is no usable transcript", async () => {
    const advice = await consultAdvisor({ systemPrompt: null, messages: [] });
    expect(advice).toContain("no conversation context");
    expect(sendMessageArgs).toBeNull();
  });

  test("falls back to a notice when the advisor returns blank text", async () => {
    responseText = "   ";
    const advice = await consultAdvisor({
      systemPrompt: null,
      messages: [userMsg("hi")],
    });
    expect(advice).toContain("no guidance");
  });

  test("streams the model's text deltas to `onText` as it generates", async () => {
    streamDeltas = ["Use a ", "channel-based ", "worker pool."];
    const chunks: string[] = [];

    const advice = await consultAdvisor({
      systemPrompt: null,
      messages: [userMsg("hi")],
      onText: (c) => chunks.push(c),
    });

    // Each visible delta is forwarded live...
    expect(chunks).toEqual(["Use a ", "channel-based ", "worker pool."]);
    // ...and the complete guidance is still returned.
    expect(advice).toBe(responseText);
  });

  test("registers no `onEvent` sink when `onText` is absent", async () => {
    streamDeltas = ["x"];
    await consultAdvisor({ systemPrompt: null, messages: [userMsg("hi")] });
    const options = sendMessageArgs?.options as { onEvent?: unknown };
    expect(options.onEvent).toBeUndefined();
  });
});

describe("advisor tool.execute", () => {
  test("reads the captured transcript and returns guidance as a non-error result", async () => {
    recordSystemPrompt("c1", "You are a coding agent.");
    recordMessages("c1", [userMsg("build a worker pool")]);

    const result = await advisorTool.execute?.({}, {
      conversationId: "c1",
    } as never);

    expect(result?.isError).toBe(false);
    expect(result?.content).toBe(responseText);
  });

  test("degrades to a benign result (never throws) when the consult fails", async () => {
    recordMessages("c2", [userMsg("hi")]);
    sendMessageError = new Error("kaboom");

    const result = await advisorTool.execute?.({}, {
      conversationId: "c2",
    } as never);

    expect(result?.isError).toBe(false);
    expect(result?.content).toContain("advisor unavailable");
    expect(result?.content).toContain("kaboom");
  });

  test("streams the consult live via `ctx.onOutput`", async () => {
    recordMessages("c3", [userMsg("hi")]);
    streamDeltas = ["plan: ", "do X"];
    const out: string[] = [];

    const result = await advisorTool.execute?.({}, {
      conversationId: "c3",
      onOutput: (c: string) => out.push(c),
    } as never);

    expect(out).toEqual(["plan: ", "do X"]);
    expect(result?.isError).toBe(false);
    expect(result?.content).toBe(responseText);
  });
});
