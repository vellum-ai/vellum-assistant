/**
 * Route handler for conversation analysis.
 *
 * POST /v1/conversations/:id/analyze — analyze a conversation via a new
 * agent loop that produces a structured self-assessment.
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
import { httpError } from "../http-errors.js";
import type { RouteDefinition } from "../http-router.js";
import type { SendMessageDeps } from "../http-types.js";

const log = getLogger("conversation-analysis-routes");

// ---------------------------------------------------------------------------
// Dependency types — injected by the daemon at wiring time
// ---------------------------------------------------------------------------

export interface ConversationAnalysisDeps {
  sendMessageDeps: SendMessageDeps;
  buildConversationDetailResponse: (
    id: string,
  ) => Record<string, unknown> | null;
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

export function conversationAnalysisRouteDefinitions(
  deps: ConversationAnalysisDeps,
): RouteDefinition[] {
  return [
    {
      endpoint: "conversations/:id/analyze",
      method: "POST",
      policyKey: "conversations/analyze",
      summary: "Analyze a conversation",
      description:
        "Create a new conversation with a structured self-assessment of an existing conversation.",
      tags: ["conversations"],
      handler: async ({ params }) => {
        // a. Resolve conversation ID
        const resolvedId = resolveConversationId(params.id);
        if (!resolvedId) {
          return httpError(
            "NOT_FOUND",
            `Conversation ${params.id} not found`,
            404,
          );
        }

        // b. Load the conversation
        const conversation = getConversation(resolvedId);
        if (!conversation) {
          return httpError(
            "NOT_FOUND",
            `Conversation ${resolvedId} not found`,
            404,
          );
        }

        // c. Reject private conversations
        if (conversation.conversationType === "private") {
          return httpError(
            "FORBIDDEN",
            "Private conversations cannot be analyzed",
            403,
          );
        }

        // d. Check for messages
        const existingMessages = getMessages(resolvedId);
        if (existingMessages.length === 0) {
          return httpError(
            "BAD_REQUEST",
            "Conversation has no messages to analyze",
            400,
          );
        }

        // e. Build the analysis transcript
        const { buildAnalysisTranscript } =
          await import("../../export/transcript-formatter.js");
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

        // m. Return the new conversation detail
        const detail = deps.buildConversationDetailResponse(newConv.id);
        if (!detail) {
          return httpError(
            "INTERNAL_ERROR",
            `Analysis conversation ${newConv.id} could not be loaded`,
            500,
          );
        }
        return Response.json(detail);
      },
    },
  ];
}
