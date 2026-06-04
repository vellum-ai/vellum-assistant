
import { ExternalLink, Pin, PinOff, Puzzle } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { cn } from "@/utils/misc";
import { preparePreviewHtml } from "@/utils/sandbox-bridge";
import { Button } from "@vellumai/design-library";

export interface AppCardProps {
  name: string;
  description?: string;
  icon?: string;
  /**
   * Lazy HTML provider. When the card scrolls into view, this is called and
   * the resolved HTML is rendered into a non-interactive sandboxed iframe
   * to act as a live preview thumbnail. Until then (or if it rejects), the
   * `icon` / Puzzle fallback is shown.
   */
  loadHtml?: () => Promise<string>;
  isPinned?: boolean;
  /** Spinner overlay — used while opening the app from a click. */
  isLoading?: boolean;
  /** Disable only the open action while the app is still being built. */
  isOpenDisabled?: boolean;
  /** Show a neutral thumbnail placeholder instead of loading or icon fallback. */
  isPreviewPending?: boolean;
  onOpen?: () => void;
  onPin?: () => void;
}

/**
 * AppCard — a presentational card for displaying an app in a grid.
 *
 * Structure:
 * 1. Thumbnail (16:10) — lazy live mini-iframe of the app, with icon/Puzzle
 *    fallback before it loads or if no `loadHtml` is provided.
 * 2. Text area — name + optional description.
 * 3. Actions row — Open App, Pin/Unpin.
 */
export function AppCard({
  name,
  description,
  icon,
  loadHtml,
  isPinned = false,
  isLoading = false,
  isOpenDisabled = false,
  isPreviewPending = false,
  onOpen,
  onPin,
}: AppCardProps) {
  return (
    <div
      className={cn(
        "flex flex-col gap-2 rounded-xl border border-[var(--border-base)]",
        "bg-[var(--surface-lift)] p-3",
      )}
    >
      <AppPreviewThumbnail
        name={name}
        icon={icon}
        loadHtml={isPreviewPending ? undefined : loadHtml}
        isLoading={isLoading}
        isPreviewPending={isPreviewPending}
      />

      <div className="flex flex-col gap-0.5 px-0.5">
        <span className="flex items-center gap-2 truncate text-body-large-default text-[color:var(--content-emphasised)]">
          {icon ? (
            <span aria-hidden className="leading-none">
              {icon}
            </span>
          ) : null}
          <span className="truncate">{name}</span>
        </span>
        {description ? (
          <span className="truncate text-body-medium-default text-[color:var(--content-secondary)]">
            {description}
          </span>
        ) : null}
      </div>

      <div className="flex items-center gap-1.5 px-0.5">
        <Button
          variant="primary"
          leftIcon={<ExternalLink />}
          onClick={onOpen}
          disabled={isOpenDisabled || onOpen == null}
        >
          Open App
        </Button>
        <Button
          variant="outlined"
          leftIcon={isPinned ? <PinOff /> : <Pin />}
          onClick={onPin}
          disabled={onPin == null}
        >
          {isPinned ? "Unpin" : "Pin"}
        </Button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// AppPreviewThumbnail — lazy live iframe preview, exported for reuse by
// LibraryAppCard and any other surface that needs the same preview block.
// ---------------------------------------------------------------------------

export interface AppPreviewThumbnailProps {
  name: string;
  icon?: string;
  loadHtml?: () => Promise<string>;
  isLoading?: boolean;
  isPreviewPending?: boolean;
  className?: string;
}

export function AppPreviewThumbnail({
  name,
  icon,
  loadHtml,
  isLoading = false,
  isPreviewPending = false,
  className,
}: AppPreviewThumbnailProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [html, setHtml] = useState<string | null>(null);
  const [isVisible, setIsVisible] = useState(false);

  // Defer iframe mount until the card scrolls into view. Browsers without
  // IntersectionObserver simply never load the live preview and stay on the
  // icon/Puzzle fallback — acceptable degradation.
  useEffect(() => {
    if (loadHtml == null) return;
    const el = containerRef.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          setIsVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "200px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [loadHtml]);

  useEffect(() => {
    if (!isVisible || loadHtml == null) return;
    let cancelled = false;
    loadHtml()
      .then((result) => {
        if (!cancelled) setHtml(result);
      })
      .catch(() => {
        // Silent — falls back to icon/Puzzle placeholder.
      });
    return () => {
      cancelled = true;
    };
  }, [isVisible, loadHtml]);

  return (
    <div
      ref={containerRef}
      className={cn(
        "relative aspect-[16/10] w-full overflow-hidden rounded-lg",
        "border border-[var(--border-base)] bg-[var(--surface-base)]",
        className,
      )}
    >
      {/* Fallback layer — always rendered so it shows during iframe paint
          and serves as the placeholder when no html is available. */}
      <div className="absolute inset-0 flex items-center justify-center">
        {isPreviewPending ? null : icon ? (
          <span className="text-4xl">{icon}</span>
        ) : (
          <Puzzle size={32} className="text-[var(--content-tertiary)]" />
        )}
      </div>

      {html != null && (
        // Render the iframe at 2× the container's display size and scale it
        // back down so the app sees a desktop-ish viewport while we show the
        // shrunken result in the thumbnail. Net effect: ~2× more app content
        // visible compared to a 100%×100% iframe.
        <iframe
          srcDoc={preparePreviewHtml(html)}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          title={`${name} preview`}
          aria-hidden="true"
          tabIndex={-1}
          loading="lazy"
          scrolling="no"
          className="absolute left-0 top-0 border-none bg-[var(--surface-base)]"
          style={{
            width: "200%",
            height: "200%",
            transform: "scale(0.5)",
            transformOrigin: "top left",
            pointerEvents: "none",
          }}
        />
      )}

      {isLoading && (
        <div className="absolute inset-0 z-10 flex items-center justify-center bg-[var(--surface-base)]/60 backdrop-blur-sm">
          <div className="h-5 w-5 animate-spin rounded-full border-2 border-[var(--border-base)] border-t-[var(--primary-base)]" />
        </div>
      )}
    </div>
  );
}


