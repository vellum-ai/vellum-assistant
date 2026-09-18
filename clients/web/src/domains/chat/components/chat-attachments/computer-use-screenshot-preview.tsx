import { Loader2 } from "lucide-react";
import { useReducedMotion } from "motion/react";
import {
  type FC,
  type MouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { AttachmentDownloadOverlay } from "@/domains/chat/components/chat-attachments/attachment-download-overlay";
import { AttachmentPreviewBox } from "@/domains/chat/components/chat-attachments/attachment-preview-box";
import {
  downloadAttachment,
  fetchAttachmentContentBlob,
} from "@/domains/chat/components/chat-attachments/download-attachment";
import { useAttachmentPreview } from "@/domains/chat/components/chat-attachments/use-attachment-preview";
import type { ToolResultImage } from "@/domains/chat/components/chat-attachments/tool-result-images";
import { useTranslation } from "@/i18n";

const FADE_DURATION_MS = 150;

interface ReadyScreenshot {
  attachment: ToolResultImage;
  occurrenceKey: string;
  ownsSrc: boolean;
  src: string;
}

type TransitionPhase = "empty" | "loading" | "fading" | "ready" | "error";

interface TransitionView {
  displayed: ReadyScreenshot | null;
  fadeStarted: boolean;
  incoming: ReadyScreenshot | null;
  phase: TransitionPhase;
  scopeKey: string;
}

interface ReferenceLoad {
  blob: Blob | null;
  error: boolean;
  key: string;
}

export interface ComputerUseScreenshotTransition {
  displayed: ReadyScreenshot | null;
  fadeStarted: boolean;
  incoming: ReadyScreenshot | null;
  phase: TransitionPhase;
  targetOccurrenceKey?: string;
  finishFade: () => void;
  openPreview: (trigger: HTMLElement | null) => void;
  previewModal: ReactNode;
}

function emptyView(scopeKey: string): TransitionView {
  return {
    displayed: null,
    fadeStarted: false,
    incoming: null,
    phase: "empty",
    scopeKey,
  };
}

function decodeImage(src: string): Promise<void> {
  const image = new Image();
  image.src = src;
  if (typeof image.decode === "function") {
    return image.decode();
  }
  return new Promise((resolve, reject) => {
    image.onload = () => resolve();
    image.onerror = () => reject(new Error("Failed to decode screenshot"));
  });
}

function disposeScreenshot(screenshot: ReadyScreenshot | null): void {
  if (screenshot?.ownsSrc) {
    URL.revokeObjectURL(screenshot.src);
  }
}

/**
 * Prepares the logically latest computer-use screenshot without removing the
 * last decoded frame. The returned view is message-scoped and can be rendered
 * under whichever activity group currently owns the selected tool call.
 */
export function useComputerUseScreenshotTransition({
  assistantId,
  scopeKey,
  target,
}: {
  assistantId?: string | null;
  scopeKey: string;
  target?: ToolResultImage;
}): ComputerUseScreenshotTransition {
  const reduceMotion = Boolean(useReducedMotion());
  const [view, setView] = useState<TransitionView>(() => emptyView(scopeKey));
  const [preparation, setPreparation] = useState(() => ({ scopeKey, target }));
  const [referenceLoad, setReferenceLoad] = useState<ReferenceLoad | null>(
    null,
  );
  const viewRef = useRef(view);
  const generationRef = useRef(0);
  const activeOccurrenceRef = useRef(target?.occurrenceKey);
  const latestTargetRef = useRef(target);

  const setCurrentView = useCallback((next: TransitionView) => {
    viewRef.current = next;
    setView(next);
  }, []);
  const finishFade = useCallback(() => {
    const current = viewRef.current;
    if (!current.incoming || !current.fadeStarted) {
      return;
    }
    const previous = current.displayed;
    setCurrentView({
      ...current,
      displayed: current.incoming,
      fadeStarted: false,
      incoming: null,
      phase: "ready",
    });
    disposeScreenshot(previous);
  }, [setCurrentView]);

  const scopedView = view.scopeKey === scopeKey ? view : emptyView(scopeKey);
  const targetOccurrenceKey = target?.occurrenceKey;
  const preparationTarget =
    preparation.scopeKey === scopeKey &&
    preparation.target?.occurrenceKey === targetOccurrenceKey
      ? preparation.target
      : target;
  const displayedMatchesTarget =
    scopedView.displayed?.occurrenceKey === targetOccurrenceKey;
  const targetNeedsFetch =
    preparationTarget !== undefined &&
    preparationTarget.previewUrl === null &&
    !displayedMatchesTarget &&
    !!assistantId &&
    !!preparationTarget.id &&
    !preparationTarget.id.startsWith("rehydrated:");
  const targetCannotLoad =
    preparationTarget !== undefined &&
    preparationTarget.previewUrl === null &&
    !displayedMatchesTarget &&
    !targetNeedsFetch;
  const referenceKey = targetNeedsFetch
    ? `${scopeKey}:${targetOccurrenceKey}:${preparationTarget.id}`
    : null;
  const referenceAttachmentId = targetNeedsFetch ? preparationTarget.id : null;
  const loadedReference =
    referenceLoad?.key === referenceKey ? referenceLoad : null;

  useLayoutEffect(() => {
    latestTargetRef.current = target;
  }, [target]);

  useEffect(() => {
    if (!referenceKey || !assistantId || !referenceAttachmentId) {
      return;
    }
    let cancelled = false;
    setReferenceLoad({ blob: null, error: false, key: referenceKey });
    void fetchAttachmentContentBlob(assistantId, referenceAttachmentId).then(
      (blob) => {
        if (!cancelled) {
          setReferenceLoad({
            blob,
            error: blob === null,
            key: referenceKey,
          });
        }
      },
      () => {
        if (!cancelled) {
          setReferenceLoad({ blob: null, error: true, key: referenceKey });
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [assistantId, referenceAttachmentId, referenceKey]);

  useLayoutEffect(() => {
    const current = viewRef.current;
    if (current.scopeKey === scopeKey) {
      return;
    }
    generationRef.current += 1;
    disposeScreenshot(current.displayed);
    disposeScreenshot(current.incoming);
    activeOccurrenceRef.current = targetOccurrenceKey;
    setPreparation({ scopeKey, target });
    setCurrentView(emptyView(scopeKey));
  }, [scopeKey, setCurrentView, target, targetOccurrenceKey]);

  useLayoutEffect(() => {
    const current =
      viewRef.current.scopeKey === scopeKey
        ? viewRef.current
        : emptyView(scopeKey);
    if (!target || !targetOccurrenceKey) {
      generationRef.current += 1;
      activeOccurrenceRef.current = undefined;
      disposeScreenshot(current.displayed);
      disposeScreenshot(current.incoming);
      setCurrentView(emptyView(scopeKey));
      return;
    }

    if (activeOccurrenceRef.current !== targetOccurrenceKey) {
      generationRef.current += 1;
      activeOccurrenceRef.current = targetOccurrenceKey;
      setPreparation({ scopeKey, target });
      disposeScreenshot(current.incoming);
      setCurrentView({
        ...current,
        fadeStarted: false,
        incoming: null,
        phase: "loading",
      });
      return;
    }

    if (current.displayed?.occurrenceKey === targetOccurrenceKey) {
      generationRef.current += 1;
      disposeScreenshot(current.incoming);
      setCurrentView({
        ...current,
        displayed: { ...current.displayed, attachment: target },
        fadeStarted: false,
        incoming: null,
        phase: "ready",
      });
      return;
    }

    if (
      targetCannotLoad ||
      loadedReference?.error ||
      current.phase === "empty"
    ) {
      setCurrentView({
        ...current,
        fadeStarted: false,
        phase: targetCannotLoad || loadedReference?.error ? "error" : "loading",
      });
    }
  }, [
    loadedReference?.error,
    scopeKey,
    setCurrentView,
    target,
    targetCannotLoad,
    targetOccurrenceKey,
  ]);

  useEffect(() => {
    if (!preparationTarget || !targetOccurrenceKey || displayedMatchesTarget) {
      return;
    }

    let src: string | null = preparationTarget.previewUrl;
    let ownsSrc = false;
    if (!src && loadedReference?.blob) {
      src = URL.createObjectURL(loadedReference.blob);
      ownsSrc = true;
    }
    if (!src) {
      return;
    }

    const generation = ++generationRef.current;
    let handedOff = false;
    let cancelled = false;
    let released = false;
    const releaseCandidate = () => {
      if (ownsSrc && !released) {
        released = true;
        URL.revokeObjectURL(src);
      }
    };
    void decodeImage(src).then(
      () => {
        if (
          cancelled ||
          generationRef.current !== generation ||
          viewRef.current.scopeKey !== scopeKey
        ) {
          releaseCandidate();
          return;
        }
        const latestTarget = latestTargetRef.current;
        const ready: ReadyScreenshot = {
          attachment:
            latestTarget?.occurrenceKey === targetOccurrenceKey
              ? latestTarget
              : preparationTarget,
          occurrenceKey: targetOccurrenceKey,
          ownsSrc,
          src,
        };
        handedOff = true;
        const current = viewRef.current;
        if (reduceMotion) {
          disposeScreenshot(current.displayed);
          disposeScreenshot(current.incoming);
          setCurrentView({
            displayed: ready,
            fadeStarted: false,
            incoming: null,
            phase: "ready",
            scopeKey,
          });
          return;
        }
        disposeScreenshot(current.incoming);
        setCurrentView({
          ...current,
          fadeStarted: false,
          incoming: ready,
          phase: "fading",
        });
      },
      () => {
        if (
          cancelled ||
          generationRef.current !== generation ||
          viewRef.current.scopeKey !== scopeKey
        ) {
          releaseCandidate();
          return;
        }
        releaseCandidate();
        const latestTarget = latestTargetRef.current;
        if (
          latestTarget?.occurrenceKey === targetOccurrenceKey &&
          (latestTarget.id !== preparationTarget.id ||
            latestTarget.previewUrl !== preparationTarget.previewUrl)
        ) {
          setPreparation({ scopeKey, target: latestTarget });
          const current = viewRef.current;
          setCurrentView({ ...current, phase: "loading" });
          return;
        }
        const current = viewRef.current;
        setCurrentView({
          ...current,
          fadeStarted: false,
          incoming: null,
          phase: "error",
        });
      },
    );

    return () => {
      cancelled = true;
      if (!handedOff) {
        releaseCandidate();
      }
    };
  }, [
    displayedMatchesTarget,
    loadedReference?.blob,
    reduceMotion,
    scopeKey,
    setCurrentView,
    preparationTarget,
    targetOccurrenceKey,
  ]);

  useEffect(() => {
    const incoming = scopedView.incoming;
    if (!incoming || scopedView.phase !== "fading") {
      return;
    }

    const frame = requestAnimationFrame(() => {
      const current = viewRef.current;
      if (current.incoming !== incoming) {
        return;
      }
      setCurrentView({ ...current, fadeStarted: true });
    });

    return () => cancelAnimationFrame(frame);
  }, [scopedView.incoming, scopedView.phase, setCurrentView]);

  useEffect(() => {
    const incoming = scopedView.incoming;
    if (!incoming || !scopedView.fadeStarted) {
      return;
    }
    const timer = setTimeout(() => {
      if (viewRef.current.incoming === incoming) {
        finishFade();
      }
    }, FADE_DURATION_MS);

    return () => clearTimeout(timer);
  }, [finishFade, scopedView.fadeStarted, scopedView.incoming]);

  useEffect(() => {
    return () => {
      generationRef.current += 1;
      disposeScreenshot(viewRef.current.displayed);
      disposeScreenshot(viewRef.current.incoming);
    };
  }, []);

  const previewAttachment = scopedView.displayed?.attachment;
  const previewAttachments = useMemo(
    () => (previewAttachment ? [previewAttachment] : []),
    [previewAttachment],
  );
  const previewKeys = useMemo(
    () => (scopedView.displayed ? [scopedView.displayed.occurrenceKey] : []),
    [scopedView.displayed],
  );
  const { openPreview, previewModal } = useAttachmentPreview(
    assistantId,
    previewAttachments,
    previewKeys,
    { scopeKey },
  );

  return {
    displayed: scopedView.displayed,
    fadeStarted: scopedView.fadeStarted,
    incoming: scopedView.incoming,
    phase: scopedView.phase,
    targetOccurrenceKey,
    finishFade,
    openPreview: (trigger) => {
      if (previewAttachment) {
        openPreview(previewAttachment, 0, trigger);
      }
    },
    previewModal,
  };
}

const SCREENSHOT_FRAME_CLASS =
  "relative aspect-[16/10] w-full max-w-[28rem] overflow-hidden rounded-md border border-[var(--border-base)] bg-[var(--surface-base)]";
const SCREENSHOT_IMAGE_CLASS =
  "absolute inset-0 h-full w-full object-contain transition-opacity duration-150 motion-reduce:transition-none";

export const ComputerUseScreenshotPreview: FC<{
  assistantId?: string | null;
  transition: ComputerUseScreenshotTransition;
}> = ({ assistantId, transition }) => {
  const { t } = useTranslation("chat");
  const interactive = transition.displayed !== null;
  const status =
    transition.phase === "loading" || transition.phase === "fading"
      ? t("computerUseScreenshotPreview.updating")
      : transition.phase === "error"
        ? transition.displayed
          ? t("computerUseScreenshotPreview.unavailableShowingPrevious")
          : t("computerUseScreenshotPreview.unavailable")
        : null;

  const handleDownload = useCallback(() => {
    if (transition.displayed) {
      const attachment = transition.displayed.attachment;
      void downloadAttachment(
        attachment,
        attachment.previewUrl ? undefined : assistantId,
      );
    }
  }, [assistantId, transition.displayed]);

  return (
    <div className="w-full" data-testid="computer-use-screenshot-preview">
      <div
        className={`${SCREENSHOT_FRAME_CLASS}${interactive ? " group cursor-pointer" : ""}`}
        role={interactive ? "button" : undefined}
        aria-label={
          interactive ? transition.displayed?.attachment.filename : undefined
        }
        tabIndex={interactive ? 0 : undefined}
        onClick={(event) =>
          transition.openPreview(event.currentTarget as HTMLElement)
        }
        onKeyDown={(event) => {
          if (interactive && (event.key === "Enter" || event.key === " ")) {
            event.preventDefault();
            transition.openPreview(event.currentTarget);
          }
        }}
        data-reveal-row=""
      >
        {transition.displayed && (
          <img
            data-testid="computer-use-screenshot-displayed"
            src={transition.displayed.src}
            alt={transition.displayed.attachment.filename}
            className={`${SCREENSHOT_IMAGE_CLASS} ${transition.fadeStarted ? "opacity-0" : "opacity-100"}`}
          />
        )}
        {transition.incoming && (
          <img
            data-testid="computer-use-screenshot-incoming"
            src={transition.incoming.src}
            alt={transition.incoming.attachment.filename}
            className={`${SCREENSHOT_IMAGE_CLASS} ${transition.fadeStarted ? "opacity-100" : "opacity-0"}`}
            onTransitionEnd={transition.finishFade}
          />
        )}
        {!transition.displayed && !transition.incoming && (
          <AttachmentPreviewBox
            className="h-full w-full"
            kind="image"
            glyphClassName="h-6 w-6"
            placeholder={
              transition.phase === "error" ? null : (
                <Loader2 className="h-6 w-6 animate-spin text-[var(--content-tertiary)]" />
              )
            }
          />
        )}
        {status && (
          <div
            className="absolute right-2 bottom-2 left-2 rounded-md bg-[var(--surface-overlay)]/90 px-2 py-1 text-body-small-default text-[var(--content-secondary)] shadow-sm backdrop-blur-sm"
            role="status"
            aria-live="polite"
          >
            {status}
          </div>
        )}
        {transition.displayed && (
          <AttachmentDownloadOverlay
            filename={transition.displayed.attachment.filename}
            onDownload={(event: MouseEvent<HTMLButtonElement>) => {
              event.stopPropagation();
              handleDownload();
            }}
            className="rounded-md"
          />
        )}
      </div>
    </div>
  );
};
