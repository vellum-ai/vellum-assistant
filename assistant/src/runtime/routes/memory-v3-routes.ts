/**
 * Memory v3 route definitions — read-only diagnostics over the hand-authored
 * v3 tree DAG.
 *
 * Two operations, both side-effect-free (no LLM, no writes):
 *
 *   - `memory_v3_validate` — returns the {@link TreeValidationReport} from
 *     `validateTree(workspaceDir)` (orphan pages, cycles, dangling refs,
 *     stale-index, unknown edge targets).
 *   - `memory_v3_tree` — returns a JSON-serializable view of
 *     `getTreeIndex(workspaceDir)`: the root id, every node id, and each
 *     node's ordered child refs. `TreeIndex` is Map-based, so the handler
 *     flattens it into arrays/objects the wire protocol can carry.
 *
 * The v3 tree is authored by the v2 → v3 data-migration; these routes are the
 * on-demand inspection surface operators run while that migration is in flight.
 * They are NOT invoked on any turn.
 */

import { z } from "zod";

import { getTreeIndex } from "../../memory/v3/tree-index.js";
import type { TreeValidationReport } from "../../memory/v3/validate.js";
import { validateTree } from "../../memory/v3/validate.js";
import { getWorkspaceDir } from "../../util/platform.js";
import type { RouteDefinition, RouteHandlerArgs } from "./types.js";

// ── Validate ────────────────────────────────────────────────────────────

const MemoryV3ValidateParams = z.object({}).strict();

/**
 * Wire shape for `memory_v3_validate`. Identical to the daemon-internal
 * {@link TreeValidationReport} — every field is already serializable, so the
 * route forwards it verbatim. Re-exported as its own type so the CLI can
 * import it without reaching into the validator module.
 */
export type MemoryV3ValidateResult = TreeValidationReport;

async function handleValidate({
  body = {},
}: RouteHandlerArgs): Promise<MemoryV3ValidateResult> {
  // Read-only structural validation of the v3 tree. Like the v2 validate
  // route, it is intentionally ungated: operators dry-run it while the
  // v2 → v3 migration is mid-flight, well before any v3 flag flips.
  MemoryV3ValidateParams.parse(body);
  return validateTree(getWorkspaceDir());
}

// ── Tree ────────────────────────────────────────────────────────────────

const MemoryV3TreeParams = z.object({}).strict();

/** One node in the serialized tree view: its id and ordered child refs. */
export interface MemoryV3TreeNodeView {
  id: string;
  children: Array<{ kind: "node" | "page"; ref: string }>;
}

/**
 * JSON-serializable projection of the {@link TreeIndex}. `TreeIndex` keys its
 * adjacency by `Map`, which doesn't survive JSON, so the handler flattens it:
 * `root` is the entry-point node id and `nodes` is every node with its ordered
 * child refs. The CLI renderer walks `nodes`/`root` to print an indented tree,
 * marking shared-DAG re-entries.
 */
export interface MemoryV3TreeResult {
  root: string;
  nodes: MemoryV3TreeNodeView[];
}

async function handleTree({
  body = {},
}: RouteHandlerArgs): Promise<MemoryV3TreeResult> {
  MemoryV3TreeParams.parse(body);

  const tree = await getTreeIndex(getWorkspaceDir());

  const nodes: MemoryV3TreeNodeView[] = [...tree.nodes.keys()]
    .sort()
    .map((id) => ({
      id,
      children: (tree.childrenByNode.get(id) ?? []).map((child) => ({
        kind: child.kind,
        ref: child.ref,
      })),
    }));

  return { root: tree.root, nodes };
}

// ── Route definitions ───────────────────────────────────────────────────

export const ROUTES: RouteDefinition[] = [
  {
    operationId: "memory_v3_validate",
    method: "POST",
    endpoint: "memory/v3/validate",
    handler: handleValidate,
    summary: "Validate the memory v3 tree structure (read-only)",
    description:
      "Read-only structural validation of the hand-authored v3 tree DAG. Reports dangling child refs, orphan pages, cycles, stale compositional indexes, and unknown edge targets. Writes nothing and runs no LLM — operators dry-run it while the v2 → v3 migration is in flight.",
    tags: ["memory"],
    requestBody: MemoryV3ValidateParams,
  },
  {
    operationId: "memory_v3_tree",
    method: "POST",
    endpoint: "memory/v3/tree",
    handler: handleTree,
    summary: "Return a serializable view of the memory v3 tree DAG (read-only)",
    description:
      "Returns the v3 tree root id plus every node and its ordered child refs (page:/node:) as a JSON-serializable projection of the in-memory TreeIndex. Read-only; the CLI uses it to print an indented tree with shared-DAG re-entries marked.",
    tags: ["memory"],
    requestBody: MemoryV3TreeParams,
  },
];
