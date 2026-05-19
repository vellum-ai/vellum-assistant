
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

/**
 * Context exposing the live `.app-root` element to descendants.
 *
 * Overlay primitives (Modal, BottomSheet, Popover, Menu, ContextMenu,
 * Dropdown) need to portal into `.app-root` so the theme variables defined
 * there in `appTheme.css` (e.g. `--surface-lift`, `--border-base`) resolve
 * inside the portal. Reading the DOM during render to find that element is
 * unsafe — see the rule in `web/AGENTS.md` ("Don't read the DOM during
 * render"): with React Compiler enabled, the result of a render-time
 * `document.querySelector` can be auto-memoized into the fiber's compile
 * cache and persist across subsequent renders, even after the DOM changes.
 *
 * Subscribing to `useAppRootContainer()` returns the actual element and
 * re-renders when the host `<div>` mounts, with no DOM reads in render.
 */
const AppRootContext = createContext<HTMLElement | null>(null);

/**
 * Provider that renders the host `<div class="app-root">` and shares it via
 * context. Mount this at the top of the signed-in app shell so every
 * descendant primitive can portal into the same theme-scoped element.
 */
export function AppRootProvider({ children }: { children: ReactNode }) {
  // Use a stable `useRef` for the DOM node and `useState` for the published
  // context value. `useEffect` with `[]` runs once after the first commit
  // and copies the live element into state, which triggers a single
  // re-render so consumers receive the resolved container.
  //
  // We deliberately avoid the `ref={setStateSetter}` pattern here. With
  // React Compiler enabled, ref-callback identity can be observed as
  // changing between renders, which causes React 19's cleanup-aware ref
  // contract to fire setter(null) → setter(element) on every commit and
  // produce a "Maximum update depth exceeded" loop in Suspense-wrapped
  // trees. The split ref/state pattern below keeps the ref callback stable
  // and decouples the published value from React's ref reconciliation.
  const ref = useRef<HTMLDivElement | null>(null);
  const [container, setContainer] = useState<HTMLElement | null>(null);

  useEffect(() => {
    setContainer(ref.current);
  }, []);

  return (
    <div ref={ref} className="app-root w-full min-w-0 font-sans">
      <AppRootContext value={container}>
        {children}
      </AppRootContext>
    </div>
  );
}

/**
 * Returns the live `.app-root` element, or `null` when called outside the
 * `<AppRootProvider>` tree (e.g. tests without a wrapper, marketing pages).
 *
 * Callers that need to feed a Radix `Portal` `container` prop should pass
 * `useAppRootContainer() ?? undefined` so Radix falls back to
 * `document.body` when no provider is mounted. Callers that drive
 * `react-dom`'s `createPortal` directly should bail out / render inline
 * when the value is `null`.
 */
export function useAppRootContainer(): HTMLElement | null {
  return useContext(AppRootContext);
}
