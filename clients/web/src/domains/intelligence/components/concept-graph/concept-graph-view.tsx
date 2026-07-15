import { useQuery } from "@tanstack/react-query";
import {
  Maximize2,
  Minimize2,
  RotateCcw,
  Search,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { VIRTUAL_CENTER } from "@/domains/intelligence/components/constellation-view/constants";
import { memoryGraphOptions } from "@/domains/intelligence/memory-graph/get-memory-graph";
import { Button } from "@vellumai/design-library";

import { buildForceLayout } from "./build-force-layout";
import { ConceptDetailPanel, type ConceptDetailNode } from "./concept-detail-panel";
import { ConceptGraphIntroBanner } from "./concept-graph-intro-banner";
import { ConceptGraphLegend } from "./concept-graph-legend";
import { CLUSTER_PALETTE, EDGE_LEARNED_COLOR, NODE_KIND_COLORS } from "./constants";
import { detectClusters } from "./detect-clusters";
import { RecencyLens, type RecencyWindow } from "./recency-lens";
import type { ConceptNodeKind, GraphLayoutNode } from "./types";
import { useGraphIntroDismissed } from "./use-graph-intro-dismissed";

const NODE_KIND_ORDER: ConceptNodeKind[] = [
  "concept",
  "skill",
  "capability",
  "other",
];

// Rotation / projection tuning.
const AUTO_YAW_PER_SEC = 0.13;
const IDLE_RESUME_MS = 2600;
const DRAG_SENSITIVITY = 0.006;
const PITCH_CLAMP = 1.15;
const FOCAL_FACTOR = 3.0; // focal = FOCAL_FACTOR * massRadius (gentle perspective)
const DEPTH_ALPHA_MIN = 0.32;
const MIN_ZOOM = 0.45;
const MAX_ZOOM = 3;
const HUB_LABEL_DEGREE = 4;

// Recency emphasis: recently-updated concepts glow brighter, and the freshest
// gently pulse, so the map reads as alive and "what did it just learn?" pops.
const DAY_MS = 24 * 60 * 60 * 1000;
const RECENCY_GLOW_WINDOW_MS = 14 * DAY_MS; // recency fades out over ~2 weeks
const RECENCY_GLOW_MAX = 12; // extra shadowBlur at peak freshness
const PULSE_WINDOW_MS = 2 * DAY_MS; // newer than this → pulses (unless reduced motion)

// As the graph grows, fade the resting (nothing-focused) learned-edge web so
// dense corpora don't read as a haze. Full strength up to FOG_FULL_BELOW nodes,
// easing to FOG_FLOOR by FOG_FLOOR_ABOVE. Only learned (associative) edges fade;
// authored links carry structure and stay. Hover always restores full contrast.
const FOG_FULL_BELOW = 80;
const FOG_FLOOR_ABOVE = 340;
const FOG_FLOOR = 0.12;

// Below this node count the graph is small enough to scan by eye — no search box.
const SEARCH_MIN_NODES = 12;

interface Projected {
  id: string;
  sx: number;
  sy: number;
  sr: number;
  depth: number; // 0 (far) .. 1 (near)
  updatedAtMs?: number; // for recency hit-test skipping; undefined = stale/older
}

interface Colors {
  content: string;
  tertiary: string;
}

function resolveColors(el: HTMLElement): Colors {
  const s = getComputedStyle(el);
  return {
    content: s.getPropertyValue("--content-default").trim() || "#e5e7eb",
    tertiary: s.getPropertyValue("--content-tertiary").trim() || "#8792a0",
  };
}

export interface ConceptGraphViewProps {
  assistantId: string;
  className?: string;
  isFullscreen?: boolean;
  onToggleFullscreen?: () => void;
  /** Opens a fresh chat seeded with a message; wired to the node detail drawer's
   * chat-from-node actions. When absent, those actions are hidden. */
  onOpenThread?: (message: string) => void;
}

function CenteredMessage({ title, detail }: { title: string; detail?: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
      <p className="text-body-medium-default" style={{ color: "var(--content-default)" }}>
        {title}
      </p>
      {detail ? (
        <p className="max-w-sm text-body-small-default" style={{ color: "var(--content-tertiary)" }}>
          {detail}
        </p>
      ) : null}
    </div>
  );
}

/**
 * A 2.5D "brain" of the assistant's memory concepts: nodes laid out in a 3D
 * volume, slowly auto-rotating (drag to orbit, scroll to zoom), drawn on canvas
 * with depth cues (near = larger / brighter / glowing) and hover-neighborhood
 * highlighting. Wired to the backend-agnostic `GET /memory-graph`.
 */
export function ConceptGraphView({
  assistantId,
  className,
  isFullscreen,
  onToggleFullscreen,
  onOpenThread,
}: ConceptGraphViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const query = useQuery(memoryGraphOptions(assistantId));
  const graph = query.data?.kind === "ready" ? query.data.graph : null;

  const layout = useMemo(
    () => (graph ? buildForceLayout(graph) : { nodes: [], edges: [] }),
    [graph],
  );
  const ready = query.data?.kind === "ready" && layout.nodes.length > 0;

  // Group concepts into themes so the map reads as colored clusters instead of
  // one flat color. Deterministic (see detect-clusters), so no render churn.
  const clusters = useMemo(
    () => detectClusters(layout.nodes, layout.edges),
    [layout.nodes, layout.edges],
  );

  // Neighbor adjacency for hover highlighting.
  const adjacency = useMemo(() => {
    const map = new Map<string, Set<string>>();
    const add = (a: string, b: string) => {
      let set = map.get(a);
      if (!set) {
        set = new Set();
        map.set(a, set);
      }
      set.add(b);
    };
    for (const e of layout.edges) {
      add(e.fromId, e.toId);
      add(e.toId, e.fromId);
    }
    return map;
  }, [layout.edges]);

  // Radius of the mass (rotation-invariant → stable framing while spinning).
  // Framed by the 92nd percentile of node distances so a few fringe/orphan
  // nodes can't shrink the whole mass into the middle of the viewport.
  const massRadius = useMemo(() => {
    if (layout.nodes.length === 0) {return 1;}
    const dists = layout.nodes
      .map((n) => {
        const dx = n.x - VIRTUAL_CENTER.x;
        const dy = n.y - VIRTUAL_CENTER.y;
        return Math.sqrt(dx * dx + dy * dy + n.z * n.z) + n.radius;
      })
      .sort((a, b) => a - b);
    const idx = Math.min(dists.length - 1, Math.floor(dists.length * 0.92));
    return Math.max(1, dists[idx]);
  }, [layout.nodes]);

  // Everything the animation loop reads lives in refs so it never triggers a
  // React re-render (the loop runs at 60fps off these).
  const view = useRef({
    yaw: 0.5,
    pitch: 0.32,
    zoom: 1,
    hoveredId: null as string | null,
    dragging: false,
    moved: false,
    lastX: 0,
    lastY: 0,
    lastInteractAt: -Infinity,
    // Set by every input that changes the scene; lets the reduced-motion
    // render path skip redrawing identical frames.
    dirty: true,
  });
  const projectedRef = useRef<Projected[]>([]);
  const colorsRef = useRef<Colors>({ content: "#e5e7eb", tertiary: "#8792a0" });

  // Bumped only when the focused node changes, so the DOM tooltip re-renders.
  // The canvas itself never needs React state.
  const [focusLabel, setFocusLabel] = useState<string | null>(null);
  // The concept opened into the detail drawer (null = graph only).
  const [openNode, setOpenNode] = useState<ConceptDetailNode | null>(null);

  // First-run explainer: shown over the graph (empty or populated) until the
  // user dismisses it; the dismissal sticks per-assistant.
  const [introDismissed, dismissIntro] = useGraphIntroDismissed(assistantId);

  // Name search: as the graph grows, typing narrows it to matching concepts —
  // matches stay lit, everything else ghosts. The set of matching ids lives in
  // a ref the 60fps render loop reads (so keystrokes don't re-run the effect),
  // and `dirty` is bumped whenever it changes so reduced-motion redraws.
  const [search, setSearch] = useState("");
  const searchLower = search.trim().toLowerCase();
  const matchIds = useMemo(() => {
    if (!searchLower) {return null;}
    const s = new Set<string>();
    for (const n of layout.nodes) {
      if (n.label.toLowerCase().includes(searchLower)) {s.add(n.id);}
    }
    return s;
  }, [searchLower, layout.nodes]);
  const filterRef = useRef<{ active: boolean; matches: Set<string> | null }>({
    active: false,
    matches: null,
  });
  useEffect(() => {
    filterRef.current = { active: Boolean(matchIds), matches: matchIds };
    view.current.dirty = true;
  }, [matchIds]);
  // Reset the search when the active assistant changes: this component is reused
  // across assistants (IdentityTab doesn't key it), so a stale query would
  // otherwise filter the new assistant's graph and ghost every node.
  useEffect(() => {
    setSearch("");
  }, [assistantId]);

  // Recency time-lens: "All · Month · Week" narrows the graph to concepts
  // updated within the window — older ones ghost like non-search-matches, so
  // "what did it learn recently?" pops. The window (in ms, or null for "all")
  // lives in a ref the 60fps loop reads (so segment clicks don't re-run it), and
  // `dirty` is bumped whenever it changes so reduced-motion redraws.
  const [recency, setRecency] = useState<RecencyWindow>("all");
  const recencyRef = useRef<{ windowMs: number | null }>({ windowMs: null });
  useEffect(() => {
    recencyRef.current.windowMs =
      recency === "week" ? 7 * DAY_MS : recency === "month" ? 30 * DAY_MS : null;
    view.current.dirty = true;
  }, [recency]);
  // Reset the window on assistant switch (mirrors the search reset above), so a
  // stale window doesn't ghost the new assistant's freshly-loaded concepts.
  useEffect(() => {
    setRecency("all");
  }, [assistantId]);

  const labelFor = useCallback(
    (id: string | null): string | null => {
      if (!id) {return null;}
      const node = layout.nodes.find((n) => n.id === id);
      if (!node) {return null;}
      return node.summary ? `${node.label} — ${node.summary}` : node.label;
    },
    [layout.nodes],
  );

  const resetView = useCallback(() => {
    const v = view.current;
    v.yaw = 0.5;
    v.pitch = 0.32;
    v.zoom = 1;
    v.lastInteractAt = -Infinity;
    v.dirty = true;
    setFocusLabel(null);
  }, []);

  const zoomBy = useCallback((factor: number) => {
    const v = view.current;
    v.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, v.zoom * factor));
    v.lastInteractAt = performance.now();
    v.dirty = true;
  }, []);

  useEffect(() => {
    if (!ready) {return;}
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) {return;}
    const ctx = canvas.getContext("2d");
    if (!ctx) {return;}

    // Capture the current layout for the loop; the effect re-runs (cancelling
    // this loop) whenever the data changes, so these never go stale.
    const nodes = layout.nodes;
    const edges = layout.edges;
    const nodeClusters = clusters;
    const adj = adjacency;
    const R = massRadius;

    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    colorsRef.current = resolveColors(container);

    let dpr = Math.min(window.devicePixelRatio || 1, 2);
    let cssW = 0;
    let cssH = 0;
    const applySize = () => {
      const rect = container.getBoundingClientRect();
      cssW = rect.width;
      cssH = rect.height;
      dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.max(1, Math.round(cssW * dpr));
      canvas.height = Math.max(1, Math.round(cssH * dpr));
      canvas.style.width = `${cssW}px`;
      canvas.style.height = `${cssH}px`;
      colorsRef.current = resolveColors(container);
      view.current.dirty = true;
    };
    applySize();
    const ro = new ResizeObserver(applySize);
    ro.observe(container);

    let raf = 0;
    let last = 0;
    const render = (t: number) => {
      const dt = last ? Math.min(0.05, (t - last) / 1000) : 0;
      last = t;
      const v = view.current;
      const colors = colorsRef.current;
      const nowMs = Date.now();

      const idle = !v.dragging && t - v.lastInteractAt > IDLE_RESUME_MS;
      if (idle && !reduceMotion) {
        v.yaw += AUTO_YAW_PER_SEC * dt;
      }

      // With reduced motion there is no auto-rotation, so the scene is static
      // between inputs — don't re-project and redraw identical frames.
      if (reduceMotion && !v.dirty) {
        raf = requestAnimationFrame(render);
        return;
      }
      v.dirty = false;

      const cosY = Math.cos(v.yaw);
      const sinY = Math.sin(v.yaw);
      const cosX = Math.cos(v.pitch);
      const sinX = Math.sin(v.pitch);
      const focal = FOCAL_FACTOR * R;
      const baseZoom = (Math.min(cssW, cssH) * 0.88) / (2 * R);
      const zoom = baseZoom * v.zoom;
      const cx = cssW / 2;
      const cy = cssH / 2;

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cssW, cssH);

      const activeId = v.hoveredId;
      const neighbors = activeId ? adj.get(activeId) : undefined;
      const isLit = (id: string) =>
        !activeId || id === activeId || (neighbors?.has(id) ?? false);

      // Search: when active, only matching nodes/edges stay lit; the rest ghost.
      const filter = filterRef.current;
      const searchActive = filter.active;
      const isMatch = (id: string) =>
        !searchActive || (filter.matches?.has(id) ?? false);

      // Recency lens: when a window is set, concepts not updated within it ghost
      // (like non-search-matches). A missing timestamp counts as stale/older.
      const recencyWindowMs = recencyRef.current.windowMs;
      const isRecencyGhost = (n: GraphLayoutNode) =>
        recencyWindowMs != null &&
        (!n.updatedAtMs || nowMs - n.updatedAtMs > recencyWindowMs);

      // Density fog: fade the resting learned-edge web as the corpus grows.
      const learnedFog =
        nodes.length <= FOG_FULL_BELOW
          ? 1
          : Math.max(
              FOG_FLOOR,
              1 -
                ((nodes.length - FOG_FULL_BELOW) /
                  (FOG_FLOOR_ABOVE - FOG_FULL_BELOW)) *
                  (1 - FOG_FLOOR),
            );

      // Project every node into screen space.
      const proj = new Array<{
        node: GraphLayoutNode;
        sx: number;
        sy: number;
        sr: number;
        depth: number;
      }>(nodes.length);
      for (let i = 0; i < nodes.length; i++) {
        const node = nodes[i];
        const px = node.x - VIRTUAL_CENTER.x;
        const py = node.y - VIRTUAL_CENTER.y;
        const pz = node.z;
        const x1 = px * cosY + pz * sinY;
        const z1 = -px * sinY + pz * cosY;
        const y2 = py * cosX - z1 * sinX;
        const z2 = py * sinX + z1 * cosX;
        const persp = focal / (focal - z2);
        proj[i] = {
          node,
          sx: cx + x1 * zoom * persp,
          sy: cy + y2 * zoom * persp,
          sr: Math.max(1.2, node.radius * zoom * persp),
          depth: Math.max(0, Math.min(1, (z2 + R) / (2 * R))),
        };
      }
      // Painter's order: far → near.
      const order = proj.map((_, i) => i).sort((a, b) => proj[a].depth - proj[b].depth);
      const posById = new Map<string, (typeof proj)[number]>();
      for (const p of proj) {posById.set(p.node.id, p);}

      // Edges (behind nodes).
      ctx.lineCap = "round";
      for (const e of edges) {
        const a = posById.get(e.fromId);
        const b = posById.get(e.toId);
        if (!a || !b) {continue;}
        const learned = e.kind === "learned";
        // An edge ghosts if either endpoint is ghosted by search or recency.
        const ghost =
          (searchActive && (!isMatch(e.fromId) || !isMatch(e.toId))) ||
          isRecencyGhost(a.node) ||
          isRecencyGhost(b.node);
        const incident = activeId != null && (e.fromId === activeId || e.toId === activeId);
        const depth = (a.depth + b.depth) / 2;
        // Learned edges fade with density in the resting web; authored links
        // don't. A focused hover neighborhood reads at full contrast, though —
        // so lit edges use the unfogged base even in a dense graph.
        const litAlpha = (learned ? 0.34 : 0.28) * (0.4 + 0.6 * depth);
        const restAlpha = learned ? litAlpha * learnedFog : litAlpha;
        let alpha: number;
        if (ghost) {
          alpha = 0.03;
        } else if (activeId != null) {
          alpha = incident ? 0.9 : isLit(e.fromId) && isLit(e.toId) ? litAlpha : 0.05;
        } else {
          alpha = restAlpha;
        }
        ctx.globalAlpha = alpha;
        ctx.strokeStyle = learned ? EDGE_LEARNED_COLOR : colors.tertiary;
        ctx.lineWidth = (incident ? 2 : 1) * (0.6 + 0.6 * depth);
        ctx.setLineDash(learned ? [4, 4] : []);
        ctx.beginPath();
        ctx.moveTo(a.sx, a.sy);
        ctx.lineTo(b.sx, b.sy);
        ctx.stroke();
      }
      ctx.setLineDash([]);

      // Nodes (far → near) with depth + glow.
      for (const idx of order) {
        const p = proj[idx];
        const node = p.node;
        // Concepts are colored by their detected theme/cluster; any non-concept
        // node falls back to its per-kind color.
        const color =
          node.kind === "concept"
            ? CLUSTER_PALETTE[(nodeClusters.get(node.id) ?? 0) % CLUSTER_PALETTE.length]
            : NODE_KIND_COLORS[node.kind];
        const searchGhost = searchActive && !isMatch(node.id);
        const ghost = searchGhost || isRecencyGhost(node);
        const lit = !ghost && isLit(node.id);
        const isActive = node.id === activeId;
        const depthA = DEPTH_ALPHA_MIN + (1 - DEPTH_ALPHA_MIN) * p.depth;
        const alpha = ghost ? depthA * 0.08 : lit ? depthA : depthA * 0.18;

        let glow = (isActive ? 16 : node.degree >= HUB_LABEL_DEGREE ? 8 : 4) * p.depth;
        // Recency: fresh concepts glow brighter; the very newest pulse. Static
        // (no pulse) under reduced motion, which only ever redraws on input.
        const updatedAtMs = node.updatedAtMs;
        if (updatedAtMs) {
          const age = nowMs - updatedAtMs;
          const recency = Math.max(0, 1 - age / RECENCY_GLOW_WINDOW_MS);
          if (recency > 0) {
            let boost = recency * RECENCY_GLOW_MAX;
            if (!reduceMotion && age < PULSE_WINDOW_MS) {
              boost *= 0.55 + 0.45 * Math.sin(t / 420 + idx * 1.7);
            }
            glow += boost * p.depth;
          }
        }
        ctx.shadowColor = color;
        ctx.shadowBlur = lit ? glow : 0;

        ctx.globalAlpha = alpha * 0.55;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.arc(p.sx, p.sy, p.sr, 0, Math.PI * 2);
        ctx.fill();

        ctx.shadowBlur = 0;
        ctx.globalAlpha = alpha;
        ctx.lineWidth = isActive ? 2.5 : 1.4;
        ctx.strokeStyle = color;
        ctx.stroke();
      }
      ctx.shadowBlur = 0;

      // Labels: hubs (when nothing is focused) + the focused neighborhood.
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.font = "11px ui-sans-serif, system-ui, sans-serif";
      for (const idx of order) {
        const p = proj[idx];
        const node = p.node;
        // When nothing is focused, only label front-facing hubs (depth-gated) so
        // the dense middle of the mass doesn't turn into unreadable label soup.
        // While searching, label the matches instead (that's what you're after).
        // Ghosted nodes (search or recency) never get labels.
        if ((searchActive && !isMatch(node.id)) || isRecencyGhost(node)) {continue;}
        const showLabel = searchActive
          ? p.depth > 0.3
          : activeId != null
            ? isLit(node.id)
            : node.degree >= HUB_LABEL_DEGREE && p.depth > 0.55;
        if (!showLabel) {continue;}
        ctx.globalAlpha = (node.id === activeId ? 1 : 0.85) * (0.4 + 0.6 * p.depth);
        ctx.fillStyle = colors.content;
        const label = node.label.length > 22 ? `${node.label.slice(0, 21)}…` : node.label;
        ctx.fillText(label, p.sx, p.sy + p.sr + 3);
      }
      ctx.globalAlpha = 1;

      projectedRef.current = proj.map((p) => ({
        id: p.node.id,
        sx: p.sx,
        sy: p.sy,
        sr: p.sr,
        depth: p.depth,
        updatedAtMs: p.node.updatedAtMs,
      }));

      raf = requestAnimationFrame(render);
    };
    raf = requestAnimationFrame(render);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [ready, layout, adjacency, massRadius, clusters]);

  // Nearest node under a screen point; nearest-in-front wins. Ghosted nodes are
  // skipped so hover/click land on a live node, not a faded background one: both
  // search non-matches and, when a recency window is set, concepts older than it
  // (a missing timestamp counts as stale). Mirrors the render-loop ghosting.
  const hitTest = useCallback((x: number, y: number): string | null => {
    const filter = filterRef.current;
    const recencyWindowMs = recencyRef.current.windowMs;
    const now = Date.now();
    let best: string | null = null;
    let bestDepth = -1;
    for (const p of projectedRef.current) {
      if (filter.active && !(filter.matches?.has(p.id) ?? false)) {continue;}
      if (
        recencyWindowMs != null &&
        (!p.updatedAtMs || now - p.updatedAtMs > recencyWindowMs)
      ) {
        continue;
      }
      const dx = x - p.sx;
      const dy = y - p.sy;
      if (dx * dx + dy * dy <= (p.sr + 5) * (p.sr + 5) && p.depth > bestDepth) {
        best = p.id;
        bestDepth = p.depth;
      }
    }
    return best;
  }, []);

  const localPoint = (e: React.PointerEvent) => {
    const rect = containerRef.current!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const onPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) {return;}
    if ((e.target as HTMLElement).closest("[data-graph-control]")) {return;}
    const v = view.current;
    v.dragging = true;
    v.moved = false;
    v.lastX = e.clientX;
    v.lastY = e.clientY;
    v.lastInteractAt = performance.now();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }, []);

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const v = view.current;
      if (v.dragging) {
        const dx = e.clientX - v.lastX;
        const dy = e.clientY - v.lastY;
        if (Math.abs(dx) > 2 || Math.abs(dy) > 2) {
          v.moved = true;
        }
        v.yaw += dx * DRAG_SENSITIVITY;
        v.pitch = Math.max(-PITCH_CLAMP, Math.min(PITCH_CLAMP, v.pitch + dy * DRAG_SENSITIVITY));
        v.lastX = e.clientX;
        v.lastY = e.clientY;
        v.lastInteractAt = performance.now();
        v.dirty = true;
        return;
      }
      const { x, y } = localPoint(e);
      const hit = hitTest(x, y);
      if (hit !== v.hoveredId) {
        v.hoveredId = hit;
        v.dirty = true;
        setFocusLabel(labelFor(hit));
      }
    },
    [hitTest, labelFor],
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const v = view.current;
      if (!v.dragging) {
        return;
      }
      v.dragging = false;
      v.lastInteractAt = performance.now();
      v.dirty = true;
      const el = e.currentTarget as HTMLElement;
      if (el.hasPointerCapture(e.pointerId)) {
        el.releasePointerCapture(e.pointerId);
      }
      if (!v.moved) {
        const { x, y } = localPoint(e);
        const hit = hitTest(x, y);
        if (hit) {
          // Click a node → open its concept page in the detail drawer.
          const n = layout.nodes.find((nn) => nn.id === hit);
          if (n) {
            setOpenNode({ id: n.id, label: n.label, updatedAtMs: n.updatedAtMs });
          }
        } else {
          setFocusLabel(null);
        }
      }
    },
    [hitTest, layout.nodes],
  );

  // Hover is only ever rewritten by moves inside the container, so without
  // this the highlight + tooltip would stay pinned after the pointer leaves.
  const onPointerLeave = useCallback(() => {
    const v = view.current;
    if (v.dragging || v.hoveredId == null) {
      return;
    }
    v.hoveredId = null;
    v.dirty = true;
    setFocusLabel(null);
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el || !ready) {return;}
    const onWheel = (e: WheelEvent) => {
      // Let the detail drawer scroll natively instead of zooming the graph.
      if ((e.target as HTMLElement).closest?.("[data-graph-panel]")) {return;}
      e.preventDefault();
      const v = view.current;
      v.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, v.zoom * (1 - e.deltaY / 500)));
      v.lastInteractAt = performance.now();
      v.dirty = true;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [ready]);

  const presentKinds = useMemo(() => {
    const kinds = new Set(layout.nodes.map((n) => n.kind));
    return NODE_KIND_ORDER.filter((k) => kinds.has(k));
  }, [layout.nodes]);
  const hasLearned = useMemo(() => layout.edges.some((e) => e.kind === "learned"), [layout.edges]);
  const hasLinks = useMemo(() => layout.edges.some((e) => e.kind !== "learned"), [layout.edges]);

  // The intro banner shows over a supported graph (empty or populated), never
  // over the loading / error / unsupported states.
  const showIntro = query.data?.kind === "ready" && !introDismissed;

  let body: React.ReactNode;
  if (query.isLoading) {
    body = (
      <div className="flex h-full items-center justify-center">
        <div
          className="h-6 w-6 animate-spin rounded-full border-2"
          style={{ borderColor: "var(--border-base)", borderTopColor: "var(--content-tertiary)" }}
        />
      </div>
    );
  } else if (query.isError) {
    body = (
      <CenteredMessage
        title="Couldn't load the memory graph"
        detail="Something went wrong fetching your assistant's memory. Try again in a moment."
      />
    );
  } else if (query.data?.kind === "unsupported") {
    body = (
      <CenteredMessage
        title="Memory graph isn't available"
        detail="The active memory backend doesn't expose a concept graph."
      />
    );
  } else if (!ready) {
    body = (
      <CenteredMessage
        title="No concepts yet"
        detail="As your assistant learns and links ideas, they'll appear here as a living map of its memory."
      />
    );
  } else {
    body = (
      <>
        <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />

        {/* Keep the box visible whenever a search is active, even if the graph
            shrank below the threshold (e.g. a refetch) — otherwise an active
            filter would ghost nodes with no way to clear it short of remount. */}
        {layout.nodes.length > SEARCH_MIN_NODES || search ? (
          <div
            data-graph-control
            className={`absolute top-4 z-10 ${onToggleFullscreen ? "left-16" : "left-4"}`}
          >
            <div
              className="flex items-center gap-1.5 rounded-full px-2.5 py-1"
              style={{
                backgroundColor: "color-mix(in srgb, var(--surface-base) 82%, transparent)",
                border: "1px solid var(--border-base)",
              }}
            >
              <Search size={14} aria-hidden style={{ color: "var(--content-tertiary)" }} />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    setSearch("");
                  }
                }}
                placeholder="Search concepts…"
                aria-label="Search concepts"
                className="w-36 bg-transparent text-[12px] outline-none placeholder:text-[var(--content-tertiary)]"
                style={{ color: "var(--content-default)" }}
              />
              {search ? (
                <>
                  <span
                    className="text-[11px] tabular-nums"
                    style={{ color: "var(--content-tertiary)" }}
                  >
                    {matchIds?.size ?? 0}
                  </span>
                  <button
                    type="button"
                    onClick={() => setSearch("")}
                    aria-label="Clear search"
                    className="flex items-center"
                    style={{ color: "var(--content-tertiary)" }}
                  >
                    <X size={13} />
                  </button>
                </>
              ) : null}
            </div>
          </div>
        ) : null}

        {/* Recency time-lens, tucked just under the search pill. Kept visible
            while a non-"all" window is active even if the graph shrank below the
            threshold (e.g. a refetch), so an active window is always resettable
            — mirrors the search box's own guard. */}
        {layout.nodes.length > SEARCH_MIN_NODES || recency !== "all" ? (
          <div className={`absolute top-14 z-10 ${onToggleFullscreen ? "left-16" : "left-4"}`}>
            <RecencyLens value={recency} onChange={setRecency} />
          </div>
        ) : null}

        <ConceptGraphLegend
          nodeKinds={presentKinds.filter((k) => k !== "concept")}
          coloredByTheme={presentKinds.includes("concept")}
          hasLinks={hasLinks}
          hasLearned={hasLearned}
        />

        {focusLabel && !showIntro ? (
          <div
            className="pointer-events-none absolute left-1/2 top-4 max-w-[80%] -translate-x-1/2 truncate rounded-full px-3 py-1 text-[12px]"
            style={{
              backgroundColor: "color-mix(in srgb, var(--surface-base) 82%, transparent)",
              border: "1px solid var(--border-base)",
              color: "var(--content-default)",
            }}
          >
            {focusLabel}
          </div>
        ) : null}

        <div
          className="pointer-events-none absolute bottom-4 right-4 text-[11px]"
          style={{ color: "var(--content-tertiary)" }}
        >
          drag to rotate · scroll to zoom
        </div>

        {graph?.truncated ? (
          <div
            className="pointer-events-none absolute bottom-4 left-1/2 -translate-x-1/2 rounded-full px-3 py-1 text-[11px]"
            style={{
              backgroundColor: "color-mix(in srgb, var(--surface-base) 82%, transparent)",
              border: "1px solid var(--border-base)",
              color: "var(--content-tertiary)",
            }}
          >
            Showing the {layout.nodes.length} most-connected concepts
          </div>
        ) : null}

        <div data-graph-control className="absolute right-4 top-4 flex flex-col gap-1">
          <Button
            variant="ghost"
            iconOnly={<ZoomIn />}
            onClick={() => zoomBy(1.25)}
            aria-label="Zoom in"
            tooltip="Zoom in"
          />
          <Button
            variant="ghost"
            iconOnly={<ZoomOut />}
            onClick={() => zoomBy(0.8)}
            aria-label="Zoom out"
            tooltip="Zoom out"
          />
          <Button
            variant="ghost"
            iconOnly={<RotateCcw />}
            onClick={resetView}
            aria-label="Reset view"
            tooltip="Reset view"
          />
        </div>
      </>
    );
  }

  return (
    <div
      ref={containerRef}
      className={`relative select-none overflow-hidden rounded-xl ${className ?? ""}`}
      style={{
        backgroundColor: "var(--surface-base)",
        backgroundImage:
          "radial-gradient(circle at center, color-mix(in srgb, var(--content-tertiary) 8%, transparent), transparent 62%)",
        touchAction: "none",
        cursor: ready ? "grab" : "default",
      }}
      onPointerDown={ready ? onPointerDown : undefined}
      onPointerMove={ready ? onPointerMove : undefined}
      onPointerUp={ready ? onPointerUp : undefined}
      onPointerCancel={ready ? onPointerUp : undefined}
      onPointerLeave={ready ? onPointerLeave : undefined}
    >
      {onToggleFullscreen ? (
        <div className="absolute left-4 top-4 z-10" data-graph-control>
          <Button
            variant="ghost"
            iconOnly={isFullscreen ? <Minimize2 /> : <Maximize2 />}
            onClick={onToggleFullscreen}
            aria-label={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
            tooltip={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
          />
        </div>
      ) : null}

      {showIntro ? <ConceptGraphIntroBanner onDismiss={dismissIntro} /> : null}

      {body}

      {ready && openNode ? (
        <ConceptDetailPanel
          assistantId={assistantId}
          node={openNode}
          onClose={() => setOpenNode(null)}
          onOpenThread={onOpenThread}
        />
      ) : null}
    </div>
  );
}
