
import {
    Maximize2,
    Minimize2,
    Scan,
    ZoomIn,
    ZoomOut,
} from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import {
    type MouseEvent as ReactMouseEvent,
    type PointerEvent as ReactPointerEvent,
    useCallback,
    useEffect,
    useLayoutEffect,
    useMemo,
    useRef,
    useState,
} from "react";

import type { SkillInfo } from "@/domains/intelligence/skills/types";
import type { CharacterComponents, CharacterTraits } from "@/types/avatar";
import { Button } from "@vellumai/design-library";

import {
    buildGroups,
    buildTree,
    CENTER_AVATAR_SIZE,
    getCategoryConfig,
    type OrbitItem,
    type TreeNode,
} from "@/domains/intelligence/components/constellation-layout";

import { VIRTUAL_CENTER } from "@/domains/intelligence/components/constellation-view/constants";
import { EdgesLayer } from "@/domains/intelligence/components/constellation-view/edge-line";
import { Legend } from "@/domains/intelligence/components/constellation-view/legend";
import { NodePopover } from "@/domains/intelligence/components/constellation-view/node-popover";
import { NodeView } from "@/domains/intelligence/components/constellation-view/node-view";
import { useConstellationViewport } from "@/domains/intelligence/components/constellation-view/use-constellation-viewport";
import { popoverItemForNode } from "@/domains/intelligence/components/constellation-view/utils";

export interface ConstellationViewProps {
  skills: SkillInfo[];
  components: CharacterComponents | null;
  traits: CharacterTraits | null;
  customImageUrl: string | null;
  className?: string;
  isFullscreen?: boolean;
  onToggleFullscreen?: () => void;
  /** Called when the user activates "View Details" on a skill popover. */
  onSelectSkill?: (skillId: string) => void;
}

export function ConstellationView({
  skills,
  components,
  traits,
  customImageUrl,
  className,
  isFullscreen,
  onToggleFullscreen,
  onSelectSkill,
}: ConstellationViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const [phase, setPhase] = useState<0 | 1 | 2 | 3 | 4>(0);
  const [popoverNodeId, setPopoverNodeId] = useState<string | null>(null);
  const [popoverSize, setPopoverSize] = useState({ width: 240, height: 120 });

  const { nodes, edges } = useMemo(() => {
    const items: OrbitItem[] = skills.map((skill) => ({
      id: skill.id,
      label: skill.name,
      icon: skill.icon,
      emoji: skill.emoji,
      category: skill.category ?? "system",
      description: skill.description,
      kind: "skill" as const,
    }));
    const groups = buildGroups(items);
    return buildTree(VIRTUAL_CENTER, groups, CENTER_AVATAR_SIZE);
  }, [skills]);

  const nodeById = useMemo(() => {
    const map = new Map<string, TreeNode>();
    for (const node of nodes) map.set(node.id, node);
    return map;
  }, [nodes]);

  // Derive popoverItem from popoverNodeId — no separate state needed.
  const popoverItem = useMemo(() => {
    if (popoverNodeId == null) return null;
    const node = nodeById.get(popoverNodeId);
    if (!node) return null;
    return popoverItemForNode(node) ?? null;
  }, [popoverNodeId, nodeById]);

  const dismissPopover = useCallback(() => {
    setPopoverNodeId(null);
  }, []);

  const viewport = useConstellationViewport(
    containerRef,
    nodes,
    nodeById,
    // Dismiss popover when background is clicked
    dismissPopover,
  );

  // Staggered reveal animation driven by skill-count changes.
  const skillCount = skills.length;
  useEffect(() => {
    let cancelled = false;
    const safeSetPhase = (value: 0 | 1 | 2 | 3 | 4) => {
      if (!cancelled) setPhase(value);
    };
    safeSetPhase(0);
    const timers = [
      setTimeout(() => safeSetPhase(1), 100),
      setTimeout(() => safeSetPhase(2), 300),
      setTimeout(() => safeSetPhase(3), 500),
      setTimeout(() => safeSetPhase(4), 700),
    ];
    return () => {
      cancelled = true;
      timers.forEach(clearTimeout);
    };
  }, [skillCount]);

  const togglePopover = useCallback((nodeId: string) => {
    setPopoverNodeId((prev) => (prev === nodeId ? null : nodeId));
  }, []);

  const handleViewDetails = useCallback(() => {
    if (!popoverItem || popoverItem.kind !== "skill") return;
    dismissPopover();
    onSelectSkill?.(popoverItem.id);
  }, [dismissPopover, onSelectSkill, popoverItem]);

  // Dismiss the popover on Escape.
  useEffect(() => {
    if (popoverNodeId == null) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") dismissPopover();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dismissPopover, popoverNodeId]);

  // Measure popover so positioning can clamp to viewport bounds.
  useLayoutEffect(() => {
    if (popoverItem == null) return;
    const el = popoverRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setPopoverSize({ width: rect.width, height: rect.height });
  }, [popoverItem]);

  const viewportCenter = {
    x: viewport.viewSize.width / 2,
    y: viewport.viewSize.height / 2,
  };
  const offsetX = viewportCenter.x - VIRTUAL_CENTER.x * viewport.zoom + viewport.pan.x;
  const offsetY = viewportCenter.y - VIRTUAL_CENTER.y * viewport.zoom + viewport.pan.y;

  // Compute popover position (relative to container) so it hovers above the
  // selected node and stays within viewport bounds.
  const popoverNode = popoverNodeId != null ? nodeById.get(popoverNodeId) : undefined;
  let popoverLeft = 0;
  let popoverTop = 0;
  if (popoverItem != null && popoverNode) {
    const nodeScreenX = offsetX + popoverNode.x * viewport.zoom;
    const nodeScreenY = offsetY + popoverNode.y * viewport.zoom;
    const rawX = nodeScreenX;
    const rawY = nodeScreenY - 60;
    const margin = 8;
    const halfW = popoverSize.width / 2;
    const halfH = popoverSize.height / 2;
    const minX = halfW + margin;
    const maxX = Math.max(minX, viewport.viewSize.width - halfW - margin);
    const minY = halfH + margin;
    const maxY = Math.max(minY, viewport.viewSize.height - halfH - margin);
    popoverLeft = Math.min(Math.max(rawX, minX), maxX);
    popoverTop = Math.min(Math.max(rawY, minY), maxY);
  }

  const handleZoomToNode = useCallback(
    (nodeId: string) => {
      dismissPopover();
      viewport.zoomToNode(nodeId);
    },
    [dismissPopover, viewport],
  );

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
        cursor: viewport.isDragging ? "grabbing" : "grab",
        userSelect: "none",
        WebkitUserSelect: "none",
      }}
      onPointerDown={viewport.handlePointerDown}
      onPointerMove={viewport.handlePointerMove}
      onPointerUp={viewport.handlePointerUp}
      onPointerCancel={viewport.handlePointerUp}
    >
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
        {/* Edges first (below nodes). */}
        <EdgesLayer edges={edges} nodeById={nodeById} visible={phase >= 2} />

        {/* Nodes. */}
        {nodes.map((node, index) => (
          <NodeView
            key={node.id}
            node={node}
            index={index}
            phase={phase}
            components={components}
            traits={traits}
            customImageUrl={customImageUrl}
            isSelected={popoverNodeId === node.id || viewport.zoomedNodeId === node.id}
            onSingleClick={() => togglePopover(node.id)}
            onDoubleClick={() => handleZoomToNode(node.id)}
          />
        ))}
      </div>

      {/* Fullscreen toggle (top-left). */}
      {onToggleFullscreen && (
        <div className="absolute left-4 top-4" data-constellation-control>
          <Button
            variant="ghost"
            iconOnly={isFullscreen ? <Minimize2 /> : <Maximize2 />}
            onClick={onToggleFullscreen}
            aria-label={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
            tooltip={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
          />
        </div>
      )}

      {/* Shape legend (bottom-left). */}
      <Legend visible={phase >= 4} />

      {/* Popover — shown while a node is selected. */}
      <AnimatePresence>
        {popoverItem != null ? (
          <motion.div
            key="constellation-popover"
            ref={popoverRef}
            className="pointer-events-auto absolute z-20"
            data-constellation-popover
            style={{
              left: popoverLeft,
              top: popoverTop,
              transform: "translate(-50%, -50%)",
            }}
            initial={{ opacity: 0, scale: 0.9 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.9 }}
            transition={{ duration: 0.15, ease: "easeOut" }}
            onPointerDown={(event: ReactPointerEvent) => event.stopPropagation()}
            onClick={(event: ReactMouseEvent) => event.stopPropagation()}
          >
            <NodePopover
              item={popoverItem}
              color={getCategoryConfig(popoverItem.category).color}
              onViewDetails={
                onSelectSkill && popoverItem.kind === "skill"
                  ? handleViewDetails
                  : undefined
              }
            />
          </motion.div>
        ) : null}
      </AnimatePresence>

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
    </div>
  );
}
