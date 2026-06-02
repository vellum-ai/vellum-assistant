import { afterEach, describe, expect, test } from "bun:test";

import { getLifecycleDiagnosticsEvents } from "@/lib/diagnostics";
import { __resetForTesting, publish } from "@/lib/event-bus";
import { subscribeLifecycleDiagnostics } from "@/lib/lifecycle-diagnostics";

afterEach(() => {
  __resetForTesting();
});

describe("subscribeLifecycleDiagnostics", () => {
  test("records app.resume with its signal into the lifecycle ring", () => {
    // GIVEN the lifecycle recorder is attached to the bus
    const before = getLifecycleDiagnosticsEvents().length;
    const unsubscribe = subscribeLifecycleDiagnostics();

    // WHEN a resume signal is published
    publish("app.resume", { signal: "visibility" });

    // THEN it is recorded with the signal preserved
    const recorded = getLifecycleDiagnosticsEvents().slice(before);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.kind).toBe("app.resume");
    expect(recorded[0]!.details.signal).toBe("visibility");

    unsubscribe();
  });

  test("records hidden, network, and power transitions", () => {
    // GIVEN the lifecycle recorder is attached to the bus
    const before = getLifecycleDiagnosticsEvents().length;
    const unsubscribe = subscribeLifecycleDiagnostics();

    // WHEN a range of lifecycle signals fire
    publish("app.hidden", { signal: "visibility" });
    publish("app.offline", {});
    publish("app.online", {});
    publish("power.suspend", {});
    publish("power.resume", {});

    // THEN every signal lands in the lifecycle ring in order
    const kinds = getLifecycleDiagnosticsEvents()
      .slice(before)
      .map((event) => event.kind);
    expect(kinds).toEqual([
      "app.hidden",
      "app.offline",
      "app.online",
      "power.suspend",
      "power.resume",
    ]);

    unsubscribe();
  });

  test("stops recording after unsubscribe", () => {
    // GIVEN the recorder was attached and then torn down
    const unsubscribe = subscribeLifecycleDiagnostics();
    unsubscribe();
    const before = getLifecycleDiagnosticsEvents().length;

    // WHEN a signal fires after unsubscribe
    publish("app.resume", { signal: "online" });

    // THEN nothing new is recorded
    expect(getLifecycleDiagnosticsEvents().length).toBe(before);
  });
});
