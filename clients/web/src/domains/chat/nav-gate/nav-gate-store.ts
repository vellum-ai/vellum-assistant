/**
 * State for the first-session sidenav-gating experiment (activation).
 *
 * New users in the `gated` arm start with most sidenav items visually
 * disabled; items unlock in two stages keyed to sent messages (1 → the
 * conversations/nav spine, 5 → full chrome, experiment over). Clicking a
 * disabled item opens an avatar bubble whose buttons drop the user back into
 * chat; a third click on the same item quietly unlocks it — repeated clicking
 * is a power user telling us the gate is wrong for them.
 *
 * Persisted (localStorage): the lifetime sent-message count, per-item click
 * attempts, and the one-shot collapse flag — so a mid-experiment refresh
 * neither re-locks unlocked items nor re-collapses the sidebar. The counter
 * increments for everyone (cheap, capped) because the flag arm resolves
 * asynchronously; gating and events apply only to the experiment cohort.
 */

import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { createSelectors } from "@/utils/create-selectors";

export type NavGateItemId =
  | "library"
  | "new-conversation"
  | "history"
  | "settings"
  | "assistant-access"
  | "model-profile"
  | "assistant-profile";

/** Arm of the sidenav-gating experiment flag. `none` = not in the cohort. */
export type NavGateArm = "none" | "control" | "gated";

/** Unlock thresholds from the experiment design. */
export const NAV_SPINE_UNLOCK_COUNT = 1;
export const FULL_UNLOCK_COUNT = 5;
/** Clicks on the same disabled item before it quietly unlocks. */
export const QUIET_UNLOCK_ATTEMPTS = 3;
/** Counting past the full-unlock threshold buys nothing; stop writing. */
const COUNT_CAP = FULL_UNLOCK_COUNT + 1;

/** Items that unlock at the first sent message (the nav spine). */
const SPINE_ITEMS: readonly NavGateItemId[] = ["history", "new-conversation"];

export interface NavGatePendingSend {
  text: string;
}

interface NavGateState {
  /** Lifetime user-sent (non-hidden) message count, capped at COUNT_CAP. */
  sentCount: number;
  /** Clicks per gated item; drives copy variation and the quiet unlock. */
  attempts: Partial<Record<NavGateItemId, number>>;
  /** One-shot: the gated arm collapses the sidebar once, then never again. */
  collapseApplied: boolean;
  /** Item whose bubble is open (ephemeral, not persisted). */
  bubbleItem: NavGateItemId | null;
  /**
   * Element the open bubble anchors to — the clicked region in whichever
   * side-menu instance (desktop rail or mobile drawer) took the click. Held
   * here so a single layout-scope bubble can anchor to it via a virtual ref.
   */
  bubbleAnchor: HTMLElement | null;
  /**
   * Message a bubble button asked to send on the user's behalf. Consumed by
   * the active chat view (same one-shot channel as the onboarding
   * `pendingFollowupMessage`) and sent with `source: "nav_redirect"`.
   */
  pendingSend: NavGatePendingSend | null;

  recordMessageSent: () => void;
  /**
   * Register a click on a gated item. Returns `"bubble"` (open/refresh the
   * bubble) or `"unlock"` (third click — quiet-unlock and let the original
   * action run).
   */
  registerGatedClick: (
    item: NavGateItemId,
    anchor: HTMLElement | null,
  ) => "bubble" | "unlock";
  dismissBubble: () => void;
  requestSend: (text: string) => void;
  consumePendingSend: () => NavGatePendingSend | null;
  markCollapseApplied: () => void;
}

const NAV_GATE_STORE_KEY = "vellum:nav-gate";

const useNavGateStoreBase = create<NavGateState>()(
  persist(
    (set, get) => ({
      sentCount: 0,
      attempts: {},
      collapseApplied: false,
      bubbleItem: null,
      bubbleAnchor: null,
      pendingSend: null,

      recordMessageSent: () => {
        const { sentCount } = get();
        if (sentCount >= COUNT_CAP) {
          return;
        }
        set({ sentCount: sentCount + 1 });
      },

      registerGatedClick: (item, anchor) => {
        const attempts = { ...get().attempts };
        const next = (attempts[item] ?? 0) + 1;
        attempts[item] = next;
        if (next >= QUIET_UNLOCK_ATTEMPTS) {
          set({ attempts, bubbleItem: null, bubbleAnchor: null });
          return "unlock";
        }
        set({ attempts, bubbleItem: item, bubbleAnchor: anchor });
        return "bubble";
      },

      dismissBubble: () => set({ bubbleItem: null, bubbleAnchor: null }),

      requestSend: (text) =>
        set({ pendingSend: { text }, bubbleItem: null, bubbleAnchor: null }),

      consumePendingSend: () => {
        const pending = get().pendingSend;
        if (pending) {
          set({ pendingSend: null });
        }
        return pending;
      },

      markCollapseApplied: () => set({ collapseApplied: true }),
    }),
    {
      name: NAV_GATE_STORE_KEY,
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({
        sentCount: state.sentCount,
        attempts: state.attempts,
        collapseApplied: state.collapseApplied,
      }),
    },
  ),
);

export const useNavGateStore = createSelectors(useNavGateStoreBase);

/**
 * Whether an item is gated for the given arm and store state. Pure so the
 * side menu, telemetry, and tests share one definition of the unlock curve.
 */
export function isNavItemGated(
  arm: NavGateArm,
  item: NavGateItemId,
  state: Pick<NavGateState, "sentCount" | "attempts">,
): boolean {
  if (arm !== "gated") {
    return false;
  }
  if (state.sentCount >= FULL_UNLOCK_COUNT) {
    return false;
  }
  if ((state.attempts[item] ?? 0) >= QUIET_UNLOCK_ATTEMPTS) {
    return false;
  }
  if (
    state.sentCount >= NAV_SPINE_UNLOCK_COUNT &&
    SPINE_ITEMS.includes(item)
  ) {
    return false;
  }
  return true;
}
