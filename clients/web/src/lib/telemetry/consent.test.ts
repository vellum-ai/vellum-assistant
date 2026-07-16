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
    // An explicit local choice wins in both directions: sync adopts the
    // server's raw value into the store, so local true + effective false
    // only exists while a local opt-in's server write is in flight — it
    // must re-enable immediately, not on the next sync.
    {
      local: true,
      server: false,
      expected: true,
      why: "mid-flight local opt-in wins over the cached server verdict",
    },
  ];

  for (const { local, server, expected, why } of cases) {
    test(`local ${String(local)} + serverEffective ${String(server)} → ${String(expected)} (${why})`, () => {
      useOnboardingStore.setState({
        shareAnalytics: local,
        serverAnalyticsEffective: server,
      });
      expect(readAnalyticsConsent()).toBe(expected);
    });
  }
});
