/**
 * The plugin channel detail panel, and the ingress decision it carries.
 *
 * The ingress query is seeded through the react-query cache rather than
 * mocked, so the real hook runs and the generated query key stays part of what
 * is under test: a key that drifted from the one the hook reads would leave
 * the panel permanently blank, which is exactly the bug worth catching.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";
import { MemoryRouter } from "react-router";

import { PluginChannelPanel } from "@/domains/channels/components/plugin-channel-panel";
import { assistantChannelIngressListQueryKey } from "@/generated/gateway/@tanstack/react-query.gen";
import type { PluginChannelSummary } from "@/types/channel-types";

const ASSISTANT_ID = "assistant-1";

const CHANNEL: PluginChannelSummary = {
  id: "courier",
  label: "Courier",
  description: "Reach the assistant by carrier pigeon.",
  icon: "send",
};

const ROUTES = [
  { path: "events", publicPath: "/webhooks/plugins/courier/events" },
];

afterEach(() => {
  cleanup();
});

/** Renders the panel with `sources` already in the ingress cache. */
function renderPanel(sources?: unknown[]) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  if (sources) {
    queryClient.setQueryData(
      assistantChannelIngressListQueryKey({
        path: { assistant_id: ASSISTANT_ID },
      }),
      { sources, problems: [] },
    );
  }
  return render(
    <MemoryRouter>
      <QueryClientProvider client={queryClient}>
        <PluginChannelPanel channel={CHANNEL} assistantId={ASSISTANT_ID} />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe("PluginChannelPanel", () => {
  test("offers approval, and says what approving opens", () => {
    // Approving exposes these paths to the public internet, so the panel
    // names them rather than describing the grant in the abstract.
    renderPanel([
      {
        source: "courier",
        state: "pending",
        digest: "d".repeat(32),
        routes: ROUTES,
      },
    ]);

    expect(document.body.textContent).toContain("Ingress awaiting approval");
    expect(document.body.textContent).toContain("Approve ingress");
    expect(document.body.textContent).toContain(
      "/webhooks/plugins/courier/events",
    );
  });

  test("says deliveries are refused while a declaration waits", () => {
    // The consequence a guardian is deciding about. Without it, "awaiting
    // approval" reads as a formality rather than as inbound being down.
    renderPanel([
      {
        source: "courier",
        state: "pending",
        digest: "d".repeat(32),
        routes: ROUTES,
      },
    ]);

    expect(document.body.textContent).toContain(
      "deliveries to them are refused",
    );
  });

  test("offers revocation once approved", () => {
    renderPanel([
      {
        source: "courier",
        state: "approved",
        digest: "d".repeat(32),
        routes: ROUTES,
      },
    ]);

    expect(document.body.textContent).toContain("Ingress approved");
    expect(document.body.textContent).toContain("Revoke ingress");
    expect(document.body.textContent).not.toContain("Approve ingress");
  });

  test("reads the decision for its own plugin, not a sibling's", () => {
    // One listing covers every plugin, so picking the wrong row would show a
    // guardian someone else's grant and let them revoke it from here.
    renderPanel([
      {
        source: "other",
        state: "approved",
        digest: "d".repeat(32),
        routes: ROUTES,
      },
    ]);

    expect(document.body.textContent).not.toContain("Ingress approved");
    expect(document.body.textContent).not.toContain("Revoke ingress");
  });

  test("shows no decision when the gateway cannot answer", () => {
    // An older gateway 404s the endpoint and a non-guardian gets a 403.
    // Neither has a decision to offer, so the panel stays a description
    // rather than reporting a failure the viewer cannot act on.
    renderPanel();

    expect(document.body.textContent).not.toContain("Approve ingress");
    expect(document.body.textContent).not.toContain("Revoke ingress");
  });

  test("still offers a way through to the plugin either way", () => {
    // The panel's other job: a plugin owns its own setup surface, and this
    // client cannot render one it does not know the shape of.
    renderPanel();

    expect(document.body.textContent).toContain("Open Courier settings");
  });
});
