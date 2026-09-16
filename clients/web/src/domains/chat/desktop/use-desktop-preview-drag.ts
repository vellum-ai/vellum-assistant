import {
  useCallback,
  useLayoutEffect,
  useRef,
  type KeyboardEvent,
  type PointerEvent,
  type MouseEvent,
} from "react";

import { useDesktopPreviewStore } from "./desktop-preview-store";

export function useDesktopPreviewDrag() {
  const boundsRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLElement>(null);
  const position = useDesktopPreviewStore.use.position();
  const gesture = useRef<{
    id: number;
    x: number;
    y: number;
    left: number;
    top: number;
  } | null>(null);
  const dragged = useRef(false);

  const move = useCallback((x: number, y: number) => {
    const bounds = boundsRef.current;
    const frame = frameRef.current;
    if (!bounds || !frame) {
      return;
    }
    const next = {
      x: Math.max(0, Math.min(x, bounds.clientWidth - frame.offsetWidth)),
      y: Math.max(0, Math.min(y, bounds.clientHeight - frame.offsetHeight)),
    };
    const current = useDesktopPreviewStore.getState().position;
    if (current?.x !== next.x || current?.y !== next.y) {
      useDesktopPreviewStore.getState().setPosition(next);
    }
  }, []);

  useLayoutEffect(() => {
    const keepInBounds = () => {
      const current = useDesktopPreviewStore.getState().position;
      if (current) {
        move(current.x, current.y);
      }
    };
    keepInBounds();
    const observer = new ResizeObserver(keepInBounds);
    if (boundsRef.current) {
      observer.observe(boundsRef.current);
    }
    if (frameRef.current) {
      observer.observe(frameRef.current);
    }
    return () => observer.disconnect();
  }, [move]);

  const onPointerDownCapture = (event: PointerEvent<HTMLElement>) => {
    if (
      event.button !== 0 ||
      !event.isPrimary ||
      !(event.target instanceof Element) ||
      !event.currentTarget.contains(event.target)
    ) {
      return;
    }
    dragged.current = false;
    if (event.target.closest("[data-desktop-close]")) {
      return;
    }
    gesture.current = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      left: event.currentTarget.offsetLeft,
      top: event.currentTarget.offsetTop,
    };
  };
  const onPointerMove = (event: PointerEvent<HTMLElement>) => {
    const start = gesture.current;
    if (!start || start.id !== event.pointerId) {
      return;
    }
    if ((event.buttons & 1) === 0) {
      gesture.current = null;
      return;
    }
    const dx = event.clientX - start.x;
    const dy = event.clientY - start.y;
    if (!dragged.current && Math.hypot(dx, dy) < 5) {
      return;
    }
    dragged.current = true;
    event.currentTarget.setPointerCapture(event.pointerId);
    move(start.left + dx, start.top + dy);
  };
  const endGesture = () => {
    gesture.current = null;
  };
  const onClickCapture = (event: MouseEvent<HTMLElement>) => {
    if (
      dragged.current &&
      event.detail !== 0 &&
      event.currentTarget.contains(event.target as Node)
    ) {
      event.preventDefault();
      event.stopPropagation();
    }
  };
  const onMoveKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const frame = frameRef.current;
    if (!frame) {
      return;
    }
    const step = event.shiftKey ? 40 : 16;
    const delta = {
      ArrowLeft: [-step, 0],
      ArrowRight: [step, 0],
      ArrowUp: [0, -step],
      ArrowDown: [0, step],
    }[event.key];
    if (delta) {
      event.preventDefault();
      move(frame.offsetLeft + delta[0], frame.offsetTop + delta[1]);
    }
  };

  return {
    boundsRef,
    frameRef,
    position,
    onPointerDownCapture,
    onPointerMove,
    onPointerUp: endGesture,
    onPointerCancel: endGesture,
    onLostPointerCapture: endGesture,
    onClickCapture,
    onMoveKeyDown,
  };
}
