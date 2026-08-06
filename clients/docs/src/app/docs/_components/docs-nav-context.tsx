"use client";

import { usePathname } from "next/navigation";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";

import { lockBodyScroll, unlockBodyScroll } from "@/app/docs/_components/body-scroll-lock";

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
  const holdsLockRef = useRef(false);
  const pathname = usePathname();
  const previousPathnameRef = useRef(pathname);

  const open = useCallback(() => {
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
    }
    setVisible(true);
    // Trigger enter animation on next frame
    requestAnimationFrame(() => {
      requestAnimationFrame(() => setAnimating(true));
    });
    if (!holdsLockRef.current) {
      holdsLockRef.current = true;
      lockBodyScroll();
    }
  }, []);

  const close = useCallback(() => {
    setAnimating(false);
    // close() also fires on route/hash/breakpoint changes while the drawer is
    // already closed; only release a lock this provider actually holds.
    if (holdsLockRef.current) {
      holdsLockRef.current = false;
      unlockBodyScroll();
    }
    timeoutRef.current = setTimeout(() => setVisible(false), 250);
  }, []);

  // Close the drawer on any route change, including navigations that do not
  // pass through a nav link (e.g. selecting a search result).
  useEffect(() => {
    if (previousPathnameRef.current === pathname) {
      return;
    }
    previousPathnameRef.current = pathname;
    close();
  }, [close, pathname]);

  // Same-path anchor navigations (search results link to #section anchors on
  // the current page) never change the pathname, so also close on hash change.
  useEffect(() => {
    window.addEventListener("hashchange", close);
    return () => window.removeEventListener("hashchange", close);
  }, [close]);

  // The drawer markup is md:hidden, so if the viewport is resized or rotated
  // past the md breakpoint while the drawer is open, the drawer (and its close
  // button) disappears while body scroll stays locked. Close on crossing.
  useEffect(() => {
    // 48rem matches Tailwind's md breakpoint even under non-16px root font sizes.
    const mql = window.matchMedia("(min-width: 48rem)");
    const handleChange = (event: MediaQueryListEvent) => {
      if (event.matches) {
        close();
      }
    };
    mql.addEventListener("change", handleChange);
    return () => mql.removeEventListener("change", handleChange);
  }, [close]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
      if (holdsLockRef.current) {
        holdsLockRef.current = false;
        unlockBodyScroll();
      }
    };
  }, []);

  return (
    <DocsNavContext value={{ visible, animating, open, close }}>
      {children}
    </DocsNavContext>
  );
}
