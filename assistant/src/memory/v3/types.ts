// ---------------------------------------------------------------------------
// Memory v3 — Shared types
// ---------------------------------------------------------------------------
//
// Types shared across the v3 memory subsystem. Like v2, every value here
// crosses a serialization boundary — YAML frontmatter on disk — so it ships as
// a Zod schema with an inferred TypeScript type so runtime validation runs
// wherever a node is read.
//
// This file must not import from any other `memory/v3/*` module — it is the
// leaf of the v3 dependency graph.

import { z } from "zod";

// ---------------------------------------------------------------------------
// Tree nodes
// ---------------------------------------------------------------------------

/**
 * YAML frontmatter at the top of a v3 tree node (`memory/tree/<id>.md`).
 *
 * The v3 tree is a DAG *overlay* over the existing flat `memory/concepts/`
 * pages. A node organizes a region of the graph: its markdown body is the
 * node's full self-description and `children` is the list of outgoing edges.
 *
 * `children` is the canonical, ordered list of child *references*. Each entry
 * is either:
 *   - `"page:<page-slug>"` — a leaf concept page (canonical content stays in
 *     `memory/concepts/<page-slug>.md`, shared and untouched by v3), or
 *   - `"node:<node-id>"` — a sub-node in the v3 tree.
 *
 * This reference list IS the DAG edge — it is the portable replacement for the
 * filesystem symlinks an earlier design would have used. A page or node may be
 * referenced by more than one parent (hence DAG, not tree).
 *
 * `routing_hints` is a thin, hand-written line of cross-branch disambiguation
 * — e.g. "for *work* relationships see people/colleagues, not this node".
 * Kept deliberately small so it stays cheap to inject during routing.
 *
 * `summary` is the node's self-description headline (1-line); the markdown body
 * is the full self-description. Optional so a freshly authored node with only a
 * body still parses.
 */
export const TreeNodeFrontmatterSchema = z
  .object({
    children: z.array(z.string()).default([]),
    routing_hints: z.string().optional(),
    summary: z.string().optional(),
  })
  .strict();

export type TreeNodeFrontmatter = z.infer<typeof TreeNodeFrontmatterSchema>;

/**
 * A single tree node on disk. The id is the relative path from
 * `memory/tree/` minus `.md`, using forward slashes — so `people` and
 * `people/colleagues` are both valid ids. The id is the stable identity used
 * in `children` references (`node:<id>`) and is the portable node handle a
 * future data-migration authors by hand.
 */
export type TreeNode = {
  id: string;
  frontmatter: TreeNodeFrontmatter;
  body: string;
};
