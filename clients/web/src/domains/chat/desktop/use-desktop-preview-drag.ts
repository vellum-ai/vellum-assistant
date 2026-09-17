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
  const width = useDesktopPreviewStore.use.width();
  const position = useDesktopPreviewStore.use.position();
  const gesture = useRef<{
    kind: "move" | "resize";
    width: number;
    height: number;
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

  const resize = (
    nextWidth: number,
    start: { width: number; height: number; left: number; top: number },
  ) => {
    const bounds = boundsRef.current;
    if (!bounds) {
      return;
    }
    const chromeHeight = start.height - (start.width * 9) / 16;
    const maxWidth = Math.max(
      0,
      Math.min(
        1000,
        bounds.clientWidth,
        ((bounds.clientHeight - chromeHeight) * 16) / 9,
      ),
    );
    const store = useDesktopPreviewStore.getState();
    const preferredWidth = Math.min(1000, Math.max(320, nextWidth));
    const next = Math.min(maxWidth, preferredWidth);
    const height = (next * 9) / 16 + chromeHeight;
    store.resize(preferredWidth, {
      x: Math.max(
        0,
        Math.min(start.left + start.width - next, bounds.clientWidth - next),
      ),
      y: Math.max(
        0,
        Math.min(start.top + start.height - height, bounds.clientHeight - height),
      ),
    });
  };

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
    const resizing = Boolean(event.target.closest("[data-desktop-resize]"));
    if (resizing) {
      event.currentTarget.setPointerCapture(event.pointerId);
    }
    gesture.current = {
      kind: resizing ? "resize" : "move",
      width: event.currentTarget.offsetWidth,
      height: event.currentTarget.offsetHeight,
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
    if (start.kind === "resize") {
      const delta =
        Math.abs(dx) >= Math.abs((dy * 16) / 9) ? dx : (dy * 16) / 9;
      const nextWidth = start.width - delta;
      resize(
        delta <= 0
          ? Math.max(useDesktopPreviewStore.getState().width, nextWidth)
          : nextWidth,
        start,
      );
    } else {
      move(start.left + dx, start.top + dy);
    }
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

  const onResizeKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const frame = frameRef.current;
    const direction = {
      ArrowLeft: 1,
      ArrowUp: 1,
      ArrowRight: -1,
      ArrowDown: -1,
    }[event.key];
    if (!frame || !direction) {
      return;
    }
    event.preventDefault();
    const currentWidth = useDesktopPreviewStore.getState().width;
    resize(currentWidth + direction * (event.shiftKey ? 40 : 16), {
      width: frame.offsetWidth,
      height: frame.offsetHeight,
      left: frame.offsetLeft,
      top: frame.offsetTop,
    });
  };

  return {
    boundsRef,
    width,
    onResizeKeyDown,
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
