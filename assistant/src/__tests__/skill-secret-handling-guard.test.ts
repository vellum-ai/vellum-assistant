import { execSync } from "node:child_process";
import { describe, expect, test } from "bun:test";

/**
 * Guard test: SKILL.md files must never instruct the assistant to accept
 * secrets (passwords, API keys, tokens, etc.) pasted directly in chat.
 *
 * Secrets must always be collected via `assistant credentials prompt`, which
 * presents a secure native UI that keeps the value out of conversation
 * history and LLM context.
 *
 * This guard prevents regressions like the gmail/messaging bundled skill
 * violation where SKILL.md contained "Include client_secret too if they
 * provide one" — directing the assistant to accept a secret value from
 * the chat stream.
 */

/** SKILL.md files permitted to contain otherwise-violating patterns. */
const ALLOWLIST = new Set<string>([
  // Add paths here only if there is a genuine, documented exception.
]);

/**
 * Words that indicate the line is about a secret/credential value.
 */
const SECRET_WORDS =
  "secret|password|api[_\\s-]?key|auth[_\\s-]?token|private[_\\s-]?key|access[_\\s-]?token|client[_\\s-]?secret|signing[_\\s-]?key|bearer[_\\s-]?token";

/**
 * Patterns that indicate the assistant is being told to accept a secret
 * value directly in chat, rather than via `assistant credentials prompt`.
 */
const VIOLATION_PATTERNS: RegExp[] = [
  // "accept <secret> in/via/from chat/plaintext/the conversation"
  new RegExp(
    `accept\\s+.*(?:${SECRET_WORDS}).*\\b(?:in|via|from)\\s+(?:chat|plaintext|the\\s+conversation)`,
    "i",
  ),
  new RegExp(
    `accept\\s+.*\\b(?:in|via|from)\\s+(?:chat|plaintext|the\\s+conversation).*(?:${SECRET_WORDS})`,
    "i",
  ),
  // "ask (the user|them) (for|to share/send/paste/type/provide) <secret>" where destination is chat
  // Must have "the user" or "them" as the object to avoid matching third-party descriptions
  // like "Discord will ask for a 2FA code before revealing the secret"
  new RegExp(
    `ask\\s+(?:the\\s+user|them)\\s+(?:for|to\\s+(?:share|send|paste|type|provide))\\s+(?:the\\s+|their\\s+|a\\s+)?(?:${SECRET_WORDS})`,
    "i",
  ),
  // "Include <secret> too if they provide one" — the original gmail violation pattern
  new RegExp(
    `include\\s+(?:the\\s+)?(?:${SECRET_WORDS})\\s+(?:too|as\\s+well|also)\\s+if\\s+they\\s+provide`,
    "i",
  ),
  // "<secret> pasted/typed/sent in chat/conversation/plaintext"
  new RegExp(
    `(?:${SECRET_WORDS})\\s+(?:pasted|typed|sent|provided|shared)\\s+(?:in|via|through)\\s+(?:chat|conversation|plaintext)`,
    "i",
  ),
  // "paste/type/send <secret> in chat/here/the conversation"
  new RegExp(
    `(?:paste|type|send|share|provide)\\s+(?:the\\s+|your\\s+|their\\s+)?(?:${SECRET_WORDS})\\s+(?:in\\s+(?:chat|the\\s+conversation)|here)`,
    "i",
  ),
];

/**
 * Lines containing these negation words are typically instructing the
 * assistant NOT to do something — these are not violations.
 */
const NEGATION_PATTERNS =
  /\b(?:never|do\s+not|don['']t|must\s+not|should\s+not|shouldn['']t)\b|\bNOT\b/;

/**
 * Lines that carry the secure prompt's field text within an `assistant
 * credentials prompt` block — either CLI flags (`--label`, `--description`,
 * `--placeholder`, ...) or legacy YAML-style fields. These contain
 * secret-related words but are secure UI text, not chat instructions.
 */
const CREDENTIAL_PROMPT_UI_FIELD =
  /^\s*(?:[-*]\s+)?(?:label|description|placeholder)\s*[:=]\s*|^\s*--(?:service|field|label|description|placeholder|allowed-domains|allowed-tools|injection-templates|usage-description)\b/i;

interface Violation {
  file: string;
  line: number;
  text: string;
}

function findViolations(): Violation[] {
  const repoRoot = process.cwd() + "/..";

  // Find all SKILL.md files tracked by git
  let skillFiles: string[];
  try {
    const output = execSync(`git grep -l "" -- '*/SKILL.md'`, {
      encoding: "utf-8",
      cwd: repoRoot,
    }).trim();
    skillFiles = output.split("\n").filter((f) => f.length > 0);
  } catch (err) {
    if ((err as { status?: number }).status === 1) {
      return []; // no SKILL.md files found
    }
    throw err;
  }

  // Filter to skills/ and assistant/src/config/bundled-skills/ directories
  skillFiles = skillFiles.filter(
    (f) =>
      f.startsWith("skills/") ||
      f.startsWith("assistant/src/config/bundled-skills/"),
  );

  const violations: Violation[] = [];

  for (const filePath of skillFiles) {
    if (ALLOWLIST.has(filePath)) continue;

    let content: string;
    try {
      content = execSync(`git show HEAD:${filePath}`, {
        encoding: "utf-8",
        cwd: repoRoot,
      });
    } catch {
      continue;
    }

    const lines = content.split("\n");

    // Track whether we're inside an `assistant credentials prompt` block
    // (the command plus its indented flag continuation lines)
    let inCredentialPromptBlock = false;
    let blockIndent = 0;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNumber = i + 1;

      // Track `assistant credentials prompt` blocks
      if (/assistant\s+credentials\s+prompt/i.test(line)) {
        inCredentialPromptBlock = true;
        blockIndent = line.search(/\S/);
        continue;
      }

      // Exit the prompt block when indentation returns to same or lesser level
      if (inCredentialPromptBlock) {
        const currentIndent = line.search(/\S/);
        if (
          currentIndent !== -1 &&
          currentIndent <= blockIndent &&
          line.trim().length > 0
        ) {
          inCredentialPromptBlock = false;
        }
      }

      // Skip empty lines
      if (line.trim().length === 0) continue;

      // Skip negation lines — these instruct NOT to do something
      if (NEGATION_PATTERNS.test(line)) continue;

      // Skip secure-prompt UI field lines (--label/--description/--placeholder, etc.)
      if (inCredentialPromptBlock && CREDENTIAL_PROMPT_UI_FIELD.test(line))
        continue;

      // Strip markdown backticks before pattern matching so that
      // violations like `client_secret` are caught the same as bare words.
      const stripped = line.replace(/`/g, "");

      // Check against violation patterns
      for (const pattern of VIOLATION_PATTERNS) {
        if (pattern.test(stripped)) {
          violations.push({
            file: filePath,
            line: lineNumber,
            text: line.trim(),
          });
          break; // one violation per line is enough
        }
      }
    }
  }

  return violations;
}

describe("SKILL.md secret handling guard", () => {
  test("no SKILL.md files instruct accepting secrets in chat", () => {
    const violations = findViolations();

    if (violations.length > 0) {
      const message = [
        "Found SKILL.md files that instruct accepting secrets directly in chat.",
        "Secrets must always be collected via `assistant credentials prompt`, which",
        "presents a secure native UI that keeps values out of conversation history.",
        "",
        "Violations:",
        ...violations.map((v) => `  - ${v.file}:${v.line}: ${v.text}`),
        "",
        "To fix: replace chat-based secret collection with an `assistant credentials prompt` call.",
        "See any *-setup skill (e.g. skills/slack-app-setup/SKILL.md) for the correct pattern.",
        "",
        "If this is a genuine exception, add the file path to the ALLOWLIST in",
        "skill-secret-handling-guard.test.ts.",
      ].join("\n");

      expect(violations, message).toEqual([]);
    }
  });
});
