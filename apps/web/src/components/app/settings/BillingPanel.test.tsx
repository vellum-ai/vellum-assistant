/**
 * Tests for BillingPanel.
 *
 * Covers:
 * 1. Navigation panel-id integration.
 * 2. The `formatCredits` / `formatCreditsShort` helpers (re-implemented here
 *    since the component does not export them).
 * 3. Generated query/mutation helpers are callable (smoke).
 * 4. Bootstrap retry state-machine logic (bounded retries on failure).
 */

import { describe, expect, mock, test } from "bun:test";
import * as realRQ from "@tanstack/react-query";

import {
  organizationsBillingSummaryRetrieveOptions,
  organizationsBillingTopUpsCheckoutSessionCreateMutation,
} from "@/generated/api/@tanstack/react-query.gen.js";
import { PANEL_IDS, SETTINGS_SIDEBAR } from "@/lib/settings/navigation.js";

// ---------------------------------------------------------------------------
// Module mocks — registered before the subject is imported.
// ---------------------------------------------------------------------------

mock.module("@tanstack/react-query", () => ({
  ...realRQ,
  useQuery: () => ({ data: undefined, isLoading: false, isError: false }),
  useMutation: () => ({
    mutate: () => {},
    isPending: false,
    isError: false,
    error: null,
    reset: () => {},
  }),
  useQueryClient: () => ({
    invalidateQueries: () => {},
  }),
}));

mock.module("next/navigation", () => ({
  useRouter: () => ({
    push: () => {},
    replace: () => {},
    back: () => {},
    prefetch: () => {},
    refresh: () => {},
  }),
  usePathname: () => "/settings/billing",
  useSearchParams: () => new URLSearchParams(),
}));

// ---------------------------------------------------------------------------
// Subject (imported AFTER mocks)
// ---------------------------------------------------------------------------

import {
  BOOTSTRAP_MAX_RETRIES,
  BOOTSTRAP_RETRY_DELAY_MS,
} from "@/components/app/settings/BillingPanel.js";

// ---------------------------------------------------------------------------
// formatCredits & formatCreditsShort (re-implemented here for unit testing
// since the component does not export them)
// ---------------------------------------------------------------------------

function formatCredits(value: string): string {
  const num = parseFloat(value);
  if (Number.isNaN(num)) {
    return "0 credits";
  }
  const abs = Math.abs(num);
  const formatted = abs.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const stripped = formatted.endsWith(".00")
    ? formatted.slice(0, -3)
    : formatted;
  return num < 0 ? `-${stripped} credits` : `${stripped} credits`;
}

function formatCreditsShort(value: string): string {
  const num = parseFloat(value);
  if (Number.isNaN(num)) {
    return "0";
  }
  const abs = Math.abs(num);
  const formatted = abs.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  const stripped = formatted.endsWith(".00")
    ? formatted.slice(0, -3)
    : formatted;
  return num < 0 ? `-${stripped}` : stripped;
}

// ---------------------------------------------------------------------------
// Navigation integration
// ---------------------------------------------------------------------------

describe("BillingPanel navigation integration", () => {
  test("billing is a recognised panel ID", () => {
    expect((PANEL_IDS as readonly string[]).includes("billing")).toBe(true);
  });

  test("billing panel is listed in the sidebar", () => {
    const ids = SETTINGS_SIDEBAR.map((item) => item.id);
    expect(ids).toContain("billing");
  });
});

// ---------------------------------------------------------------------------
// formatCredits helper
// ---------------------------------------------------------------------------

describe("formatCredits", () => {
  test("formats a positive balance with non-zero decimals", () => {
    expect(formatCredits("125.50")).toBe("125.50 credits");
  });

  test("strips .00 from whole numbers", () => {
    expect(formatCredits("10.00")).toBe("10 credits");
  });

  test("formats zero", () => {
    expect(formatCredits("0.00")).toBe("0 credits");
  });

  test("formats a negative balance with non-zero decimals", () => {
    expect(formatCredits("-42.10")).toBe("-42.10 credits");
  });

  test("strips .00 from negative whole numbers", () => {
    expect(formatCredits("-50.00")).toBe("-50 credits");
  });

  test("formats a large number with commas", () => {
    expect(formatCredits("1234567.89")).toBe("1,234,567.89 credits");
  });

  test("strips .00 from whole numbers passed without decimals", () => {
    expect(formatCredits("5")).toBe("5 credits");
  });

  test("returns 0 credits for non-numeric string", () => {
    expect(formatCredits("not-a-number")).toBe("0 credits");
  });

  test("returns 0 credits for empty string", () => {
    expect(formatCredits("")).toBe("0 credits");
  });
});

// ---------------------------------------------------------------------------
// formatCreditsShort helper
// ---------------------------------------------------------------------------

describe("formatCreditsShort", () => {
  test("formats a positive balance without credits suffix", () => {
    expect(formatCreditsShort("125.50")).toBe("125.50");
  });

  test("strips .00 from whole numbers", () => {
    expect(formatCreditsShort("10.00")).toBe("10");
  });

  test("formats zero", () => {
    expect(formatCreditsShort("0.00")).toBe("0");
  });

  test("formats a negative balance", () => {
    expect(formatCreditsShort("-42.10")).toBe("-42.10");
  });

  test("formats a large number with commas", () => {
    expect(formatCreditsShort("1234567.89")).toBe("1,234,567.89");
  });

  test("strips .00 from large whole numbers with commas", () => {
    expect(formatCreditsShort("1000.00")).toBe("1,000");
  });

  test("returns 0 for non-numeric string", () => {
    expect(formatCreditsShort("not-a-number")).toBe("0");
  });

  test("returns 0 for empty string", () => {
    expect(formatCreditsShort("")).toBe("0");
  });
});

// ---------------------------------------------------------------------------
// Generated query options (smoke test)
// ---------------------------------------------------------------------------

describe("organizationsBillingSummaryRetrieveOptions", () => {
  test("returns an object with a queryKey and queryFn", () => {
    const opts = organizationsBillingSummaryRetrieveOptions();
    expect(opts.queryKey).toBeDefined();
    expect(typeof opts.queryFn).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// Generated checkout mutation (smoke test)
// ---------------------------------------------------------------------------

describe("organizationsBillingTopUpsCheckoutSessionCreateMutation", () => {
  test("returns an object with a mutationFn", () => {
    const opts = organizationsBillingTopUpsCheckoutSessionCreateMutation();
    expect(typeof opts.mutationFn).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// Auto top-up card mounting
//
// We can't render the panel here (no @testing-library/react), so we exercise
// the mount at the source level: the card is rendered unconditionally and
// imported from the dedicated AutoTopUpCard module (NOT inlined into
// BillingPanel.tsx).
// ---------------------------------------------------------------------------

async function readSettingsFile(name: string): Promise<string> {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  return fs.readFile(path.join(import.meta.dir, name), "utf-8");
}

describe("BillingPanel — auto top-up card", () => {
  test("source renders the card and imports it from the dedicated module", async () => {
    const source = await readSettingsFile("BillingPanel.tsx");
    expect(source).toContain("<AutoTopUpCard />");
    expect(source).toContain(
      'import { AutoTopUpCard } from "@/components/app/settings/AutoTopUpCard.js"',
    );
  });

  test("AutoTopUpCard module exists and exports the component", async () => {
    const mod = await import("./AutoTopUpCard");
    expect(typeof mod.AutoTopUpCard).toBe("function");
  });

  test("AutoTopUpSavePaymentMethodModal does NOT exist in the settings tree", async () => {
    // Negative-assertion: per Decision 5, no save-payment-method modal
    // ships with this slice. If a future PR re-adds it without an explicit
    // decision flip, this test fails loudly.
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    const settingsDir = path.dirname(
      path.join(import.meta.dir, "BillingPanel.tsx"),
    );
    const entries = await fs.readdir(settingsDir);
    expect(entries).not.toContain("AutoTopUpSavePaymentMethodModal.tsx");
    expect(entries).not.toContain("AutoTopUpSavePaymentMethodModal.test.tsx");
  });
});

// ---------------------------------------------------------------------------
// Bootstrap retry state-machine
// ---------------------------------------------------------------------------

type MutationStatus = "idle" | "pending" | "error" | "success";

interface BootstrapState {
  attempts: number;
  status: MutationStatus;
  pendingTimers: number;
}

// Mirrors the all-three-fields-zero gate the BillingPanel useEffect uses to
// decide whether to fire the bootstrap mutation. Keep this re-implementation
// in lockstep with the production check in BillingPanel.tsx — a
// partially-zero summary is a real org with usage, not a fresh bootstrap
// candidate.
const ZERO_SUMMARY = {
  settled_balance: "0.00",
  pending_compute: "0.00",
  effective_balance: "0.00",
};

const NON_ZERO_SUMMARY = {
  settled_balance: "100.00",
  pending_compute: "5.00",
  effective_balance: "95.00",
};

function shouldBootstrap(
  summary: typeof ZERO_SUMMARY | typeof NON_ZERO_SUMMARY | null,
  state: BootstrapState,
): boolean {
  return !!(
    summary &&
    summary.settled_balance === "0.00" &&
    summary.pending_compute === "0.00" &&
    summary.effective_balance === "0.00" &&
    state.attempts < BOOTSTRAP_MAX_RETRIES &&
    state.status !== "pending" &&
    state.status !== "error" &&
    state.status !== "success"
  );
}

function onBootstrapError(state: BootstrapState): BootstrapState {
  const next: BootstrapState = { ...state, status: "error" };
  if (next.attempts < BOOTSTRAP_MAX_RETRIES) {
    next.pendingTimers += 1;
  }
  return next;
}

function onTimerFire(state: BootstrapState): BootstrapState {
  return { ...state, status: "idle", pendingTimers: state.pendingTimers - 1 };
}

function attemptBootstrap(
  summary: typeof ZERO_SUMMARY | typeof NON_ZERO_SUMMARY | null,
  state: BootstrapState,
  outcome: "success" | "error",
): BootstrapState {
  if (!shouldBootstrap(summary, state)) {
    return state;
  }
  let next: BootstrapState = {
    ...state,
    attempts: state.attempts + 1,
    status: "pending",
  };
  if (outcome === "success") {
    next = { ...next, status: "success" };
  } else {
    next = onBootstrapError(next);
  }
  return next;
}

describe("Bootstrap retry state-machine", () => {
  test("exported constants have expected values", () => {
    expect(BOOTSTRAP_MAX_RETRIES).toBe(3);
    expect(BOOTSTRAP_RETRY_DELAY_MS).toBe(2000);
  });

  test("triggers bootstrap on zero summary", () => {
    const state: BootstrapState = {
      attempts: 0,
      status: "idle",
      pendingTimers: 0,
    };
    expect(shouldBootstrap(ZERO_SUMMARY, state)).toBe(true);
  });

  test("does not trigger bootstrap on non-zero summary", () => {
    const state: BootstrapState = {
      attempts: 0,
      status: "idle",
      pendingTimers: 0,
    };
    expect(shouldBootstrap(NON_ZERO_SUMMARY, state)).toBe(false);
  });

  test("does not trigger bootstrap when summary is null", () => {
    const state: BootstrapState = {
      attempts: 0,
      status: "idle",
      pendingTimers: 0,
    };
    expect(shouldBootstrap(null, state)).toBe(false);
  });

  test("does not trigger bootstrap while pending", () => {
    const state: BootstrapState = {
      attempts: 1,
      status: "pending",
      pendingTimers: 0,
    };
    expect(shouldBootstrap(ZERO_SUMMARY, state)).toBe(false);
  });

  test("does not trigger bootstrap while in error state (before reset)", () => {
    const state: BootstrapState = {
      attempts: 1,
      status: "error",
      pendingTimers: 1,
    };
    expect(shouldBootstrap(ZERO_SUMMARY, state)).toBe(false);
  });

  test("does not trigger bootstrap after success", () => {
    const state: BootstrapState = {
      attempts: 1,
      status: "success",
      pendingTimers: 0,
    };
    expect(shouldBootstrap(ZERO_SUMMARY, state)).toBe(false);
  });

  test("successful bootstrap on first attempt stops retries", () => {
    const initial: BootstrapState = {
      attempts: 0,
      status: "idle",
      pendingTimers: 0,
    };
    const after = attemptBootstrap(ZERO_SUMMARY, initial, "success");

    expect(after.attempts).toBe(1);
    expect(after.status).toBe("success");
    expect(shouldBootstrap(ZERO_SUMMARY, after)).toBe(false);
  });

  test("failed bootstrap schedules a retry timer", () => {
    const initial: BootstrapState = {
      attempts: 0,
      status: "idle",
      pendingTimers: 0,
    };
    const after = attemptBootstrap(ZERO_SUMMARY, initial, "error");

    expect(after.attempts).toBe(1);
    expect(after.status).toBe("error");
    expect(after.pendingTimers).toBe(1);
    expect(shouldBootstrap(ZERO_SUMMARY, after)).toBe(false);
  });

  test("timer reset allows next retry attempt", () => {
    const initial: BootstrapState = {
      attempts: 0,
      status: "idle",
      pendingTimers: 0,
    };
    const afterError = attemptBootstrap(ZERO_SUMMARY, initial, "error");
    const afterReset = onTimerFire(afterError);

    expect(afterReset.status).toBe("idle");
    expect(afterReset.attempts).toBe(1);
    expect(shouldBootstrap(ZERO_SUMMARY, afterReset)).toBe(true);
  });

  test("retries up to BOOTSTRAP_MAX_RETRIES times then stops", () => {
    let state: BootstrapState = {
      attempts: 0,
      status: "idle",
      pendingTimers: 0,
    };

    for (let i = 0; i < BOOTSTRAP_MAX_RETRIES; i++) {
      expect(shouldBootstrap(ZERO_SUMMARY, state)).toBe(true);
      state = attemptBootstrap(ZERO_SUMMARY, state, "error");
      if (i < BOOTSTRAP_MAX_RETRIES - 1) {
        state = onTimerFire(state);
      }
    }

    expect(state.attempts).toBe(BOOTSTRAP_MAX_RETRIES);
    const resetState = { ...state, status: "idle" as const };
    expect(shouldBootstrap(ZERO_SUMMARY, resetState)).toBe(false);
  });

  test("onError does not schedule timer when at max retries", () => {
    const atLimit: BootstrapState = {
      attempts: BOOTSTRAP_MAX_RETRIES,
      status: "error",
      pendingTimers: 0,
    };
    const after = onBootstrapError(atLimit);
    expect(after.pendingTimers).toBe(0);
  });

  test("success after retries stops further attempts", () => {
    let state: BootstrapState = {
      attempts: 0,
      status: "idle",
      pendingTimers: 0,
    };

    state = attemptBootstrap(ZERO_SUMMARY, state, "error");
    state = onTimerFire(state);

    state = attemptBootstrap(ZERO_SUMMARY, state, "success");
    expect(state.attempts).toBe(2);
    expect(state.status).toBe("success");
    expect(shouldBootstrap(ZERO_SUMMARY, state)).toBe(false);
  });
});
