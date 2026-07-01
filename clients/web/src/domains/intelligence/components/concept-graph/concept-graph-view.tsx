import { useQuery } from "@tanstack/react-query";
import { Maximize2, Minimize2, Scan, ZoomIn, ZoomOut } from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";

import { useConstellationViewport } from "@/domains/intelligence/components/constellation-view/use-constellation-viewport";
import { VIRTUAL_CENTER } from "@/domains/intelligence/components/constellation-view/constants";
import { memoryGraphOptions } from "@/domains/intelligence/memory-graph/get-memory-graph";
import { Button } from "@vellumai/design-library";

import { buildForceLayout } from "./build-force-layout";
import { ConceptEdgesLayer } from "./concept-edges-layer";
import { ConceptGraphLegend } from "./concept-graph-legend";
import { ConceptNode } from "./concept-node";
import type { ConceptNodeKind, GraphLayoutNode } from "./types";

const NODE_KIND_ORDER: ConceptNodeKind[] = [
  "concept",
  "skill",
  "capability",
  "other",
];

/** Above this zoom every node shows its label; below it, only hubs / focused
 * nodes do, so a fit-all view stays legible (Obsidian-style). */
const LABEL_ZOOM_THRESHOLD = 1.15;
/** Minimum degree for a node to keep its label when zoomed out. */
const HUB_LABEL_DEGREE = 4;

export interface ConceptGraphViewProps {
  assistantId: string;
  className?: string;
  isFullscreen?: boolean;
  onToggleFullscreen?: () => void;
}

function CenteredMessage({
  title,
  detail,
}: {
  title: string;
  detail?: string;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
      <p
        className="text-body-medium-default"
        style={{ color: "var(--content-default)" }}
      >
        {title}
      </p>
      {detail ? (
        <p
          className="max-w-sm text-body-small-default"
          style={{ color: "var(--content-tertiary)" }}
        >
          {detail}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Obsidian-style force-directed graph of the assistant's memory concepts, wired
 * to the backend-agnostic `GET /memory-graph` endpoint. Reuses the shared
 * constellation viewport (pan/zoom/fit) over a force-laid-out node set. Hovering
 * or tapping a node highlights its neighborhood; the rest dims.
 */
export function ConceptGraphView({
  assistantId,
  className,
  isFullscreen,
  onToggleFullscreen,
}: ConceptGraphViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const query = useQuery(memoryGraphOptions(assistantId));
  const graph = query.data?.kind === "ready" ? query.data.graph : null;

  const { nodes, edges } = useMemo(
    () => (graph ? buildForceLayout(graph) : { nodes: [], edges: [] }),
    [graph],
  );

  const nodeById = useMemo(() => {
    const map = new Map<string, GraphLayoutNode>();
    for (const node of nodes) map.set(node.id, node);
    return map;
  }, [nodes]);

  const dismiss = useCallback(() => setSelectedId(null), []);
  const viewport = useConstellationViewport(
    containerRef,
    nodes,
    nodeById,
    dismiss,
  );

  const activeId = selectedId ?? hoveredId;
  const neighborIds = useMemo(() => {
    if (!activeId) return null;
    const set = new Set<string>([activeId]);
    for (const edge of edges) {
      if (edge.fromId === activeId) set.add(edge.toId);
      if (edge.toId === activeId) set.add(edge.fromId);
    }
    return set;
  }, [activeId, edges]);

  const presentKinds = useMemo(() => {
    const kinds = new Set(nodes.map((n) => n.kind));
    return NODE_KIND_ORDER.filter((k) => kinds.has(k));
  }, [nodes]);
  const hasLearned = useMemo(
    () => edges.some((e) => e.kind === "learned"),
    [edges],
  );
  const hasLinks = useMemo(
    () => edges.some((e) => e.kind !== "learned"),
    [edges],
  );

  const handleSelect = useCallback((id: string) => {
    setSelectedId((prev) => (prev === id ? null : id));
  }, []);

  const offsetX =
    viewport.viewSize.width / 2 -
    VIRTUAL_CENTER.x * viewport.zoom +
    viewport.pan.x;
  const offsetY =
    viewport.viewSize.height / 2 -
    VIRTUAL_CENTER.y * viewport.zoom +
    viewport.pan.y;

  const ready = query.data?.kind === "ready" && nodes.length > 0;

  let body: React.ReactNode;
  if (query.isLoading) {
    body = (
      <div className="flex h-full items-center justify-center">
        <div
          className="h-6 w-6 animate-spin rounded-full border-2"
          style={{
            borderColor: "var(--border-base)",
            borderTopColor: "var(--content-tertiary)",
          }}
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
        detail="As your assistant learns and links ideas, they'll appear here as a living graph of its memory."
      />
    );
  } else {
    body = (
      <>
        {/* Soft central glow. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0"
          style={{
            background:
              "radial-gradient(circle at center, color-mix(in srgb, var(--content-tertiary) 6%, transparent), transparent 60%)",
          }}
        />

        {/* Transformed canvas — shared origin for edges and nodes. */}
        <div
          className="absolute inset-0"
          style={{
            transform: `translate(${offsetX}px, ${offsetY}px) scale(${viewport.zoom})`,
            transformOrigin: "0 0",
            transition: viewport.isAnimating
              ? "transform 0.4s cubic-bezier(0.22, 1, 0.36, 1)"
              : "none",
          }}
        >
          <ConceptEdgesLayer
            edges={edges}
            nodeById={nodeById}
            activeId={activeId}
          />
          {nodes.map((node) => (
            <ConceptNode
              key={node.id}
              node={node}
              active={node.id === activeId}
              dimmed={neighborIds != null && !neighborIds.has(node.id)}
              showLabel={
                viewport.zoom >= LABEL_ZOOM_THRESHOLD ||
                node.degree >= HUB_LABEL_DEGREE ||
                (neighborIds != null && neighborIds.has(node.id))
              }
              onHover={setHoveredId}
              onClick={handleSelect}
            />
          ))}
        </div>

        {graph?.truncated ? (
          <div
            className="pointer-events-none absolute right-4 top-4 rounded-full px-3 py-1 text-[11px]"
            style={{
              backgroundColor:
                "color-mix(in srgb, var(--surface-base) 80%, transparent)",
              border: "1px solid var(--border-base)",
              color: "var(--content-tertiary)",
            }}
          >
            Showing the {nodes.length} most-connected concepts
          </div>
        ) : null}

        <ConceptGraphLegend
          nodeKinds={presentKinds}
          hasLinks={hasLinks}
          hasLearned={hasLearned}
        />

        {/* Viewport controls (bottom-right). */}
        <div
          data-constellation-control
          className="absolute bottom-4 right-4 flex items-center gap-1"
        >
          <Button
            variant="ghost"
            iconOnly={<ZoomIn />}
            onClick={viewport.zoomIn}
            aria-label="Zoom in"
            tooltip="Zoom in"
          />
          <Button
            variant="ghost"
            iconOnly={<ZoomOut />}
            onClick={viewport.zoomOut}
            aria-label="Zoom out"
            tooltip="Zoom out"
          />
          <Button
            variant="ghost"
            iconOnly={<Scan />}
            onClick={viewport.fitAll}
            aria-label="Fit all"
            tooltip="Fit all"
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
          "radial-gradient(circle, color-mix(in srgb, var(--content-tertiary) 20%, transparent) 1px, transparent 1px)",
        backgroundSize: "24px 24px",
        backgroundPosition: "12px 12px",
        touchAction: "none",
        cursor: ready ? (viewport.isDragging ? "grabbing" : "grab") : "default",
        userSelect: "none",
        WebkitUserSelect: "none",
      }}
      onPointerDown={ready ? viewport.handlePointerDown : undefined}
      onPointerMove={ready ? viewport.handlePointerMove : undefined}
      onPointerUp={ready ? viewport.handlePointerUp : undefined}
      onPointerCancel={ready ? viewport.handlePointerUp : undefined}
    >
      {/* Fullscreen toggle (top-left). */}
      {onToggleFullscreen ? (
        <div className="absolute left-4 top-4 z-10" data-constellation-control>
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
    </div>
  );
}
