/**
 * Narrow redactor for the recall-gate decision log.
 *
 * Replaces emails, URLs, file paths, and long alphanumeric tokens with
 * type-tags before writing to the log table. Purpose-built for Boss's
 * single-user log — not a general PII redactor.
 */

const EMAIL_RE = /\b[\w.+-]+@[\w.-]+\.\w{2,}\b/g;
const URL_RE = /https?:\/\/[^\s)>\]]+/g;
const FILE_PATH_RE =
  /(?:^|\s)((?:\/|\.\.?\/|~\/)(?:[\w.-]+\/)*[\w.-]+(?:\.\w+)?)/g;
const LONG_TOKEN_RE = /\b[A-Za-z0-9_-]{40,}\b/g;

export function redactForLog(text: string): string {
  return text
    .replace(EMAIL_RE, "<email>")
    .replace(URL_RE, "<url>")
    .replace(FILE_PATH_RE, " <filepath>")
    .replace(LONG_TOKEN_RE, "<token>");
}
