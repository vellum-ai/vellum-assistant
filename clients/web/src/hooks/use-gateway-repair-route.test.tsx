import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { render, cleanup } from "@testing-library/react";

const navigateMock = mock((..._args: unknown[]) => {});

mock.module("react-router", () => ({
  useNavigate: () => navigateMock,
}));

import { notifyGatewayRepairRequired } from "@/assistant/gateway-repair-bus";
import { useGatewayRepairRoute } from "@/hooks/use-gateway-repair-route";
import { routes } from "@/utils/routes";

function Harness() {
  useGatewayRepairRoute();
  return null;
}

describe("useGatewayRepairRoute", () => {
  beforeEach(() => {
    navigateMock.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  test("routes to the chooser when a guardian repair is required", () => {
    render(<Harness />);

    notifyGatewayRepairRequired();

    expect(navigateMock).toHaveBeenCalledTimes(1);
    expect(navigateMock).toHaveBeenCalledWith(routes.selectAssistant);
  });

  test("routes without the auto-skip opt-out, so a lone assistant reaches the repair unattended", () => {
    /**
     * The chooser auto-connects when exactly one assistant is installed,
     * and that connect is what raises the repair dialog. Adding
     * `noAutoSkip` here would leave the user on a one-row picker with no
     * hint that the row they are looking at is the broken one.
     */
    render(<Harness />);

    notifyGatewayRepairRequired();

    const [target] = navigateMock.mock.calls[0] as [string];
    expect(target).not.toContain("noAutoSkip");
  });

  test("stops listening once unmounted", () => {
    const { unmount } = render(<Harness />);
    unmount();

    notifyGatewayRepairRequired();

    expect(navigateMock).not.toHaveBeenCalled();
  });
});
