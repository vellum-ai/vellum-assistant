/**
 * Rehype plugin behind the streamed-text reveal sweep. Wraps each word of the
 * rendered markdown in a `<span class="stream-word-fade">` and, while the
 * reveal is still catching up to the stream (`caughtUp: false`), grades the
 * last `TAIL_WORDS` spans with inline opacities that ramp from near-invisible
 * at the reveal edge to full — a soft gradient that sweeps left-to-right (and
 * across wrapped lines and new blocks, since the spans are inline flow) as
 * text streams in.
 *
 * Only applied to the trailing text group of the actively-streaming
 * assistant message (see `ChatMarkdownMessage`'s `streamWordFade` prop). On
 * each ~30fps reveal commit React reconciles the spans by position, so
 * existing spans keep their DOM nodes and just receive a higher opacity,
 * which the `transition` on `.stream-word-fade` (see `index.css`) animates —
 * each word brightens smoothly as the edge moves past it. Once the reveal
 * catches up (`caughtUp: true`) no grading is applied, so the tail lifts to
 * full opacity through the same transition and the eventual settle render
 * (spans removed) is a visual no-op.
 *
 * Code content is skipped: `<pre>` blocks preserve whitespace exactly, and
 * splitting their text into spans would garble it.
 */

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

/** Width of the fading edge. ~8 words ≈ half a line of chat text. */
const TAIL_WORDS = 8;

const FADE_CLASS = "stream-word-fade";

function isElement(node: HastNode): node is HastElement {
  return node.type === "element";
}

function wrapWords(node: HastNode): void {
  if (isElement(node) && SKIPPED_TAGS.has(node.tagName)) return;
  const children = node.children;
  if (!children) return;
  for (let i = children.length - 1; i >= 0; i--) {
    const child = children[i];
    if (child.type !== "text") {
      wrapWords(child);
      continue;
    }
    const value = (child as HastText).value;
    // Split into alternating word / whitespace runs; whitespace stays a bare
    // text node so wrapped words never change inter-word spacing.
    const runs = value.match(/\S+|\s+/g);
    if (!runs || (runs.length === 1 && /^\s+$/.test(runs[0]))) continue;
    const replacement: HastNode[] = runs.map((run) =>
      /^\s+$/.test(run)
        ? ({ type: "text", value: run } satisfies HastText)
        : ({
            type: "element",
            tagName: "span",
            properties: { className: [FADE_CLASS] },
            children: [{ type: "text", value: run } satisfies HastText],
          } satisfies HastElement),
    );
    children.splice(i, 1, ...replacement);
  }
}

/** Collects the fade spans in document order (wrapWords creates them out of
 *  order because it iterates children in reverse). */
function collectSpans(node: HastNode, out: HastElement[]): void {
  if (isElement(node)) {
    const className = node.properties?.className;
    if (Array.isArray(className) && className.includes(FADE_CLASS)) {
      out.push(node);
      return;
    }
  }
  if (node.children) {
    for (const child of node.children) collectSpans(child, out);
  }
}

export interface RehypeStreamWordFadeOptions {
  /**
   * True once the revealed text has fully caught up to the streamed target.
   * Skips the tail grading so every word sits at full opacity (reached via
   * the CSS transition, since the spans persist across commits).
   */
  caughtUp?: boolean;
}

export function rehypeStreamWordFade(options?: RehypeStreamWordFadeOptions) {
  const caughtUp = options?.caughtUp ?? false;
  return (tree: HastNode) => {
    wrapWords(tree);
    if (caughtUp) return;
    const spans: HastElement[] = [];
    collectSpans(tree, spans);
    const tail = Math.min(TAIL_WORDS, spans.length);
    for (let d = 0; d < tail; d++) {
      const span = spans[spans.length - 1 - d];
      const opacity = ((d + 1) / (TAIL_WORDS + 1)).toFixed(3);
      span.properties = { ...span.properties, style: `opacity:${opacity}` };
    }
  };
}
