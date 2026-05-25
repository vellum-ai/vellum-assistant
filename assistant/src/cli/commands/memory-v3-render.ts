/**
 * Text rendering for `assistant memory v3 validate` and `... tree`.
 *
 * Both functions are pure presentation: they take the daemon route's response
 * shape and return a terminal-ready string. They live CLI-side (mirroring
 * `memory-v2-compare-render.ts`) and import only the response *types* from the
 * daemon route — `cli/no-daemon-internals` permits type-only imports but
 * forbids pulling in daemon runtime modules.
 */

import type {
  MemoryV3TreeResult,
  MemoryV3ValidateResult,
} from "../../runtime/routes/memory-v3-routes.js";

/**
 * Render a {@link MemoryV3ValidateResult} into a counts summary plus the
 * offending ids for each non-empty category. Categories with zero entries
 * print `none` so a clean tree reads at a glance.
 */
export function renderValidationReport(report: MemoryV3ValidateResult): string {
  const lines: string[] = [
    "Memory v3 Tree Validation",
    "=========================",
    `Dangling child refs: ${report.danglingChildRefCount || "none"}`,
  ];
  for (const d of report.danglingChildRefs) {
    lines.push(`  - ${d.node} → ${d.kind}:${d.ref}`);
  }

  lines.push(`Orphan pages: ${report.orphanPageCount || "none"}`);
  for (const slug of report.orphanPages) {
    lines.push(`  - ${slug}`);
  }

  lines.push(`Cycles: ${report.cycleCount || "none"}`);
  for (const c of report.cycles) {
    lines.push(`  - ${c.from} → ${c.to}`);
  }

  lines.push(`Stale index: ${report.staleIndexCount || "none"}`);
  for (const s of report.staleIndex) {
    lines.push(`  - ${s.node} (older than child ${s.child})`);
  }

  lines.push(
    `Unknown edge targets: ${report.unknownEdgeTargetCount || "none"}`,
  );
  for (const e of report.unknownEdgeTargets) {
    lines.push(`  - ${e.from} → ${e.to}`);
  }

  return lines.join("\n");
}

/**
 * Whether the validation report has any defect in any category. The CLI uses
 * this to set a non-zero exit code so `validate` is scriptable as a check.
 */
export function reportHasDefects(report: MemoryV3ValidateResult): boolean {
  return (
    report.danglingChildRefCount > 0 ||
    report.orphanPageCount > 0 ||
    report.cycleCount > 0 ||
    report.staleIndexCount > 0 ||
    report.unknownEdgeTargetCount > 0
  );
}

/**
 * Render a {@link MemoryV3TreeResult} as an indented tree rooted at `view.root`,
 * descending `node:` children depth-first. A node reached more than once
 * (shared DAG sub-node) is printed once with a `(↑ …)` re-entry marker rather
 * than re-expanded, which also bounds output when the structure contains a
 * cycle. `page:` children are printed as leaves under their parent node.
 */
export function renderTree(view: MemoryV3TreeResult): string {
  const childrenById = new Map<string, MemoryV3TreeResult["nodes"][number]>();
  for (const node of view.nodes) {
    childrenById.set(node.id, node);
  }

  const lines: string[] = [];
  const expanded = new Set<string>();

  const walk = (nodeId: string, depth: number): void => {
    const indent = "  ".repeat(depth);
    const node = childrenById.get(nodeId);

    if (!node) {
      lines.push(`${indent}node:${nodeId} (missing)`);
      return;
    }

    if (expanded.has(nodeId)) {
      // Shared DAG sub-node (or a cycle's back-edge): print the reference but
      // do not re-expand, so output stays finite and the re-entry is visible.
      lines.push(`${indent}node:${nodeId} (↑ already shown)`);
      return;
    }
    expanded.add(nodeId);
    lines.push(`${indent}node:${nodeId}`);

    for (const child of node.children) {
      if (child.kind === "page") {
        lines.push(`${"  ".repeat(depth + 1)}page:${child.ref}`);
      } else {
        walk(child.ref, depth + 1);
      }
    }
  };

  walk(view.root, 0);

  if (lines.length === 0) {
    lines.push("(empty tree)");
  }

  // Surface nodes that exist on disk but were never reached from the root —
  // they would otherwise be invisible in a root-anchored print.
  const unreached = view.nodes
    .map((n) => n.id)
    .filter((id) => !expanded.has(id))
    .sort();
  if (unreached.length > 0) {
    lines.push("", `Unreachable nodes (${unreached.length}):`);
    for (const id of unreached) {
      lines.push(`  - node:${id}`);
    }
  }

  return lines.join("\n");
}
