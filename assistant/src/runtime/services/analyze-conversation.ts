/**
 * Service: analyzeConversation
 *
 * Factored out of the manual analyze route handler so the same core logic can
 * be invoked from multiple call sites (manual HTTP trigger today; additional
 * triggers planned). Behavior for the manual path is preserved exactly —
 * this is a pure refactor.
 *
 * The service:
 *   1. Resolves the source conversation and validates it can be analyzed.
 *   2. Builds the analysis transcript + prompt.
 *   3. Creates a new analysis conversation with unknown trust and no tools.
 *   4. Fires the agent loop in the background.
 *   5. Returns the new conversation ID on success, or a structured error.
 */
import type { ServerMessage } from "../../daemon/message-protocol.js";
import {
  addMessage,
  createConversation,
  getConversation,
  getMessages,
} from "../../memory/conversation-crud.js";
import { resolveConversationId } from "../../memory/conversation-key-store.js";
import { getLogger } from "../../util/logger.js";
import { buildAssistantEvent } from "../assistant-event.js";
import { DAEMON_INTERNAL_ASSISTANT_ID } from "../assistant-scope.js";
import type { SendMessageDeps } from "../http-types.js";

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
 * Discriminated union of analyze triggers. Today only `manual` is supported;
 * additional triggers (e.g. `auto`) will be added in follow-up PRs without
 * changing the manual path.
 */
export interface AnalyzeOptions {
  trigger: "manual";
}

export interface AnalyzeResult {
  analysisConversationId: string;
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
  _opts: AnalyzeOptions,
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

  // e. Build the analysis transcript
  const { buildAnalysisTranscript } = await import(
    "../../export/transcript-formatter.js"
  );
  const transcript = buildAnalysisTranscript(resolvedId);

  // f. Create a new conversation for the analysis
  const newConv = createConversation({
    title: `Analysis: ${conversation.title ?? "Untitled"}`,
  });

  // g. Build the analysis prompt
  const prompt = `<transcript>
${transcript}
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

  // h. Persist the user message
  const message = await addMessage(
    newConv.id,
    "user",
    JSON.stringify([{ type: "text", text: prompt }]),
    { provenanceTrustClass: "unknown" as const },
  );
  const messageId = message.id;

  // i. Load the conversation into memory with untrusted analysis context
  const analysisConversation =
    await deps.sendMessageDeps.getOrCreateConversation(newConv.id);
  analysisConversation.setTrustContext({
    trustClass: "unknown",
    sourceChannel: "vellum",
  });
  await analysisConversation.ensureActorScopedHistory();
  // Analysis runs over attacker-influenced transcript content, so do not
  // expose any tools, even when a live client is available.
  analysisConversation.setSubagentAllowedTools(new Set<string>());

  const hasLiveSubscriber =
    deps.sendMessageDeps.assistantEventHub.hasSubscribersForEvent({
      assistantId: DAEMON_INTERNAL_ASSISTANT_ID,
      conversationId: newConv.id,
    });

  // j. Build onEvent using inline hub publisher
  const onEvent = (msg: ServerMessage) => {
    deps.sendMessageDeps.assistantEventHub.publish(
      buildAssistantEvent(DAEMON_INTERNAL_ASSISTANT_ID, msg, newConv.id),
    );
  };
  analysisConversation.updateClient(onEvent, !hasLiveSubscriber);

  // k. Set up processing state (required by runAgentLoop guard)
  analysisConversation.processing = true;
  analysisConversation.abortController = new AbortController();
  analysisConversation.currentRequestId = crypto.randomUUID();

  // l. Fire-and-forget the agent loop
  analysisConversation
    .runAgentLoop(prompt, messageId, onEvent, {
      isInteractive: false,
      isUserMessage: true,
    })
    .catch((err) => {
      log.error(
        { err, conversationId: newConv.id },
        "Analysis agent loop failed",
      );
    });

  return { analysisConversationId: newConv.id };
}
