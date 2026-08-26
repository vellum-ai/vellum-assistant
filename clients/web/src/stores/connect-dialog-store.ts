/**
 * Connect-dialog state for the "Connect a remote assistant" dialog on the
 * assistant chooser, shared between its two openers:
 *
 *   - The chooser's own affordance opens it empty.
 *   - `useGlobalDeepLinkConsumer` opens it for a `<scheme>://connect`
 *     deep link, which can fire while the chooser is not mounted; the
 *     request parks here and the chooser picks it up on mount.
 *
 * Why a store instead of a query param: the parked payload can carry a
 * pairing link, whose device code is secret material. Carrying it in the
 * URL would place it in browser history and in navigation breadcrumbs
 * captured by telemetry.
 *
 * `closeConnectDialog` clears the deep-link payload along with the open
 * flag, so a later manual open starts empty. Renderer reloads blow this
 * away because it's not persisted; deep links are transient signals.
 *
 * The store also carries `deepLinkDrainSettled`: Electron buffers deep
 * links that arrive before the renderer exists and drains them shortly
 * after mount (see `runtime/event-sources/electron-deep-links.ts`, which
 * marks the flag once the drain settles). The chooser's auto-skip defers
 * to it so a cold-start connect link can open this dialog before a sole
 * assistant auto-connects. It latches true for the renderer's lifetime.
 *
 * @see {@link https://zustand.docs.pmnd.rs/}
 */

import { create } from "zustand";

import { createSelectors } from "@/utils/create-selectors";

/**
 * Which explanation an address-less `connect` deep link earns. `legacy` marks
 * an app version whose connect dialog took a pasted pairing bundle; `generic`
 * is a link that simply carried no usable base. The discriminant is parked
 * rather than resolved copy, so the dialog renders it through its own reactive
 * `t` and a language switch reaches it.
 */
export type ConnectGuidanceKind = "legacy" | "generic";

export interface ConnectDialogState {
  open: boolean;
  /** Prefill for the dialog's address field (deep-link entry), or `null`. */
  initialAddress: string | null;
  /** Which guidance the dialog shows above the form, or `null` for none. */
  guidanceKind: ConnectGuidanceKind | null;
  /** Whether the Electron cold-start deep-link drain has settled. */
  deepLinkDrainSettled: boolean;
}

export interface ConnectDialogActions {
  /**
   * Open the dialog. Omitted fields clear any previously parked payload,
   * so a manual open never resurfaces a stale deep-link prefill.
   */
  openConnectDialog: (options?: {
    initialAddress?: string;
    guidanceKind?: ConnectGuidanceKind;
  }) => void;
  /** Close the dialog and clear any parked deep-link payload. */
  closeConnectDialog: () => void;
  /** Latch that the startup deep-link backlog has been published (or failed). */
  markDeepLinkDrainSettled: () => void;
}

export type ConnectDialogStore = ConnectDialogState & ConnectDialogActions;

const useConnectDialogStoreBase = create<ConnectDialogStore>()((set) => ({
  open: false,
  initialAddress: null,
  guidanceKind: null,
  deepLinkDrainSettled: false,
  openConnectDialog: (options) =>
    set({
      open: true,
      initialAddress: options?.initialAddress ?? null,
      guidanceKind: options?.guidanceKind ?? null,
    }),
  closeConnectDialog: () =>
    set({ open: false, initialAddress: null, guidanceKind: null }),
  markDeepLinkDrainSettled: () => set({ deepLinkDrainSettled: true }),
}));

export const useConnectDialogStore = createSelectors(useConnectDialogStoreBase);

/**
 * Reset hook for tests. Not intended for production callers.
 */
export function __resetConnectDialogForTesting(): void {
  useConnectDialogStoreBase.setState({
    open: false,
    initialAddress: null,
    guidanceKind: null,
    deepLinkDrainSettled: false,
  });
}
