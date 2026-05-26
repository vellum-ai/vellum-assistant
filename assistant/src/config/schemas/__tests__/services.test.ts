import { describe, expect, test } from "bun:test";

import { ServicesSchema } from "../services.js";

describe("ServicesSchema OAuth mode defaults", () => {
  test("notion-oauth defaults to managed", () => {
    const parsed = ServicesSchema.parse({});
    expect(parsed["notion-oauth"].mode).toBe("managed");
  });

  test("google-oauth defaults to managed", () => {
    const parsed = ServicesSchema.parse({});
    expect(parsed["google-oauth"].mode).toBe("managed");
  });

  test("linear-oauth default is unchanged (your-own)", () => {
    const parsed = ServicesSchema.parse({});
    expect(parsed["linear-oauth"].mode).toBe("your-own");
  });

  test("explicit notion-oauth mode 'your-own' is preserved", () => {
    const parsed = ServicesSchema.parse({
      "notion-oauth": { mode: "your-own" },
    });
    expect(parsed["notion-oauth"].mode).toBe("your-own");
  });
});
