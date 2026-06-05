import { motion } from "motion/react";
import { useEffect, useMemo, useRef, useState } from "react";

import type { GraphViewData } from "./memory-graph-data";

/**
 * Honest node-link view of a memory graph (JARVIS-1112). Unlike the skill
 * `ConstellationView` — a curated center→category→leaf TREE — a memory graph is
 * peer-to-peer, so this lays nodes out with a small deterministic force
 * simulation and draws the real edges directly. No invented category/center
 * nodes. It deliberately reuses the constellation's chrome (dot-grid canvas,
 * glow, dim/highlight on focus, click-to-traverse, selectable edges) so it
 * still feels like part of the same family.
 *
 * Data is MemoryV2 concept pages: nodes are ConceptPages, edges are their real
 * (unnamed) frontmatter links. Click a node for details; click a link to
 * highlight it. The view fills its container (responsive for a side panel).
 */

const CANVAS_W = 760;
const CANVAS_H = 560;
const NODE_R = 22;

interface MemoryGraphViewProps {
  data: GraphViewData;
  /**
   * When set, only these node ids render (and edges between two visible nodes).
   * Layout still runs over the FULL `data`, so positions are stable and nodes
   * appear in their final spot as the set grows — the "fills in" effect. Omit
   * to show everything.
   */
  revealedIds?: Set<string>;
}

/**
 * Deterministic force-directed layout, then a fit/normalize pass that centers
 * and scales the result to fill the canvas. The fit pass is what guarantees a
 * balanced, framed graph regardless of where the simulation settles. Small N,
 * so O(n²·iters) is fine. No Math.random → stable across renders.
 */
function forceLayout(data: GraphViewData): Map<string, { x: number; y: number }> {
  const nodes = data.nodes;
  const n = nodes.length;
  const pos = new Map<string, { x: number; y: number }>();
  if (n === 0) return pos;

  // Seed on a ring around the origin (we re-center in the fit pass).
  nodes.forEach((nd, i) => {
    const a = (i / n) * 2 * Math.PI;
    pos.set(nd.id, { x: Math.cos(a) * 240, y: Math.sin(a) * 240 });
  });

  const REST = 170;
  const KSPRING = 0.06;
  const KREPEL = 18000;
  const ITERS = 420;

  for (let it = 0; it < ITERS; it++) {
    const disp = new Map(nodes.map((nd) => [nd.id, { x: 0, y: 0 }]));
    // Repulsion between every pair (spreads nodes apart).
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const a = pos.get(nodes[i]!.id)!;
        const b = pos.get(nodes[j]!.id)!;
        let dx = a.x - b.x;
        let dy = a.y - b.y;
        const d2 = Math.max(1, dx * dx + dy * dy);
        const d = Math.sqrt(d2);
        const f = KREPEL / d2;
        dx = (dx / d) * f;
        dy = (dy / d) * f;
        disp.get(nodes[i]!.id)!.x += dx;
        disp.get(nodes[i]!.id)!.y += dy;
        disp.get(nodes[j]!.id)!.x -= dx;
        disp.get(nodes[j]!.id)!.y -= dy;
      }
    }
    // Spring attraction along edges (pulls connected nodes together).
    for (const e of data.edges) {
      const a = pos.get(e.from);
      const b = pos.get(e.to);
      if (!a || !b) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const d = Math.max(0.01, Math.hypot(dx, dy));
      const f = KSPRING * (d - REST);
      const fx = (dx / d) * f;
      const fy = (dy / d) * f;
      disp.get(e.from)!.x += fx;
      disp.get(e.from)!.y += fy;
      disp.get(e.to)!.x -= fx;
      disp.get(e.to)!.y -= fy;
    }
    const cool = 1 - it / ITERS;
    for (const nd of nodes) {
      const p = pos.get(nd.id)!;
      const dsp = disp.get(nd.id)!;
      p.x += Math.max(-24, Math.min(24, dsp.x)) * cool;
      p.y += Math.max(-24, Math.min(24, dsp.y)) * cool;
    }
  }

  // Fit pass: translate + uniform-scale so the settled graph is centered and
  // fills the canvas with padding. This is what makes every graph look balanced.
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  for (const nd of nodes) {
    const p = pos.get(nd.id)!;
    minX = Math.min(minX, p.x);
    maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y);
    maxY = Math.max(maxY, p.y);
  }
  const pad = 90; // room for node radius + label below
  const spanX = Math.max(1, maxX - minX);
  const spanY = Math.max(1, maxY - minY);
  const scale = Math.min(
    (CANVAS_W - 2 * pad) / spanX,
    (CANVAS_H - 2 * pad) / spanY,
    1.6, // don't over-zoom tiny graphs
  );
  const contentW = spanX * scale;
  const contentH = spanY * scale;
  const offX = (CANVAS_W - contentW) / 2;
  const offY = (CANVAS_H - contentH) / 2;
  for (const nd of nodes) {
    const p = pos.get(nd.id)!;
    p.x = offX + (p.x - minX) * scale;
    p.y = offY + (p.y - minY) * scale;
  }
  return pos;
}

export function MemoryGraphView({ data, revealedIds }: MemoryGraphViewProps) {
  const pos = useMemo(() => forceLayout(data), [data]);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [selectedEdgeKey, setSelectedEdgeKey] = useState<string | null>(null);

  const nodeById = useMemo(
    () => new Map(data.nodes.map((nd) => [nd.id, nd])),
    [data],
  );

  const activeSet = useMemo(() => {
    if (focusId) {
      const set = new Set<string>([focusId]);
      for (const e of data.edges) {
        if (e.from === focusId) set.add(e.to);
        if (e.to === focusId) set.add(e.from);
      }
      return set;
    }
    if (selectedEdgeKey) {
      const sep = selectedEdgeKey.indexOf("->");
      if (sep !== -1)
        return new Set([
          selectedEdgeKey.slice(0, sep),
          selectedEdgeKey.slice(sep + 2),
        ]);
    }
    return null;
  }, [focusId, selectedEdgeKey, data]);

  const drawn = useMemo(
    () =>
      data.edges
        .filter(
          (e) =>
            !revealedIds ||
            (revealedIds.has(e.from) && revealedIds.has(e.to)),
        )
        .map((e) => {
          const a = pos.get(e.from);
          const b = pos.get(e.to);
          if (!a || !b) return null;
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const len = Math.hypot(dx, dy) || 1;
          const ux = dx / len;
          const uy = dy / len;
          return {
            key: `${e.from}->${e.to}`,
            from: e.from,
            to: e.to,
            x1: a.x + ux * NODE_R,
            y1: a.y + uy * NODE_R,
            x2: b.x - ux * NODE_R,
            y2: b.y - uy * NODE_R,
          };
        })
        .filter((e): e is NonNullable<typeof e> => e != null),
    [data, pos, revealedIds],
  );

  const focusNode = focusId ? nodeById.get(focusId) : null;

  const clearAll = () => {
    setFocusId(null);
    setSelectedEdgeKey(null);
  };

  const selectEdge = (key: string) => {
    setSelectedEdgeKey((prev) => (prev === key ? null : key));
    setFocusId(null);
  };

  // Responsive scaling: the graph is laid out once in the fixed 760×560 virtual
  // space, then the whole stage (edges + nodes together) is CSS-scaled to fit
  // the container — so it fills any panel width without the coordinate drift a
  // scaling SVG viewBox would introduce.
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState({ w: CANVAS_W, h: CANVAS_H });
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (!rect) return;
      setSize((prev) => {
        const w = Math.round(rect.width);
        const h = Math.round(rect.height);
        return Math.abs(prev.w - w) < 2 && Math.abs(prev.h - h) < 2
          ? prev
          : { w, h };
      });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  const scale = Math.max(0.1, Math.min(size.w / CANVAS_W, size.h / CANVAS_H));

  return (
    <div
      ref={containerRef}
      className="relative h-full w-full overflow-hidden rounded-xl"
      style={{
        backgroundColor: "var(--surface-base)",
        backgroundImage:
          "radial-gradient(circle, color-mix(in srgb, var(--content-tertiary) 20%, transparent) 1px, transparent 1px)",
        backgroundSize: "24px 24px",
        backgroundPosition: "12px 12px",
      }}
      onClick={clearAll}
    >
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(circle at center, color-mix(in srgb, var(--content-tertiary) 6%, transparent), transparent 60%)",
        }}
      />

      {/* Focused-node detail readout (top-left). */}
      {focusNode && (
        <div className="pointer-events-none absolute left-4 top-4 z-10 max-w-[300px]">
          <div className="flex items-center gap-2">
            <span
              className="inline-flex items-center rounded px-1.5 py-0.5 text-label-small-default text-[var(--content-inset)]"
              style={{ backgroundColor: focusNode.color }}
            >
              {focusNode.badge}
            </span>
            <span className="text-title-small text-[var(--content-strong)]">
              {focusNode.label}
            </span>
          </div>
          <p className="mt-1 text-body-small-default text-[var(--content-quiet)]">
            {focusNode.detail}
          </p>
        </div>
      )}

      {/* Scaled stage — svg + nodes share one fixed 760×560 coordinate space and
          are scaled together to fit the container, so lines always land on the
          circles (a scaling viewBox would drift from the raw-pixel node
          positions). */}
      <div
        className="absolute left-1/2 top-1/2"
        style={{
          width: CANVAS_W,
          height: CANVAS_H,
          transform: `translate(-50%, -50%) scale(${scale})`,
          transformOrigin: "center",
        }}
      >
        {/* Edges. */}
        <svg
          className="absolute left-0 top-0"
          width={CANVAS_W}
          height={CANVAS_H}
          fill="none"
        >
        {drawn.map((e) => {
          const incident = focusId != null && (e.from === focusId || e.to === focusId);
          const selected = selectedEdgeKey === e.key;
          const lit = selected || incident;
          const opacity = focusId
            ? incident
              ? 0.95
              : 0.05
            : selectedEdgeKey
              ? selected
                ? 0.95
                : 0.06
              : 0.28;
          const color = lit
            ? nodeById.get(e.from)?.color ?? "var(--content-tertiary)"
            : "var(--content-tertiary)";
          return (
            <g key={e.key}>
              <line
                x1={e.x1}
                y1={e.y1}
                x2={e.x2}
                y2={e.y2}
                stroke="transparent"
                strokeWidth={14}
                style={{ pointerEvents: "stroke", cursor: "pointer" }}
                onClick={(event) => {
                  event.stopPropagation();
                  selectEdge(e.key);
                }}
              />
              <line
                x1={e.x1}
                y1={e.y1}
                x2={e.x2}
                y2={e.y2}
                stroke={color}
                strokeWidth={selected ? 2.6 : lit ? 2 : 1.4}
                opacity={opacity}
                style={{ pointerEvents: "none", transition: "opacity 0.3s ease" }}
              />
            </g>
          );
        })}
      </svg>

      {/* Nodes. Positioning lives on a plain CSS wrapper (so the centering
          translate is never clobbered by motion's scale transform); the circle
          is centered exactly on (p.x, p.y) so edges land on it, and the label is
          absolutely anchored below without affecting that centering. */}
      {data.nodes.map((nd, i) => {
        const p = pos.get(nd.id);
        if (!p) return null;
        if (revealedIds && !revealedIds.has(nd.id)) return null;
        const dimmed = activeSet != null && !activeSet.has(nd.id);
        const isFocus = focusId === nd.id;
        return (
          <div
            key={nd.id}
            className="absolute"
            style={{
              left: p.x,
              top: p.y,
              transform: "translate(-50%, -50%)",
              opacity: dimmed ? 0.16 : 1,
              transition: "opacity 0.3s ease",
            }}
          >
            <motion.button
              type="button"
              title={nd.detail}
              className="block rounded-full"
              style={{
                width: NODE_R * 2,
                height: NODE_R * 2,
                border: `2px solid ${nd.color}`,
                backgroundColor: isFocus
                  ? `color-mix(in srgb, ${nd.color} 24%, var(--surface-lift))`
                  : "var(--surface-lift)",
                boxShadow: isFocus
                  ? `0 0 0 4px color-mix(in srgb, ${nd.color} 18%, transparent)`
                  : "none",
                cursor: "pointer",
              }}
              initial={{ opacity: 0, scale: 0.6 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: 0.4, delay: Math.min(i * 0.03, 0.3) }}
              onClick={(event) => {
                event.stopPropagation();
                setSelectedEdgeKey(null);
                setFocusId((prev) => (prev === nd.id ? null : nd.id));
              }}
            />
            <span
              className="absolute left-1/2 top-full mt-1 -translate-x-1/2 whitespace-nowrap text-label-small-default"
              style={{
                color: isFocus
                  ? "var(--content-strong)"
                  : "var(--content-secondary)",
              }}
            >
              {nd.label}
            </span>
          </div>
        );
      })}
      </div>
    </div>
  );
}
