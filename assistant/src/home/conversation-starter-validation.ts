import {
  DEFAULT_USER_REFERENCE,
  resolveUserReference,
} from "../prompts/user-reference.js";

export interface ConversationStarterText {
  label: string;
  prompt: string;
}

export interface ConversationStarterValidationContext {
  userReferences: string[];
}

const ASSISTANT_VOICE_PREFIXES = [
  "let me",
  "i['’]?ll",
  "i will",
  "i should",
  "i can help",
  "i can check",
  "i can draft",
  "i can organize",
  "i can plan",
  "i can summarize",
  "you['’]?ve got",
  "you have",
  "your",
].join("|");
const ASSISTANT_VOICE_PATTERN = new RegExp(
  `^(?:${ASSISTANT_VOICE_PREFIXES})\\b`,
  "i",
);

export function buildConversationStarterValidationContext(): ConversationStarterValidationContext {
  const reference = resolveUserReference();
  const references = new Set<string>();

  if (reference !== DEFAULT_USER_REFERENCE) {
    references.add(reference);
    const firstWord = reference.match(/[A-Za-z0-9][A-Za-z0-9'-]*/)?.[0];
    if (firstWord && firstWord.length >= 2) {
      references.add(firstWord);
    }
  }

  return { userReferences: [...references] };
}

export function isValidConversationStarterText(
  starter: ConversationStarterText,
  context = buildConversationStarterValidationContext(),
): boolean {
  const label = starter.label.trim();
  const prompt = starter.prompt.trim();

  if (label.length === 0 || label.length > 40 || prompt.length === 0) {
    return false;
  }
  if (isAssistantVoice(label) || isAssistantVoice(prompt)) {
    return false;
  }
  if (
    mentionsCurrentUser(label, context) ||
    mentionsCurrentUser(prompt, context)
  ) {
    return false;
  }

  return true;
}

function isAssistantVoice(text: string): boolean {
  return ASSISTANT_VOICE_PATTERN.test(text.trim());
}

function mentionsCurrentUser(
  text: string,
  context: ConversationStarterValidationContext,
): boolean {
  return context.userReferences.some((reference) =>
    new RegExp(`\\b${escapeRegExp(reference)}\\b`, "i").test(text),
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
