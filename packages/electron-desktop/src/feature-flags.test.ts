import { beforeEach, describe, expect, test } from "bun:test";

import type { z } from "zod";

let store: Record<string, unknown> = {};

type Registration = {
  channel: string;
  schema: z.ZodType<unknown[]>;
  fn: (args: unknown[]) => unknown;
};
const onRegistrations: Registration[] = [];
const ipc = {
  on: <Args extends unknown[]>(
    channel: string,
    schema: z.ZodType<Args>,
    fn: (args: Args) => unknown,
  ): void => {
    onRegistrations.push({
      channel,
      schema: schema as z.ZodType<unknown[]>,
      fn: fn as (args: unknown[]) => unknown,
    });
  },
};

const { installFeatureFlagsIpc } = await import("./feature-flags");

const registrationFor = (channel: string): Registration => {
  const registration = onRegistrations.find((r) => r.channel === channel);
  if (!registration) {
    throw new Error(`No handler for ${channel}`);
  }
  return registration;
};

beforeEach(() => {
  store = {};
  onRegistrations.length = 0;
  installFeatureFlagsIpc(ipc, {
    write: (flags) => {
      store["featureFlags"] = flags;
    },
  });
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

  test("replaces stale flags on refresh", () => {
    const registration = registrationFor("vellum:featureFlags:set");
    registration.fn([{ oldFlag: true }]);
    registration.fn([{ newFlag: false }]);
    expect(store["featureFlags"]).toEqual({ newFlag: false });
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
