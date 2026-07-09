/**
 * Rehype plugin that wraps each word of the rendered markdown in a
 * `<span class="stream-word-fade">` so newly streamed words animate in
 * (see the `stream-word-fade-in` keyframes in `index.css`).
 *
 * Only applied to the trailing text group of the actively-streaming
 * assistant message (see `ChatMarkdownMessage`'s `streamWordFade` prop), so
 * the extra spans exist for at most one growing block and disappear on the
 * settle render. Newly revealed words animate exactly once: on each ~30fps
 * reveal commit React reconciles the word spans by position, so existing
 * spans keep their DOM nodes (CSS animations only restart on insertion) and
 * only the words appended since the last commit mount — and fade — in.
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

function wrapWords(node: HastNode): void {
  if (node.type === "element") {
    const el = node as HastElement;
    if (SKIPPED_TAGS.has(el.tagName)) return;
  }
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
            properties: { className: ["stream-word-fade"] },
            children: [{ type: "text", value: run } satisfies HastText],
          } satisfies HastElement),
    );
    children.splice(i, 1, ...replacement);
  }
}

export function rehypeStreamWordFade() {
  return (tree: HastNode) => {
    wrapWords(tree);
  };
}
