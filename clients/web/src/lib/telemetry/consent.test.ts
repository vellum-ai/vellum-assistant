/**
 * Truth table for the shared analytics emit gate: a local explicit opt-out
 * always wins; otherwise the server-adopted effective verdict decides, with
 * the opt-out default applying before the first sync. Runs against the real
 * onboarding store (like the funnel-events tests) — the gate is a pure read
 * over its state.
 */
import { beforeEach, describe, expect, test } from "bun:test";

import { useOnboardingStore } from "@/domains/onboarding/onboarding-store";
import { readAnalyticsConsent } from "@/lib/telemetry/consent";

beforeEach(() => {
  localStorage.clear();
  useOnboardingStore.setState({
    shareAnalytics: null,
    serverAnalyticsEffective: null,
  });
});

describe("readAnalyticsConsent", () => {
  const cases: Array<{
    local: boolean | null;
    server: boolean | null;
    expected: boolean;
    why: string;
  }> = [
    {
      local: false,
      server: null,
      expected: false,
      why: "local opt-out, pre-sync",
    },
    {
      local: false,
      server: true,
      expected: false,
      why: "local opt-out beats a server grant (write may be in flight)",
    },
    {
      local: false,
      server: false,
      expected: false,
      why: "local and server both off",
    },
    {
      local: null,
      server: null,
      expected: true,
      why: "pre-sync opt-out default",
    },
    { local: true, server: null, expected: true, why: "local grant, pre-sync" },
    {
      local: null,
      server: true,
      expected: true,
      why: "server verdict enabled",
    },
    { local: true, server: true, expected: true, why: "both enabled" },
    // The server-authority case: an effective opt-out is honored when the
    // local value is never-asked.
    {
      local: null,
      server: false,
      expected: false,
      why: "server-effective opt-out with never-asked local",
    },
    // A server-ADOPTED raw grant earns no override: with no pending local
    // edit, a divergent effective opt-out wins.
    {
      local: true,
      server: false,
      expected: false,
      why: "adopted raw grant never bypasses the effective opt-out",
    },
  ];

  for (const { local, server, expected, why } of cases) {
    test(`local ${String(local)} + serverEffective ${String(server)} → ${String(expected)} (${why})`, () => {
      useOnboardingStore.setState({
        shareAnalytics: local,
        serverAnalyticsEffective: server,
        pendingAnalyticsOptIn: false,
      });
      expect(readAnalyticsConsent()).toBe(expected);
    });
  }

  test("a PENDING local opt-in re-enables immediately over a stale server-effective opt-out", () => {
    useOnboardingStore.setState({
      shareAnalytics: true,
      serverAnalyticsEffective: false,
      pendingAnalyticsOptIn: true,
    });
    expect(readAnalyticsConsent()).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Pending-flag lifecycle matrix. The gate cases above cover READS; this
  // table pins the WRITE/lifecycle contract implemented across
  // consent-persistence (set on explicit local writes), auth-store /
  // consent-refresh (cleared only on server reflection), and auth-store's
  // account-change reset. Each row names the owning module so a transition
  // regression points at its home.
  //
  // | transition                                   | pending after | owner              |
  // | explicit local opt-in written                | true          | writeConsent       |
  // | explicit local opt-out written               | false         | writeConsent       |
  // | sync: record reflects opt-in (raw true)      | false         | auth-store/refresh |
  // | sync: stale record (raw null/false)          | unchanged     | auth-store/refresh |
  // | account switch (incl. to signed-out)         | false         | auth-store         |
  // | same-user resync, unreflected                | unchanged     | auth-store         |
  //
  // The corresponding behavior pins live beside their owners:
  // consent-persistence.test.ts (write path), consent-refresh.test.ts
  // (reflection + stale-record race), auth-store.test.ts (reflection,
  // account switch, same-user preservation, unconditional verdict adoption).
  // -------------------------------------------------------------------------

  test("an explicit opt-out wins even while an older pending opt-in flag lingers", () => {
    useOnboardingStore.setState({
      shareAnalytics: false,
      serverAnalyticsEffective: true,
      pendingAnalyticsOptIn: true,
    });
    expect(readAnalyticsConsent()).toBe(false);
  });
});
