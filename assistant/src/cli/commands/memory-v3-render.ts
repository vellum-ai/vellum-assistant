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
  DescentPass,
  LlmCallRecord,
  MemoryV3SimulateResult,
  MemoryV3TreeResult,
  MemoryV3ValidateResult,
  SeedCoretrievalResult,
  ShadowDiffResult,
  ShadowDiffTurn,
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

/** Canonical print order for the loop's provenance lanes. */
const SIMULATE_LANE_ORDER = ["hot", "sparse", "dense", "tree", "edge"] as const;

/** Render the effective lane toggles as a one-line `on` / restricted summary. */
function renderEffectiveLanes(
  lanes: MemoryV3SimulateResult["effectiveConfig"]["lanes"],
): string {
  const on = Object.entries(lanes)
    .filter(([, enabled]) => enabled)
    .map(([name]) => name);
  const off = Object.entries(lanes)
    .filter(([, enabled]) => !enabled)
    .map(([name]) => name);
  if (off.length === 0) return on.join(", ");
  return `${on.join(", ")}  (off: ${off.join(", ")})`;
}

/** Render one pass's scout / tree / edge / gate breakdown into `lines`. */
function renderPass(pass: DescentPass, lines: string[]): void {
  lines.push(`Pass ${pass.passNumber}`);

  if (pass.scouts && pass.scouts.length > 0) {
    const summary = pass.scouts
      .map((s) => `${s.lane}=${s.slugs.length}`)
      .join("  ");
    lines.push(`  scouts: ${summary}`);
  }

  if (pass.treeLevels && pass.treeLevels.length > 0) {
    lines.push(`  tree: ${pass.treeLevels.length} level(s)`);
    for (const level of pass.treeLevels) {
      const node = level.node === "" ? "[root]" : level.node;
      lines.push(
        `    ${node}: considered ${level.considered.length}, descended ${level.descended.length}, skipped ${level.skipped.length}`,
      );
      if (level.descended.length > 0) {
        lines.push(`      → ${level.descended.join(", ")}`);
      }
      if (level.reasoning.trim().length > 0) {
        lines.push(`      reason: ${level.reasoning.trim()}`);
      }
    }
  }

  if (pass.edgeExpansions && pass.edgeExpansions.length > 0) {
    const pulled = pass.edgeExpansions.reduce((n, e) => n + e.pulled.length, 0);
    lines.push(
      `  edges: ${pass.edgeExpansions.length} seed(s) expanded, ${pulled} pulled`,
    );
  }

  if (pass.gate) {
    lines.push(`  gate: ${pass.gate.decision}`);
    for (const q of pass.gate.questions ?? []) {
      lines.push(`    ? ${q}`);
    }
  }
}

/**
 * Render a {@link MemoryV3SimulateResult} into a query echo, effective config,
 * per-pass descent breakdown, and the final selection grouped by provenance
 * lane (in fanout order). Mirrors the grouped layout of `memory v2 simulate`.
 */
export function renderSimulation(result: MemoryV3SimulateResult): string {
  const lines: string[] = [
    "Memory v3 Retrieval Simulation",
    "==============================",
    `Query: ${JSON.stringify(result.query)}`,
    "",
    "Config (effective):",
    `  passCap: ${result.effectiveConfig.passCap}`,
    `  lanes: ${renderEffectiveLanes(result.effectiveConfig.lanes)}`,
    "",
  ];

  const passes = result.trace.passes;
  lines.push(`Passes: ${passes.length || "none"}`);
  for (const pass of passes) {
    lines.push("");
    renderPass(pass, lines);
  }
  lines.push("");

  lines.push(`Selected: ${result.selectedSlugs.length} page(s)`);
  const grouped = new Map<string, string[]>();
  for (const slug of result.selectedSlugs) {
    const lane = result.sourceBySlug[slug] ?? "unknown";
    const bucket = grouped.get(lane) ?? [];
    bucket.push(slug);
    grouped.set(lane, bucket);
  }
  const laneRank = (lane: string): number => {
    const i = SIMULATE_LANE_ORDER.indexOf(
      lane as (typeof SIMULATE_LANE_ORDER)[number],
    );
    return i === -1 ? SIMULATE_LANE_ORDER.length : i;
  };
  const lanes = [...grouped.keys()].sort((a, b) => laneRank(a) - laneRank(b));
  for (const lane of lanes) {
    const slugs = grouped.get(lane)!;
    lines.push(`  ${lane} (${slugs.length})`);
    for (const slug of slugs) {
      lines.push(`    - ${slug}`);
    }
  }

  if (result.cost.ms !== undefined) {
    lines.push("", `Cost: ${result.cost.ms} ms`);
  }
  if (result.failureReason) {
    lines.push(`Failure: ${result.failureReason}`);
  }

  return lines.join("\n");
}

// ── Shadow-diff ───────────────────────────────────────────────────────────

/** Max slugs to list per side of a per-turn detail block (full set in --json). */
const SHADOW_DIFF_SLUG_CAP = 12;

/** Format an epoch-ms timestamp as local `YYYY-MM-DD HH:MM:SS`. */
function fmtTime(ms: number): string {
  const d = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  );
}

/** Render a lane/slug tally as `key: n` pairs, count-descending. */
function renderTally(tally: Record<string, number>): string {
  const entries = Object.entries(tally).sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  );
  if (entries.length === 0) return "none";
  return entries.map(([k, v]) => `${k}: ${v}`).join("   ");
}

/** Render a capped slug list with an overflow note. */
function renderSlugList(slugs: readonly string[]): string {
  if (slugs.length === 0) return "—";
  const shown = slugs.slice(0, SHADOW_DIFF_SLUG_CAP).join(", ");
  const extra = slugs.length - SHADOW_DIFF_SLUG_CAP;
  return extra > 0 ? `${shown}  (+${extra} more)` : shown;
}

/** Render one paired turn's sizes + the v3-only / v2-only slug lists. */
function renderShadowDiffTurn(turn: ShadowDiffTurn, lines: string[]): void {
  const dt = `${turn.deltaMs >= 0 ? "+" : ""}${(turn.deltaMs / 1000).toFixed(1)}s`;
  lines.push(
    `  [${turn.conversationId.slice(0, 12)}] ${fmtTime(turn.shadowAt)}  Δ${dt}`,
  );
  lines.push(
    `    v2=${turn.v2Count}  v3=${turn.v3Count}  overlap=${turn.overlap.length}` +
      `  jaccard=${turn.jaccard.toFixed(2)}  (v2 cached: ${turn.v2CachedCount})`,
  );
  lines.push(
    `    v3-only (${turn.v3Only.length}): ${renderSlugList(turn.v3Only)}`,
  );
  lines.push(
    `    v2-only (${turn.v2Only.length}): ${renderSlugList(turn.v2Only)}`,
  );
}

/**
 * Render a {@link ShadowDiffResult}: the read window, the aggregate v2-vs-v3
 * comparison, the v3 lane breakdowns (extra recall + recovered overlap), the
 * most-dropped / most-added slug lists, and the capped per-turn detail.
 */
export function renderShadowDiff(result: ShadowDiffResult): string {
  const { agg } = result;
  const lines: string[] = [
    "Memory v3 Shadow Diff",
    "=====================",
    `Window: ${result.shadowRows} shadow row(s), ${result.turnsCompared} paired, ` +
      `${result.unpaired.length} unpaired   (tolerance ${result.toleranceMs / 1000}s)`,
  ];

  if (result.turnsCompared === 0) {
    lines.push(
      "",
      "No paired turns. Either v3 shadow mode has not run (no v3_shadow rows),",
      "or no v2 router row landed within tolerance of a shadow row. Enable",
      "memory.v3.enabled + memory.v3.shadow and let a few turns accrue.",
    );
    if (result.unpaired.length > 0) {
      lines.push("", `Unpaired shadow rows (${result.unpaired.length}):`);
      for (const u of result.unpaired) {
        lines.push(
          `  [${u.conversationId.slice(0, 12)}] ${fmtTime(u.shadowAt)}  v3=${u.v3Count}`,
        );
      }
    }
    return lines.join("\n");
  }

  lines.push(
    "",
    `Aggregate (${result.turnsCompared} turns):`,
    `  v2 picked (injected):  mean ${agg.meanV2.toFixed(1)}   total ${agg.totalOverlap + agg.totalV2Only}`,
    `  v3 selected:           mean ${agg.meanV3.toFixed(1)}   total ${agg.totalOverlap + agg.totalV3Only}`,
    `  overlap:               mean ${agg.meanOverlap.toFixed(1)}   total ${agg.totalOverlap}   (mean Jaccard ${agg.meanJaccard.toFixed(2)})`,
    `  v3-only (v3 added):    total ${agg.totalV3Only}`,
    `  v2-only (v3 dropped):  total ${agg.totalV2Only}`,
    "",
    "v3 extra recall by lane (v3-only):",
    `  ${renderTally(agg.v3OnlyByLane)}`,
    "",
    "overlap recovered by lane:",
    `  ${renderTally(agg.overlapByLane)}`,
  );

  if (agg.v2OnlyTop.length > 0) {
    lines.push("", "Most-dropped v2 pages (v2-only):");
    for (const { slug, count } of agg.v2OnlyTop) {
      lines.push(`  ${count}×  ${slug}`);
    }
  }
  if (agg.v3OnlyTop.length > 0) {
    lines.push("", "Most-frequent v3 extras (v3-only):");
    for (const { slug, count } of agg.v3OnlyTop) {
      lines.push(`  ${count}×  ${slug}`);
    }
  }

  lines.push("", `Per-turn (newest first, showing ${result.turns.length}):`);
  for (const turn of result.turns) {
    lines.push("");
    renderShadowDiffTurn(turn, lines);
  }

  if (result.unpaired.length > 0) {
    lines.push("", `Unpaired shadow rows (${result.unpaired.length}):`);
    for (const u of result.unpaired) {
      lines.push(
        `  [${u.conversationId.slice(0, 12)}] ${fmtTime(u.shadowAt)}  v3=${u.v3Count}`,
      );
    }
  }

  return lines.join("\n");
}

// ── LLM-call capture ────────────────────────────────────────────────────────

type CapturedMessage = LlmCallRecord["request"]["messages"][number];
type CapturedBlock = LlmCallRecord["response"]["content"][number];

/** Concatenate the text blocks of a message (non-text blocks are ignored). */
function messageText(message: CapturedMessage): string {
  return message.content
    .filter(
      (b): b is Extract<CapturedBlock, { type: "text" }> => b.type === "text",
    )
    .map((b) => b.text)
    .join("\n");
}

/** The forced-tool block from a response, if the model returned one. */
function toolUseOf(
  call: LlmCallRecord,
): Extract<CapturedBlock, { type: "tool_use" }> | undefined {
  return call.response.content.find(
    (b): b is Extract<CapturedBlock, { type: "tool_use" }> =>
      b.type === "tool_use",
  );
}

function truncate(s: string, max: number): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

function indent(s: string, by = "    "): string {
  return s
    .split("\n")
    .map((line) => by + line)
    .join("\n");
}

/**
 * Render the captured v3 LLM calls. Compact (default): one line per call —
 * pass/lane/node, input size, round-trip ms, and the forced-tool summary. Full
 * (`--show-llm`): the system prompt, every message, the tool names, and the
 * tool_use input for each call. Grouped in call order (which is pass order).
 */
export function renderLlmCalls(
  calls: readonly LlmCallRecord[],
  opts: { full: boolean },
): string {
  if (calls.length === 0) return "LLM calls: none";

  const lines: string[] = [`LLM calls (${calls.length}):`];
  for (const call of calls) {
    const label =
      `pass${call.pass} · ${call.lane}` +
      (call.node ? ` · node=${call.node}` : "");
    const inputChars =
      call.request.systemPrompt.length +
      call.request.messages.reduce((n, m) => n + messageText(m).length, 0);
    const tool = toolUseOf(call);
    const toolSummary = tool
      ? `${tool.name}(${truncate(JSON.stringify(tool.input), 80)})`
      : `no tool_use (stop=${call.response.stopReason})`;

    if (!opts.full) {
      lines.push(
        `  ${label} · in ${inputChars}c · ${call.ms}ms · ${truncate(toolSummary, 100)}`,
      );
      continue;
    }

    lines.push("", `── ${label}  (${call.callSite}, ${call.ms}ms) ──`);
    lines.push("system:", indent(call.request.systemPrompt));
    lines.push("messages:");
    for (const message of call.request.messages) {
      lines.push(
        indent(`[${message.role}]`),
        indent(messageText(message), "      "),
      );
    }
    lines.push(`tools: ${call.request.tools.map((t) => t.name).join(", ")}`);
    lines.push("output:");
    lines.push(
      indent(
        tool
          ? `${tool.name} ${JSON.stringify(tool.input, null, 2)}`
          : `(no tool_use, stop=${call.response.stopReason})`,
      ),
    );
  }
  return lines.join("\n");
}

/**
 * Render a {@link SeedCoretrievalResult} into a one-block summary of the seeding
 * run: how many router turns were scanned and how many nodes/edges were written.
 */
export function renderSeedEdges(result: SeedCoretrievalResult): string {
  return [
    "Memory v3 Co-Retrieval Edge Seed",
    "================================",
    `Router turns scanned: ${result.turnsScanned}`,
    `Nodes (sources):      ${result.nodes}`,
    `Edges written:        ${result.edgesWritten}`,
    `Avg out-degree:       ${result.avgDegree.toFixed(1)}`,
  ].join("\n");
}
