import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";

import type * as SystemPermissions from "@/runtime/system-permissions";

let inputMonitoringStatus: string | null = "not-determined";
mock.module(
  "@/runtime/system-permissions",
  (): Partial<typeof SystemPermissions> => ({
    useSystemPermissionsState: () =>
      ({
        state:
          inputMonitoringStatus === null
            ? null
            : { inputMonitoring: { status: inputMonitoringStatus } },
        loading: false,
        error: null,
        supported: inputMonitoringStatus !== null,
        refresh: async () => null,
      }) as unknown as ReturnType<
        typeof SystemPermissions.useSystemPermissionsState
      >,
  }),
);

const { InputMonitoringReason } =
  await import("@/components/input-monitoring-reason");

describe("the Input Monitoring reason", () => {
  beforeEach(() => {
    inputMonitoringStatus = "not-determined";
  });

  afterEach(() => {
    cleanup();
  });

  test("says what the grant is for while it is not given", () => {
    render(<InputMonitoringReason />);
    expect(screen.getByText(/Input Monitoring/)).toBeTruthy();
  });

  test("draws nothing once the grant is given", () => {
    inputMonitoringStatus = "granted";
    const { container } = render(<InputMonitoringReason />);
    expect(container.innerHTML).toBe("");
  });

  test("draws nothing on a host with no system permissions", () => {
    inputMonitoringStatus = null;
    const { container } = render(<InputMonitoringReason />);
    expect(container.innerHTML).toBe("");
  });
});
