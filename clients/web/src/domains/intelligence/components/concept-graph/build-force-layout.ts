/**
 * Deterministic force-directed layout for the memory concept graph.
 *
 * Pure and dependency-free: seeds node positions on a phyllotaxis spiral
 * (index-based, NO RNG — so the same graph lays out identically across renders
 * and never reshuffles), then relaxes them with repulsion + link springs +
 * centering gravity, and finishes with a radius-aware collision pass so nodes
 * never overlap regardless of force tuning. Emits nodes that satisfy
 * `PositionedNode`, so the shared viewport/fit math frames the result — absolute
 * scale is irrelevant because the viewport auto-fits.
 */

import { VIRTUAL_CENTER } from "@/domains/intelligence/components/constellation-view/constants";

import type { MemoryGraph } from "@/domains/intelligence/memory-graph/types";
import type {
  ConceptEdgeKind,
  ConceptNodeKind,
  GraphLayout,
  GraphLayoutEdge,
  GraphLayoutNode,
} from "./types";

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

const NODE_BASE_RADIUS = 7;
const NODE_RADIUS_PER_DEGREE = 2.4;
const NODE_MAX_RADIUS = 34;
const COLLISION_GAP = 10;

function nodeRadius(degree: number): number {
  return Math.min(
    NODE_MAX_RADIUS,
    NODE_BASE_RADIUS + NODE_RADIUS_PER_DEGREE * Math.sqrt(degree),
  );
}

function toNodeKind(kind: string | undefined): ConceptNodeKind {
  return kind === "concept" || kind === "skill" || kind === "capability"
    ? kind
    : "other";
}

function toEdgeKind(kind: string | undefined): ConceptEdgeKind {
  return kind === "link" || kind === "learned" ? kind : "other";
}

export interface ForceLayoutOptions {
  /** Override the relaxation iteration count (defaults to a size-adaptive value). */
  iterations?: number;
  center?: { x: number; y: number };
}

interface Body {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

export function buildForceLayout(
  graph: MemoryGraph,
  opts: ForceLayoutOptions = {},
): GraphLayout {
  const center = opts.center ?? VIRTUAL_CENTER;
  const raw = graph.nodes;
  const n = raw.length;
  if (n === 0) return { nodes: [], edges: [] };

  const indexById = new Map<string, number>();
  raw.forEach((node, i) => indexById.set(node.id, i));

  // Keep only edges whose endpoints both exist and aren't self-loops.
  const validEdges = graph.edges.filter(
    (e) =>
      e.source !== e.target &&
      indexById.has(e.source) &&
      indexById.has(e.target),
  );

  const degree = new Array<number>(n).fill(0);
  const edgePairs: Array<readonly [number, number]> = [];
  for (const e of validEdges) {
    const a = indexById.get(e.source)!;
    const b = indexById.get(e.target)!;
    degree[a]++;
    degree[b]++;
    edgePairs.push([a, b]);
  }

  const radii = raw.map((_, i) => nodeRadius(degree[i]));

  // Seed on a golden-angle spiral so initial spacing is even and deterministic.
  const spread = 60 + 26 * Math.sqrt(n);
  const bodies: Body[] = raw.map((_, i) => {
    const r = spread * Math.sqrt((i + 0.5) / n);
    const angle = i * GOLDEN_ANGLE;
    return {
      x: center.x + r * Math.cos(angle),
      y: center.y + r * Math.sin(angle),
      vx: 0,
      vy: 0,
    };
  });

  const iterations =
    opts.iterations ?? Math.max(90, Math.min(360, Math.round(50000 / n)));
  const K_REPULSION = 7800;
  const IDEAL_LEN = 150;
  const K_SPRING = 0.05;
  const K_CENTER = 0.007;
  const DAMPING = 0.82;
  const STEP = 0.5;

  let alpha = 1;
  const alphaDecay = 1 - 0.001 ** (1 / iterations);

  for (let iter = 0; iter < iterations; iter++) {
    // Pairwise repulsion (O(n^2); n is capped server-side).
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let dx = bodies[i].x - bodies[j].x;
        let dy = bodies[i].y - bodies[j].y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 0.01) {
          // Perturb coincident nodes deterministically so they can separate.
          dx = (i - j) * 0.1 + 0.1;
          dy = 0.1;
          d2 = dx * dx + dy * dy;
        }
        const dist = Math.sqrt(d2);
        const force = K_REPULSION / d2;
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        bodies[i].vx += fx;
        bodies[i].vy += fy;
        bodies[j].vx -= fx;
        bodies[j].vy -= fy;
      }
    }

    // Link springs pull connected nodes toward the ideal edge length.
    for (const [a, b] of edgePairs) {
      const dx = bodies[b].x - bodies[a].x;
      const dy = bodies[b].y - bodies[a].y;
      const dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
      const f = K_SPRING * (dist - IDEAL_LEN);
      const fx = (dx / dist) * f;
      const fy = (dy / dist) * f;
      bodies[a].vx += fx;
      bodies[a].vy += fy;
      bodies[b].vx -= fx;
      bodies[b].vy -= fy;
    }

    // Centering gravity + integrate with cooling and damping.
    for (let i = 0; i < n; i++) {
      bodies[i].vx += (center.x - bodies[i].x) * K_CENTER;
      bodies[i].vy += (center.y - bodies[i].y) * K_CENTER;
      bodies[i].x += bodies[i].vx * alpha * STEP;
      bodies[i].y += bodies[i].vy * alpha * STEP;
      bodies[i].vx *= DAMPING;
      bodies[i].vy *= DAMPING;
    }

    alpha *= 1 - alphaDecay;
  }

  // Radius-aware collision resolution — guarantees no overlaps for readability.
  for (let pass = 0; pass < 12; pass++) {
    let moved = false;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let dx = bodies[j].x - bodies[i].x;
        let dy = bodies[j].y - bodies[i].y;
        let dist = Math.sqrt(dx * dx + dy * dy);
        const min = radii[i] + radii[j] + COLLISION_GAP;
        if (dist >= min) continue;
        if (dist < 0.01) {
          dx = (j - i) * 0.1 + 0.1;
          dy = 0.1;
          dist = Math.sqrt(dx * dx + dy * dy);
        }
        const push = (min - dist) / 2;
        const ux = (dx / dist) * push;
        const uy = (dy / dist) * push;
        bodies[i].x -= ux;
        bodies[i].y -= uy;
        bodies[j].x += ux;
        bodies[j].y += uy;
        moved = true;
      }
    }
    if (!moved) break;
  }

  const nodes: GraphLayoutNode[] = raw.map((node, i) => {
    const out: GraphLayoutNode = {
      id: node.id,
      x: bodies[i].x,
      y: bodies[i].y,
      radius: radii[i],
      label: node.label,
      kind: toNodeKind(node.kind),
      degree: degree[i],
    };
    if (node.summary) out.summary = node.summary;
    if (node.updatedAtMs !== undefined) out.updatedAtMs = node.updatedAtMs;
    return out;
  });

  const edges: GraphLayoutEdge[] = validEdges.map((e, i) => {
    const out: GraphLayoutEdge = {
      id: `${e.source}__${e.target}__${i}`,
      fromId: e.source,
      toId: e.target,
      kind: toEdgeKind(e.kind),
      directed: e.directed ?? false,
    };
    if (e.description) out.description = e.description;
    return out;
  });

  return { nodes, edges };
}
