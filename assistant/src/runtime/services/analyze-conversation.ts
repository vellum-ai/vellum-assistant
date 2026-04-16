/**
 * Service: analyzeConversation
 *
 * Factored out of the manual analyze route handler so the same core logic can
 * be invoked from multiple call sites (manual HTTP trigger and auto-analyze
 * job worker).
 *
 * Two triggers are supported:
 *   - **manual**: user-initiated analysis. Creates a fresh conversation each
 *     invocation, runs with `trustClass: "unknown"`, and strips the tool
 *     surface.
 *   - **auto**: called by the auto-analyze job when a source conversation
 *     reaches a natural pause. Reuses a rolling analysis conversation per
 *     parent (creating one if none exists), runs with `trustClass:
 *     "guardian"`, and keeps the full tool surface so the analysis agent can
 *     write memory and skills directly.
 *
 * Both triggers route the agent loop through `callSite: 'analyzeConversation'`
 * so per-call provider/model selection flows through `resolveCallSiteConfig`
 * against `llm.callSites.analyzeConversation` (populated by the unify-llm
 * workspace migration from the legacy `analysis.modelIntent`/`modelOverride`).
 */
import type { ServerMessage } from "../../daemon/message-protocol.js";
import {
  AUTO_ANALYSIS_GROUP_ID,
  AUTO_ANALYSIS_SOURCE,
} from "../../memory/auto-analysis-guard.js";
import {
  addMessage,
  createConversation,
  findAnalysisConversationFor,
  getConversation,
  getConversationSource,
  getMessages,
} from "../../memory/conversation-crud.js";
import { resolveConversationId } from "../../memory/conversation-key-store.js";
import { getLogger } from "../../util/logger.js";
import { buildAssistantEvent } from "../assistant-event.js";
import { DAEMON_INTERNAL_ASSISTANT_ID } from "../assistant-scope.js";
import type { SendMessageDeps } from "../http-types.js";
import {
  buildAutoAnalysisPrompt,
  neutralizeTranscriptSentinel,
} from "./auto-analysis-prompt.js";

const log = getLogger("analyze-conversation-service");

// ---------------------------------------------------------------------------
// Dependency types — injected by the caller (route handler / future triggers)
// ---------------------------------------------------------------------------

export interface ConversationAnalysisDeps {
  sendMessageDeps: SendMessageDeps;
  buildConversationDetailResponse: (
    id: string,
  ) => Record<string, unknown> | null;
}

// ---------------------------------------------------------------------------
// Request/response shapes
// ---------------------------------------------------------------------------

/**
 * Discriminated union of analyze triggers. `manual` is user-initiated from
 * the HTTP route; `auto` is fired by the auto-analyze job worker.
 */
export type AnalyzeOptions =
  | { trigger: "manual" }
  | { trigger: "auto" };

export interface AnalyzeResult {
  analysisConversationId: string;
  /**
   * Set when the auto branch found the rolling analysis conversation already
   * processing and skipped this run to avoid stomping its in-flight agent
   * loop. Callers that care can distinguish "started a new run" from "no-op
   * skip"; everyone else can ignore it.
   */
  skipped?: true;
}

export interface AnalyzeError {
  error: {
    kind: string;
    status: number;
    message: string;
  };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export async function analyzeConversation(
  sourceConversationId: string,
  deps: ConversationAnalysisDeps,
  opts: AnalyzeOptions,
): Promise<AnalyzeResult | AnalyzeError> {
  // a. Resolve conversation ID
  const resolvedId = resolveConversationId(sourceConversationId);
  if (!resolvedId) {
    return {
      error: {
        kind: "NOT_FOUND",
        status: 404,
        message: `Conversation ${sourceConversationId} not found`,
      },
    };
  }

  // b. Load the conversation
  const conversation = getConversation(resolvedId);
  if (!conversation) {
    return {
      error: {
        kind: "NOT_FOUND",
        status: 404,
        message: `Conversation ${resolvedId} not found`,
      },
    };
  }

  // c. Reject private conversations
  if (conversation.conversationType === "private") {
    return {
      error: {
        kind: "FORBIDDEN",
        status: 403,
        message: "Private conversations cannot be analyzed",
      },
    };
  }

  // d. Check for messages
  const existingMessages = getMessages(resolvedId);
  if (existingMessages.length === 0) {
    return {
      error: {
        kind: "BAD_REQUEST",
        status: 400,
        message: "Conversation has no messages to analyze",
      },
    };
  }

  // e. Defense-in-depth recursion guard for auto mode: refuse to
  // auto-analyze a conversation that is itself an auto-analysis
  // conversation. Prevents job-handler bugs from triggering runaway
  // self-analysis loops.
  if (
    opts.trigger === "auto" &&
    getConversationSource(resolvedId) === AUTO_ANALYSIS_SOURCE
  ) {
    return {
      error: {
        kind: "BAD_REQUEST",
        status: 400,
        message: "Cannot auto-analyze an auto-analysis conversation",
      },
    };
  }

  // f. Build the analysis transcript
  const { buildAnalysisTranscript } = await import(
    "../../export/transcript-formatter.js"
  );
  const transcript = buildAnalysisTranscript(resolvedId);

  // g. Resolve the analysis conversation + prompt + trust context based on
  // trigger. Manual trigger always creates a fresh conversation with
  // unknown trust and no tools. Auto trigger reuses a rolling analysis
  // conversation (creating one if missing) and runs as guardian with the
  // default tool surface.
  let analysisConversationId: string;
  let prompt: string;
  let trustClass: "unknown" | "guardian";
  let stripTools: boolean;

  if (opts.trigger === "manual") {
    const newConv = createConversation({
      title: `Analysis: ${conversation.title ?? "Untitled"}`,
    });
    analysisConversationId = newConv.id;
    prompt = buildManualAnalysisPrompt(transcript);
    trustClass = "unknown";
    stripTools = true;
  } else {
    // Auto trigger.
    const existing = findAnalysisConversationFor(resolvedId);
    if (existing) {
      analysisConversationId = existing.id;
    } else {
      // New rolling analysis conversations land in a dedicated group so they
      // do not appear in the default `system:all` list rendered by clients
      // that don't filter on `source` (CLI, gateway, web). Existing rolling
      // conversations stay where they were — no migration needed.
      const newConv = createConversation({
        title: `Analysis: ${conversation.title ?? "Untitled"}`,
        source: AUTO_ANALYSIS_SOURCE,
        groupId: AUTO_ANALYSIS_GROUP_ID,
        forkParentConversationId: resolvedId,
      });
      analysisConversationId = newConv.id;
    }
    prompt = buildAutoAnalysisPrompt(transcript);
    trustClass = "guardian";
    stripTools = false;
  }

  // h. Load the conversation into memory with the appropriate trust
  // context. Manual analysis runs untrusted over attacker-influenced
  // transcript content; auto analysis runs as guardian so it can act on
  // what it learns.
  //
  // Hoisted ahead of message persistence so the auto branch can detect a
  // still-running prior agent loop on the rolling conversation and bail out
  // before mutating any state. See concurrency guard below.
  //
  // Per-call model selection is no longer threaded through `getOrCreateConversation`;
  // the runAgentLoop call below passes `callSite: 'analyzeConversation'` so the
  // unified call-site resolver picks up provider/model from
  // `llm.callSites.analyzeConversation`.
  const analysisConversation =
    await deps.sendMessageDeps.getOrCreateConversation(
      analysisConversationId,
    );

  // h.1. Concurrency guard (auto trigger only). The rolling analysis
  // conversation is reused across runs; if a prior agent loop is still in
  // flight, starting another would overwrite `abortController` /
  // `currentRequestId` and let two loops mutate the same Conversation
  // state. Skip this run instead — the next upstream trigger will
  // re-enqueue once the in-flight loop finishes.
  if (opts.trigger === "auto" && analysisConversation.processing) {
    log.info(
      {
        sourceConversationId: resolvedId,
        analysisConversationId,
      },
      "Skipping auto-analysis run: rolling conversation already processing",
    );
    return { analysisConversationId, skipped: true };
  }

  // i. Persist the user message (with provenance snapshot matching the
  // trust context we will run under).
  const message = await addMessage(
    analysisConversationId,
    "user",
    JSON.stringify([{ type: "text", text: prompt }]),
    { provenanceTrustClass: trustClass },
  );
  const messageId = message.id;

  analysisConversation.setTrustContext({
    trustClass,
    sourceChannel: "vellum",
  });
  // Force a reload so the just-persisted user prompt lands in
  // `ctx.messages`. On a freshly created conversation this is a no-op
  // beyond the reload `ensureActorScopedHistory` would already perform
  // (trustClass transitioned from undefined). On a reused rolling
  // analysis conversation the cached `loadedHistoryTrustClass` already
  // matches `trustClass`, so without this invalidation the ensure call
  // short-circuits and `runAgentLoopImpl` would run on stale in-memory
  // history missing the newly-enqueued prompt.
  analysisConversation.loadedHistoryTrustClass = undefined;
  await analysisConversation.ensureActorScopedHistory();
  if (stripTools) {
    // Manual analysis runs over attacker-influenced transcript content, so
    // do not expose any tools, even when a live client is available.
    analysisConversation.setSubagentAllowedTools(new Set<string>());
  }

  const hasLiveSubscriber =
    deps.sendMessageDeps.assistantEventHub.hasSubscribersForEvent({
      assistantId: DAEMON_INTERNAL_ASSISTANT_ID,
      conversationId: analysisConversationId,
    });

  // j. Build onEvent using inline hub publisher
  const onEvent = (msg: ServerMessage) => {
    deps.sendMessageDeps.assistantEventHub.publish(
      buildAssistantEvent(
        DAEMON_INTERNAL_ASSISTANT_ID,
        msg,
        analysisConversationId,
      ),
    );
  };
  analysisConversation.updateClient(onEvent, !hasLiveSubscriber);

  // k. Set up processing state (required by runAgentLoop guard)
  analysisConversation.processing = true;
  analysisConversation.abortController = new AbortController();
  analysisConversation.currentRequestId = crypto.randomUUID();

  // l. Fire-and-forget the agent loop. `callSite: 'analyzeConversation'`
  // routes the per-call provider config through `resolveCallSiteConfig`
  // against `llm.callSites.analyzeConversation`.
  analysisConversation
    .runAgentLoop(prompt, messageId, onEvent, {
      isInteractive: false,
      isUserMessage: true,
      callSite: "analyzeConversation",
    })
    .catch((err) => {
      log.error(
        { err, conversationId: analysisConversationId },
        "Analysis agent loop failed",
      );
    });

  return { analysisConversationId };
}

// ---------------------------------------------------------------------------
// Prompt builders
// ---------------------------------------------------------------------------

/**
 * Manual-mode prompt: conservative self-assessment with no side effects. The
 * transcript is attacker-controlled so the prompt explicitly disables tool
 * usage and asks for memory candidates rather than in-band writes.
 */
export function buildManualAnalysisPrompt(transcript: string): string {
  const safeTranscript = neutralizeTranscriptSentinel(transcript);
  return `<transcript>
${safeTranscript}
</transcript>

Analyze the conversation above. Provide a structured self-assessment:

1. **Summary**: What was the user trying to accomplish? What was the outcome?
2. **What went well**: Effective tool usage, good reasoning, helpful responses, problem-solving patterns.
3. **What went wrong**: Errors, unnecessary tool calls, incorrect assumptions, wasted turns, misunderstandings.
4. **Root causes**: Why did failures happen? Missing context? Wrong approach? Tool limitations?
5. **Recommendations**: Specific, actionable improvements for similar conversations next time.
6. **Code & tooling changes**: Are there any changes to files you should make based on these learnings? Are there any skills or scripts that are worth creating or modifying? Don't make these changes yet — just provide your analysis.

Be honest and specific. Reference particular moments in the transcript. Focus on patterns that generalize beyond this specific conversation.

Do not use tools during analysis. If you identify insights worth remembering for future conversations, include them in the response as explicit memory candidates instead of saving them directly.`;
}
