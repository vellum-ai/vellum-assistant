/**
 * Shared types for the runtime HTTP server and its route handlers.
 */
import type { ChannelId, InterfaceId } from "../channels/types.js";
import type { SkillOperationContext } from "../daemon/handlers/skills.js";
import type {
  SurfaceData,
  SurfaceType,
} from "../daemon/ipc-contract/surfaces.js";
import type { ServerMessage } from "../daemon/ipc-protocol.js";
import type { Session } from "../daemon/session.js";
import type { TrustContext } from "../daemon/session-runtime-assembly.js";
import type {
  ApprovalMessageContext,
  ComposeApprovalMessageGenerativeOptions,
} from "./approval-message-composer.js";
import type { AssistantEventHub } from "./assistant-event-hub.js";
import type {
  ComposeGuardianActionMessageOptions,
  GuardianActionMessageContext,
} from "./guardian-action-message-composer.js";
import type { SessionManagementDeps } from "./routes/session-management-routes.js";
/**
 * Daemon-injected function that generates approval copy using a provider.
 * Returns generated text or `null` on failure (caller falls back to deterministic text).
 */
export type ApprovalCopyGenerator = (
  context: ApprovalMessageContext,
  options?: ComposeApprovalMessageGenerativeOptions,
) => Promise<string | null>;

// ---------------------------------------------------------------------------
// Approval conversation flow types
// ---------------------------------------------------------------------------

/** The disposition returned by the approval conversation engine. */
export type ApprovalConversationDisposition =
  | "keep_pending"
  | "approve_once"
  | "approve_10m"
  | "approve_thread"
  | "approve_always"
  | "reject";

/** Structured result from a single turn of the approval conversation. */
export interface ApprovalConversationResult {
  disposition: ApprovalConversationDisposition;
  replyText: string;
  /** Required when there are multiple pending approvals and the disposition is decision-bearing. */
  targetRequestId?: string;
}

/** Input context for the approval conversation engine. */
export interface ApprovalConversationContext {
  toolName: string;
  allowedActions: string[];
  role: "requester" | "guardian";
  pendingApprovals: Array<{ requestId: string; toolName: string }>;
  userMessage: string;
}

/**
 * Daemon-injected function that processes one turn of an approval conversation.
 * Takes conversation context and returns a structured approval decision + reply.
 */
export type ApprovalConversationGenerator = (
  context: ApprovalConversationContext,
) => Promise<ApprovalConversationResult>;

/**
 * Daemon-injected function that generates guardian action copy using a provider.
 * Returns generated text or `null` on failure (caller falls back to deterministic text).
 */
export type GuardianActionCopyGenerator = (
  context: GuardianActionMessageContext,
  options?: ComposeGuardianActionMessageOptions,
) => Promise<string | null>;

// ---------------------------------------------------------------------------
// Guardian follow-up conversation flow types
// ---------------------------------------------------------------------------

/** The disposition returned by the guardian follow-up conversation engine. */
export type GuardianFollowUpDisposition =
  | "call_back"
  | "message_back"
  | "decline"
  | "keep_pending";

/** Structured result from a single turn of the guardian follow-up conversation. */
export interface GuardianFollowUpTurnResult {
  disposition: GuardianFollowUpDisposition;
  replyText: string;
}

/** Input context for the guardian follow-up conversation engine. */
export interface GuardianFollowUpConversationContext {
  /** The original question that was asked during the voice call. */
  questionText: string;
  /** The guardian's late answer text that initiated the follow-up. */
  lateAnswerText: string;
  /** The guardian's latest reply in the follow-up conversation. */
  guardianReply: string;
}

/**
 * Daemon-injected function that processes one turn of a guardian follow-up
 * conversation. Classifies the guardian's intent into a structured disposition
 * and produces a natural reply.
 */
export type GuardianFollowUpConversationGenerator = (
  context: GuardianFollowUpConversationContext,
) => Promise<GuardianFollowUpTurnResult>;

export interface RuntimeMessageSessionOptions {
  transport?: {
    channelId: ChannelId;
    hints?: string[];
    uxBrief?: string;
  };
  assistantId?: string;
  trustContext?: TrustContext;
  /**
   * Whether this turn should permit interactive approval prompts.
   * Channel ingress sets this true so confirmations can be resolved
   * through channel approval flows.
   */
  isInteractive?: boolean;
  /** Channel command intent metadata (e.g. Telegram /start). */
  commandIntent?: { type: string; payload?: string; languageCode?: string };
  /** Optional callback to receive real-time agent loop events (text deltas, tool starts, etc.). */
  onEvent?: (msg: ServerMessage) => void;
}

export type MessageProcessor = (
  conversationId: string,
  content: string,
  attachmentIds?: string[],
  options?: RuntimeMessageSessionOptions,
  sourceChannel?: ChannelId,
  sourceInterface?: InterfaceId,
) => Promise<{ messageId: string }>;

/**
 * Dependencies for the POST /v1/messages handler.
 *
 * The handler needs direct access to the session so it can check busy state,
 * persist user messages, fire the agent loop, or queue messages when busy.
 * Hub publishing wires outbound events to the SSE stream.
 */
export interface SendMessageDeps {
  getOrCreateSession: (conversationId: string) => Promise<Session>;
  assistantEventHub: AssistantEventHub;
  resolveAttachments: (attachmentIds: string[]) => Array<{
    id: string;
    filename: string;
    mimeType: string;
    data: string;
  }>;
}

export interface RuntimeHttpServerOptions {
  port?: number;
  /** Hostname / IP to bind to. Defaults to '127.0.0.1' (loopback-only). */
  hostname?: string;
  /** Legacy shared secret for pairing routes (not used for delivery or auth). */
  bearerToken?: string;
  processMessage?: MessageProcessor;
  /** Root directory for interface files on disk. */
  interfacesDir?: string;
  /** Daemon-injected generator for approval copy (provider-backed). */
  approvalCopyGenerator?: ApprovalCopyGenerator;
  /** Daemon-injected generator for conversational approval flow (provider-backed). */
  approvalConversationGenerator?: ApprovalConversationGenerator;
  /** Daemon-injected generator for guardian action copy (provider-backed). */
  guardianActionCopyGenerator?: GuardianActionCopyGenerator;
  /** Daemon-injected generator for guardian follow-up conversation (provider-backed). */
  guardianFollowUpConversationGenerator?: GuardianFollowUpConversationGenerator;
  /** Dependencies for the POST /v1/messages queue-if-busy handler. */
  sendMessageDeps?: SendMessageDeps;
  /** Context provider for skill management HTTP routes. */
  getSkillContext?: () => SkillOperationContext;
  /** Lookup an active session by ID (for surface actions and content fetches). */
  findSession?: (sessionId: string) =>
    | {
        handleSurfaceAction(
          surfaceId: string,
          actionId: string,
          data?: Record<string, unknown>,
        ): void;
        surfaceState: Map<
          string,
          { surfaceType: SurfaceType; data: SurfaceData; title?: string }
        >;
        currentTurnSurfaces?: Array<{
          surfaceId: string;
          surfaceType: SurfaceType;
          title?: string;
          data: SurfaceData;
          actions?: Array<{ id: string; label: string; style?: string }>;
        }>;
        removeQueuedMessage?: (requestId: string) => boolean;
      }
    | undefined;
  /** Dependencies for session management HTTP routes (switch, rename, clear, cancel, undo, regenerate). */
  sessionManagementDeps?: SessionManagementDeps;
  /** Context for model config set operations (session eviction, config reload suppression). */
  modelSetContext?: import("../daemon/handlers/config-model.js").ModelSetContext;
  /** Provider for computer-use session dependencies (CU routes). */
  getComputerUseDeps?: () => import("./routes/computer-use-routes.js").ComputerUseDeps;
  /** Provider for recording dependencies (recording routes). */
  getRecordingDeps?: () => import("./routes/recording-routes.js").RecordingDeps;
}

export interface RuntimeAttachmentMetadata {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  kind: string;
}

export interface RuntimeMessagePayload {
  id: string;
  role: string;
  content: string;
  timestamp: string;
  attachments: RuntimeAttachmentMetadata[];
  toolCalls?: Array<{
    name: string;
    input: Record<string, unknown>;
    result?: string;
    isError?: boolean;
  }>;
  interfaces?: string[];
}
