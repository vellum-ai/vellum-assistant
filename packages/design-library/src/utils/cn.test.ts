import { describe, expect, test } from "bun:test";

import { cn } from "./cn";

describe("cn — tailwind-merge typography / text-color interaction", () => {
  test("preserves text-color alongside typography utility", () => {
    const result = cn("text-[color:var(--vbtn-fg)]", "text-body-medium-default");
    expect(result).toContain("text-[color:var(--vbtn-fg)]");
    expect(result).toContain("text-body-medium-default");
  });

  test("consumer text-color className overrides base text-color", () => {
    expect(cn("text-[color:var(--vbtn-fg)]", "text-white")).toBe("text-white");
    expect(cn("text-[color:var(--content-default)]", "text-red-500")).toBe(
      "text-red-500",
    );
  });

  test("typography utilities deduplicate against each other", () => {
    expect(cn("text-body-medium-default", "text-body-small-emphasised")).toBe(
      "text-body-small-emphasised",
    );
    expect(cn("text-lg", "text-body-medium-default")).toBe(
      "text-body-medium-default",
    );
  });

  test("tag: text-color + typography coexist in same cn() call", () => {
    const result = cn(
      "text-body-small-emphasised",
      "text-[color:var(--content-default)]",
    );
    expect(result).toContain("text-body-small-emphasised");
    expect(result).toContain("text-[color:var(--content-default)]");
  });
});
