import { describe, expect, test } from "bun:test";

import { VIRTUAL_CENTER } from "@/domains/intelligence/components/constellation-view/constants";

import {
  computeEdgeStyle,
  computeLearnedEdgeFog,
  computeNodeStyle,
  projectNodes,
} from "./render-calculations";
import type { GraphLayoutNode } from "./types";

const DAY_MS = 24 * 60 * 60 * 1000;
const CLUSTER_PALETTE = ["#cluster-0", "#cluster-1", "#cluster-2"] as const;
const EDGE_LEARNED_COLOR = "#learned";
const NODE_KIND_COLORS = {
  concept: "#concept",
  skill: "#skill",
  capability: "#capability",
  pending: "#pending",
  other: "#other",
} as const;

function node(overrides: Partial<GraphLayoutNode> = {}): GraphLayoutNode {
  return {
    id: "node",
    x: VIRTUAL_CENTER.x,
    y: VIRTUAL_CENTER.y,
    z: 0,
    radius: 10,
    label: "Node",
    kind: "concept",
    degree: 1,
    ...overrides,
  };
}

describe("projectNodes", () => {
  test("projects the virtual center to the canvas center", () => {
    const [projected] = projectNodes([node()], {
      width: 800,
      height: 600,
      massRadius: 100,
      yaw: 0,
      pitch: 0,
      zoom: 1,
    });

    expect(projected.sx).toBe(400);
    expect(projected.sy).toBe(300);
    expect(projected.sr).toBeCloseTo(26.4);
    expect(projected.depth).toBe(0.5);
  });

  test("applies yaw, pitch, perspective, and zoom deterministically", () => {
    const [projected] = projectNodes(
      [
        node({
          x: VIRTUAL_CENTER.x + 20,
          y: VIRTUAL_CENTER.y - 10,
          z: 30,
          radius: 5,
        }),
      ],
      {
        width: 1000,
        height: 500,
        massRadius: 100,
        yaw: Math.PI / 2,
        pitch: Math.PI / 6,
        zoom: 1.5,
      },
    );

    expect(projected.sx).toBeCloseTo(592.1443, 4);
    expect(projected.sy).toBeCloseTo(254.115, 4);
    expect(projected.sr).toBeCloseTo(15.3574, 4);
    expect(projected.depth).toBeCloseTo(0.3884, 4);
  });

  test("clamps depth and projected radius", () => {
    const [projected] = projectNodes([node({ z: -500, radius: 0.01 })], {
      width: 100,
      height: 100,
      massRadius: 100,
      yaw: 0,
      pitch: 0,
      zoom: 0.1,
    });

    expect(projected.depth).toBe(0);
    expect(projected.sr).toBe(1.2);
  });
});

describe("computeLearnedEdgeFog", () => {
  test("stays full below the density threshold and eases to its floor", () => {
    expect(computeLearnedEdgeFog(80)).toBe(1);
    expect(computeLearnedEdgeFog(210)).toBeCloseTo(0.56);
    expect(computeLearnedEdgeFog(340)).toBeCloseTo(0.12);
    expect(computeLearnedEdgeFog(1000)).toBeCloseTo(0.12);
  });
});

describe("computeEdgeStyle", () => {
  const base = {
    kind: "learned" as const,
    depth: 0.5,
    ghost: false,
    selectionActive: false,
    egoEdge: false,
    hoverActive: false,
    incident: false,
    endpointsLit: true,
    learnedFog: 0.5,
    learnedColor: EDGE_LEARNED_COLOR,
    linkColor: "#neutral",
  };

  test("styles a resting learned edge with depth and density fog", () => {
    const style = computeEdgeStyle(base);

    expect(style.alpha).toBeCloseTo(0.119);
    expect(style.strokeStyle).toBe(EDGE_LEARNED_COLOR);
    expect(style.lineWidth).toBeCloseTo(0.9);
    expect(style.lineDash).toEqual([4, 4]);
  });

  test("hover, selection, and ghost states preserve their precedence", () => {
    expect(
      computeEdgeStyle({ ...base, hoverActive: true, incident: true }).alpha,
    ).toBe(0.9);
    expect(
      computeEdgeStyle({
        ...base,
        selectionActive: true,
        egoEdge: false,
      }).alpha,
    ).toBe(0.03);
    expect(
      computeEdgeStyle({
        ...base,
        ghost: true,
        selectionActive: true,
        egoEdge: true,
      }).alpha,
    ).toBe(0.03);
  });

  test("keeps link edges solid and independent of learned-edge fog", () => {
    expect(
      computeEdgeStyle({
        ...base,
        kind: "link",
        depth: 1,
        learnedFog: 0.12,
      }),
    ).toEqual({
      alpha: 0.28,
      strokeStyle: "#neutral",
      lineWidth: 1.2,
      lineDash: [],
    });
  });
});

describe("computeNodeStyle", () => {
  const nowMs = 100 * DAY_MS;
  const base = {
    node: node(),
    depth: 0.5,
    cluster: 2,
    ghost: false,
    lit: true,
    selectionActive: false,
    inSelectedEgo: false,
    isActive: false,
    nowMs,
    frameTimeMs: 0,
    renderIndex: 0,
    reduceMotion: true,
    clusterPalette: CLUSTER_PALETTE,
    nodeKindColors: NODE_KIND_COLORS,
  };

  test("uses cluster color and depth alpha for a lit concept", () => {
    const style = computeNodeStyle(base);

    expect(style.color).toBe(CLUSTER_PALETTE[2]);
    expect(style.fillAlpha).toBeCloseTo(0.363);
    expect(style.strokeAlpha).toBeCloseTo(0.66);
    expect(style.shadowBlur).toBe(2);
    expect(style.lineWidth).toBe(1.4);
    expect(style.lineDash).toEqual([]);
  });

  test("dims nodes outside the selected ego-network", () => {
    const style = computeNodeStyle({
      ...base,
      selectionActive: true,
      inSelectedEgo: false,
    });

    expect(style.strokeAlpha).toBeCloseTo(0.033);
    expect(style.fillAlpha).toBeCloseTo(0.01815);
    expect(style.shadowBlur).toBe(2);
  });

  test("styles pending nodes with their lighter fill and dashed ring", () => {
    const style = computeNodeStyle({
      ...base,
      node: node({ kind: "pending" }),
      depth: 1,
      isActive: true,
    });

    expect(style).toMatchObject({
      fillAlpha: 0.3,
      strokeAlpha: 1,
      shadowBlur: 16,
      lineWidth: 2.5,
      lineDash: [3, 3],
    });
  });

  test("adds a deterministic recency glow without pulsing in reduced motion", () => {
    const style = computeNodeStyle({
      ...base,
      node: node({ updatedAtMs: nowMs - 7 * DAY_MS }),
      depth: 1,
      frameTimeMs: 12345,
      renderIndex: 8,
      reduceMotion: true,
    });

    expect(style.shadowBlur).toBe(10);
  });
});
