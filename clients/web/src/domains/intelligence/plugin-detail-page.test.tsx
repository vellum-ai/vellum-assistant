/**
 * Tests for the standalone plugin-detail route, a thin redirect shim: detail
 * renders in-tab via the `?plugin=<name>` deep-link on the My Superpowers
 * page, so the `/assistant/plugins/:name` URL forwards there to preserve the
 * bookmark/deep-link contract.
 *
 * Mounted via `@testing-library/react` (happy-dom — see `test-setup.ts`)
 * with sentinel routes at the redirect targets so the test can prove where
 * the shim lands. The active assistant id is stubbed and the identity store
 * is seeded per-test so the backwards-compat gate's branch is deterministic
 * (a plugin-capable version forwards in-tab; a too-old version lands on the
 * skills-only list without the deep-link).
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useSearchParams } from "react-router";

import { MIN_VERSION } from "@/lib/backwards-compat/plugins-surface";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";

const ASSISTANT_ID = "asst-1";

mock.module("@/assistant/use-active-assistant-id", () => ({
  useActiveAssistantId: () => ASSISTANT_ID,
}));

const { PluginDetailPage } =
  await import("@/domains/intelligence/plugin-detail-page");

// A sentinel for the My Superpowers landing that echoes the `?plugin=` param
// so the test can assert the redirect carried the name through as a deep-link.
function SuperpowersLanding() {
  const [searchParams] = useSearchParams();
  const plugin = searchParams.get("plugin");
  return (
    <div>{plugin ? `Superpowers: ${plugin}` : "Superpowers: (no plugin)"}</div>
  );
}

function renderAt(name: string): void {
  render(
    <MemoryRouter initialEntries={[`/assistant/plugins/${name}`]}>
      <Routes>
        <Route path="/assistant/plugins/:name" element={<PluginDetailPage />} />
        <Route
          path="/assistant/superpowers"
          element={<SuperpowersLanding />}
        />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
});

describe("PluginDetailPage redirect", () => {
  beforeEach(() => {
    useAssistantIdentityStore
      .getState()
      .setIdentity("Test Assistant", MIN_VERSION);
  });

  test("forwards /assistant/plugins/:name to the in-tab ?plugin= deep-link", () => {
    renderAt("caveman");

    expect(screen.getByText("Superpowers: caveman")).toBeDefined();
  });

  test("encodes the plugin name in the forwarded deep-link", () => {
    renderAt("scope%2Fname");

    // The decoded `:name` param round-trips back through encodeURIComponent
    // so the in-tab detail receives the literal plugin name.
    expect(screen.getByText("Superpowers: scope/name")).toBeDefined();
  });
});

describe("PluginDetailPage flag-off guard", () => {
  beforeEach(() => {
    // A version below the plugin-surface floor stands in for the old
    // flag-off / unsupported assistant: the route must still land on the
    // (skills-only) list rather than forwarding into a dead detail.
    useAssistantIdentityStore.getState().setIdentity("Old Assistant", "0.9.0");
  });

  test("drops the deep-link when the assistant predates the plugin routes", () => {
    renderAt("caveman");

    expect(screen.getByText("Superpowers: (no plugin)")).toBeDefined();
  });
});
