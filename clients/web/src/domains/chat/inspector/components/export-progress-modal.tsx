import { AlertCircle, CheckCircle2, Download } from "lucide-react";
import { type ReactNode } from "react";

import { useTranslation } from "@/i18n";
import { Button, Modal, ProgressBar } from "@vellumai/design-library";

export type ExportPhase = "running" | "done" | "error";

export interface ExportProgressModalProps {
  open: boolean;
  phase: ExportPhase;
  /** Requests resolved so far. */
  completed: number;
  /** Total requests the export will issue. */
  total: number;
  /** Error message shown when `phase === "error"`. */
  error: string | null;
  onCancel: () => void;
  onRetry: () => void;
  onClose: () => void;
}

/**
 * Determinate progress UI for the inspector ZIP export. The export fans out
 * one request per LLM call (in capped batches), which can be thousands of
 * requests for a long conversation — so we surface a progress bar and a
 * cancel affordance instead of a bare "Exporting…" spinner.
 *
 * Purely presentational: the parent owns the export lifecycle and feeds it
 * `phase`/`completed`/`total`.
 */
export function ExportProgressModal({
  open,
  phase,
  completed,
  total,
  error,
  onCancel,
  onRetry,
  onClose,
}: ExportProgressModalProps): ReactNode {
  const { t } = useTranslation("chat");
  const isRunning = phase === "running";
  const fraction = total > 0 ? completed / total : 0;

  const title =
    phase === "error"
      ? t("exportProgressModal.titleError")
      : phase === "done"
        ? t("exportProgressModal.titleDone")
        : t("exportProgressModal.titleRunning");

  const description =
    phase === "error"
      ? t("exportProgressModal.descriptionError")
      : phase === "done"
        ? t("exportProgressModal.descriptionDone")
        : t("exportProgressModal.descriptionRunning");

  // While running, the export shouldn't be dismissed out from under itself —
  // the only exit is the explicit Cancel button.
  return (
    <Modal.Root
      open={open}
      onOpenChange={(next) => {
        if (!next && !isRunning) {
          onClose();
        }
      }}
    >
      <Modal.Content
        size="sm"
        hideCloseButton={isRunning}
        dismissOnOverlayClick={!isRunning}
        onEscapeKeyDown={(event) => {
          if (isRunning) {
            event.preventDefault();
          }
        }}
        onInteractOutside={(event) => {
          if (isRunning) {
            event.preventDefault();
          }
        }}
      >
        <Modal.Header
          icon={
            phase === "error"
              ? AlertCircle
              : phase === "done"
                ? CheckCircle2
                : Download
          }
        >
          <Modal.Title>{title}</Modal.Title>
          <Modal.Description>{description}</Modal.Description>
        </Modal.Header>
        <Modal.Body>
          {phase === "error" ? (
            <p
              className="text-body-medium-default"
              role="alert"
              style={{ color: "var(--system-negative-strong)" }}
            >
              {error ?? t("exportProgressModal.defaultError")}
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              <ProgressBar
                value={phase === "done" ? 1 : fraction}
                aria-label={t("exportProgressModal.progressAriaLabel")}
              />
              <div
                className="flex items-center justify-between text-label-default"
                style={{ color: "var(--content-secondary)" }}
              >
                <span>
                  {phase === "done"
                    ? t("exportProgressModal.statusDone")
                    : completed >= total && total > 0
                      ? t("exportProgressModal.statusPackaging")
                      : t("exportProgressModal.statusProgress", {
                          completed,
                          total,
                        })}
                </span>
                <span>
                  {Math.round((phase === "done" ? 1 : fraction) * 100)}%
                </span>
              </div>
            </div>
          )}
        </Modal.Body>
        <Modal.Footer>
          {phase === "running" ? (
            <Button variant="outlined" onClick={onCancel}>
              {t("exportProgressModal.cancel")}
            </Button>
          ) : phase === "error" ? (
            <>
              <Button variant="outlined" onClick={onClose}>
                {t("exportProgressModal.close")}
              </Button>
              <Button variant="primary" onClick={onRetry}>
                {t("exportProgressModal.retry")}
              </Button>
            </>
          ) : (
            <Button variant="primary" onClick={onClose}>
              {t("exportProgressModal.done")}
            </Button>
          )}
        </Modal.Footer>
      </Modal.Content>
    </Modal.Root>
  );
}
