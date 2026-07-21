import { describe, expect, test } from "bun:test";

import {
  deriveProvisioningState,
  type DeriveProvisioningInput,
} from "./provisioning-machine";
import { PROVISION_STALL_MS, PROVISION_WAIT_GRACE_MS } from "./utils";

/** Pro confirmed, targets unmet, no operation observed yet → WAITING. */
function baseInput(
  overrides: Partial<DeriveProvisioningInput> = {},
): DeriveProvisioningInput {
  return {
    planId: "pro",
    targets: { machineSize: "large", storageGib: 50 },
    actuals: { machineSize: "small", storageGib: 10 },
    initialActuals: { machineSize: "small", storageGib: 10 },
    resizeOperationInFlight: false,
    sawOperation: false,
    msSinceWatchStart: 1000,
    confirmExpired: false,
    serverVerdict: null,
    ...overrides,
  };
}

describe("deriveProvisioningState — confirm phase", () => {
  test("plan not yet pro → CONFIRMING", () => {
    expect(deriveProvisioningState(baseInput({ planId: "base" }))).toEqual({
      state: "CONFIRMING",
      softWaiting: false,
    });
  });

  test("plan unknown (subscription not loaded) → CONFIRMING", () => {
    expect(deriveProvisioningState(baseInput({ planId: null })).state).toBe(
      "CONFIRMING",
    );
  });

  test("confirm poll timed out → CONFIRM_TIMEOUT", () => {
    expect(
      deriveProvisioningState(
        baseInput({ planId: "base", confirmExpired: true }),
      ).state,
    ).toBe("CONFIRM_TIMEOUT");
  });
});

describe("deriveProvisioningState — WAITING", () => {
  test("pro confirmed, targets unmet, no operation observed → WAITING", () => {
    expect(deriveProvisioningState(baseInput())).toEqual({
      state: "WAITING",
      softWaiting: false,
    });
  });

  test("targets not loaded yet → WAITING", () => {
    expect(deriveProvisioningState(baseInput({ targets: null })).state).toBe(
      "WAITING",
    );
  });

  test("actuals not loaded yet → WAITING", () => {
    expect(deriveProvisioningState(baseInput({ actuals: null })).state).toBe(
      "WAITING",
    );
  });

  test("past the grace window → still WAITING but softWaiting", () => {
    expect(
      deriveProvisioningState(
        baseInput({ msSinceWatchStart: PROVISION_WAIT_GRACE_MS }),
      ),
    ).toEqual({ state: "WAITING", softWaiting: true });
  });
});

describe("deriveProvisioningState — RESIZING", () => {
  test("resize operation in flight → RESIZING", () => {
    expect(
      deriveProvisioningState(baseInput({ resizeOperationInFlight: true })),
    ).toEqual({ state: "RESIZING", softWaiting: false });
  });

  test("operation seen earlier but momentarily gone → stays RESIZING", () => {
    expect(
      deriveProvisioningState(baseInput({ sawOperation: true })).state,
    ).toBe("RESIZING");
  });
});

describe("deriveProvisioningState — DONE", () => {
  test("actuals meet both targets after an observed operation → DONE", () => {
    expect(
      deriveProvisioningState(
        baseInput({
          actuals: { machineSize: "large", storageGib: 50 },
          sawOperation: true,
        }),
      ),
    ).toEqual({ state: "DONE", softWaiting: false });
  });

  test("machine compared by rank — a larger size than the target counts", () => {
    expect(
      deriveProvisioningState(
        baseInput({
          actuals: { machineSize: "extra_large", storageGib: 50 },
          sawOperation: true,
        }),
      ).state,
    ).toBe("DONE");
  });

  test("machine met but storage still short → not DONE", () => {
    expect(
      deriveProvisioningState(
        baseInput({
          actuals: { machineSize: "large", storageGib: 25 },
          sawOperation: true,
        }),
      ).state,
    ).toBe("RESIZING");
  });

  test("null machine target (Mighty) is satisfied by storage alone", () => {
    expect(
      deriveProvisioningState(
        baseInput({
          targets: { machineSize: null, storageGib: 25 },
          actuals: { machineSize: "small", storageGib: 25 },
          sawOperation: true,
        }),
      ).state,
    ).toBe("DONE");
  });

  test("null storage target dimension is treated as satisfied", () => {
    expect(
      deriveProvisioningState(
        baseInput({
          targets: { machineSize: "medium", storageGib: null },
          actuals: { machineSize: "medium", storageGib: null },
          sawOperation: true,
        }),
      ).state,
    ).toBe("DONE");
  });

  test("resize that completed without ever being observed → DONE", () => {
    // The first observed actuals were below the targets, so a resize must
    // have run even though no operation was caught between polls.
    expect(
      deriveProvisioningState(
        baseInput({ actuals: { machineSize: "large", storageGib: 50 } }),
      ),
    ).toEqual({ state: "DONE", softWaiting: false });
  });
});

describe("deriveProvisioningState — NOT_APPLICABLE", () => {
  test("targets already met with no operation ever observed (Mighty at ceiling)", () => {
    expect(
      deriveProvisioningState(
        baseInput({
          targets: { machineSize: null, storageGib: 10 },
          actuals: { machineSize: "small", storageGib: 10 },
        }),
      ),
    ).toEqual({ state: "NOT_APPLICABLE", softWaiting: false });
  });

  test("both target dimensions null → NOT_APPLICABLE", () => {
    expect(
      deriveProvisioningState(
        baseInput({ targets: { machineSize: null, storageGib: null } }),
      ).state,
    ).toBe("NOT_APPLICABLE");
  });

  test("first observed actuals already met the targets → NOT_APPLICABLE", () => {
    expect(
      deriveProvisioningState(
        baseInput({
          actuals: { machineSize: "large", storageGib: 50 },
          initialActuals: { machineSize: "large", storageGib: 50 },
        }),
      ).state,
    ).toBe("NOT_APPLICABLE");
  });

  test("no snapshot yet and targets met on the first observation → NOT_APPLICABLE", () => {
    expect(
      deriveProvisioningState(
        baseInput({
          actuals: { machineSize: "large", storageGib: 50 },
          initialActuals: null,
        }),
      ).state,
    ).toBe("NOT_APPLICABLE");
  });
});

describe("deriveProvisioningState — STALLED", () => {
  test("WAITING past the stall threshold → STALLED", () => {
    expect(
      deriveProvisioningState(
        baseInput({ msSinceWatchStart: PROVISION_STALL_MS }),
      ),
    ).toEqual({ state: "STALLED", softWaiting: false });
  });

  test("RESIZING past the stall threshold → STALLED", () => {
    expect(
      deriveProvisioningState(
        baseInput({
          resizeOperationInFlight: true,
          msSinceWatchStart: PROVISION_STALL_MS,
        }),
      ).state,
    ).toBe("STALLED");
  });

  test("just under the stall threshold stays WAITING", () => {
    expect(
      deriveProvisioningState(
        baseInput({ msSinceWatchStart: PROVISION_STALL_MS - 1 }),
      ).state,
    ).toBe("WAITING");
  });

  test("actuals meeting targets past the stall threshold → DONE (late resize self-recovers)", () => {
    // Targets-met is checked before the stall clock, so a resize that lands
    // after the stall threshold still resolves the flow.
    expect(
      deriveProvisioningState(
        baseInput({
          actuals: { machineSize: "large", storageGib: 50 },
          sawOperation: true,
          msSinceWatchStart: PROVISION_STALL_MS + 1,
        }),
      ),
    ).toEqual({ state: "DONE", softWaiting: false });
  });

  test("re-based watch clock with a seen operation leaves STALLED for RESIZING", () => {
    // The manual-apply resume path: the hook re-bases msSinceWatchStart to the
    // resume instant and latches sawOperation.
    expect(
      deriveProvisioningState(
        baseInput({ sawOperation: true, msSinceWatchStart: 0 }),
      ),
    ).toEqual({ state: "RESIZING", softWaiting: false });
  });
});

describe("deriveProvisioningState — server verdict overrides", () => {
  test("already_done → DONE even with stale unmet actuals", () => {
    expect(
      deriveProvisioningState(
        baseInput({ serverVerdict: "already_done" }),
      ).state,
    ).toBe("DONE");
  });

  test("started → RESIZING", () => {
    expect(
      deriveProvisioningState(baseInput({ serverVerdict: "started" })).state,
    ).toBe("RESIZING");
  });

  test("in_progress → RESIZING", () => {
    expect(
      deriveProvisioningState(baseInput({ serverVerdict: "in_progress" }))
        .state,
    ).toBe("RESIZING");
  });

  test("not_applicable → NOT_APPLICABLE", () => {
    expect(
      deriveProvisioningState(
        baseInput({ serverVerdict: "not_applicable" }),
      ).state,
    ).toBe("NOT_APPLICABLE");
  });

  test("DONE-by-actuals beats a stale in_progress verdict", () => {
    expect(
      deriveProvisioningState(
        baseInput({
          actuals: { machineSize: "large", storageGib: 50 },
          sawOperation: true,
          serverVerdict: "in_progress",
        }),
      ).state,
    ).toBe("DONE");
  });

  test("verdict never applies before pro is confirmed", () => {
    expect(
      deriveProvisioningState(
        baseInput({ planId: "base", serverVerdict: "already_done" }),
      ).state,
    ).toBe("CONFIRMING");
  });
});

describe("deriveProvisioningState — an in-flight resize blocks completion", () => {
  // The platform persists the effective machine_size / provisioned_storage_gib
  // at *acceptance* of the resize, while the operation marker is still
  // WAITING_FOR_PVC/WAITING_FOR_READY — so targets read as met for the whole
  // window the pod spends restarting. Completing there would clear machineBusy
  // and let the domain step write to a gateway that is still down.
  test("targets met while the resize is still in flight → RESIZING, not DONE", () => {
    expect(
      deriveProvisioningState(
        baseInput({
          actuals: { machineSize: "large", storageGib: 50 },
          resizeOperationInFlight: true,
        }),
      ),
    ).toEqual({ state: "RESIZING", softWaiting: false });
  });

  test("an in_progress verdict with met targets stays RESIZING", () => {
    expect(
      deriveProvisioningState(
        baseInput({
          actuals: { machineSize: "large", storageGib: 50 },
          resizeOperationInFlight: true,
          serverVerdict: "in_progress",
        }),
      ).state,
    ).toBe("RESIZING");
  });

  test("an already_done verdict does not complete mid-resize", () => {
    expect(
      deriveProvisioningState(
        baseInput({
          resizeOperationInFlight: true,
          serverVerdict: "already_done",
        }),
      ).state,
    ).toBe("RESIZING");
  });

  test("a not_applicable verdict does not complete mid-resize", () => {
    expect(
      deriveProvisioningState(
        baseInput({
          resizeOperationInFlight: true,
          serverVerdict: "not_applicable",
        }),
      ).state,
    ).toBe("RESIZING");
  });

  test("first-observed actuals already at target still NOT_APPLICABLE when nothing is in flight", () => {
    // The guard keys on the live operation only, so the no-op upgrade path is
    // untouched.
    expect(
      deriveProvisioningState(
        baseInput({
          targets: { machineSize: "small", storageGib: 10 },
          actuals: { machineSize: "small", storageGib: 10 },
          initialActuals: { machineSize: "small", storageGib: 10 },
        }),
      ).state,
    ).toBe("NOT_APPLICABLE");
  });

  test("once the operation clears, met targets settle to DONE", () => {
    expect(
      deriveProvisioningState(
        baseInput({
          actuals: { machineSize: "large", storageGib: 50 },
          resizeOperationInFlight: false,
          sawOperation: true,
        }),
      ).state,
    ).toBe("DONE");
  });

  test("a marker that never clears still reaches STALLED, keeping the escape", () => {
    expect(
      deriveProvisioningState(
        baseInput({
          actuals: { machineSize: "large", storageGib: 50 },
          resizeOperationInFlight: true,
          msSinceWatchStart: PROVISION_STALL_MS,
        }),
      ).state,
    ).toBe("STALLED");
  });
});
