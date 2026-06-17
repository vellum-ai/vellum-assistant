import { CircleCheck, Download, X } from "lucide-react";
import { useEffect, useRef } from "react";
import { ProgressBar, toast } from "@vellumai/design-library";

import { isElectron } from "@/runtime/is-electron";
import {
  getUpdateState,
  installUpdate,
  onUpdateState,
  type UpdateState,
  type UpdateStatus,
} from "@/runtime/auto-update";

const TOAST_ID = "app-update";

function UpdateToastContent({
  state,
  toastId,
}: {
  state: UpdateState;
  toastId: string | number;
}) {
  const percent = Math.round(state.progress?.percent ?? 0);
  const isDownloaded = state.status === "downloaded";

  const containerClass = isDownloaded
    ? "bg-[var(--system-positive-weak)] border-[var(--system-positive-strong)] text-[var(--system-positive-strong)]"
    : "bg-[var(--surface-overlay)] border-[var(--border-element)] text-[var(--content-default)]";

  const iconClass = isDownloaded
    ? "text-[var(--system-positive-strong)]"
    : "text-[var(--content-secondary)]";

  return (
    <div
      role="status"
      data-slot="toast"
      className={`flex w-full items-start gap-3 rounded-lg border p-3 shadow-lg ${containerClass}`}
    >
      <span className={`mt-0.5 shrink-0 ${iconClass}`}>
        {isDownloaded ? (
          <CircleCheck className="h-4 w-4" />
        ) : (
          <Download className="h-4 w-4" />
        )}
      </span>

      <div className="min-w-0 flex-1 space-y-2">
        {state.status === "available" && (
          <p className="text-body-medium-default">
            Update available — downloading will begin shortly.
          </p>
        )}

        {state.status === "downloading" && (
          <>
            <div className="flex items-center justify-between">
              <p className="text-body-medium-default">Downloading update…</p>
              <span className="text-body-small-default tabular-nums opacity-70">
                {percent}%
              </span>
            </div>
            <ProgressBar value={percent / 100} height={4} />
          </>
        )}

        {state.status === "downloaded" && (
          <>
            <p className="text-body-medium-default">
              Vellum {state.version ?? "update"} is ready.
            </p>
            <button
              type="button"
              onClick={() => void installUpdate()}
              className="cursor-pointer bg-transparent text-body-small-default underline underline-offset-2 hover:no-underline"
            >
              Restart to install
            </button>
          </>
        )}
      </div>

      <button
        type="button"
        onClick={() => toast.dismiss(toastId)}
        aria-label="Close"
        className="shrink-0 cursor-pointer rounded bg-transparent p-0.5 opacity-50 transition-opacity hover:opacity-100"
      >
        <X className="h-3.5 w-3.5" strokeWidth={2} />
      </button>
    </div>
  );
}

export function UpdateToast(): null {
  const dismissedForStatusRef = useRef<UpdateStatus | null>(null);

  useEffect(() => {
    if (!isElectron()) return;

    function handleState(state: UpdateState) {
      if (
        state.status === "idle" ||
        state.status === "checking" ||
        state.status === "error"
      ) {
        toast.dismiss(TOAST_ID);
        dismissedForStatusRef.current = null;
        return;
      }

      if (dismissedForStatusRef.current === state.status) return;

      if (dismissedForStatusRef.current !== null) {
        dismissedForStatusRef.current = null;
      }

      toast.custom(
        (id) => <UpdateToastContent state={state} toastId={id} />,
        {
          id: TOAST_ID,
          duration: Infinity,
          onDismiss: () => {
            dismissedForStatusRef.current = state.status;
          },
        },
      );
    }

    void getUpdateState().then(handleState);
    return onUpdateState(handleState);
  }, []);

  return null;
}
