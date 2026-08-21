import { afterEach, describe, expect, test } from "bun:test";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { TunnelStatusRow, type TunnelStatusView } from "./tunnel-status-row";

const PUBLIC_URL = "https://foo.ts.net";
const REFRESH_LABEL = "Check the tunnel again";

function renderRow(
  status: TunnelStatusView,
  { isRefreshing = false }: { isRefreshing?: boolean } = {},
) {
  const calls: number[] = [];
  const result = render(
    <TunnelStatusRow
      status={status}
      onRefresh={() => calls.push(1)}
      isRefreshing={isRefreshing}
    />,
  );
  return { calls, result };
}

function refreshButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: REFRESH_LABEL });
}

afterEach(cleanup);

describe("TunnelStatusRow", () => {
  test("renders nothing while the tunnel was never configured", () => {
    const { result } = renderRow({ kind: "unconfigured" });
    expect(result.container.innerHTML).toBe("");
  });

  test("renders nothing when the probe has no verdict to report", () => {
    const { result } = renderRow({ kind: "unavailable" });
    expect(result.container.innerHTML).toBe("");
  });

  test("names the probe in flight and disables the refresh", () => {
    renderRow({ kind: "checking" });

    expect(
      screen.getByText("Checking whether the tunnel is reachable…"),
    ).toBeDefined();
    expect(refreshButton().disabled).toBe(true);
  });

  test("reports a healthy tunnel with its address and check age", () => {
    renderRow({
      kind: "healthy",
      publicBaseUrl: PUBLIC_URL,
      checkedAt: new Date(Date.now() - 5_000).toISOString(),
    });

    expect(
      screen.getByText("The tunnel is running and reachable."),
    ).toBeDefined();
    expect(screen.getByText(PUBLIC_URL)).toBeDefined();
    expect(screen.getByText("Checked 5 seconds ago")).toBeDefined();
  });

  test("reports an unreachable address", () => {
    renderRow({
      kind: "unreachable",
      publicBaseUrl: PUBLIC_URL,
      checkedAt: new Date().toISOString(),
    });

    expect(
      screen.getByText("This address is not answering right now."),
    ).toBeDefined();
    expect(screen.getByText(PUBLIC_URL)).toBeDefined();
  });

  test("names the assistant a foreign edge is serving", () => {
    renderRow({
      kind: "foreign",
      publicBaseUrl: PUBLIC_URL,
      checkedAt: new Date().toISOString(),
      servingAssistantName: "Jarvis",
    });

    expect(
      screen.getByText(
        "This address is serving Jarvis right now, not this assistant.",
      ),
    ).toBeDefined();
  });

  test("falls back to an unnamed foreign edge", () => {
    renderRow({
      kind: "foreign",
      publicBaseUrl: PUBLIC_URL,
      checkedAt: new Date().toISOString(),
    });

    expect(
      screen.getByText(
        "This address is serving a different assistant right now.",
      ),
    ).toBeDefined();
  });

  test("prints the provider's restart command when the tunnel is stopped", () => {
    renderRow({
      kind: "stopped",
      provider: "cloudflare",
      publicBaseUrl: PUBLIC_URL,
    });

    expect(
      screen.getByText(
        "The tunnel is stopped, so other devices cannot reach this assistant.",
      ),
    ).toBeDefined();
    expect(
      screen.getByText("vellum tunnel --provider cloudflare"),
    ).toBeDefined();
    expect(screen.getByText(PUBLIC_URL)).toBeDefined();
  });

  test("refreshing calls back to the owner", () => {
    const { calls } = renderRow({
      kind: "healthy",
      publicBaseUrl: PUBLIC_URL,
      checkedAt: new Date().toISOString(),
    });

    fireEvent.click(refreshButton());

    expect(calls.length).toBe(1);
  });

  test("disables the refresh while a refetch is in flight", () => {
    renderRow(
      {
        kind: "unreachable",
        publicBaseUrl: PUBLIC_URL,
        checkedAt: new Date().toISOString(),
      },
      { isRefreshing: true },
    );

    expect(refreshButton().disabled).toBe(true);
  });
});
