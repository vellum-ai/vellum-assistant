/**
 * Shared test harness for driving the daemon's native `server_tool_complete`
 * web_search handler in isolation (ATL-727).
 *
 * Both `native-web-search.test.ts` and `web-search-backend-failure.test.ts`
 * exercise the same handler the same way: build a set of mocked
 * `EventHandlerDeps` (capturing emitted `AssistantEvent`s and `rlog.warn`
 * records), then drive a `server_tool_start` → `server_tool_complete` pair.
 * This module is the single source of truth for that harness so the two suites
 * cannot drift apart.
 *
 * Note: each consuming test file must still install its own
 * `mock.module(...)` stubs for the daemon collaborators the handler imports at
 * load time (config loader, conversation-crud, llm-request-log-store), because
 * Bun's `mock.module()` is scoped to the file that registers it.
 */
import type { AssistantEvent } from "../../api/index.js";
import type {
  EventHandlerDeps,
  EventHandlerState,
} from "../../daemon/conversation-agent-loop-handlers.js";
import { dispatchAgentEvent } from "../../daemon/conversation-agent-loop-handlers.js";

/** A `tool_result` `AssistantEvent` emitted by the handler. */
export type ToolResultEvent = Extract<AssistantEvent, { type: "tool_result" }>;

/** A captured `rlog.warn(obj, msg)` call. */
export interface LogRecord {
  obj: Record<string, unknown>;
  msg?: string;
}

export interface HandlerHarness {
  deps: EventHandlerDeps;
  /** Every `AssistantEvent` the handler emitted via `onEvent`. */
  events: AssistantEvent[];
  /** Every `rlog.warn(obj, msg)` call the handler made. */
  warnings: LogRecord[];
}

/** Build mocked handler deps that capture emitted events and warn logs. */
export function createHandlerDeps(reqId = "req-web-search"): HandlerHarness {
  const events: AssistantEvent[] = [];
  const warnings: LogRecord[] = [];
  const rlog = {
    warn: (obj: Record<string, unknown>, msg?: string) =>
      warnings.push({ obj, msg }),
    info: () => {},
    error: () => {},
    debug: () => {},
    trace: () => {},
    fatal: () => {},
  };
  const deps = {
    ctx: {
      conversationId: "conv-web-search",
      provider: { name: "anthropic" },
      streamThinking: false,
      emitActivityState: () => {},
      markWorkspaceTopLevelDirty: () => {},
      currentTurnSurfaces: [],
    } as unknown as EventHandlerDeps["ctx"],
    onEvent: (msg: AssistantEvent) => events.push(msg),
    reqId,
    isFirstMessage: false,
    shouldGenerateTitle: false,
    rlog: rlog as unknown as EventHandlerDeps["rlog"],
    turnChannelContext: {
      userMessageChannel: "vellum",
      assistantMessageChannel: "vellum",
    } as EventHandlerDeps["turnChannelContext"],
    turnInterfaceContext: {
      userMessageInterface: "macos",
      assistantMessageInterface: "macos",
    } as EventHandlerDeps["turnInterfaceContext"],
    applyCompaction: async () => {},
  } as EventHandlerDeps;
  return { deps, events, warnings };
}

/** The `server_tool_complete` payload shape a test supplies. */
export interface WebSearchCompleteEvent {
  isError: boolean;
  errorCode?: string;
  errorMessage?: string;
  content?: unknown[];
}

/** Drive one native (Anthropic) web_search start → complete pair. */
export async function completeNativeWebSearch(
  state: EventHandlerState,
  deps: EventHandlerDeps,
  toolUseId: string,
  event: WebSearchCompleteEvent,
): Promise<void> {
  await dispatchAgentEvent(state, deps, {
    type: "server_tool_start",
    name: "web_search",
    toolUseId,
    input: { query: "what is the weather" },
  });
  await dispatchAgentEvent(state, deps, {
    type: "server_tool_complete",
    toolUseId,
    isError: event.isError,
    ...(event.errorCode ? { errorCode: event.errorCode } : {}),
    ...(event.errorMessage ? { errorMessage: event.errorMessage } : {}),
    content: event.content ?? [],
  });
}

/** All `tool_result` events emitted so far, in order. */
export function toolResults(events: AssistantEvent[]): ToolResultEvent[] {
  return events.filter((e): e is ToolResultEvent => e.type === "tool_result");
}

/** The most recent `tool_result` event, if any. */
export function lastToolResult(
  events: AssistantEvent[],
): ToolResultEvent | undefined {
  const results = toolResults(events);
  return results[results.length - 1];
}

/** The captured `web_search_backend_failure` telemetry warn records. */
export function backendFailureLogs(warnings: LogRecord[]): LogRecord[] {
  return warnings.filter((w) => w.obj.event === "web_search_backend_failure");
}
