/**
 * Rehype plugin that marks inline code spans holding a workspace file path so
 * they can resolve into clickable file links.
 *
 * The plugin only *proposes*: it rewrites a qualifying `<code>` element to a
 * `<workspace-path>` element carrying the normalized path, and
 * `ChatMarkdownMessage` maps that tag to `WorkspacePathLink` via the design
 * library's `extraComponents` seam. The component checks the file's existence
 * before rendering any affordance, so an over-eager match here degrades to
 * plain inline code rather than a dead link.
 *
 * Only *inline* code is considered. Fenced blocks arrive as `<pre><code>`, and
 * a path inside a shell transcript or code sample is content being quoted, not
 * a file the user is meant to click — so the walk never descends into `<pre>`.
 * `<a>` is skipped for the same reason as `rehype-redacted-credential`: the
 * resolved link renders a button, which is invalid nested inside an anchor and
 * would double-fire the surrounding navigation.
 */

import {
  toWorkspaceRelativePath,
  WORKSPACE_PATH_TAG,
} from "@/domains/chat/utils/workspace-path-links";

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

const SKIPPED_TAGS = new Set(["pre", "a", "style", "script"]);

function isElement(node: HastNode): node is HastElement {
  return node.type === "element";
}

/**
 * The text of an inline code span, or `undefined` when it isn't a single plain
 * text run (syntax-highlighted or otherwise structured content is left alone).
 */
function singleTextChild(node: HastElement): string | undefined {
  if (node.children.length !== 1) {
    return undefined;
  }
  const only = node.children[0];
  return only.type === "text" ? (only as HastText).value : undefined;
}

function walk(node: HastNode): void {
  const children = node.children;
  if (!children) {
    return;
  }
  for (const child of children) {
    if (!isElement(child)) {
      continue;
    }
    if (SKIPPED_TAGS.has(child.tagName)) {
      continue;
    }
    if (child.tagName === "code") {
      const text = singleTextChild(child);
      const path = text === undefined ? null : toWorkspaceRelativePath(text);
      if (path !== null && text !== undefined) {
        // Rewritten in place so the element keeps its position among its
        // siblings. `raw` preserves the author's spelling (usually an
        // absolute `/workspace/...` path) — the link shows the text the
        // assistant actually wrote, while `path` carries the workspace-relative
        // form the daemon routes expect.
        child.tagName = WORKSPACE_PATH_TAG;
        child.properties = { ...child.properties, path, raw: text };
        child.children = [];
      }
      continue;
    }
    walk(child);
  }
}

/** Rehype plugin factory (no options). */
export function rehypeWorkspacePath() {
  return (tree: HastNode): void => {
    walk(tree);
  };
}
