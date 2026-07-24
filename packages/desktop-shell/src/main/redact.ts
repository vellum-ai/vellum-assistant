export const REDACTION_VERSION = 1;

const PATTERNS: [RegExp, string][] = [
  [/Bearer\s+[A-Za-z0-9\-._~+/]+=*/g, "Bearer [REDACTED]"],
  [/sk-[A-Za-z0-9\-]{20,}/g, "[REDACTED_API_KEY]"],
  [/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, "[REDACTED_EMAIL]"],
  [/\/Users\/[^/\s]+/g, "~"],
];

export function redactText(input: string): string {
  let result = input;
  for (const [pattern, replacement] of PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}
