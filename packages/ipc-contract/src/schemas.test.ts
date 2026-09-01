import { describe, expect, test } from "bun:test";

import { companionContextSchema } from "./schemas";

const entrypoint = (overrides: Record<string, unknown> = {}) => ({
  id: "notes:capture",
  label: "Capture",
  icon: "pencil",
  prompt: "Capture a note about what I am working on.",
  ...overrides,
});

const context = (overrides: Record<string, unknown> = {}) => ({
  assistantName: "Vellum",
  turns: [],
  ...overrides,
});

describe("companionContextSchema entrypoints", () => {
  test("parses a contributed list and keeps its order", () => {
    const parsed = companionContextSchema.parse(
      context({
        entrypoints: [
          entrypoint(),
          entrypoint({ id: "inbox:triage", label: "Triage", icon: undefined }),
        ],
      }),
    );
    expect(parsed.entrypoints.map((e) => e.id)).toEqual([
      "notes:capture",
      "inbox:triage",
    ]);
    expect(parsed.entrypoints[1]?.icon).toBeUndefined();
  });

  test("defaults to none contributed when the field is absent", () => {
    expect(companionContextSchema.parse(context()).entrypoints).toEqual([]);
  });

  test("rejects more entrypoints than the aggregate cap allows", () => {
    const nine = Array.from({ length: 9 }, (_, i) =>
      entrypoint({ id: `plugin:${i}` }),
    );
    expect(
      companionContextSchema.safeParse(context({ entrypoints: nine })).success,
    ).toBe(false);
    expect(
      companionContextSchema.safeParse(
        context({ entrypoints: nine.slice(0, 8) }),
      ).success,
    ).toBe(true);
  });

  test("rejects a label longer than a pill can hold", () => {
    expect(
      companionContextSchema.safeParse(
        context({ entrypoints: [entrypoint({ label: "a".repeat(25) })] }),
      ).success,
    ).toBe(false);
  });

  test("rejects an empty label and an over-long prompt", () => {
    expect(
      companionContextSchema.safeParse(
        context({ entrypoints: [entrypoint({ label: "" })] }),
      ).success,
    ).toBe(false);
    expect(
      companionContextSchema.safeParse(
        context({ entrypoints: [entrypoint({ prompt: "a".repeat(2001) })] }),
      ).success,
    ).toBe(false);
  });
});
