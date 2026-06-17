
import {
  type PointerEvent as ReactPointerEvent,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { computeFit, type TreeNode } from "@/domains/intelligence/components/constellation-layout";

import { MAX_ZOOM, MIN_ZOOM, VIRTUAL_CENTER, ZOOM_STEP } from "@/domains/intelligence/components/constellation-view/constants";

interface ViewportState {
  zoom: number;
  pan: { x: number; y: number };
  isDragging: boolean;
  isAnimating: boolean;
  viewSize: { width: number; height: number };
  zoomedNodeId: string | null;
}

interface ViewportActions {
  zoomIn: () => void;
  zoomOut: () => void;
  fitAll: () => void;
  zoomToNode: (nodeId: string) => void;
  handlePointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
  handlePointerMove: (event: ReactPointerEvent<HTMLDivElement>) => void;
  handlePointerUp: (event: ReactPointerEvent<HTMLDivElement>) => void;
}

/**
 * Manages all pan/zoom/drag viewport state for the constellation canvas.
 * Extracts ~150 lines of interaction logic from the main component.
 */
export function useConstellationViewport(
  containerRef: RefObject<HTMLDivElement | null>,
  nodes: TreeNode[],
  nodeById: Map<string, TreeNode>,
  onBackgroundPointerDown?: () => void,
): ViewportState & ViewportActions {
  const [viewSize, setViewSize] = useState({ width: 0, height: 0 });
  const [userZoom, setUserZoom] = useState<number | null>(null);
  const [userPan, setUserPan] = useState<{ x: number; y: number } | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [zoomedNodeId, setZoomedNodeId] = useState<string | null>(null);
  const [isAnimating, setIsAnimating] = useState(false);
  const animationResetRef = useRef<number | null>(null);

  const dragRef = useRef<{
    startX: number;
    startY: number;
    panStartX: number;
    panStartY: number;
    pointerId: number;
    moved: boolean;
  } | null>(null);

  // Observe container size.
  useLayoutEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        setViewSize({ width, height });
      }
    });
    observer.observe(el);
    const rect = el.getBoundingClientRect();
    setViewSize({ width: rect.width, height: rect.height });
    return () => observer.disconnect();
  }, [containerRef]);

  // Baseline fit — recomputed whenever nodes or view size change.
  const baseline = useMemo(
    () => computeFit(nodes, VIRTUAL_CENTER, viewSize.width, viewSize.height),
    [nodes, viewSize.width, viewSize.height],
  );

  const zoom = userZoom ?? baseline.zoom;
  const pan = userPan ?? { x: baseline.panX, y: baseline.panY };

  const triggerAnimation = useCallback(() => {
    setIsAnimating(true);
    if (animationResetRef.current != null) {
      window.clearTimeout(animationResetRef.current);
    }
    animationResetRef.current = window.setTimeout(() => {
      setIsAnimating(false);
      animationResetRef.current = null;
    }, 500);
  }, []);

  useEffect(() => {
    return () => {
      if (animationResetRef.current != null) {
        window.clearTimeout(animationResetRef.current);
      }
    };
  }, []);

  const fitAll = useCallback(() => {
    setUserZoom(null);
    setUserPan(null);
    setZoomedNodeId(null);
    triggerAnimation();
  }, [triggerAnimation]);

  const applyZoom = useCallback(
    (nextZoom: number, options?: { animate?: boolean }) => {
      const clamped = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, nextZoom));
      if (clamped === zoom) return;
      const scale = clamped / zoom;
      setUserPan({ x: pan.x * scale, y: pan.y * scale });
      setUserZoom(clamped);
      setZoomedNodeId(null);
      if (options?.animate) {
        triggerAnimation();
      }
    },
    [pan.x, pan.y, triggerAnimation, zoom],
  );

  const zoomIn = useCallback(() => {
    applyZoom(zoom + ZOOM_STEP, { animate: true });
  }, [applyZoom, zoom]);

  const zoomOut = useCallback(() => {
    applyZoom(zoom - ZOOM_STEP, { animate: true });
  }, [applyZoom, zoom]);

  const zoomToNode = useCallback(
    (nodeId: string) => {
      if (zoomedNodeId === nodeId) {
        fitAll();
        return;
      }
      const node = nodeById.get(nodeId);
      if (!node) return;
      const targetZoom = 1.8;
      setUserZoom(targetZoom);
      setUserPan({
        x: (VIRTUAL_CENTER.x - node.x) * targetZoom,
        y: (VIRTUAL_CENTER.y - node.y) * targetZoom,
      });
      setZoomedNodeId(nodeId);
      triggerAnimation();
    },
    [fitAll, nodeById, triggerAnimation, zoomedNodeId],
  );

  // Native wheel listener with { passive: false } so preventDefault suppresses
  // browser's Ctrl+scroll page zoom.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const handler = (event: WheelEvent) => {
      event.preventDefault();
      const divisor = event.ctrlKey || event.metaKey ? 150 : 400;
      const delta = -event.deltaY / divisor;
      applyZoom(zoom * (1 + delta));
    };
    el.addEventListener("wheel", handler, { passive: false });
    return () => el.removeEventListener("wheel", handler);
  }, [applyZoom, containerRef, zoom]);

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      const target = event.target as HTMLElement;
      if (target.closest("[data-constellation-control]")) return;
      if (!target.closest("[data-constellation-node]")) {
        onBackgroundPointerDown?.();
      }
      dragRef.current = {
        startX: event.clientX,
        startY: event.clientY,
        panStartX: pan.x,
        panStartY: pan.y,
        pointerId: event.pointerId,
        moved: false,
      };
      setIsDragging(true);
      if (animationResetRef.current != null) {
        window.clearTimeout(animationResetRef.current);
        animationResetRef.current = null;
      }
      setIsAnimating(false);
      (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    },
    [onBackgroundPointerDown, pan.x, pan.y],
  );

  const handlePointerMove = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (!drag.moved && (Math.abs(dx) > 3 || Math.abs(dy) > 3)) {
      drag.moved = true;
      setZoomedNodeId(null);
    }
    setUserPan({
      x: drag.panStartX + dx,
      y: drag.panStartY + dy,
    });
  }, []);

  const handlePointerUp = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setIsDragging(false);
    try {
      (event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
    } catch {
      // Ignore if capture was already released.
    }
  }, []);

  return {
    zoom,
    pan,
    isDragging,
    isAnimating,
    viewSize,
    zoomedNodeId,
    zoomIn,
    zoomOut,
    fitAll,
    zoomToNode,
    handlePointerDown,
    handlePointerMove,
    handlePointerUp,
  };
}
