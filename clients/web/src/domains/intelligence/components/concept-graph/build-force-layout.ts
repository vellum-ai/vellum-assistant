/**
 * Deterministic 3D force-directed layout for the memory concept graph.
 *
 * Pure and dependency-free: seeds node positions in a sphere (index-based, NO
 * RNG — identical layout across renders, never reshuffles), then relaxes them
 * in 3D with repulsion + link springs + centering gravity, and finishes with a
 * radius-aware collision pass. The result is a rounded "brain mass" volume
 * (even disconnected nodes are pulled into the sphere rather than scattered).
 * The renderer rotates and projects these 3D positions to 2.5D with depth cues.
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
  z: number;
  vx: number;
  vy: number;
  vz: number;
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

  // Seed inside a sphere (Fibonacci direction + volume-filling radius) so the
  // relaxed result is a solid ball, not a hollow shell. Deterministic.
  const spread = 70 + 26 * Math.sqrt(n);
  const bodies: Body[] = raw.map((_, i) => {
    const t = (i + 0.5) / n;
    const inclination = Math.acos(1 - 2 * t); // 0..π, even in cosine
    const azimuth = i * GOLDEN_ANGLE;
    const r = spread * Math.cbrt(t); // uniform volume density
    const sinI = Math.sin(inclination);
    return {
      x: center.x + r * sinI * Math.cos(azimuth),
      y: center.y + r * sinI * Math.sin(azimuth),
      z: r * Math.cos(inclination),
      vx: 0,
      vy: 0,
      vz: 0,
    };
  });

  const iterations =
    opts.iterations ?? Math.max(90, Math.min(340, Math.round(46000 / n)));
  const K_REPULSION = 6400;
  const IDEAL_LEN = 140;
  const K_SPRING = 0.05;
  const K_CENTER = 0.011;
  const DAMPING = 0.82;
  const STEP = 0.5;

  let alpha = 1;
  const alphaDecay = 1 - 0.001 ** (1 / iterations);

  for (let iter = 0; iter < iterations; iter++) {
    // Pairwise repulsion in 3D (O(n^2); n is capped server-side).
    for (let i = 0; i < n; i++) {
      const bi = bodies[i];
      for (let j = i + 1; j < n; j++) {
        const bj = bodies[j];
        let dx = bi.x - bj.x;
        let dy = bi.y - bj.y;
        let dz = bi.z - bj.z;
        let d2 = dx * dx + dy * dy + dz * dz;
        if (d2 < 0.01) {
          dx = (i - j) * 0.1 + 0.1;
          dy = 0.1;
          dz = 0.05;
          d2 = dx * dx + dy * dy + dz * dz;
        }
        const dist = Math.sqrt(d2);
        const force = K_REPULSION / d2;
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        const fz = (dz / dist) * force;
        bi.vx += fx;
        bi.vy += fy;
        bi.vz += fz;
        bj.vx -= fx;
        bj.vy -= fy;
        bj.vz -= fz;
      }
    }

    // Link springs pull connected nodes toward the ideal edge length.
    for (const [a, b] of edgePairs) {
      const ba = bodies[a];
      const bb = bodies[b];
      const dx = bb.x - ba.x;
      const dy = bb.y - ba.y;
      const dz = bb.z - ba.z;
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz) || 0.01;
      const f = K_SPRING * (dist - IDEAL_LEN);
      const fx = (dx / dist) * f;
      const fy = (dy / dist) * f;
      const fz = (dz / dist) * f;
      ba.vx += fx;
      ba.vy += fy;
      ba.vz += fz;
      bb.vx -= fx;
      bb.vy -= fy;
      bb.vz -= fz;
    }

    // Centering gravity toward (center, 0) + integrate with cooling/damping.
    for (let i = 0; i < n; i++) {
      const b = bodies[i];
      b.vx += (center.x - b.x) * K_CENTER;
      b.vy += (center.y - b.y) * K_CENTER;
      b.vz += (0 - b.z) * K_CENTER;
      b.x += b.vx * alpha * STEP;
      b.y += b.vy * alpha * STEP;
      b.z += b.vz * alpha * STEP;
      b.vx *= DAMPING;
      b.vy *= DAMPING;
      b.vz *= DAMPING;
    }

    alpha *= 1 - alphaDecay;
  }

  // Radius-aware 3D collision resolution — keeps nodes from interpenetrating.
  for (let pass = 0; pass < 10; pass++) {
    let moved = false;
    for (let i = 0; i < n; i++) {
      const bi = bodies[i];
      for (let j = i + 1; j < n; j++) {
        const bj = bodies[j];
        let dx = bj.x - bi.x;
        let dy = bj.y - bi.y;
        let dz = bj.z - bi.z;
        let dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        const min = radii[i] + radii[j] + COLLISION_GAP;
        if (dist >= min) continue;
        if (dist < 0.01) {
          dx = (j - i) * 0.1 + 0.1;
          dy = 0.1;
          dz = 0.05;
          dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        }
        const push = (min - dist) / 2;
        const ux = (dx / dist) * push;
        const uy = (dy / dist) * push;
        const uz = (dz / dist) * push;
        bi.x -= ux;
        bi.y -= uy;
        bi.z -= uz;
        bj.x += ux;
        bj.y += uy;
        bj.z += uz;
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
      z: bodies[i].z,
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
