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
import {
  classifyIngressFailure,
  reportableError,
} from "@/domains/channels/hooks/use-channel-ingress";
import { assistantChannelIngressListQueryKey } from "@/generated/gateway/@tanstack/react-query.gen";
import type { PluginChannelSummary } from "@/types/channel-types";

const ASSISTANT_ID = "assistant-1";

const CHANNEL: PluginChannelSummary = {
  plugin: "courier",
  key: "plugins-courier",
  label: "Courier",
  description: "Reach the assistant by carrier pigeon.",
  icon: "send",
};

const ROUTES = [
  {
    path: "events",
    publicPath: "/webhooks/plugins/courier/events",
    signer: "plugin",
  },
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
        <PluginChannelPanel
          channel={CHANNEL}
          assistantId={ASSISTANT_ID}
          assistantDisplayName="Ada"
        />
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
    expect(document.body.textContent).toContain(
      "sees no ingress declaration for Courier",
    );
  });

  test("says the gateway sees no declaration rather than showing nothing", () => {
    // "Can anyone reach this channel" is the question the panel exists to
    // answer, so an absent answer has to read as an absent answer and not as
    // an absent feature.
    renderPanel([]);

    expect(document.body.textContent).toContain(
      "sees no ingress declaration for Courier",
    );
    expect(document.body.textContent).not.toContain("Approve ingress");
  });

  test("still offers a way through to the plugin either way", () => {
    // The panel's other job: a plugin owns its own setup surface, and this
    // client cannot render one it does not know the shape of.
    renderPanel([]);

    expect(document.body.textContent).toContain("Open plugin page");
  });

  test("does not claim a route is refused when approval does not govern it", () => {
    // The gateway serves a `vellum`-signed route out of a pending declaration,
    // so folding it into the refusal would tell a guardian that public ingress
    // is closed while it is open.
    renderPanel([
      {
        source: "courier",
        state: "pending",
        digest: "d".repeat(32),
        routes: [
          ...ROUTES,
          {
            path: "ours",
            publicPath: "/webhooks/plugins/courier/ours",
            signer: "vellum",
          },
        ],
      },
    ]);

    expect(document.body.textContent).toContain(
      "open whatever you decide, because only Vellum can reach them",
    );
    expect(document.body.textContent).toContain(
      "/webhooks/plugins/courier/ours",
    );
    expect(document.body.textContent).toContain(
      "deliveries to them are refused",
    );
  });

  test("says nothing about refusal when no address is approval-governed", () => {
    // Every route already open. There is a decision to record, but claiming
    // deliveries are refused would be false for all of them.
    renderPanel([
      {
        source: "courier",
        state: "pending",
        digest: "d".repeat(32),
        routes: [
          {
            path: "ours",
            publicPath: "/webhooks/plugins/courier/ours",
            signer: "vellum",
          },
        ],
      },
    ]);

    expect(document.body.textContent).not.toContain(
      "deliveries to them are refused",
    );
  });
});

describe("classifyIngressFailure", () => {
  test("tells a gateway with no such endpoint from a viewer who may not ask", () => {
    // The copy differs, and conflating them tells a guardian that only the
    // guardian may approve, which is false when they already are one.
    expect(classifyIngressFailure({ status: 404 })).toBe("unsupported");
    expect(classifyIngressFailure({ status: 501 })).toBe("unsupported");
    expect(classifyIngressFailure({ status: 403 })).toBe("forbidden");
    expect(classifyIngressFailure({ status: 401 })).toBe("forbidden");
  });

  test("treats anything else as a failed read rather than an answer", () => {
    // A 5xx or a dropped connection is transient. Reporting it as "no
    // declaration" would present an outage as a settled result.
    expect(classifyIngressFailure({ status: 500 })).toBe("unreadable");
    expect(classifyIngressFailure({ status: 502 })).toBe("unreadable");
    expect(classifyIngressFailure(new Error("network down"))).toBe(
      "unreadable",
    );
  });
});

describe("reportableError", () => {
  test("reports the read failure when the read is what failed", () => {
    // A refused decision outlives its request, so a rejected approval is still
    // present when a later refetch fails. Pairing "could not read the ingress
    // approval" with a digest-mismatch sentence explains nothing.
    const decision = new Error("Digest does not match");
    const read = new Error("Bad gateway");

    expect(reportableError("unreadable", read, decision)).toBe("Bad gateway");
  });

  test("reports the refused decision everywhere else", () => {
    const decision = new Error("Digest does not match");

    expect(reportableError("pending", undefined, decision)).toBe(
      "Digest does not match",
    );
    expect(reportableError("approved", undefined, decision)).toBe(
      "Digest does not match",
    );
  });

  test("says nothing when nothing failed", () => {
    expect(reportableError("approved", undefined, undefined)).toBeNull();
  });

  test("falls back to a sentence for a failure carrying no message", () => {
    // The generated client can reject with a plain object, which would
    // otherwise render as an empty line under the button.
    expect(reportableError("unreadable", { status: 500 }, undefined)).toBe(
      "Something went wrong",
    );
  });
});
