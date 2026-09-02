/**
 * Closed list of reserved runtime-injection wrappers and a leading-tag
 * classifier for assistant completions.
 *
 * Runtime assembly splices these envelopes onto the tail user message. A
 * completer that continues that template can open a reply with the same
 * wrapper. The classifier is start-of-text only: mid-message XML, quoted tag
 * names, and user-authored markup are left alone.
 */

export const RESERVED_INJECTION_TAG_NAMES = [
  "memory",
  "memory_context",
  "memory_image",
  "memory_spotlight",
  "turn_context",
  "workspace",
  "workspace_top_level",
  "knowledge_base",
  "pkb",
  "system_reminder",
  "now_scratchpad",
  "NOW.md",
  "active_thread",
  "active_subagents",
  "active_workspace",
  "active_dynamic_page",
  "channel_capabilities",
  "transport_hints",
  "system_notice",
  "non_interactive_context",
  "temporal_context",
  "guardian_context",
  "inbound_actor_context",
  "channel_turn_context",
  "interface_turn_context",
  "channel_command_context",
  "voice_call_control",
] as const;

export type ReservedInjectionTagName =
  (typeof RESERVED_INJECTION_TAG_NAMES)[number];

const RESERVED_TAG_SET = new Set<string>(
  RESERVED_INJECTION_TAG_NAMES.map((name) => name.toLowerCase()),
);

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Matches a reserved opener anywhere in text. Compaction quality signals use
 * this to flag a summary that echoed an injection tag.
 */
export const RESERVED_INJECTION_OPENER_PATTERN = new RegExp(
  `<(?:${RESERVED_INJECTION_TAG_NAMES.map(escapeRegExp).join("|")})\\b`,
  "i",
);

export type LeadingReservedInjectionClassification =
  | { status: "pending" }
  | { status: "clean" }
  | { status: "reserved"; tag: ReservedInjectionTagName };

const TAG_NAME_CHAR = /[A-Za-z0-9_.]/;

function canonicalReservedTag(name: string): ReservedInjectionTagName | null {
  const lower = name.toLowerCase();
  for (const tag of RESERVED_INJECTION_TAG_NAMES) {
    if (tag.toLowerCase() === lower) {
      return tag;
    }
  }
  return null;
}

function prefixCouldBecomeReserved(name: string): boolean {
  const lower = name.toLowerCase();
  for (const reserved of RESERVED_TAG_SET) {
    if (reserved.startsWith(lower)) {
      return true;
    }
  }
  return false;
}

/**
 * Classify whether `text` opens with a reserved runtime-injection envelope.
 *
 * Leading whitespace is ignored. Only the start of the string is considered.
 * While `complete` is false, an unfinished `<` or a reserved-name prefix is
 * `pending` so a streaming caller can buffer. A finished string that does not
 * match a reserved opener is `clean`.
 */
export function classifyLeadingReservedInjection(
  text: string,
  options?: { complete?: boolean },
): LeadingReservedInjectionClassification {
  const complete = options?.complete === true;
  const trimmed = text.replace(/^\s+/, "");

  if (trimmed.length === 0) {
    return complete ? { status: "clean" } : { status: "pending" };
  }

  if (trimmed.charAt(0) !== "<") {
    return { status: "clean" };
  }

  const second = trimmed.charAt(1);
  if (second === "/" || second === "!" || second === "?") {
    return { status: "clean" };
  }

  if (second === "") {
    return complete ? { status: "clean" } : { status: "pending" };
  }

  if (!/[A-Za-z]/.test(second)) {
    return { status: "clean" };
  }

  let end = 1;
  while (end < trimmed.length && TAG_NAME_CHAR.test(trimmed.charAt(end))) {
    end += 1;
  }
  const name = trimmed.slice(1, end);
  const hasDelimiter = end < trimmed.length;
  const delimiter = hasDelimiter ? trimmed.charAt(end) : "";
  const delimited =
    hasDelimiter &&
    (delimiter === ">" || delimiter === "/" || /\s/.test(delimiter));

  if (delimited || complete) {
    const tag = canonicalReservedTag(name);
    if (tag) {
      return { status: "reserved", tag };
    }
    return { status: "clean" };
  }

  if (prefixCouldBecomeReserved(name)) {
    return { status: "pending" };
  }
  return { status: "clean" };
}

/** Concatenate an assistant message's `text` blocks in order. */
export function concatenateAssistantText(
  content: ReadonlyArray<{ type: string; text?: string }>,
): string {
  let text = "";
  for (const block of content) {
    if (block.type === "text" && typeof block.text === "string") {
      text += block.text;
    }
  }
  return text;
}
