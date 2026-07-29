import { describe, expect, test } from "bun:test";

import type { OperationalStatus } from "@/generated/api/types.gen";

import {
  isEntitlementRaceVerdict,
  isResizeOperationInFlight,
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
