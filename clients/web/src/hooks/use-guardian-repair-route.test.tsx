import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { render, cleanup } from "@testing-library/react";

const navigateMock = mock((..._args: unknown[]) => {});

mock.module("react-router", () => ({
  useNavigate: () => navigateMock,
}));

import { useGuardianRepairRoute } from "@/hooks/use-guardian-repair-route";
import { publish } from "@/lib/event-bus";
import { routes } from "@/utils/routes";

function Harness() {
  useGuardianRepairRoute();
  return null;
}

describe("useGuardianRepairRoute", () => {
  beforeEach(() => {
    navigateMock.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  test("routes to the chooser when a guardian repair is required", () => {
    render(<Harness />);

    publish("gateway.guardian-repair-required", {});

    expect(navigateMock).toHaveBeenCalledTimes(1);
    expect(navigateMock).toHaveBeenCalledWith(routes.selectAssistant, {
      replace: true,
    });
  });

  test("routes without the auto-skip opt-out, so a lone assistant reaches the repair unattended", () => {
    /**
     * The chooser auto-connects when exactly one assistant is installed,
     * and that connect is what raises the repair dialog. Adding
     * `noAutoSkip` here would leave the user on a one-row picker with no
     * hint that the row they are looking at is the broken one.
     */
    render(<Harness />);

    publish("gateway.guardian-repair-required", {});

    const [target] = navigateMock.mock.calls[0] as [string];
    expect(target).not.toContain("noAutoSkip");
  });

  test("replaces the rejected route instead of stacking on it", () => {
    /**
     * The route the session died on renders against a bearer the gateway
     * refuses, and recovery stays latched off until a repair seeds a fresh
     * one. A pushed entry would put that dead page one Back press away,
     * with nothing left to heal it.
     */
    render(<Harness />);

    publish("gateway.guardian-repair-required", {});

    const [, options] = navigateMock.mock.calls[0] as [
      string,
      { replace?: boolean } | undefined,
    ];
    expect(options?.replace).toBe(true);
  });

  test("stops listening once unmounted", () => {
    const { unmount } = render(<Harness />);
    unmount();

    publish("gateway.guardian-repair-required", {});

    expect(navigateMock).not.toHaveBeenCalled();
  });
});
