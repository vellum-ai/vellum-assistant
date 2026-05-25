/**
 * Memory v3 — Compositional index rendering.
 *
 * A v3 tree node has no stored "index" of its own. Instead, a parent node's
 * index is *composed at read time* by concatenating one description line per
 * child (a `node:` sub-node's summary or a `page:` leaf's summary) plus a thin
 * `Routing hints:` trailer drawn from the node's own frontmatter. Nothing here
 * is persisted — the block is generated fresh every time a descent prompt needs
 * it, so it always reflects the current state of the children.
 *
 * {@link composeNodeIndex} is a **pure function** over an already-built
 * {@link TreeIndex} (from `tree-index.ts`) and {@link PageIndex} (from
 * `../v2/page-index.ts`). It does no I/O: the tree walk / driver PR is
 * responsible for building those indices and feeding them in.
 *
 * Resolution rules, per child ref of `nodeId` (in authored order):
 *   - `kind:"node"` → look up the child in `tree.nodes`; emit
 *     `"[node:<id>] <summary>"` where summary is the child's
 *     `frontmatter.summary` if non-empty, else the first non-empty line of its
 *     body. A node with neither still emits its header (`"[node:<id>]"`).
 *   - `kind:"page"` → look up `pages.bySlug.get(ref)`; emit
 *     `"[page:<slug>] <entry.summary>"`.
 *   - Either lookup missing → emit nothing for that ref. Reporting dangling
 *     refs is validation's job, not this renderer's.
 *
 * The node's own `routing_hints` (when present) are appended last under a
 * `Routing hints:` trailer. A node with no resolvable children and no routing
 * hints composes to the empty string.
 */

import type { PageIndex } from "../v2/page-index.js";
import type { TreeIndex } from "./tree-index.js";
import type { TreeNode } from "./types.js";

/** Trailer label introducing a node's own routing hints. */
const ROUTING_HINTS_LABEL = "Routing hints:";

/**
 * Resolve a node's display summary: its frontmatter `summary` if non-empty,
 * otherwise the first non-empty line of its body, otherwise the empty string.
 * Whitespace is trimmed so a leading blank line in the body never wins.
 */
function nodeSummary(node: TreeNode): string {
  const summary = node.frontmatter.summary?.trim();
  if (summary) return summary;
  for (const line of node.body.split("\n")) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return "";
}

/**
 * Render one child ref into its index line, or `null` when the ref's target is
 * absent from the supplied indices (validation owns reporting those).
 *
 * A resolvable `node:` child always yields a line — its header (`[node:<id>]`)
 * with a trailing summary when one exists. A `page:` child yields
 * `[page:<slug>] <summary>`; the v2 page index already truncates `summary`.
 */
function renderChild(
  kind: "page" | "node",
  ref: string,
  tree: TreeIndex,
  pages: PageIndex,
): string | null {
  if (kind === "node") {
    const child = tree.nodes.get(ref);
    if (!child) return null;
    const summary = nodeSummary(child);
    return summary ? `[node:${ref}] ${summary}` : `[node:${ref}]`;
  }
  const entry = pages.bySlug.get(ref);
  if (!entry) return null;
  return `[page:${ref}] ${entry.summary}`;
}

/**
 * Compose the prompt-ready index block for `nodeId` from its children's
 * descriptions plus the node's own routing hints.
 *
 * Pure and deterministic: children are emitted in authored order (the order
 * `tree.childrenByNode` preserves from the node's `children` frontmatter), refs
 * whose targets are absent are silently skipped, and the node's
 * `routing_hints` (if present) are appended under a {@link ROUTING_HINTS_LABEL}
 * trailer. A node with no entry in `childrenByNode`, no resolvable children,
 * and no routing hints composes to the empty string.
 *
 * The result is a plain string with no trailing newline, suitable to drop
 * directly into an LLM descent prompt.
 */
export function composeNodeIndex(
  nodeId: string,
  tree: TreeIndex,
  pages: PageIndex,
): string {
  const blocks: string[] = [];

  const childRefs = tree.childrenByNode.get(nodeId) ?? [];
  for (const { kind, ref } of childRefs) {
    const line = renderChild(kind, ref, tree, pages);
    if (line !== null) blocks.push(line);
  }

  const routingHints = tree.nodes
    .get(nodeId)
    ?.frontmatter.routing_hints?.trim();
  if (routingHints) {
    blocks.push(`${ROUTING_HINTS_LABEL} ${routingHints}`);
  }

  return blocks.join("\n");
}
