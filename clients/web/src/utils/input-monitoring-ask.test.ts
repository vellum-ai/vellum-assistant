import { beforeEach, describe, expect, mock, test } from "bun:test";

import type * as SystemPermissions from "@/runtime/system-permissions";

let inputMonitoringStatus: string | null = "not-determined";
let answer: string = "granted";
const requestSystemPermission = mock(async (_kind: string) => ({
  status: answer,
}));
mock.module(
  "@/runtime/system-permissions",
  (): Partial<typeof SystemPermissions> => ({
    getSystemPermissionsState: async () =>
      (inputMonitoringStatus === null
        ? null
        : {
            inputMonitoring: { status: inputMonitoringStatus },
          }) as unknown as Awaited<
        ReturnType<typeof SystemPermissions.getSystemPermissionsState>
      >,
    requestSystemPermission:
      requestSystemPermission as unknown as typeof SystemPermissions.requestSystemPermission,
  }),
);

const { askForInputMonitoring, __resetInputMonitoringAskForTests } =
  await import("@/utils/input-monitoring-ask");

describe("asking for Input Monitoring", () => {
  beforeEach(() => {
    inputMonitoringStatus = "not-determined";
    answer = "granted";
    requestSystemPermission.mockClear();
    __resetInputMonitoringAskForTests();
  });

  test("asks when the grant is not given, and answers with the outcome", async () => {
    answer = "denied";
    expect(await askForInputMonitoring()).toBe("denied");
    expect(requestSystemPermission).toHaveBeenCalledWith("inputMonitoring");
  });

  test("asks nothing of a user who already said yes", async () => {
    inputMonitoringStatus = "granted";
    expect(await askForInputMonitoring()).toBe("granted");
    expect(requestSystemPermission).not.toHaveBeenCalled();
  });

  /** A refusal is the user's answer for the session. */
  test("asks once per launch", async () => {
    answer = "denied";
    await askForInputMonitoring();
    inputMonitoringStatus = "denied";
    expect(await askForInputMonitoring()).toBe("denied");
    expect(requestSystemPermission).toHaveBeenCalledTimes(1);
  });

  test("has nothing to ask on a host without system permissions", async () => {
    inputMonitoringStatus = null;
    expect(await askForInputMonitoring()).toBeNull();
    expect(requestSystemPermission).not.toHaveBeenCalled();
  });
});
