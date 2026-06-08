import { useEffect, useState } from "react";

import { isElectron } from "@/runtime/is-electron";
import {
  getUpdateState,
  installUpdate,
  onUpdateState,
  type UpdateState,
} from "@/runtime/auto-update";

/**
 * Compact, non-blocking banner that surfaces auto-update progress to
 * the user. Only renders inside the Electron host — on web / iOS the
 * component returns null.
 *
 * States:
 *  - idle / checking / error: render nothing.
 *  - available: "Update available" (auto-download is enabled, no action needed).
 *  - downloading: progress bar with percentage.
 *  - downloaded: "Vellum X.Y.Z is ready — Restart to install" with a button.
 */
export function UpdateBanner() {
  const [state, setState] = useState<UpdateState>({ status: "idle" });

  useEffect(() => {
    if (!isElectron()) return;

    // Seed with current state, then subscribe for live updates.
    void getUpdateState().then(setState);
    return onUpdateState(setState);
  }, []);

  if (!isElectron()) return null;

  if (
    state.status === "idle" ||
    state.status === "checking" ||
    state.status === "error"
  ) {
    return null;
  }

  const percent = Math.round(state.progress?.percent ?? 0);

  return (
    <div
      data-testid="update-banner"
      className="flex items-center gap-3 px-4 py-1.5"
      style={{
        background: "var(--surface-active)",
        borderBottom: "1px solid var(--border-default)",
        fontSize: "13px",
        color: "var(--text-secondary)",
      }}
    >
      {state.status === "available" && (
        <span>Update available — downloading will begin shortly.</span>
      )}

      {state.status === "downloading" && (
        <>
          <span className="shrink-0">Downloading update…</span>
          <div
            className="h-1.5 flex-1 overflow-hidden rounded-full"
            style={{ background: "var(--surface-hover)" }}
          >
            <div
              className="h-full rounded-full transition-[width] duration-300"
              style={{
                width: `${percent}%`,
                background: "var(--brand-default)",
              }}
            />
          </div>
          <span className="shrink-0 tabular-nums">{percent}%</span>
        </>
      )}

      {state.status === "downloaded" && (
        <>
          <span>
            Vellum {state.version ?? "update"} is ready.
          </span>
          <button
            type="button"
            onClick={() => void installUpdate()}
            className="cursor-pointer underline"
            style={{
              background: "none",
              border: "none",
              padding: 0,
              font: "inherit",
              color: "var(--brand-default)",
            }}
          >
            Restart to install
          </button>
        </>
      )}
    </div>
  );
}
