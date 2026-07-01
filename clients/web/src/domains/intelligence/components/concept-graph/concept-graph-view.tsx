import { useQuery } from "@tanstack/react-query";
import { Maximize2, Minimize2, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { VIRTUAL_CENTER } from "@/domains/intelligence/components/constellation-view/constants";
import { memoryGraphOptions } from "@/domains/intelligence/memory-graph/get-memory-graph";
import { Button } from "@vellumai/design-library";

import { buildForceLayout } from "./build-force-layout";
import { ConceptDetailPanel, type ConceptDetailNode } from "./concept-detail-panel";
import { ConceptGraphLegend } from "./concept-graph-legend";
import { NODE_KIND_COLORS } from "./constants";
import type { ConceptNodeKind, GraphLayoutNode } from "./types";

const NODE_KIND_ORDER: ConceptNodeKind[] = [
  "concept",
  "skill",
  "capability",
  "other",
];
/** amber, matches EDGE_LEARNED_COLOR in constants — used with canvas globalAlpha. */
const EDGE_LEARNED_RGB = "rgb(233, 162, 59)";

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

interface Projected {
  id: string;
  sx: number;
  sy: number;
  sr: number;
  depth: number; // 0 (far) .. 1 (near)
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
    if (layout.nodes.length === 0) return 1;
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
    selectedId: null as string | null,
    dragging: false,
    moved: false,
    lastX: 0,
    lastY: 0,
    lastInteractAt: -Infinity,
  });
  const projectedRef = useRef<Projected[]>([]);
  const colorsRef = useRef<Colors>({ content: "#e5e7eb", tertiary: "#8792a0" });

  // Bumped only when the focused node changes, so the DOM tooltip re-renders.
  // The canvas itself never needs React state.
  const [focusLabel, setFocusLabel] = useState<string | null>(null);
  // The concept opened into the detail drawer (null = graph only).
  const [openNode, setOpenNode] = useState<ConceptDetailNode | null>(null);

  const labelFor = useCallback(
    (id: string | null): string | null => {
      if (!id) return null;
      const node = layout.nodes.find((n) => n.id === id);
      if (!node) return null;
      return node.summary ? `${node.label} — ${node.summary}` : node.label;
    },
    [layout.nodes],
  );

  const resetView = useCallback(() => {
    const v = view.current;
    v.yaw = 0.5;
    v.pitch = 0.32;
    v.zoom = 1;
    v.selectedId = null;
    v.lastInteractAt = -Infinity;
    setFocusLabel(null);
  }, []);

  useEffect(() => {
    if (!ready) return;
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    // Capture the current layout for the loop; the effect re-runs (cancelling
    // this loop) whenever the data changes, so these never go stale.
    const nodes = layout.nodes;
    const edges = layout.edges;
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

      const idle = !v.dragging && t - v.lastInteractAt > IDLE_RESUME_MS;
      if (idle && !reduceMotion) v.yaw += AUTO_YAW_PER_SEC * dt;

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

      const activeId = v.selectedId ?? v.hoveredId;
      const neighbors = activeId ? adj.get(activeId) : undefined;
      const isLit = (id: string) =>
        !activeId || id === activeId || (neighbors?.has(id) ?? false);

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
      for (const p of proj) posById.set(p.node.id, p);

      // Edges (behind nodes).
      ctx.lineCap = "round";
      for (const e of edges) {
        const a = posById.get(e.fromId);
        const b = posById.get(e.toId);
        if (!a || !b) continue;
        const learned = e.kind === "learned";
        const incident = activeId != null && (e.fromId === activeId || e.toId === activeId);
        const depth = (a.depth + b.depth) / 2;
        let alpha = (learned ? 0.34 : 0.28) * (0.4 + 0.6 * depth);
        if (activeId != null) alpha = incident ? 0.9 : isLit(e.fromId) && isLit(e.toId) ? alpha : 0.05;
        ctx.globalAlpha = alpha;
        ctx.strokeStyle = learned ? EDGE_LEARNED_RGB : colors.tertiary;
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
        const color = NODE_KIND_COLORS[node.kind];
        const lit = isLit(node.id);
        const isActive = node.id === activeId;
        const depthA = DEPTH_ALPHA_MIN + (1 - DEPTH_ALPHA_MIN) * p.depth;
        const alpha = lit ? depthA : depthA * 0.18;

        const glow = (isActive ? 16 : node.degree >= HUB_LABEL_DEGREE ? 8 : 4) * p.depth;
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
        const showLabel =
          activeId != null
            ? isLit(node.id)
            : node.degree >= HUB_LABEL_DEGREE && p.depth > 0.55;
        if (!showLabel) continue;
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
      }));

      raf = requestAnimationFrame(render);
    };
    raf = requestAnimationFrame(render);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [ready, layout, adjacency, massRadius]);

  // Nearest node under a screen point; nearest-in-front wins.
  const hitTest = useCallback((x: number, y: number): string | null => {
    let best: string | null = null;
    let bestDepth = -1;
    for (const p of projectedRef.current) {
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
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest("[data-graph-control]")) return;
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
        if (Math.abs(dx) > 2 || Math.abs(dy) > 2) v.moved = true;
        v.yaw += dx * DRAG_SENSITIVITY;
        v.pitch = Math.max(-PITCH_CLAMP, Math.min(PITCH_CLAMP, v.pitch + dy * DRAG_SENSITIVITY));
        v.lastX = e.clientX;
        v.lastY = e.clientY;
        v.lastInteractAt = performance.now();
        return;
      }
      const { x, y } = localPoint(e);
      const hit = hitTest(x, y);
      if (hit !== v.hoveredId) {
        v.hoveredId = hit;
        if (v.selectedId == null) setFocusLabel(labelFor(hit));
      }
    },
    [hitTest, labelFor],
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const v = view.current;
      if (!v.dragging) return;
      v.dragging = false;
      v.lastInteractAt = performance.now();
      try {
        (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
      } catch {
        /* already released */
      }
      if (!v.moved) {
        const { x, y } = localPoint(e);
        const hit = hitTest(x, y);
        if (hit) {
          // Click a node → open its concept page in the detail drawer.
          const n = layout.nodes.find((nn) => nn.id === hit);
          if (n) setOpenNode({ id: n.id, label: n.label, updatedAtMs: n.updatedAtMs });
        } else {
          v.selectedId = null;
          setFocusLabel(null);
        }
      }
    },
    [hitTest, layout.nodes],
  );

  useEffect(() => {
    const el = containerRef.current;
    if (!el || !ready) return;
    const onWheel = (e: WheelEvent) => {
      // Let the detail drawer scroll natively instead of zooming the graph.
      if ((e.target as HTMLElement).closest?.("[data-graph-panel]")) return;
      e.preventDefault();
      const v = view.current;
      v.zoom = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, v.zoom * (1 - e.deltaY / 500)));
      v.lastInteractAt = performance.now();
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

        <ConceptGraphLegend
          nodeKinds={presentKinds.length > 1 ? presentKinds : []}
          hasLinks={hasLinks}
          hasLearned={hasLearned}
        />

        {focusLabel ? (
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

        <div data-graph-control className="absolute right-4 top-4">
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

      {body}

      {ready && openNode ? (
        <ConceptDetailPanel
          assistantId={assistantId}
          node={openNode}
          onClose={() => setOpenNode(null)}
        />
      ) : null}
    </div>
  );
}
