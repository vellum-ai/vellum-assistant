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
 * sprouting an interactive chip inside preformatted content. `<a>` is skipped
 * too: the chip's controls are buttons, which are invalid nested inside an
 * anchor and would double-fire the link's navigation.
 */

import {
  createNeutralizedSentinelRegex,
  createRedactedSentinelRegex,
  decodeRedactedSentinelMatch,
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

// `pre`/`code`/`style`/`script`: a sentinel quoted inside preformatted or raw
// content renders as literal text, not an interactive chip (mirrors
// rehype-stream-word-fade). `a`: the chip's reveal/copy controls are buttons,
// and a button nested inside an anchor is invalid HTML whose clicks would also
// trigger the surrounding link navigation — so a sentinel inside link text
// stays literal rather than sprouting controls inside the `<a>`.
const SKIPPED_TAGS = new Set(["pre", "code", "style", "script", "a"]);

function isElement(node: HastNode): node is HastElement {
  return node.type === "element";
}

/** A located sentinel span: genuine (chip) or neutralized (inert badge). */
interface SentinelHit {
  index: number;
  length: number;
  element: HastElement;
}

/** Split one text node's value into text runs and sentinel elements. */
function splitSentinels(value: string): HastNode[] | undefined {
  const hits: SentinelHit[] = [];
  const genuine = createRedactedSentinelRegex();
  let m: RegExpExecArray | null;
  while ((m = genuine.exec(value)) !== null) {
    // The regex capture groups carry percent-ENCODED segments; the shared
    // decoder yields the real vault coordinates (and degrades a malformed
    // escape to the plain non-revealable shape).
    const sentinel = decodeRedactedSentinelMatch(m);
    hits.push({
      index: m.index,
      length: m[0].length,
      element: {
        type: "element",
        tagName: REDACTED_CREDENTIAL_TAG,
        properties: {
          type: sentinel.type,
          ...(sentinel.service !== undefined && sentinel.field !== undefined
            ? { service: sentinel.service, field: sentinel.field }
            : {}),
        },
        children: [],
      },
    });
  }
  // Neutralized sentinels (the word-joiner form the daemon's forgery guard
  // produces for sentinel-shaped text it refused to vouch for) render as a
  // generic inert badge instead of leaking bare glyphs into the transcript.
  // None of the span's own segments are forwarded: its type/service/field
  // are unverified claims, and displaying them would lend a forgery the
  // daemon's voice. The two regexes cannot overlap — they differ at the
  // fixed post-bracket position.
  const neutralized = createNeutralizedSentinelRegex();
  while ((m = neutralized.exec(value)) !== null) {
    hits.push({
      index: m.index,
      length: m[0].length,
      element: {
        type: "element",
        tagName: REDACTED_CREDENTIAL_TAG,
        properties: { neutralized: true },
        children: [],
      },
    });
  }
  if (hits.length === 0) {
    return undefined;
  }
  hits.sort((a, b) => a.index - b.index);
  const parts: HastNode[] = [];
  let lastIndex = 0;
  for (const hit of hits) {
    if (hit.index > lastIndex) {
      parts.push({ type: "text", value: value.slice(lastIndex, hit.index) });
    }
    parts.push(hit.element);
    lastIndex = hit.index + hit.length;
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
