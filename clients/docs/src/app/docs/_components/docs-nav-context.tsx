"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";

interface DocsNavContextValue {
  /** Whether the mobile nav DOM should be rendered */
  visible: boolean;
  /** Whether the enter animation class should be applied */
  animating: boolean;
  open: () => void;
  close: () => void;
}

const DocsNavContext = createContext<DocsNavContextValue>({
  visible: false,
  animating: false,
  open: () => {},
  close: () => {},
});

export function useDocsNav() {
  return useContext(DocsNavContext);
}

export function DocsNavProvider({ children }: { children: ReactNode }) {
  const [visible, setVisible] = useState(false);
  const [animating, setAnimating] = useState(false);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const open = useCallback(() => {
    if (timeoutRef.current) {clearTimeout(timeoutRef.current);}
    setVisible(true);
    // Trigger enter animation on next frame
    requestAnimationFrame(() => {
      requestAnimationFrame(() => setAnimating(true));
    });
    document.body.style.overflow = "hidden";
  }, []);

  const close = useCallback(() => {
    setAnimating(false);
    document.body.style.overflow = "";
    timeoutRef.current = setTimeout(() => setVisible(false), 250);
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (timeoutRef.current) {clearTimeout(timeoutRef.current);}
      document.body.style.overflow = "";
    };
  }, []);

  return (
    <DocsNavContext value={{ visible, animating, open, close }}>
      {children}
    </DocsNavContext>
  );
}
