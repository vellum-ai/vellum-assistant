import { afterEach, describe, expect, test } from "bun:test";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import {
  statusPublicBaseUrl,
  TunnelStatusRow,
  tunnelStartCommand,
  type TunnelStatusView,
} from "./tunnel-status-row";

const PUBLIC_URL = "https://foo.ts.net";
const REFRESH_LABEL = "Check the tunnel again";

function renderRow(
  status: TunnelStatusView,
  {
    isRefreshing = false,
    assistantName = null,
  }: { isRefreshing?: boolean; assistantName?: string | null } = {},
) {
  const calls: number[] = [];
  const result = render(
    <TunnelStatusRow
      status={status}
      onRefresh={() => calls.push(1)}
      isRefreshing={isRefreshing}
      assistantName={assistantName}
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
    renderRow({ kind: "checking" }, { isRefreshing: true });

    expect(
      screen.getByText("Checking whether the tunnel is reachable…"),
    ).toBeDefined();
    expect(refreshButton().disabled).toBe(true);
  });

  test("reports a healthy tunnel with its address and check age", () => {
    renderRow({
      kind: "healthy",
      publicBaseUrl: PUBLIC_URL,
      checkedAt: new Date(Date.now() - 2 * 60_000).toISOString(),
    });

    expect(
      screen.getByText("The tunnel is running and reachable."),
    ).toBeDefined();
    expect(screen.getByText(PUBLIC_URL)).toBeDefined();
    expect(screen.getByText("Checked 2 minutes ago")).toBeDefined();
  });

  // The card re-renders the age on a 30s tick, so the label is phrased in
  // minutes; anything fresher reads as "now" rather than a stale second count.
  test("phrases a just-finished check as now", () => {
    renderRow({
      kind: "healthy",
      publicBaseUrl: PUBLIC_URL,
      checkedAt: new Date(Date.now() - 5_000).toISOString(),
    });

    expect(screen.getByText("Checked now")).toBeDefined();
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

  test("shows the daemon's reason beside the unreachable sentence", () => {
    renderRow({
      kind: "unreachable",
      publicBaseUrl: PUBLIC_URL,
      checkedAt: new Date().toISOString(),
      detail: "connection refused",
    });

    expect(screen.getByText("connection refused")).toBeDefined();
  });

  test("tells an unreachable tunnel how to start again", () => {
    renderRow({
      kind: "unreachable",
      publicBaseUrl: PUBLIC_URL,
      checkedAt: new Date().toISOString(),
      provider: "tailscale",
    });

    expect(screen.getByText(/Start this assistant's tunnel again/)).toBeDefined();
    expect(screen.getByText("vellum tunnel --provider tailscale")).toBeDefined();
  });

  test("reports an address that answers without serving the pairing app", () => {
    renderRow({
      kind: "unpairable",
      publicBaseUrl: PUBLIC_URL,
      checkedAt: new Date().toISOString(),
      detail: "HTTP 404",
      provider: "tailscale",
    });

    expect(
      screen.getByText(
        "This address answers, but it is not serving the pairing app. Start a tunnel with the web app enabled so pairing links open.",
      ),
    ).toBeDefined();
    expect(screen.getByText("HTTP 404")).toBeDefined();
    expect(screen.getByText(/Start this assistant's tunnel again/)).toBeDefined();
    expect(screen.getByText("vellum tunnel --provider tailscale")).toBeDefined();
    expect(screen.getByText(PUBLIC_URL)).toBeDefined();
  });

  test("tells a foreign edge how to start this assistant's tunnel again", () => {
    renderRow({
      kind: "foreign",
      publicBaseUrl: PUBLIC_URL,
      checkedAt: new Date().toISOString(),
      provider: "ngrok",
    });

    expect(screen.getByText("vellum tunnel --provider ngrok")).toBeDefined();
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

  // A computer running several assistants would otherwise be told to run a
  // command that starts a tunnel for whichever one is active.
  test("names the assistant in the restart command", () => {
    renderRow(
      { kind: "stopped", provider: "tailscale", publicBaseUrl: PUBLIC_URL },
      { assistantName: "jarvis" },
    );

    expect(
      screen.getByText("vellum tunnel jarvis --provider tailscale"),
    ).toBeDefined();
  });

  test("quotes an assistant name with whitespace in it", () => {
    renderRow(
      { kind: "stopped", provider: "tailscale", publicBaseUrl: PUBLIC_URL },
      { assistantName: "My Assistant" },
    );

    expect(
      screen.getByText("vellum tunnel 'My Assistant' --provider tailscale"),
    ).toBeDefined();
  });

  // Reachable whenever ingress is switched off with no tunnel on record: the
  // daemon still answered "stopped", so the row reports it rather than
  // leaving the card to re-advertise an address nothing is serving.
  test("reports a stopped tunnel the daemon remembers nothing about", () => {
    renderRow({ kind: "stopped" });

    expect(
      screen.getByText(
        "The tunnel is stopped, so other devices cannot reach this assistant.",
      ),
    ).toBeDefined();
    // No provider to name, so no restart command and no address.
    expect(screen.queryByText(/vellum tunnel/)).toBeNull();
    expect(screen.queryByText(PUBLIC_URL)).toBeNull();
    expect(refreshButton().disabled).toBe(false);
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

// Assistant names are free-form user text and this string is offered for
// pasting into a terminal, so anything the shell would act on has to be inert.
describe("tunnelStartCommand", () => {
  test("leaves a plain name unquoted", () => {
    expect(tunnelStartCommand("tailscale", "jarvis-2.0_beta")).toBe(
      "vellum tunnel jarvis-2.0_beta --provider tailscale",
    );
  });

  test("neutralizes a command separator", () => {
    expect(tunnelStartCommand("tailscale", "Bob&Alice")).toBe(
      "vellum tunnel 'Bob&Alice' --provider tailscale",
    );
  });

  test("neutralizes variable expansion", () => {
    expect(tunnelStartCommand("tailscale", "My $team")).toBe(
      "vellum tunnel 'My $team' --provider tailscale",
    );
  });

  test("neutralizes command substitution", () => {
    expect(tunnelStartCommand("tailscale", "a`whoami`")).toBe(
      "vellum tunnel 'a`whoami`' --provider tailscale",
    );
  });

  test("closes, escapes and reopens around an embedded single quote", () => {
    expect(tunnelStartCommand("tailscale", "Bob's box")).toBe(
      "vellum tunnel 'Bob'\\''s box' --provider tailscale",
    );
  });

  test("keeps a name with whitespace one argument", () => {
    expect(tunnelStartCommand("ngrok", "My Assistant")).toBe(
      "vellum tunnel 'My Assistant' --provider ngrok",
    );
  });

  test("omits the name when none is known", () => {
    expect(tunnelStartCommand("cloudflare", null)).toBe(
      "vellum tunnel --provider cloudflare",
    );
  });
});

describe("statusPublicBaseUrl", () => {
  test("reports the address a probed state carries", () => {
    expect(
      statusPublicBaseUrl({
        kind: "healthy",
        publicBaseUrl: PUBLIC_URL,
        checkedAt: "",
      }),
    ).toBe(PUBLIC_URL);
  });

  // The wire marks the field optional across every state, so a probed verdict
  // without one must read as "no address" rather than as an empty one: the
  // card decides whether to lead with the URL field on this answer.
  test("reports no address when the daemon reported an empty one", () => {
    expect(
      statusPublicBaseUrl({
        kind: "healthy",
        publicBaseUrl: "",
        checkedAt: "",
      }),
    ).toBeNull();
  });

  test("reports no address for the states carrying none", () => {
    expect(statusPublicBaseUrl({ kind: "unconfigured" })).toBeNull();
  });
});
