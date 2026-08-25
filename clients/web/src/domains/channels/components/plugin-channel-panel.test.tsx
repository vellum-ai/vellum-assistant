/**
 * The plugin channel detail panel, and the ingress decision it carries.
 *
 * The ingress query is seeded through the react-query cache rather than
 * mocked, so the real hook runs and the generated query key stays part of what
 * is under test: a key that drifted from the one the hook reads would leave
 * the panel permanently blank, which is exactly the bug worth catching.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router";

import { PluginChannelPanel } from "@/domains/channels/components/plugin-channel-panel";
import {
  classifyIngressFailure,
  reportableError,
} from "@/domains/channels/hooks/use-channel-ingress";
import {
  assistantChannelAdmissionPolicyListQueryKey,
  assistantChannelIngressListQueryKey,
} from "@/generated/gateway/@tanstack/react-query.gen";
import * as admissionApi from "@/lib/channel-admission-policy/api";
import type { AdmissionPolicy } from "@/lib/channel-admission-policy/types";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";
import type { PluginChannelSummary } from "@/types/channel-types";

/**
 * Spy on the floor write so the trust-floor tests can assert what was (not)
 * persisted; everything else in the module stays real.
 */
const setChannelPolicy = mock<(typeof admissionApi)["setChannelPolicy"]>(
  async () => ({
    channelType: "plugin",
    policy: "strangers",
    note: null,
    updatedAt: null,
  }),
);

mock.module("@/lib/channel-admission-policy/api", (): typeof admissionApi => ({
  ...admissionApi,
  setChannelPolicy,
}));

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
  useAssistantIdentityStore.getState().clearIdentity();
  setChannelPolicy.mockClear();
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
  test("offers approval without listing the routes it opens", () => {
    renderPanel([
      {
        source: "courier",
        state: "pending",
        digest: "d".repeat(32),
        routes: ROUTES,
      },
    ]);

    expect(document.body.textContent).toContain("Ingress awaiting approval");
    expect(document.body.textContent).toContain("Approve Channel");
    expect(document.body.textContent).not.toContain(
      "/webhooks/plugins/courier/events",
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
    expect(document.body.textContent).toContain("Revoke Channel");
    expect(document.body.textContent).not.toContain("Approve Channel");
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
    expect(document.body.textContent).not.toContain("Revoke Channel");
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
    expect(document.body.textContent).not.toContain("Approve Channel");
  });

  test("still offers a way through to the plugin either way", () => {
    // The panel's other job: a plugin owns its own setup surface, and this
    // client cannot render one it does not know the shape of.
    renderPanel([]);

    expect(
      document.body.querySelector('[aria-label="Navigate to plugin page"]'),
    ).toBeTruthy();
  });
});

describe("PluginChannelPanel trust floor", () => {
  /**
   * Renders the panel with the floor surface live: an assistant version past
   * the trust-floors gate and the admission-policy list already in the cache.
   * `staleTime: Infinity` keeps the seeded entry from being refetched against
   * a gateway that isn't there.
   */
  function renderPanelWithFloor(policy: AdmissionPolicy) {
    useAssistantIdentityStore
      .getState()
      .setIdentity("Ada", "0.10.0", ASSISTANT_ID);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    queryClient.setQueryData(
      assistantChannelAdmissionPolicyListQueryKey({
        path: { assistant_id: ASSISTANT_ID },
      }),
      {
        policies: [
          { channelType: "plugin", policy, note: null, updatedAt: null },
        ],
      },
    );
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

  function pickFloor(label: string) {
    const trigger = document.querySelector<HTMLElement>(
      '[data-slot="select-trigger"]',
    );
    if (!trigger) {
      throw new Error("No trust-floor dropdown rendered");
    }
    fireEvent.click(trigger);
    const option = Array.from(
      document.querySelectorAll<HTMLElement>('[role="option"]'),
    ).find((el) => el.textContent?.startsWith(label));
    if (!option) {
      throw new Error(`No option labeled "${label}"`);
    }
    fireEvent.click(option);
  }

  test("loosening the floor asks first, parity with built-in channels", async () => {
    // The floor is workspace-wide (one `plugin` row covers every plugin
    // channel), so an unconfirmed pick would persist a loosening across
    // all of them at once.
    renderPanelWithFloor("guardian_only");

    pickFloor("Strangers");
    expect(document.body.textContent).toContain("Allow strangers?");

    // `mutate` runs its function a microtask later, so flush before asserting
    // the pick alone wrote nothing.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(setChannelPolicy).not.toHaveBeenCalled();

    const confirm = document.querySelector<HTMLButtonElement>(
      "[data-confirm-dialog-confirm]",
    );
    expect(confirm).not.toBeNull();
    fireEvent.click(confirm!);

    await waitFor(() =>
      expect(setChannelPolicy.mock.calls).toEqual([
        [ASSISTANT_ID, "plugin", "strangers"],
      ]),
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
