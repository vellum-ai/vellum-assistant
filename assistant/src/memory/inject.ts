import type { Message } from "../providers/types.js";

/**
 * Inject memory recall as a text content block prepended to the last user
 * message. This follows the same pattern as workspace, temporal, and other
 * runtime injections — the memory context is a text block in the user
 * message rather than a separate synthetic message pair.
 *
 * Stripping is handled by `stripUserTextBlocksByPrefix` matching the
 * `<memory_brief>` prefix in `RUNTIME_INJECTION_PREFIXES`, so no
 * dedicated strip function is needed.
 */
export function injectMemoryRecallAsUserBlock(
  messages: Message[],
  memoryRecallText: string,
): Message[] {
  if (memoryRecallText.trim().length === 0) return messages;
  if (messages.length === 0) return messages;
  const userTail = messages[messages.length - 1];
  if (!userTail || userTail.role !== "user") return messages;
  return [
    ...messages.slice(0, -1),
    {
      ...userTail,
      content: [
        { type: "text" as const, text: memoryRecallText },
        ...userTail.content,
      ],
    },
  ];
}
