/**
 * Names for the tool-gated reply surface, with no imports of their own.
 *
 * Deliberately separate from `send-user-message-gate.ts`: the gate reaches the
 * feature-flag resolver, which reaches the gateway IPC client, so a module
 * that only needs to recognize the tool by name (the tool definition, the
 * agent loop, the read-side projection) must not pull that graph in behind it.
 * The gate re-exports both names, so a runtime evaluator can keep importing
 * one module.
 */

/** Registry flag id (and key) for the tool-gated reply surface. */
export const SEND_USER_MESSAGE_FLAG = "send-user-message" as const;

/** LLM-facing name of the tool that delivers user-facing text. */
export const SEND_USER_MESSAGE_TOOL_NAME = "send_user_message";
