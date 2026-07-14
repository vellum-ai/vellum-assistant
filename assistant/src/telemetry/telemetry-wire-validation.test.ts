/**
 * Tests for pre-flush telemetry wire validation.
 *
 * Validation is observability only — it must count and warn, never mutate,
 * filter, or block — and its warn payloads must carry the event type and
 * issue `{ path, code }` shapes only, never field values. `daemon_event_id`
 * is a field value too: activation-funnel ids embed the onboarding session
 * id (traces/claims can hold PII). Issue paths are sanitized as well: dynamic
 * record keys (e.g. `client` bag keys) are redacted to `*` before logging.
 */
import { beforeEach, describe, expect, test } from "bun:test";

import type { Logger } from "pino";

import {
  makeOnboardingResearchEvent,
  turnEventSample,
  wireEventSamples,
} from "./__tests__/telemetry-event-fixtures.js";
import { telemetryEventSchema } from "./telemetry-wire.generated.js";
import {
  resetUnknownTypeWarningsForTests,
  validateWireEvents,
} from "./telemetry-wire-validation.js";

let warnCalls: unknown[][] = [];
const stubLog = {
  warn: (...args: unknown[]) => {
    warnCalls.push(args);
  },
} as unknown as Logger;

describe("validateWireEvents", () => {
  beforeEach(() => {
    warnCalls = [];
    resetUnknownTypeWarningsForTests();
  });

  test("a valid event of each wire type passes with no warnings", () => {
    // Fixture coverage: one sample per generated union discriminator (with a
    // floor of the 9 shipped types), so a new wire type without a fixture —
    // or a shrunken union — turns this red.
    const discriminators = telemetryEventSchema.options.map(
      (option) => option.shape.type.value,
    );
    expect(discriminators.length).toBeGreaterThanOrEqual(9);
    expect(new Set(wireEventSamples.map((event) => event.type))).toEqual(
      new Set(discriminators),
    );

    const result = validateWireEvents(wireEventSamples, stubLog);
    expect(result).toEqual({
      checked: wireEventSamples.length,
      invalid: 0,
      unknownTypes: [],
    });
    expect(warnCalls).toHaveLength(0);
  });

  test("invalid events are counted and warned with {path, code} issues and no field values", () => {
    const sentinel = "SENTINEL_PII_VALUE_do_not_log";
    const invalidTurn = {
      ...turnEventSample,
      // Nested object values violate the wire contract's client bounds; the
      // sentinel must never appear in any warn payload.
      client: { nested: { secret: sentinel } },
    };
    const invalidLifecycle = {
      type: "lifecycle",
      // Mirrors the activation-funnel id shape (`version:sessionId:step`),
      // which embeds the onboarding session id and exceeds the wire schema's
      // 36-char daemon_event_id bound — the id itself must never be logged.
      daemon_event_id: `activation_v1_2026_06:${sentinel}:activation_moment_1_complete`,
      recorded_at: 1_700_000_000_011,
      assistant_version: sentinel,
      // event_name is missing.
    };

    const result = validateWireEvents([invalidTurn, invalidLifecycle], stubLog);
    expect(result).toEqual({ checked: 2, invalid: 2, unknownTypes: [] });
    expect(warnCalls).toHaveLength(2);

    for (const call of warnCalls) {
      const bag = call[0] as {
        eventType: string;
        issues: Array<Record<string, unknown>>;
      };
      // The bag carries the event type and issues only — no daemon_event_id
      // (it is a payload value; activation ids embed the session id).
      expect(Object.keys(bag).sort()).toEqual(["eventType", "issues"]);
      expect(bag.issues.length).toBeGreaterThan(0);
      for (const issue of bag.issues) {
        // Issues carry path + code only — never messages or field values.
        expect(Object.keys(issue).sort()).toEqual(["code", "path"]);
        expect(issue.path).toBeString();
        expect(issue.code).toBeString();
      }
    }
    expect(
      (warnCalls[0][0] as { issues: Array<{ path: string }> }).issues[0].path,
    ).toStartWith("client");
    const lifecyclePaths = (
      warnCalls[1][0] as { issues: Array<{ path: string }> }
    ).issues.map((issue) => issue.path);
    expect(lifecyclePaths).toContain("daemon_event_id");
    expect(lifecyclePaths).toContain("event_name");

    // The planted sentinel (a field value) must be absent from all log args.
    expect(JSON.stringify(warnCalls)).not.toInclude(sentinel);
  });

  test("dynamic record keys in issue paths are redacted to *", () => {
    const sentinel = "sentinel-user@example.com";
    const invalidTurn = {
      ...turnEventSample,
      // The client bag's keys come from an uncontrolled JSON metadata column;
      // the superRefine emits issues at ['client', <key>], so a key carrying
      // user text must be redacted from the logged path. The nested object
      // value makes the bag invalid.
      client: { [sentinel]: { nested: true } },
    };

    const result = validateWireEvents([invalidTurn], stubLog);
    expect(result).toEqual({ checked: 1, invalid: 1, unknownTypes: [] });
    expect(warnCalls).toHaveLength(1);

    const bag = warnCalls[0][0] as { issues: Array<{ path: string }> };
    // The dynamic key component is replaced with a literal `*`; the
    // schema-defined depth-0 component (`client`) is kept.
    expect(bag.issues.map((issue) => issue.path)).toContain("client.*");
    expect(JSON.stringify(warnCalls)).not.toInclude(sentinel);
  });

  test("unknown event types are reported and warned once per process per type", () => {
    const first = validateWireEvents([makeOnboardingResearchEvent()], stubLog);
    const second = validateWireEvents([makeOnboardingResearchEvent()], stubLog);

    expect(first).toEqual({
      checked: 0,
      invalid: 0,
      unknownTypes: ["onboarding_research"],
    });
    expect(second.unknownTypes).toEqual(["onboarding_research"]);

    // Rate-limited: the warn fires exactly once across both calls.
    expect(warnCalls).toHaveLength(1);
    expect(warnCalls[0][0]).toEqual({ eventType: "onboarding_research" });
  });
});
