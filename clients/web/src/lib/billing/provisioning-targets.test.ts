import { describe, expect, test } from "bun:test";

import type { OperationalStatus } from "@/generated/api/types.gen";

import {
  dimensionTargetsMet,
  isEntitlementRaceVerdict,
  isResizeOperationInFlight,
  resizeDimensionsInFlight,
  targetsMet,
} from "./provisioning-targets";

function opStatus(overrides: Partial<OperationalStatus>): OperationalStatus {
  return {
    state: "active",
    detail_state: "",
    poll_after_ms: 0,
    updated_at: "",
    state_started_at: null,
    active_operation: null,
    assistant: {
      id: "asst-1",
      status: "active",
      machine_id: null,
      vembda_cluster_id: null,
    },
    pod: {
      statefulset_found: null,
      spec_replicas: null,
      ready_replicas: null,
      pod_name: null,
      pod_phase: null,
      has_restart_history: false,
      max_restart_count: null,
      fatal_reason: null,
    },
    runtime: { healthz_ok: true, assistant_version: null, checked_at: null },
    storage: null,
    detail: { reason: null, message: null },
    ...overrides,
  };
}

describe("targetsMet", () => {
  test("null targets are never met", () => {
    expect(targetsMet(null, { machineSize: "large", storageGib: 50 })).toBe(
      false,
    );
  });

  test("both dimensions met → true", () => {
    expect(
      targetsMet(
        { machineSize: "large", storageGib: 50 },
        { machineSize: "large", storageGib: 50 },
      ),
    ).toBe(true);
  });

  test("machine compared by rank — a larger actual than the target counts", () => {
    expect(
      targetsMet(
        { machineSize: "large", storageGib: 50 },
        { machineSize: "extra_large", storageGib: 50 },
      ),
    ).toBe(true);
  });

  test("machine below the target → false", () => {
    expect(
      targetsMet(
        { machineSize: "large", storageGib: 50 },
        { machineSize: "small", storageGib: 50 },
      ),
    ).toBe(false);
  });

  test("machine met but storage short → false", () => {
    expect(
      targetsMet(
        { machineSize: "large", storageGib: 50 },
        { machineSize: "large", storageGib: 25 },
      ),
    ).toBe(false);
  });

  test("null machine target (Mighty) is satisfied by storage alone", () => {
    expect(
      targetsMet(
        { machineSize: null, storageGib: 25 },
        { machineSize: "small", storageGib: 25 },
      ),
    ).toBe(true);
  });

  test("null storage target dimension is treated as satisfied", () => {
    expect(
      targetsMet(
        { machineSize: "medium", storageGib: null },
        { machineSize: "medium", storageGib: null },
      ),
    ).toBe(true);
  });

  test("both target dimensions null → met", () => {
    expect(
      targetsMet(
        { machineSize: null, storageGib: null },
        { machineSize: "small", storageGib: 10 },
      ),
    ).toBe(true);
  });

  test("null actuals cannot meet a non-null machine target", () => {
    expect(targetsMet({ machineSize: "large", storageGib: null }, null)).toBe(
      false,
    );
  });

  test("null actual storage cannot meet a non-null storage target", () => {
    expect(
      targetsMet(
        { machineSize: null, storageGib: 50 },
        { machineSize: null, storageGib: null },
      ),
    ).toBe(false);
  });
});

describe("dimensionTargetsMet", () => {
  test("null targets leave both dimensions unmet", () => {
    expect(
      dimensionTargetsMet(null, { machineSize: "large", storageGib: 50 }),
    ).toEqual({ machine: false, storage: false });
  });

  test("a null target dimension is satisfied on its own", () => {
    expect(
      dimensionTargetsMet(
        { machineSize: null, storageGib: 50 },
        { machineSize: null, storageGib: 10 },
      ),
    ).toEqual({ machine: true, storage: false });
  });

  test("null actuals cannot meet non-null targets", () => {
    expect(
      dimensionTargetsMet({ machineSize: "large", storageGib: 50 }, null),
    ).toEqual({ machine: false, storage: false });
  });

  test("machine compares by rank, so a larger actual counts", () => {
    expect(
      dimensionTargetsMet(
        { machineSize: "large", storageGib: null },
        { machineSize: "extra_large", storageGib: null },
      ).machine,
    ).toBe(true);
    expect(
      dimensionTargetsMet(
        { machineSize: "large", storageGib: null },
        { machineSize: "small", storageGib: null },
      ).machine,
    ).toBe(false);
  });

  test("the dimensions are independent: storage can land while machine lags", () => {
    expect(
      dimensionTargetsMet(
        { machineSize: "large", storageGib: 50 },
        { machineSize: "small", storageGib: 100 },
      ),
    ).toEqual({ machine: false, storage: true });
  });

  test("machine can land while storage lags", () => {
    expect(
      dimensionTargetsMet(
        { machineSize: "large", storageGib: 50 },
        { machineSize: "large", storageGib: 25 },
      ),
    ).toEqual({ machine: true, storage: false });
  });

  test("targetsMet is the conjunction of the per-dimension flags", () => {
    const cases: [
      Parameters<typeof targetsMet>[0],
      Parameters<typeof targetsMet>[1],
    ][] = [
      [null, { machineSize: "large", storageGib: 50 }],
      [
        { machineSize: "large", storageGib: 50 },
        { machineSize: "large", storageGib: 50 },
      ],
      [
        { machineSize: "large", storageGib: 50 },
        { machineSize: "small", storageGib: 100 },
      ],
      [{ machineSize: null, storageGib: null }, null],
      [{ machineSize: "medium", storageGib: null }, null],
    ];
    for (const [targets, actuals] of cases) {
      const met = dimensionTargetsMet(targets, actuals);
      expect(targetsMet(targets, actuals)).toBe(
        targets != null && met.machine && met.storage,
      );
    }
  });
});

describe("resizeDimensionsInFlight", () => {
  test("null / undefined status flags nothing", () => {
    expect(resizeDimensionsInFlight(null)).toEqual({
      machine: false,
      storage: false,
    });
    expect(resizeDimensionsInFlight(undefined)).toEqual({
      machine: false,
      storage: false,
    });
  });

  test("a resizing_machine state flags machine only", () => {
    expect(
      resizeDimensionsInFlight(opStatus({ state: "resizing_machine" })),
    ).toEqual({ machine: true, storage: false });
  });

  test("a resizing_storage state flags storage only", () => {
    expect(
      resizeDimensionsInFlight(opStatus({ state: "resizing_storage" })),
    ).toEqual({ machine: false, storage: true });
  });

  test("a resize_machine operation flags machine while the state is active", () => {
    expect(
      resizeDimensionsInFlight(
        opStatus({
          state: "active",
          active_operation: {
            operation: "resize_machine",
            operation_id: "op-1",
            phase: "WAITING_FOR_READY",
            started_at: "",
            updated_at: "",
            target: {},
          },
        }),
      ),
    ).toEqual({ machine: true, storage: false });
  });

  test("a resize_storage operation flags storage while the state is active", () => {
    expect(
      resizeDimensionsInFlight(
        opStatus({
          state: "active",
          active_operation: {
            operation: "resize_storage",
            operation_id: "op-2",
            phase: "WAITING_FOR_PVC",
            started_at: "",
            updated_at: "",
            target: {},
          },
        }),
      ),
    ).toEqual({ machine: false, storage: true });
  });

  test("an unattributable resize operation flags neither dimension", () => {
    expect(
      resizeDimensionsInFlight(
        opStatus({
          state: "active",
          active_operation: {
            operation: "resize_something_new",
            operation_id: "op-3",
            phase: "",
            started_at: "",
            updated_at: "",
            target: {},
          },
        }),
      ),
    ).toEqual({ machine: false, storage: false });
  });

  test("an active state with no operation flags neither dimension", () => {
    expect(resizeDimensionsInFlight(opStatus({ state: "active" }))).toEqual({
      machine: false,
      storage: false,
    });
  });
});

describe("isResizeOperationInFlight", () => {
  test("null / undefined status is not in flight", () => {
    expect(isResizeOperationInFlight(null)).toBe(false);
    expect(isResizeOperationInFlight(undefined)).toBe(false);
  });

  test("a resizing_machine state is in flight", () => {
    expect(
      isResizeOperationInFlight(opStatus({ state: "resizing_machine" })),
    ).toBe(true);
  });

  test("a resizing_storage state is in flight", () => {
    expect(
      isResizeOperationInFlight(opStatus({ state: "resizing_storage" })),
    ).toBe(true);
  });

  test("a resize active_operation is in flight even when the state is active", () => {
    expect(
      isResizeOperationInFlight(
        opStatus({
          state: "active",
          active_operation: {
            operation: "resize_machine",
            operation_id: "op-1",
            phase: "WAITING_FOR_PVC",
            started_at: "",
            updated_at: "",
            target: {},
          },
        }),
      ),
    ).toBe(true);
  });

  test("an unknown resize operation still guards completion globally", () => {
    expect(
      isResizeOperationInFlight(
        opStatus({
          state: "active",
          active_operation: {
            operation: "resize_something_new",
            operation_id: "op-3",
            phase: "",
            started_at: "",
            updated_at: "",
            target: {},
          },
        }),
      ),
    ).toBe(true);
  });

  test("an active state with no resize operation is not in flight", () => {
    expect(isResizeOperationInFlight(opStatus({ state: "active" }))).toBe(
      false,
    );
  });

  test("a non-resize active_operation is not in flight", () => {
    expect(
      isResizeOperationInFlight(
        opStatus({
          state: "restarting",
          active_operation: {
            operation: "restart",
            operation_id: "op-2",
            phase: "",
            started_at: "",
            updated_at: "",
            target: {},
          },
        }),
      ),
    ).toBe(false);
  });
});

describe("isEntitlementRaceVerdict", () => {
  test("no_active_pro is a race — the entitlement isn't visible yet", () => {
    expect(
      isEntitlementRaceVerdict({
        state: "not_applicable",
        reason: "no_active_pro",
      }),
    ).toBe(true);
  });

  test("no_provisionable_assistants is a race — no settled assistant yet", () => {
    expect(
      isEntitlementRaceVerdict({
        state: "not_applicable",
        reason: "no_provisionable_assistants",
      }),
    ).toBe(true);
  });

  test("no_targets is an answer, not a race", () => {
    expect(
      isEntitlementRaceVerdict({
        state: "not_applicable",
        reason: "no_targets",
      }),
    ).toBe(false);
  });

  test("a not_applicable with no reason is not a race", () => {
    expect(
      isEntitlementRaceVerdict({ state: "not_applicable", reason: null }),
    ).toBe(false);
  });

  test("a race reason on a non-not_applicable state is not a race", () => {
    expect(
      isEntitlementRaceVerdict({
        state: "started",
        reason: "no_provisionable_assistants",
      }),
    ).toBe(false);
  });

  test("a terminal already_done verdict is not a race", () => {
    expect(
      isEntitlementRaceVerdict({ state: "already_done", reason: null }),
    ).toBe(false);
  });
});
