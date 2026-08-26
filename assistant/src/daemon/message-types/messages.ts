// User/assistant messages, tool results, confirmations, secrets, errors, and generation lifecycle.

import type { ChannelId, InterfaceId } from "../../channels/types.js";
import type { CommandIntent, UserMessageAttachment } from "./shared.js";

// === Client → Server ===

export interface UserMessage {
  type: "user_message";
  conversationId: string;
  content?: string;
  attachments?: UserMessageAttachment[];
  activeSurfaceId?: string;
  /** The page currently displayed in the WebView (e.g. "settings.html"). */
  currentPage?: string;
  /** Originating channel identifier (e.g. 'vellum'). Defaults to 'vellum' when absent. */
  channel?: ChannelId;
  /** Originating interface identifier (e.g. 'macos'). */
  interface: InterfaceId;
  /** Push-to-talk activation key configured on the client (e.g. 'fn', 'ctrl', 'fn_shift', 'none'). */
  pttActivationKey?: string;
  /** Whether the client has been granted microphone permission by the OS. */
  microphonePermissionGranted?: boolean;
  /** Structured command intent — bypasses text parsing when present. */
  commandIntent?: CommandIntent;
  /** Client-generated correlation nonce for echo dedup. See
   *  `UserMessageEchoEvent.clientMessageId` — the server echoes this value
   *  back on the matching `user_message_echo` event. */
  clientMessageId?: string;
}

export interface ConfirmationResponse {
  type: "confirmation_response";
  requestId: string;
  decision: "allow" | "deny";
}

export interface SecretResponse {
  type: "secret_response";
  requestId: string;
  value?: string; // undefined = user cancelled
  /** How the secret should be delivered: 'store' persists to credential store (default), 'transient_send' for one-time use without persisting. */
  delivery?: "store" | "transient_send";
}

// --- Domain-level union aliases (consumed by the barrel file) ---

export type _MessagesClientMessages =
  | UserMessage
  | ConfirmationResponse
  | SecretResponse;
