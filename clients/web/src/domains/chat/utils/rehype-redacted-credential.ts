/**
 * Rehype plugin that upgrades redacted-credential sentinels into renderable
 * elements (LUM-2768).
 *
 * The daemon persists chat secret redactions as plain-text sentinels —
 * `〔redacted:TYPE〕` or `〔redacted:TYPE:SERVICE:FIELD〕` (see
 * `@vellumai/service-contracts/redacted-credential`). Plain text is the only
 * marker shape that survives the chat markdown pipeline: there is no
 * rehype-raw, so an HTML marker can never become an element, but a text
 * sentinel arrives here as an ordinary hast text node. This plugin finds
 * those nodes and splits them, replacing each sentinel with a
 * `<redacted-credential>` element carrying the parsed fields as properties.
 * `ChatMarkdownMessage` maps that tag to the interactive chip component via
 * the design library's `extraComponents` seam.
 *
 * Applied unconditionally: sentinels only exist in content the daemon chose
 * to persist that way, and history must stay renderable regardless of the
 * current feature-flag state. The per-node fast path is a single
 * `includes()` check.
 *
 * `<pre>`/`<code>` content is skipped, mirroring `rehype-stream-word-fade` —
 * a sentinel quoted inside a code block renders as literal text rather than
 * sprouting an interactive chip inside preformatted content.
 */

import {
  createRedactedSentinelRegex,
  REDACTED_SENTINEL_OPEN,
} from "@vellumai/service-contracts/redacted-credential";

export const REDACTED_CREDENTIAL_TAG = "redacted-credential";

type HastText = { type: "text"; value: string };
type HastElement = {
  type: "element";
  tagName: string;
  properties?: Record<string, unknown>;
  children: HastNode[];
};
type HastNode = (HastText | HastElement | { type: string }) & {
  children?: HastNode[];
};

const SKIPPED_TAGS = new Set(["pre", "code", "style", "script"]);

function isElement(node: HastNode): node is HastElement {
  return node.type === "element";
}

/** Split one text node's value into text runs and sentinel elements. */
function splitSentinels(value: string): HastNode[] | undefined {
  const re = createRedactedSentinelRegex();
  const parts: HastNode[] = [];
  let lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(value)) !== null) {
    if (m.index > lastIndex) {
      parts.push({ type: "text", value: value.slice(lastIndex, m.index) });
    }
    const [, type, service, field] = m;
    parts.push({
      type: "element",
      tagName: REDACTED_CREDENTIAL_TAG,
      properties: {
        type,
        ...(service !== undefined && field !== undefined
          ? { service, field }
          : {}),
      },
      children: [],
    } satisfies HastElement);
    lastIndex = m.index + m[0].length;
  }
  if (parts.length === 0) {
    return undefined;
  }
  if (lastIndex < value.length) {
    parts.push({ type: "text", value: value.slice(lastIndex) });
  }
  return parts;
}

function walk(node: HastNode): void {
  if (isElement(node) && SKIPPED_TAGS.has(node.tagName)) {
    return;
  }
  const children = node.children;
  if (!children) {
    return;
  }
  for (let i = children.length - 1; i >= 0; i--) {
    const child = children[i];
    if (child.type !== "text") {
      walk(child);
      continue;
    }
    const value = (child as HastText).value;
    if (!value.includes(REDACTED_SENTINEL_OPEN)) {
      continue;
    }
    const replacement = splitSentinels(value);
    if (replacement) {
      children.splice(i, 1, ...replacement);
    }
  }
}

/** Rehype plugin factory (no options). */
export function rehypeRedactedCredential() {
  return (tree: HastNode): void => {
    walk(tree);
  };
}
