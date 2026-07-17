import { describe, expect, test } from "bun:test";

import {
  turnEventSample,
  wireEventSamples,
} from "./__tests__/telemetry-event-fixtures.js";
import { telemetryEventSchema } from "./telemetry-wire.generated.js";
import type { TurnTelemetryEvent } from "./types.js";

// Runtime contract test: events constructed with the daemon's types (the
// shared fixtures are annotated with them) must parse against the generated
// wire schemas — the same validation the platform's ingest serializers
// apply. A daemon type whose values can't round-trip through
// `telemetryEventSchema` produces events the server silently drops.

describe("daemon telemetry types against the wire contract", () => {
  for (const sample of wireEventSamples) {
    test(`daemon-typed ${sample.type} event parses against the wire schema`, () => {
      const result = telemetryEventSchema.safeParse(sample);
      expect(result.error).toBeUndefined();
      expect(result.success).toBe(true);
    });
  }

  test("turn client bag with a nested value fails the wire superRefine", () => {
    // Structurally valid for the daemon's `TurnTelemetryClientInfo` (extra
    // properties are allowed outside fresh-literal checks), but the wire
    // schema mirrors the server's validate_client: nested objects in the
    // `client` bag reject the event at ingest.
    const nestedClient = { os: "macos", screen: { width: 1512, height: 982 } };
    const invalidTurn: TurnTelemetryEvent = {
      ...turnEventSample,
      client: nestedClient,
    };
    const result = telemetryEventSchema.safeParse(invalidTurn);
    expect(result.success).toBe(false);
  });
});
