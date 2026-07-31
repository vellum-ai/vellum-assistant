import { describe, expect, test } from "bun:test";

import { UserRoutesConfigSchema } from "../user-routes.js";

describe("UserRoutesConfigSchema", () => {
  test("defaults host.enabled to false", () => {
    expect(UserRoutesConfigSchema.parse({})).toEqual({
      host: { enabled: false },
    });
  });

  test("accepts host.enabled: true", () => {
    expect(UserRoutesConfigSchema.parse({ host: { enabled: true } })).toEqual({
      host: { enabled: true },
    });
  });

  test("rejects a non-boolean enabled", () => {
    expect(() =>
      UserRoutesConfigSchema.parse({ host: { enabled: "yes" } }),
    ).toThrow();
  });
});
