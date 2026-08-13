export const REDACTION_VERSION = 1;

const PATTERNS: [RegExp, string][] = [
  [/Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi, "Bearer [REDACTED]"],
  [/sk-[A-Za-z0-9\-]{20,}/g, "[REDACTED_API_KEY]"],
  [
    /\b((?:api[_-]?key|access[_-]?token|refresh[_-]?token|session[_-]?token)\s*[:=]\s*)[^\s,;]+/gi,
    "$1[REDACTED]",
  ],
  [/(?:ghp|github_pat)_[A-Za-z0-9_]{20,}/g, "[REDACTED_TOKEN]"],
  [/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, "[REDACTED_EMAIL]"],
  [/\/Users\/[^/\s]+/g, "~"],
  [/[A-Za-z]:\\Users\\[^\\\r\n]+/gi, "~"],
];

export function redactText(input: string): string {
  let result = input;
  for (const [pattern, replacement] of PATTERNS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}
