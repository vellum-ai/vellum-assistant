import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { z } from "zod";

// In-memory settings store shared by the mock below.
let store: Record<string, unknown> = {};
mock.module("./settings", () => ({
  writeSetting: (key: string, value: unknown) => {
    store[key] = value;
  },
}));

// Capture the `on` registrations and the schema each is installed with, so we
// can drive the handler body and assert the schema rejects malformed payloads.
// The sender-origin guard inside the real `on` is covered by `ipc.test.ts`.
type Registration = {
  channel: string;
  schema: z.ZodType<unknown[]>;
  fn: (args: unknown[]) => unknown;
};
const onRegistrations: Registration[] = [];
// `handle` is included (as a no-op) even though `feature-flags.ts` only uses
// `on`: this mock leaks into co-run test files via the global module registry,
// so the full `./ipc` surface keeps siblings that import `handle` (e.g.
// `hotkeys.ts`) resolvable regardless of file order.
mock.module("./ipc", () => ({
  on: (
    channel: string,
    schema: z.ZodType<unknown[]>,
    fn: (args: unknown[]) => unknown,
  ) => {
    onRegistrations.push({ channel, schema, fn });
  },
  handle: () => {},
}));

const { installFeatureFlagsIpc } = await import("./feature-flags");

const registrationFor = (channel: string): Registration => {
  const registration = onRegistrations.find((r) => r.channel === channel);
  if (!registration) throw new Error(`No handler for ${channel}`);
  return registration;
};

beforeEach(() => {
  store = {};
  onRegistrations.length = 0;
  installFeatureFlagsIpc();
});

describe("vellum:featureFlags:set", () => {
  test("persists the published flag map", () => {
    registrationFor("vellum:featureFlags:set").fn([{ sounds: true, voice: false }]);
    expect(store["featureFlags"]).toEqual({ sounds: true, voice: false });
  });

  test("accepts an empty map", () => {
    const { schema } = registrationFor("vellum:featureFlags:set");
    expect(schema.safeParse([{}]).success).toBe(true);
  });

  test("rejects non-boolean flag values", () => {
    const { schema } = registrationFor("vellum:featureFlags:set");
    expect(schema.safeParse([{ sounds: "yes" }]).success).toBe(false);
  });

  test("rejects a missing payload", () => {
    const { schema } = registrationFor("vellum:featureFlags:set");
    expect(schema.safeParse([]).success).toBe(false);
  });
});
