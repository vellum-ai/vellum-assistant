/**
 * Registration guard for the inference model/profile/call-site routes.
 *
 * A route module that exports ROUTES but is never spread into the aggregator
 * (`routes/index.ts`) compiles, unit-tests green, and is silently unreachable
 * over both HTTP and IPC. This test pins every inference operationId to the
 * aggregated array and to the IPC method mapping the CLI depends on.
 */

import { describe, expect, test } from "bun:test";

import { routeDefinitionsToIpcMethods } from "../../../ipc/routes/route-adapter.js";
import { ROUTES } from "../index.js";

const EXPECTED_OPERATION_IDS = [
  "inference_models_list",
  "inference_profiles_list",
  "inference_profiles_get",
  "inference_profiles_create",
  "inference_profiles_update",
  "inference_profiles_delete",
  "inference_callsites_list",
  "inference_callsites_get",
] as const;

describe("inference route registration", () => {
  test("every inference operationId is registered in the aggregated ROUTES array", () => {
    const registered = new Set(ROUTES.map((r) => r.operationId));
    for (const operationId of EXPECTED_OPERATION_IDS) {
      expect(registered.has(operationId)).toBe(true);
    }
  });

  test("every inference operationId is exposed as an IPC method (CLI transport)", () => {
    const ipcMethods = new Set(
      routeDefinitionsToIpcMethods(ROUTES).map((r) => r.operationId),
    );
    for (const operationId of EXPECTED_OPERATION_IDS) {
      expect(ipcMethods.has(operationId)).toBe(true);
    }
  });
});
