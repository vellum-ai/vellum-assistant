import { isElectron } from "@/runtime/is-electron";

/**
 * Transport seam for local-mode lifecycle operations (hatch, and — as
 * follow-up tickets land — retire, lockfile, guardian-token, gateway).
 *
 * Local mode provisions an assistant on the user's own machine by driving the
 * Vellum CLI. That CLI work runs in a trusted host process, never the
 * renderer: in the Electron desktop shell it runs in the main process behind
 * `window.vellum.localMode.*`; on the web/dev host it runs in the Vite dev
 * server behind `/assistant/__local/*` middleware. This module is the single
 * place that branch lives — feature code imports these named functions and
 * stays host-agnostic, mirroring the per-capability `runtime/` wrapper rule in
 * `apps/web/docs/ELECTRON.md`.
 *
 * Unlike the host-only wrappers (`dock.ts`, `native-biometric.ts`), these
 * functions are NOT no-ops off Electron — the web/dev branch is a real
 * implementation, because local mode is a first-class web/dev capability, not
 * a desktop-only nicety.
 */

export interface LocalHatchResult {
  ok: boolean;
  assistantId?: string;
  error?: string;
}

/**
 * Provision a local assistant for the requested species.
 *
 * Both hosts spawn the Vellum CLI in a trusted process and return the same
 * `{ ok, assistantId }` contract: the Electron main process behind
 * `window.vellum.localMode.hatch`, the Vite dev server behind the
 * `/assistant/__local/hatch` middleware. Callers reload the lockfile to
 * discover the new assistant regardless of host.
 */
export async function hatchLocalAssistant(
  species: string = "vellum",
): Promise<LocalHatchResult> {
  if (isElectron()) {
    return window.vellum!.localMode.hatch(species);
  }

  const res = await fetch("/assistant/__local/hatch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ species }),
  });
  return res.json() as Promise<LocalHatchResult>;
}
