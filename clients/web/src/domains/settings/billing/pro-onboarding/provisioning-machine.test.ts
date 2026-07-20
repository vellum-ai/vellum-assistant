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
    resizeOperationInFlight: false,
    sawOperation: false,
    msSinceProConfirmed: 1000,
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
        baseInput({ msSinceProConfirmed: PROVISION_WAIT_GRACE_MS }),
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
});

describe("deriveProvisioningState — STALLED", () => {
  test("WAITING past the stall threshold → STALLED", () => {
    expect(
      deriveProvisioningState(
        baseInput({ msSinceProConfirmed: PROVISION_STALL_MS }),
      ),
    ).toEqual({ state: "STALLED", softWaiting: false });
  });

  test("RESIZING past the stall threshold → STALLED", () => {
    expect(
      deriveProvisioningState(
        baseInput({
          resizeOperationInFlight: true,
          msSinceProConfirmed: PROVISION_STALL_MS,
        }),
      ).state,
    ).toBe("STALLED");
  });

  test("just under the stall threshold stays WAITING", () => {
    expect(
      deriveProvisioningState(
        baseInput({ msSinceProConfirmed: PROVISION_STALL_MS - 1 }),
      ).state,
    ).toBe("WAITING");
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
