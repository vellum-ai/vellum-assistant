import { VIRTUAL_CENTER } from "@/domains/intelligence/components/constellation-view/constants";

import type {
  ConceptNodeKind,
  GraphLayoutEdge,
  GraphLayoutNode,
} from "./types";

const FOCAL_FACTOR = 3;
const MIN_PROJECTED_RADIUS = 1.2;
const DEPTH_ALPHA_MIN = 0.32;

const FOG_FULL_BELOW = 80;
const FOG_FLOOR_ABOVE = 340;
const FOG_FLOOR = 0.12;

const SELECTION_DIM_NODE = 0.05;
const SELECTION_DIM_EDGE = 0.03;

export const HUB_LABEL_DEGREE = 4;
const DAY_MS = 24 * 60 * 60 * 1000;
const RECENCY_GLOW_WINDOW_MS = 14 * DAY_MS;
const RECENCY_GLOW_MAX = 12;
const PULSE_WINDOW_MS = 2 * DAY_MS;

export interface ProjectedNode {
  node: GraphLayoutNode;
  sx: number;
  sy: number;
  sr: number;
  depth: number;
}

interface ProjectionOptions {
  width: number;
  height: number;
  massRadius: number;
  yaw: number;
  pitch: number;
  zoom: number;
}

/** Project force-layout coordinates into canvas screen space. */
export function projectNodes(
  nodes: readonly GraphLayoutNode[],
  { width, height, massRadius, yaw, pitch, zoom }: ProjectionOptions,
): ProjectedNode[] {
  const cosY = Math.cos(yaw);
  const sinY = Math.sin(yaw);
  const cosX = Math.cos(pitch);
  const sinX = Math.sin(pitch);
  const focal = FOCAL_FACTOR * massRadius;
  const baseZoom = (Math.min(width, height) * 0.88) / (2 * massRadius);
  const canvasZoom = baseZoom * zoom;
  const cx = width / 2;
  const cy = height / 2;

  return nodes.map((node) => {
    const px = node.x - VIRTUAL_CENTER.x;
    const py = node.y - VIRTUAL_CENTER.y;
    const pz = node.z;
    const x1 = px * cosY + pz * sinY;
    const z1 = -px * sinY + pz * cosY;
    const y2 = py * cosX - z1 * sinX;
    const z2 = py * sinX + z1 * cosX;
    const perspective = focal / (focal - z2);

    return {
      node,
      sx: cx + x1 * canvasZoom * perspective,
      sy: cy + y2 * canvasZoom * perspective,
      sr: Math.max(
        MIN_PROJECTED_RADIUS,
        node.radius * canvasZoom * perspective,
      ),
      depth: Math.max(0, Math.min(1, (z2 + massRadius) / (2 * massRadius))),
    };
  });
}

/** Fade the resting learned-edge web as the graph becomes dense. */
export function computeLearnedEdgeFog(nodeCount: number): number {
  if (nodeCount <= FOG_FULL_BELOW) {
    return 1;
  }

  return Math.max(
    FOG_FLOOR,
    1 -
      ((nodeCount - FOG_FULL_BELOW) / (FOG_FLOOR_ABOVE - FOG_FULL_BELOW)) *
        (1 - FOG_FLOOR),
  );
}

interface EdgeStyleOptions {
  kind: GraphLayoutEdge["kind"];
  depth: number;
  ghost: boolean;
  selectionActive: boolean;
  egoEdge: boolean;
  hoverActive: boolean;
  incident: boolean;
  endpointsLit: boolean;
  learnedFog: number;
  learnedColor: string;
  linkColor: string;
}

export interface EdgeStyle {
  alpha: number;
  strokeStyle: string;
  lineWidth: number;
  lineDash: number[];
}

/** Resolve an edge's canvas style from its depth and interaction state. */
export function computeEdgeStyle({
  kind,
  depth,
  ghost,
  selectionActive,
  egoEdge,
  hoverActive,
  incident,
  endpointsLit,
  learnedFog,
  learnedColor,
  linkColor,
}: EdgeStyleOptions): EdgeStyle {
  const learned = kind === "learned";
  const litAlpha = (learned ? 0.34 : 0.28) * (0.4 + 0.6 * depth);
  const restAlpha = learned ? litAlpha * learnedFog : litAlpha;

  let alpha: number;
  if (ghost) {
    alpha = 0.03;
  } else if (selectionActive) {
    alpha = egoEdge ? 0.9 : SELECTION_DIM_EDGE;
  } else if (hoverActive) {
    alpha = incident ? 0.9 : endpointsLit ? litAlpha : 0.05;
  } else {
    alpha = restAlpha;
  }

  return {
    alpha,
    strokeStyle: learned ? learnedColor : linkColor,
    lineWidth:
      (incident || (selectionActive && egoEdge) ? 2 : 1) * (0.6 + 0.6 * depth),
    lineDash: learned ? [4, 4] : [],
  };
}

interface NodeStyleOptions {
  node: GraphLayoutNode;
  depth: number;
  cluster: number;
  ghost: boolean;
  lit: boolean;
  selectionActive: boolean;
  inSelectedEgo: boolean;
  isActive: boolean;
  nowMs: number;
  frameTimeMs: number;
  renderIndex: number;
  reduceMotion: boolean;
  clusterPalette: readonly string[];
  nodeKindColors: Readonly<Record<ConceptNodeKind, string>>;
}

export interface NodeStyle {
  color: string;
  fillAlpha: number;
  strokeAlpha: number;
  shadowBlur: number;
  lineWidth: number;
  lineDash: number[];
}

/** Resolve a node's canvas style without mutating canvas state. */
export function computeNodeStyle({
  node,
  depth,
  cluster,
  ghost,
  lit,
  selectionActive,
  inSelectedEgo,
  isActive,
  nowMs,
  frameTimeMs,
  renderIndex,
  reduceMotion,
  clusterPalette,
  nodeKindColors,
}: NodeStyleOptions): NodeStyle {
  const color =
    node.kind === "concept"
      ? (clusterPalette[cluster % clusterPalette.length] ??
        nodeKindColors.concept)
      : nodeKindColors[node.kind];
  const depthAlpha = DEPTH_ALPHA_MIN + (1 - DEPTH_ALPHA_MIN) * depth;
  const alpha =
    selectionActive && !inSelectedEgo
      ? depthAlpha * SELECTION_DIM_NODE
      : ghost
        ? depthAlpha * 0.08
        : lit
          ? depthAlpha
          : depthAlpha * 0.18;

  let glow = (isActive ? 16 : node.degree >= HUB_LABEL_DEGREE ? 8 : 4) * depth;
  if (node.updatedAtMs) {
    const age = nowMs - node.updatedAtMs;
    const freshness = Math.max(0, 1 - age / RECENCY_GLOW_WINDOW_MS);
    if (freshness > 0) {
      let boost = freshness * RECENCY_GLOW_MAX;
      if (!reduceMotion && age < PULSE_WINDOW_MS) {
        boost *= 0.55 + 0.45 * Math.sin(frameTimeMs / 420 + renderIndex * 1.7);
      }
      glow += boost * depth;
    }
  }

  const pending = node.kind === "pending";
  return {
    color,
    fillAlpha: alpha * (pending ? 0.3 : 0.55),
    strokeAlpha: alpha,
    shadowBlur: lit ? glow : 0,
    lineWidth: isActive ? 2.5 : 1.4,
    lineDash: pending ? [3, 3] : [],
  };
}
