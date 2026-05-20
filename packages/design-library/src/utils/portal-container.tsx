import { createContext, useContext, type ReactNode } from "react";

/**
 * Context for configuring where portaled content (popovers, modals, menus,
 * dropdowns, bottom sheets, etc.) renders in the DOM.
 *
 * Design systems need portal containers to ensure overlays render inside a
 * theme-scoped element so CSS variables resolve correctly. Without this,
 * portaling to `document.body` loses access to scoped design tokens.
 *
 * **Pattern precedent:** Chakra UI (`PortalManager`), Blueprint
 * (`PortalProvider`), react-md (`PortalContainerProvider`), and Ark UI
 * (`EnvironmentProvider`) all use this same context-based approach.
 *
 * @see https://www.radix-ui.com/primitives/docs/utilities/portal
 * @see https://github.com/palantir/blueprint/pull/6260
 * @see https://react-md.dev/components/portal-container-provider
 */
const PortalContainerContext = createContext<HTMLElement | null>(null);

export interface PortalContainerProviderProps {
  /** The DOM element that portaled content should render into. */
  container: HTMLElement | null;
  children: ReactNode;
}

/**
 * Provides a portal target element to all descendant design library
 * components that render overlays (Popover, Modal, Menu, etc.).
 *
 * Overlay components read this context internally and fall back to
 * `document.body` when no provider is mounted. Because theme tokens are
 * defined on `:root` (scoped via `data-theme` on `<html>`), the default
 * `document.body` target already has access to design tokens, so most
 * apps don't need to mount this provider at the top level.
 *
 * The primary use case is nesting — an inner provider overrides the
 * outer one for its subtree, which is useful for rendering overlays
 * inside dialogs (so menus opened from within a modal portal into the
 * modal rather than escaping to `document.body`) or shadow DOM.
 *
 * ```tsx
 * function Dialog({ children }: { children: ReactNode }) {
 *   const ref = useRef<HTMLDivElement>(null);
 *   const [container, setContainer] = useState<HTMLElement | null>(null);
 *   useEffect(() => { setContainer(ref.current); }, []);
 *
 *   return (
 *     <div ref={ref} role="dialog">
 *       <PortalContainerProvider container={container}>
 *         {children}
 *       </PortalContainerProvider>
 *     </div>
 *   );
 * }
 * ```
 */
function PortalContainerProvider({
  container,
  children,
}: PortalContainerProviderProps) {
  return (
    <PortalContainerContext value={container}>
      {children}
    </PortalContainerContext>
  );
}

/**
 * Returns the nearest portal container element, or `null` when called
 * outside a `<PortalContainerProvider>`.
 *
 * Overlay components pass the result to Radix's `Portal` `container`
 * prop (coerced to `undefined` so Radix falls back to `document.body`
 * when no provider is mounted):
 *
 * ```tsx
 * const container = usePortalContainer();
 * <RadixPopover.Portal container={container ?? undefined}>
 * ```
 */
function usePortalContainer(): HTMLElement | null {
  return useContext(PortalContainerContext);
}

export { PortalContainerProvider, usePortalContainer };
