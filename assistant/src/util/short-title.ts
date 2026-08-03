/**
 * Title hygiene helpers shared by every surface that renders a short,
 * scannable conversation title: markdown/thinking-tag stripping, prose and
 * meta-failure rejection, and length truncation.
 */

const MAX_TITLE_LENGTH = 40;
const MAX_TITLE_WORDS = 7;

/** Word count a title exceeding `MAX_TITLE_WORDS` is cut back to. */
const TRIMMED_TITLE_WORDS = 5;

const META_FAILURE_TITLES = new Set([
  "missing context",
  "no context",
  "insufficient context",
  "unclear context",
  "empty context",
  "no topic",
  "unclear topic",
  "unclear request",
  "unclear message",
  "empty conversation",
  "empty message",
  "no content",
]);

/** Reasoning/sentence openers that never start a legitimate topic title. */
const LEAKED_PROSE_PREFIXES = [
  "i need to",
  "i needed to",
  "i should",
  "i will",
  "i'll",
  "i can ",
  "i can't",
  "i cannot",
  "i'm ",
  "i am ",
  "i've ",
  "i have ",
  "i'd ",
  "i would",
  "let me",
  "looking at",
  "based on",
  "given the",
  "to generate",
  "to summarize",
  "to title",
  // Subject-led reasoning openers. A bare noun phrase ("The User Interface
  // Redesign", "The Conversation API") is a valid title, so each subject only
  // counts as leaked prose when a verb or possessive follows it, marking the
  // output as a sentence rather than a topic.
  "the user wants",
  "the user asked",
  "the user is",
  "the user wanted",
  "the user needs",
  "the user said",
  "the user has",
  "the user would",
  "the user's request",
  "the conversation is",
  "this conversation is",
  "the conversation appears",
  "the conversation seems",
  "the conversation covers",
  "the conversation discusses",
  "the assistant should",
  "the assistant is",
  "the assistant wants",
  "the assistant needs",
  "the title should",
  "the title is",
  "the title would",
  "the title for",
  "here's ",
  "here is ",
  "here are ",
  "sure,",
  "okay,",
  "ok,",
];

/** Strip common markdown formatting so titles render as plain text. */
export function stripMarkdown(text: string): string {
  return text
    .replace(/\*\*(.+?)\*\*/g, "$1") // **bold**
    .replace(/__(.+?)__/g, "$1") // __bold__
    .replace(/\*(.+?)\*/g, "$1") // *italic*
    .replace(/(?<!\w)_(.+?)_(?!\w)/g, "$1") // _italic_ (word-boundary-aware to preserve snake_case)
    .replace(/~~(.+?)~~/g, "$1") // ~~strikethrough~~
    .replace(/`(.+?)`/g, "$1") // `code`
    .replace(/\[(.+?)\]\(.+?\)/g, "$1") // [link](url)
    .replace(/^#{1,6}\s+/gm, ""); // # headings
}

/** Strip thinking tags so they don't bleed into generated titles. */
export function stripThinkingTags(text: string): string {
  return text
    .replace(/<thinking>[\s\S]*?<\/thinking>/gi, "")
    .replace(/<thought>[\s\S]*?<\/thought>/gi, "")
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<thought>/gi, "")
    .replace(/<\/thought>/gi, "")
    .replace(/<thinking>/gi, "")
    .replace(/<\/thinking>/gi, "")
    .replace(/<think>/gi, "")
    .replace(/<\/think>/gi, "")
    .replace(/<:[^>]*>/gi, "");
}

/**
 * Clamp a title to `MAX_TITLE_LENGTH` characters and `MAX_TITLE_WORDS` words.
 * Both budgets apply: a wordy title is cut back to `TRIMMED_TITLE_WORDS` words
 * and the survivors are still trimmed at a word boundary to fit the character
 * budget, so the returned string is never longer than `MAX_TITLE_LENGTH`.
 */
export function truncateTitle(title: string): string {
  if (title.length <= MAX_TITLE_LENGTH) {
    return title;
  }
  const words = title.split(/\s+/);
  const kept =
    words.length > MAX_TITLE_WORDS
      ? words.slice(0, TRIMMED_TITLE_WORDS)
      : words;
  let result = "";
  for (const word of kept) {
    const candidate = result ? result + " " + word : word;
    if (candidate.length > MAX_TITLE_LENGTH) {
      break;
    }
    result = candidate;
  }
  // Empty when even the first word overflows: hard-slice rather than return "".
  return result || title.slice(0, MAX_TITLE_LENGTH);
}

/**
 * Heuristic guard for title outputs that are clearly prose: the model
 * reasoning aloud or replying to the conversation rather than naming it. A real
 * title is a single-line short noun phrase, so we reject multi-line output,
 * embedded transcript markers, leading reasoning openers, and sentence-shaped
 * clauses. Deliberately tight: a false reject only costs a deterministic
 * fallback title, while a false accept persists a broken one.
 */
function looksLikeLeakedProse(title: string): boolean {
  if (/\n/.test(title)) {
    return true;
  }
  if (/\b(?:user|assistant)\s*:/i.test(title)) {
    return true;
  }
  const lower = title.toLowerCase();
  if (LEAKED_PROSE_PREFIXES.some((prefix) => lower.startsWith(prefix))) {
    return true;
  }
  // Sentence-shaped: terminal punctuation on a multi-word clause.
  if (/[.?!]$/.test(title) && title.split(/\s+/).length > 5) {
    return true;
  }
  return false;
}

/**
 * Clean a raw title into a short, scannable label. Returns "" when the input is
 * empty, reads as leaked prose, or is a meta-failure title, signalling that
 * callers should fall back to a deterministic title.
 */
export function normalizeTitle(raw: string): string {
  let title = raw.trim().replace(/^["']|["']$/g, "");
  title = stripMarkdown(title);
  title = stripThinkingTags(title).trim();
  if (!title) {
    return "";
  }
  // Reject outputs that are the model reasoning aloud or continuing the
  // conversation instead of naming it (e.g. "I need to generate a…", "I'll
  // work through these files…"). Callers fall back to a deterministic title.
  if (looksLikeLeakedProse(title)) {
    return "";
  }
  if (META_FAILURE_TITLES.has(title.toLowerCase())) {
    return "";
  }
  return truncateTitle(title);
}
