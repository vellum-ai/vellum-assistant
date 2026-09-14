import { isMessageKey } from "../i18n/index.js";

const REPLACEABLE_PATTERNS = [
  /^Runtime:\s/,
  /^New Conversation$/,
  /^Untitled$/,
  /^Untitled Conversation$/,
  /^Generating title\.\.\.$/,
];

/**
 * Check whether a title is a system-generated placeholder that can be
 * replaced or omitted without discarding user-provided copy.
 */
export function isReplaceableTitle(title: string | null): boolean {
  if (title == null || title.trim() === "") {
    return true;
  }
  if (isMessageKey(title.trim())) {
    return true;
  }
  return REPLACEABLE_PATTERNS.some((pattern) => pattern.test(title));
}
