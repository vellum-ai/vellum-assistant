/**
 * Dynamic-profile injection and stripping helpers.
 *
 * The injection function is no longer used in the main code path — the V2
 * memory pipeline includes preferences directly in the tiered
 * `<memory_context>` injection. It is retained here for backwards
 * compatibility with in-flight messages that may still contain
 * `<dynamic-profile-context>` tags, and for test helpers.
 */

import type { Message } from "../providers/types.js";

/**
 * @deprecated No longer injected in the V2 pipeline. Retained for test
 * helpers and backwards-compat stripping only.
 */
export function injectDynamicProfileIntoUserMessage(
  message: Message,
  profileText: string,
): Message {
  const trimmedProfile = profileText.trim();
  if (trimmedProfile.length === 0) return message;
  const block = [
    "<dynamic-profile-context>",
    trimmedProfile,
    "</dynamic-profile-context>",
  ].join("\n");
  return {
    ...message,
    content: [...message.content, { type: "text", text: `\n\n${block}` }],
  };
}

export function stripDynamicProfileMessages(
  messages: Message[],
  profileText: string,
): Message[] {
  const trimmedProfile = profileText.trim();
  if (trimmedProfile.length === 0) return messages;
  const injectedBlock = `\n\n<dynamic-profile-context>\n${trimmedProfile}\n</dynamic-profile-context>`;
  // Find the last user message that actually contains the injected profile block.
  // We can't just target the last user message by role — tool_result messages also
  // have role 'user', so after tool use the last user message won't be the one
  // we injected the profile into.
  let lastUserIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (
      messages[i].role === "user" &&
      messages[i].content.some(
        (b) => b.type === "text" && b.text.includes(injectedBlock),
      )
    ) {
      lastUserIdx = i;
      break;
    }
  }
  if (lastUserIdx === -1) return messages;
  const message = messages[lastUserIdx];
  let changed = false;
  const nextContent = message.content
    .map((block) => {
      if (block.type !== "text") return block;
      const nextText = block.text.split(injectedBlock).join("");
      if (nextText === block.text) return block;
      changed = true;
      const stripped = nextText.replace(/\n{3,}/g, "\n\n").trimEnd();
      return stripped.length > 0 ? { ...block, text: stripped } : null;
    })
    .filter((block): block is NonNullable<typeof block> => block != null);
  if (!changed) return messages;
  // If stripping removed all content blocks, drop the message entirely
  // to avoid sending an empty content array to the provider.
  if (nextContent.length === 0) {
    return [
      ...messages.slice(0, lastUserIdx),
      ...messages.slice(lastUserIdx + 1),
    ];
  }
  return [
    ...messages.slice(0, lastUserIdx),
    { ...message, content: nextContent },
    ...messages.slice(lastUserIdx + 1),
  ];
}
