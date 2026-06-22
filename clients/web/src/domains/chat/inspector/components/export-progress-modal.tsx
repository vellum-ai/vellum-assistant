import { AlertCircle, CheckCircle2, Download } from "lucide-react";
import { type ReactNode } from "react";

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
  const isRunning = phase === "running";
  const fraction = total > 0 ? completed / total : 0;

  // While running, the export shouldn't be dismissed out from under itself —
  // the only exit is the explicit Cancel button.
  return (
    <Modal.Root
      open={open}
      onOpenChange={(next) => {
        if (!next && !isRunning) onClose();
      }}
    >
      <Modal.Content
        size="sm"
        hideCloseButton={isRunning}
        dismissOnOverlayClick={!isRunning}
        onEscapeKeyDown={(event) => {
          if (isRunning) event.preventDefault();
        }}
        onInteractOutside={(event) => {
          if (isRunning) event.preventDefault();
        }}
      >
        <Modal.Header>
          <Modal.Title icon={phase === "error" ? AlertCircle : phase === "done" ? CheckCircle2 : Download}>
            {phase === "error"
              ? "Export failed"
              : phase === "done"
                ? "Export complete"
                : "Exporting inspector data"}
          </Modal.Title>
          <Modal.Description>
            {phase === "error"
              ? "Something went wrong while collecting the export."
              : phase === "done"
                ? "Your download should have started automatically."
                : "Collecting provider payloads and normalized context. This can take a moment for long conversations."}
          </Modal.Description>
        </Modal.Header>
        <Modal.Body>
          {phase === "error" ? (
            <p
              className="text-body-medium-default"
              role="alert"
              style={{ color: "var(--system-negative-strong)" }}
            >
              {error ?? "Failed to export inspector data."}
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              <ProgressBar
                value={phase === "done" ? 1 : fraction}
                aria-label="Export progress"
              />
              <div
                className="flex items-center justify-between text-label-default"
                style={{ color: "var(--content-secondary)" }}
              >
                <span>
                  {phase === "done"
                    ? "Done"
                    : completed >= total && total > 0
                      ? "Packaging ZIP…"
                      : `${completed} of ${total} calls`}
                </span>
                <span>{Math.round((phase === "done" ? 1 : fraction) * 100)}%</span>
              </div>
            </div>
          )}
        </Modal.Body>
        <Modal.Footer>
          {phase === "running" ? (
            <Button variant="outlined" onClick={onCancel}>
              Cancel
            </Button>
          ) : phase === "error" ? (
            <>
              <Button variant="outlined" onClick={onClose}>
                Close
              </Button>
              <Button variant="primary" onClick={onRetry}>
                Retry
              </Button>
            </>
          ) : (
            <Button variant="primary" onClick={onClose}>
              Done
            </Button>
          )}
        </Modal.Footer>
      </Modal.Content>
    </Modal.Root>
  );
}
